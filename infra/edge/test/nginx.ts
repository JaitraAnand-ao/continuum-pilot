/* A reader for the edge nginx config and a model of nginx's location selection
 * (exact, then longest prefix, ^~ short-circuit, then regexes in order), so the tests
 * can ask "where does this request go?" without an nginx binary. */

export interface Directive {
  name: string
  args: string[]
  children?: Directive[]
}

function tokenize(source: string): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < source.length) {
    const c = source[i] ?? ''
    if (/\s/.test(c)) {
      i++
    } else if (c === '#') {
      while (i < source.length && source[i] !== '\n') i++
    } else if (c === '{' || c === '}' || c === ';') {
      tokens.push(c)
      i++
    } else if (c === '"' || c === "'") {
      const end = source.indexOf(c, i + 1)
      tokens.push(source.slice(i + 1, end))
      i = end + 1
    } else {
      let j = i
      while (j < source.length && !/[\s{};]/.test(source[j] ?? '')) j++
      tokens.push(source.slice(i, j))
      i = j
    }
  }
  return tokens
}

export function parse(source: string): Directive[] {
  const tokens = tokenize(source)
  let pos = 0
  function list(): Directive[] {
    const out: Directive[] = []
    while (pos < tokens.length && tokens[pos] !== '}') {
      const words: string[] = []
      while (tokens[pos] !== ';' && tokens[pos] !== '{') words.push(tokens[pos++] ?? '')
      const [name = '', ...args] = words
      if (tokens[pos++] === '{') {
        out.push({ name, args, children: list() })
        pos++
      } else {
        out.push({ name, args })
      }
    }
    return out
  }
  return list()
}

export function find(directives: Directive[], name: string): Directive[] {
  return directives.filter((d) => d.name === name)
}

export function value(directives: Directive[], name: string): string[] | undefined {
  return directives.find((d) => d.name === name)?.args
}

export function servers(config: Directive[]): Directive[] {
  return config.flatMap((d) => (d.name === 'server' ? [d] : d.name === 'http' ? servers(d.children ?? []) : []))
}

/** Picks the location nginx would use for an already-normalised URI. */
export function selectLocation(server: Directive, uri: string): Directive | undefined {
  const locations = find(server.children ?? [], 'location')
  const exact = locations.find((l) => l.args[0] === '=' && l.args[1] === uri)
  if (exact) return exact
  let best: Directive | undefined
  let bestLength = -1
  for (const l of locations) {
    const [modifier = '', path = ''] = l.args.length === 1 ? ['', l.args[0]] : l.args
    if ((modifier === '' || modifier === '^~') && uri.startsWith(path) && path.length > bestLength) {
      best = l
      bestLength = path.length
    }
  }
  if (best?.args[0] === '^~') return best
  for (const l of locations) {
    const [modifier, pattern = ''] = l.args
    if (modifier === '~' && new RegExp(pattern).test(uri)) return l
    if (modifier === '~*' && new RegExp(pattern, 'i').test(uri)) return l
  }
  return best
}

export type Outcome = { kind: 'proxy'; upstream: string } | { kind: 'status'; code: number }

function outcomeOf(directives: Directive[]): Outcome | undefined {
  const ret = value(directives, 'return')
  if (ret) return { kind: 'status', code: Number(ret[0]) }
  const pass = value(directives, 'proxy_pass')
  if (pass) return { kind: 'proxy', upstream: pass[0] ?? '' }
  return undefined
}

/** Server-level `if ($request_uri ...)` guards run first, against the raw request target. */
export function route(server: Directive, requestUri: string, normalised = requestUri): Outcome | undefined {
  for (const guard of find(server.children ?? [], 'if')) {
    const [variable, op, pattern = ''] = guard.args
      .join(' ')
      .replace(/^\(|\)$/g, '')
      .split(/\s+/)
    if (variable !== '$request_uri') continue
    const matched = op === '~*' ? new RegExp(pattern, 'i').test(requestUri) : new RegExp(pattern).test(requestUri)
    if (matched) return outcomeOf(guard.children ?? [])
  }
  const location = selectLocation(server, normalised)
  return location ? outcomeOf(location.children ?? []) : undefined
}
