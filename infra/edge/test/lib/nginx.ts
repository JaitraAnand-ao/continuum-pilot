/* A minimal nginx config parser and location matcher, enough to prove the local edge
 * routes like the ALB: exact (=) locations first, then the longest prefix, where a
 * ^~ prefix stops the search; server-level `if ($request_uri ~* ...)` guards run first. */
export type Directive = { name: string; args: string[]; block?: Directive[] }

export function parseNginx(source: string): Directive[] {
  const tokens: string[] = []
  const re = /#[^\n]*|"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([{};])|([^\s{};"'#]+)/g
  for (const m of source.matchAll(re)) {
    if (m[0].startsWith('#')) continue
    tokens.push(m[1] ?? m[2] ?? m[3] ?? m[4]!)
  }
  let i = 0
  const parseBlock = (): Directive[] => {
    const out: Directive[] = []
    while (i < tokens.length) {
      const name = tokens[i++]!
      if (name === '}') return out
      const args: string[] = []
      while (i < tokens.length && tokens[i] !== ';' && tokens[i] !== '{') args.push(tokens[i++]!)
      const end = tokens[i++]
      if (end === '{') out.push({ name, args, block: parseBlock() })
      else if (end === ';') out.push({ name, args })
      else throw new Error(`unterminated directive ${name}`)
    }
    return out
  }
  return parseBlock()
}

export function all(tree: Directive[], name: string): Directive[] {
  return tree.flatMap((d) => [...(d.name === name ? [d] : []), ...(d.block ? all(d.block, name) : [])])
}

function outcome(block: Directive[], upstreams: Record<string, string>): string {
  const ret = block.find((d) => d.name === 'return')
  if (ret) return ret.args[0] === '404' || ret.args[0] === '403' ? 'deny' : `return-${ret.args[0]}`
  const pass = block.find((d) => d.name === 'proxy_pass')
  if (!pass) throw new Error('location neither returns nor proxies')
  const host = /^https?:\/\/([^/:]+)/.exec(pass.args[0]!)?.[1]
  if (!host || !(host in upstreams)) throw new Error(`proxy_pass to unknown upstream ${pass.args[0]}`)
  return upstreams[host]!
}

/** nginx normalises the URI before location matching: decode %XX, then resolve dot segments. */
function normalise(path: string): string {
  const decoded = decodeURIComponent(path)
  const out: string[] = []
  for (const seg of decoded.split('/').slice(1)) {
    if (seg === '..') out.pop()
    else if (seg !== '.') out.push(seg)
  }
  return `/${out.join('/')}`
}

export function routeNginx(tree: Directive[], requestTarget: string): string {
  const upstreams = Object.fromEntries(all(tree, 'upstream').map((u) => [u.args[0]!, u.args[0]!]))
  const server = all(tree, 'server').find((s) => s.block?.some((d) => d.name === 'listen'))
  if (!server) throw new Error('no server block')
  for (const guard of server.block!.filter((d) => d.name === 'if')) {
    const [variable, op, pattern] = guard.args.map((a) => a.replace(/^\(|\)$/g, ''))
    if (variable !== '$request_uri' || (op !== '~*' && op !== '~')) throw new Error(`unsupported if ${guard.args}`)
    if (new RegExp(pattern!, op === '~*' ? 'i' : '').test(requestTarget)) return outcome(guard.block!, upstreams)
  }
  const path = normalise(requestTarget.split('?')[0]!)
  const locations = server.block!.filter((d) => d.name === 'location')
  const exact = locations.find((l) => l.args[0] === '=' && l.args[1] === path)
  if (exact) return outcome(exact.block!, upstreams)
  const prefixes = locations
    .filter((l) => l.args.length === 1 || l.args[0] === '^~')
    .map((l) => ({ l, prefix: l.args[l.args.length - 1]! }))
    .filter(({ prefix }) => path.startsWith(prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)
  const best = prefixes[0]
  if (!best) throw new Error(`no location matches ${path}`)
  if (locations.some((l) => l.args[0] === '~' || l.args[0] === '~*')) {
    throw new Error('regex locations are not modelled; keep the edge on prefix and exact locations')
  }
  return outcome(best.l.block!, upstreams)
}
