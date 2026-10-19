import { describe, expect, it } from 'vitest'
import { generateReport, REQUIRED_GRAPH_PERMISSIONS, type GraphReadPort } from '../src/index.js'
import { FakeClock, FakeGraph, MemoryStore, RecordingMetrics, signIn } from './support.js'

describe('AC-8: the job changes nothing in the tenant', () => {
  it('needs only the four read permissions', () => {
    expect([...REQUIRED_GRAPH_PERMISSIONS].sort()).toEqual([
      'AuditLog.Read.All',
      'IdentityRiskEvent.Read.All',
      'IdentityRiskyUser.Read.All',
      'Policy.Read.All',
    ])
    for (const permission of REQUIRED_GRAPH_PERMISSIONS) expect(permission).toMatch(/\.Read\.All$/)
  })

  it('touches Graph only through the read port: every call is a page read', async () => {
    const graph = new FakeGraph([signIn({ id: 'a' })])
    const touched = new Set<string>()
    const spy = new Proxy(graph, {
      get(target, property) {
        touched.add(String(property))
        const value: unknown = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as GraphReadPort
    await generateReport('2026-10-11', {
      graph: spy,
      store: new MemoryStore(),
      metrics: new RecordingMetrics(),
      clock: new FakeClock('2026-10-12T02:00:00.000Z'),
    })
    expect([...touched].sort()).toEqual(['riskDetectionsPage', 'signInsPage'])
  })
})
