/* Test helper: expands a React element tree whose components are hook-free into its host elements,
 * so tests can read exact copy and invoke the handlers a screen wires up without a DOM. */
import { Fragment, isValidElement, type ReactElement, type ReactNode } from 'react'

export interface HostNode {
  type: string
  props: Record<string, unknown>
  children: HostNode[]
  text: string
}

type Props = Record<string, unknown> & { children?: ReactNode }

function expand(node: ReactNode): (HostNode | string)[] {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(expand)
  if (!isValidElement(node)) return []
  const element = node as ReactElement<Props>
  if (element.type === Fragment) return expand(element.props.children)
  if (typeof element.type === 'function') {
    return expand((element.type as (props: Props) => ReactNode)(element.props))
  }
  const parts = expand(element.props.children)
  const children = parts.filter((part): part is HostNode => typeof part !== 'string')
  const text = parts.map((part) => (typeof part === 'string' ? part : part.text)).join('')
  return [{ type: String(element.type), props: element.props, children, text }]
}

export function render(node: ReactNode): HostNode[] {
  return expand(node).filter((part): part is HostNode => typeof part !== 'string')
}

export function all(roots: HostNode[], match: (node: HostNode) => boolean): HostNode[] {
  return roots.flatMap((node) => [...(match(node) ? [node] : []), ...all(node.children, match)])
}

export function one(roots: HostNode[], match: (node: HostNode) => boolean): HostNode {
  const found = all(roots, match)
  if (found.length !== 1) throw new Error(`expected exactly one match, found ${found.length}`)
  return found[0] as HostNode
}

export const byText = (type: string, text: string) => (node: HostNode) => node.type === type && node.text === text

export const texts = (roots: HostNode[], type: string): string[] =>
  all(roots, (node) => node.type === type).map((node) => node.text)

export function click(node: HostNode): void {
  const handler = node.props.onClick as ((event: { preventDefault(): void }) => void) | undefined
  if (handler === undefined) throw new Error(`<${node.type}> has no onClick`)
  handler({ preventDefault: () => undefined })
}
