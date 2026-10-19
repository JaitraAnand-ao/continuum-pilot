import { checkCompleteReport } from './check.js'
import { generateReport, type GenerateDeps } from './generate.js'
import { isReportDate, previousUtcDay } from './window.js'

export const QUEUE_GENERATE = 'report.generate'
export const QUEUE_CHECK = 'report.check'

export interface JobLike {
  data: unknown
}

type Handler = (jobs: JobLike[]) => Promise<void>

/* The slice of pg-boss the worker uses; a started PgBoss satisfies it. */
export interface ReportWorkerBoss {
  createQueue(name: string): Promise<void>
  schedule(name: string, cron: string, data: object, options: { tz: string; singletonKey: string }): Promise<void>
  work(name: string, options: { batchSize: number; pollingIntervalSeconds?: number }, handler: Handler): Promise<string>
}

/* The scheduled run carries no data and reports on the previous UTC day; a manual run names its date. */
function reportDateOf(job: JobLike, deps: Pick<GenerateDeps, 'clock'>): string {
  if (job.data === null || typeof job.data !== 'object') throw new Error('report.generate job data must be an object')
  const { reportDate } = job.data as { reportDate?: unknown }
  if (reportDate === undefined) return previousUtcDay(deps.clock.now())
  if (!isReportDate(reportDate)) throw new Error(`invalid report date: ${JSON.stringify(reportDate)}`)
  return reportDate
}

export function generateJobHandler(deps: GenerateDeps): Handler {
  return async (jobs) => {
    for (const job of jobs) await generateReport(reportDateOf(job, deps), deps)
  }
}

export function checkJobHandler(deps: Pick<GenerateDeps, 'store' | 'metrics' | 'clock'>): Handler {
  return async (jobs) => {
    for (let i = 0; i < jobs.length; i++) await checkCompleteReport(previousUtcDay(deps.clock.now()), deps)
  }
}

export async function startReportWorker(
  boss: ReportWorkerBoss,
  deps: GenerateDeps,
  workOptions: { pollingIntervalSeconds?: number } = {},
): Promise<void> {
  await boss.createQueue(QUEUE_GENERATE)
  await boss.createQueue(QUEUE_CHECK)
  await boss.schedule(QUEUE_GENERATE, '0 2 * * *', {}, { tz: 'UTC', singletonKey: QUEUE_GENERATE })
  await boss.schedule(QUEUE_CHECK, '30 7 * * *', {}, { tz: 'UTC', singletonKey: QUEUE_CHECK })
  await boss.work(QUEUE_GENERATE, { batchSize: 1, ...workOptions }, generateJobHandler(deps))
  await boss.work(QUEUE_CHECK, { batchSize: 1, ...workOptions }, checkJobHandler(deps))
}
