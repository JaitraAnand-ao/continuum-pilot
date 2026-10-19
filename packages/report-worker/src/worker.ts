import type { Clock } from './clock.js'
import { checkReportDeadline } from './deadline-check.js'
import { generateReport, type GenerateDeps, type GenerateOutcome } from './generate.js'
import { parseReportDate, previousUtcDate } from './rules.js'

export const GENERATE_QUEUE = 'report.generate'
export const DEADLINE_CHECK_QUEUE = 'report.deadline-check'
export const GENERATE_CRON = '0 2 * * *'
export const DEADLINE_CHECK_CRON = '30 7 * * *'
/* A run may keep retrying Graph from 02:00 until 07:00 UTC. */
export const GENERATE_EXPIRE_SECONDS = 6 * 3600

/* The part of pg-boss the worker uses; a PgBoss instance satisfies it. */
export interface JobBoss {
  createQueue(name: string, options?: { name: string; policy?: 'singleton'; expireInSeconds?: number }): Promise<void>
  schedule(name: string, cron: string, data?: object, options?: { tz?: string }): Promise<void>
  work<T>(name: string, handler: (jobs: { id: string; data: T }[]) => Promise<unknown>): Promise<string>
}

/* IF-15 payload: an explicit date re-runs that day; without one the scheduled run takes yesterday. */
export interface GeneratePayload {
  reportDate?: string
}

export function reportDateFor(payload: GeneratePayload | null | undefined, clock: Clock): string {
  return payload?.reportDate === undefined ? previousUtcDate(clock.now()) : parseReportDate(payload.reportDate)
}

/* pg-boss stores a failed job's error as its output; a store or Graph error may quote sign-in
 * content, so the original is dropped and only a fixed message naming the date leaves the worker. */
async function withFixedMessage<T>(message: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch {
    throw new Error(message)
  }
}

export async function registerReportWorker(boss: JobBoss, deps: GenerateDeps): Promise<void> {
  await boss.createQueue(GENERATE_QUEUE, {
    name: GENERATE_QUEUE,
    policy: 'singleton',
    expireInSeconds: GENERATE_EXPIRE_SECONDS,
  })
  await boss.createQueue(DEADLINE_CHECK_QUEUE, { name: DEADLINE_CHECK_QUEUE })
  await boss.schedule(GENERATE_QUEUE, GENERATE_CRON, {}, { tz: 'UTC' })
  await boss.schedule(DEADLINE_CHECK_QUEUE, DEADLINE_CHECK_CRON, {}, { tz: 'UTC' })
  await boss.work<GeneratePayload>(GENERATE_QUEUE, async (jobs) => {
    const outcomes: GenerateOutcome[] = []
    for (const job of jobs) {
      const reportDate = reportDateFor(job.data, deps.clock)
      outcomes.push(
        await withFixedMessage(`report generation failed for ${reportDate}`, () => generateReport(reportDate, deps)),
      )
    }
    /* Only the outcome kind leaves the worker as job output: no sign-in content. */
    return outcomes.map((outcome) => ({ kind: outcome.kind }))
  })
  await boss.work(DEADLINE_CHECK_QUEUE, async () =>
    withFixedMessage(`report deadline check failed for ${previousUtcDate(deps.clock.now())}`, () =>
      checkReportDeadline(deps),
    ),
  )
}
