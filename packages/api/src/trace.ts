/* The trace ID every problem+json carries: the caller's W3C traceparent trace ID, or a fresh one. */
import { randomBytes } from 'node:crypto'

const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/

export function traceIdFrom(traceparent: string | string[] | undefined): string {
  const match = typeof traceparent === 'string' ? TRACEPARENT.exec(traceparent) : null
  const traceId = match?.[1]
  if (traceId !== undefined && !/^0+$/.test(traceId)) return traceId
  return randomBytes(16).toString('hex')
}
