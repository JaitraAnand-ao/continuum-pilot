/* A small evaluator for the subset of CloudWatch metric math the module uses, so the
   alarm's behaviour can be checked at given instants without an AWS account.
   Unknown functions throw: the module may only use what is modelled (and exists in CloudWatch). */

export type Series = Map<number, number> // epoch ms -> value

type Node =
  | { kind: 'num'; value: number }
  | { kind: 'ref'; id: string }
  | { kind: 'call'; fn: string; args: Node[] }
  | { kind: 'bin'; op: string; left: Node; right: Node }

const TOKEN = /\s*(>=|<=|==|!=|[()+\-*/,<>]|\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*)/y

function tokenize(src: string): string[] {
  const out: string[] = []
  TOKEN.lastIndex = 0
  while (!/^\s*$/.test(src.slice(TOKEN.lastIndex))) {
    const m = TOKEN.exec(src)
    if (!m) throw new Error(`cannot tokenize near: ${src.slice(TOKEN.lastIndex)}`)
    out.push(m[1] as string)
  }
  return out
}

const PRECEDENCE: Record<string, number> = {
  OR: 1,
  AND: 2,
  '>=': 3,
  '<=': 3,
  '>': 3,
  '<': 3,
  '==': 3,
  '!=': 3,
  '+': 4,
  '-': 4,
  '*': 5,
  '/': 5,
}

export function parse(src: string): Node {
  const tokens = tokenize(src)
  let i = 0
  const peek = () => tokens[i]
  const take = (expected?: string) => {
    const t = tokens[i++]
    if (t === undefined || (expected !== undefined && t !== expected))
      throw new Error(`expected ${expected ?? 'token'} in ${src}`)
    return t
  }
  const primary = (): Node => {
    const t = take()
    if (t === '(') {
      const inner = expr(0)
      take(')')
      return inner
    }
    if (/^\d/.test(t)) return { kind: 'num', value: Number(t) }
    if (peek() === '(') {
      take('(')
      const args: Node[] = []
      if (peek() !== ')') {
        args.push(expr(0))
        while (peek() === ',') {
          take(',')
          args.push(expr(0))
        }
      }
      take(')')
      return { kind: 'call', fn: t, args }
    }
    return { kind: 'ref', id: t }
  }
  const expr = (min: number): Node => {
    let left = primary()
    for (;;) {
      const op = peek()
      const prec = op === undefined ? undefined : PRECEDENCE[op]
      if (prec === undefined || prec <= min) return left
      take()
      left = { kind: 'bin', op: op as string, left, right: expr(prec) }
    }
  }
  const node = expr(0)
  if (i !== tokens.length) throw new Error(`trailing tokens in ${src}`)
  return node
}

function at(node: Node, t: number, env: Record<string, Series>): number | undefined {
  switch (node.kind) {
    case 'num':
      return node.value
    case 'ref': {
      const s = env[node.id]
      if (!s) throw new Error(`unknown query id ${node.id}`)
      return s.get(t)
    }
    case 'bin': {
      const l = at(node.left, t, env)
      const r = at(node.right, t, env)
      if (l === undefined || r === undefined) return undefined
      const b = (x: boolean) => (x ? 1 : 0)
      switch (node.op) {
        case '+':
          return l + r
        case '-':
          return l - r
        case '*':
          return l * r
        case '/':
          return l / r
        case '>=':
          return b(l >= r)
        case '<=':
          return b(l <= r)
        case '>':
          return b(l > r)
        case '<':
          return b(l < r)
        case '==':
          return b(l === r)
        case '!=':
          return b(l !== r)
        case 'AND':
          return b(l !== 0 && r !== 0)
        case 'OR':
          return b(l !== 0 || r !== 0)
      }
      throw new Error(`operator ${node.op}`)
    }
    case 'call': {
      const [a, b, c] = node.args as [Node, Node, Node]
      switch (node.fn) {
        case 'FILL': {
          const v = at(a, t, env)
          return v === undefined ? at(b, t, env) : v
        }
        case 'IF': {
          const cond = at(a, t, env)
          if (cond === undefined) return undefined
          return cond !== 0 ? at(b, t, env) : at(c, t, env)
        }
        case 'HOUR':
          return at(a, t, env) === undefined ? undefined : new Date(t).getUTCHours()
        case 'MINUTE':
          return at(a, t, env) === undefined ? undefined : new Date(t).getUTCMinutes()
      }
      throw new Error(`metric math function ${node.fn} is not modelled`)
    }
  }
}

export type MetricQuery = {
  id: string
  expression?: string
  return_data?: boolean
  metric?: { namespace: string; metric_name: string; dimensions?: Record<string, string>; period: number; stat: string }
}

export type Alarm = {
  comparison_operator: string
  threshold: number
  evaluation_periods: number
  datapoints_to_alarm?: number
  treat_missing_data?: string
  metric_query: MetricQuery[]
}

/* Evaluates the alarm at instant `now` from raw datapoints of each metric (keyed by query id). */
export function alarmState(alarm: Alarm, now: Date, raw: Record<string, Series>): 'ALARM' | 'OK' {
  const metricQuery = alarm.metric_query.find((q) => q.metric)
  if (!metricQuery?.metric) throw new Error('the alarm has no metric query')
  const period = metricQuery.metric.period * 1000
  const last = Math.floor(now.getTime() / period) * period
  const stamps = Array.from({ length: alarm.evaluation_periods }, (_, k) => last - k * period).reverse()

  const env: Record<string, Series> = {}
  for (const q of alarm.metric_query) {
    const series: Series = new Map()
    for (const t of stamps) {
      const v = q.metric ? raw[q.id]?.get(t) : at(parse(q.expression as string), t, env)
      if (v !== undefined) series.set(t, v)
    }
    env[q.id] = series
  }
  const returned = alarm.metric_query.filter((q) => q.return_data)
  if (returned.length !== 1) throw new Error('exactly one query must return data')
  const out = env[(returned[0] as MetricQuery).id] as Series

  const breaches = (v: number) => {
    switch (alarm.comparison_operator) {
      case 'GreaterThanOrEqualToThreshold':
        return v >= alarm.threshold
      case 'GreaterThanThreshold':
        return v > alarm.threshold
      case 'LessThanThreshold':
        return v < alarm.threshold
      case 'LessThanOrEqualToThreshold':
        return v <= alarm.threshold
    }
    throw new Error(`comparison ${alarm.comparison_operator}`)
  }
  let breaching = 0
  for (const t of stamps) {
    const v = out.get(t)
    if (v === undefined ? alarm.treat_missing_data === 'breaching' : breaches(v)) breaching++
  }
  return breaching >= (alarm.datapoints_to_alarm ?? alarm.evaluation_periods) ? 'ALARM' : 'OK'
}
