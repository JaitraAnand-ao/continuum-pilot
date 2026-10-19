/* The pg-boss wiring: queues, the two UTC schedules and the handlers. */
import type PgBoss from 'pg-boss'
import { checkCompleteReport } from './deadline-check.js'
import { generateReport, type ReportJobDeps } from './generate.js'
import { previousUtcDate } from './window.js'

export const REPORT_GENERATE_QUEUE = 'report.generate'
export const REPORT_DEADLINE_CHECK_QUEUE = 'report.deadline-check'
export const REPORT_GENERATE_CRON = '0 2 * * *'
export const DEADLINE_CHECK_CRON = '30 7 * * *'

export type JobQueue = Pick<PgBoss, 'createQueue' | 'schedule' | 'work'>

/* Payloads carry IDs and the trace context only. */
export interface ReportGeneratePayload {
  reportDate?: string
  traceparent?: string
}

const PAYLOAD_KEYS = new Set(['reportDate', 'traceparent'])

export function parseGeneratePayload(data: unknown): ReportGeneratePayload {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new TypeError('report.generate payload must be an object')
  }
  const fields = data as Record<string, unknown>
  for (const key of Object.keys(fields)) {
    if (!PAYLOAD_KEYS.has(key)) throw new TypeError(`report.generate payload has an unknown field: ${key}`)
    if (typeof fields[key] !== 'string') throw new TypeError(`report.generate payload field ${key} must be a string`)
  }
  return fields as ReportGeneratePayload
}

/* Re-requesting a date is safe: the singleton key keeps one job per date in flight and the
 * job itself leaves a published report alone. */
export function requestReport(queue: Pick<PgBoss, 'send'>, reportDate: string): Promise<string | null> {
  return queue.send(REPORT_GENERATE_QUEUE, { reportDate }, { singletonKey: reportDate })
}

export async function startReportWorker(
  queue: JobQueue,
  deps: ReportJobDeps,
  { pollingIntervalSeconds = 2 }: { pollingIntervalSeconds?: number } = {},
): Promise<void> {
  /* The run starts at 02:00 and may retry Graph until 07:00, so it may not expire before 08:00. */
  await queue.createQueue(REPORT_GENERATE_QUEUE, {
    name: REPORT_GENERATE_QUEUE,
    policy: 'singleton',
    expireInHours: 6,
    retryLimit: 2,
    retryDelay: 60,
  })
  await queue.createQueue(REPORT_DEADLINE_CHECK_QUEUE, {
    name: REPORT_DEADLINE_CHECK_QUEUE,
    policy: 'singleton',
    expireInMinutes: 5,
    retryLimit: 2,
    retryDelay: 30,
  })
  await queue.schedule(REPORT_GENERATE_QUEUE, REPORT_GENERATE_CRON, {}, { tz: 'UTC' })
  await queue.schedule(REPORT_DEADLINE_CHECK_QUEUE, DEADLINE_CHECK_CRON, {}, { tz: 'UTC' })

  await queue.work(REPORT_GENERATE_QUEUE, { pollingIntervalSeconds }, async (jobs) => {
    for (const job of jobs) {
      const payload = parseGeneratePayload(job.data)
      await generateReport(payload.reportDate ?? previousUtcDate(deps.clock.now()), deps)
    }
  })
  await queue.work(REPORT_DEADLINE_CHECK_QUEUE, { pollingIntervalSeconds }, async () => {
    await checkCompleteReport(deps)
  })
}
