import { checkReportPresence } from './check.js'
import { generateReport, type GenerateDeps } from './generate.js'
import { isReportDate, previousUtcDay } from './window.js'

export const QUEUES = { generate: 'report.generate', check: 'report.check' } as const
export const SCHEDULES = { generate: '0 2 * * *', check: '30 7 * * *' } as const

export interface BossJob {
  id: string
  data: unknown
}

/** The part of pg-boss the worker uses. */
export interface BossLike {
  createQueue(name: string): Promise<void>
  schedule(name: string, cron: string, data?: object, options?: { tz?: string }): Promise<void>
  work(name: string, handler: (jobs: BossJob[]) => Promise<unknown>): Promise<string>
}

/* A scheduled job carries no date and means yesterday (UTC); a re-run may name one. */
function reportDateOf(job: BossJob, deps: GenerateDeps): string {
  const data = job.data
  const named = data !== null && typeof data === 'object' && 'reportDate' in data ? data.reportDate : undefined
  if (named === undefined) return previousUtcDay(deps.clock.now())
  if (!isReportDate(named)) throw new RangeError('report date must be a calendar date written YYYY-MM-DD')
  return named
}

export async function registerReportWorker(boss: BossLike, deps: GenerateDeps): Promise<void> {
  await boss.createQueue(QUEUES.generate)
  await boss.createQueue(QUEUES.check)
  await boss.schedule(QUEUES.generate, SCHEDULES.generate, {}, { tz: 'UTC' })
  await boss.schedule(QUEUES.check, SCHEDULES.check, {}, { tz: 'UTC' })
  await boss.work(QUEUES.generate, async (jobs) => {
    const outcomes = []
    for (const job of jobs) outcomes.push(await generateReport(deps, reportDateOf(job, deps)))
    return outcomes
  })
  await boss.work(QUEUES.check, async (jobs) => {
    const results = []
    for (const job of jobs) results.push(await checkReportPresence(deps, reportDateOf(job, deps)))
    return results
  })
}
