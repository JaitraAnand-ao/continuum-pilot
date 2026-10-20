/* ST-15 detection settings (IF-40 to IF-43): administrators read the version in effect and make detection stricter on
 * their own. Each change is a new config version plus a config.applied audit event; the rules live in rules.ts. */
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AuditLog, ConfigAppliedEvent } from '../audit.js'
import type { Clock } from '../clock.js'
import { problemSchema, sendProblem } from '../http/problem.js'
import {
  classifyThresholdChange,
  DEFAULT_THRESHOLDS,
  isSensitive,
  reportDateFor,
  THRESHOLD_KEYS,
  UNKNOWN_APP_MESSAGE,
  validateThreshold,
  withSensitiveApp,
  withThreshold,
  type ConfigVersion,
  type SensitiveApp,
  type ThresholdKey,
} from './rules.js'
import type { DetectionSettingsStore, TenantAppDirectory } from './store.js'

export interface SettingsDeps {
  clock: Clock
  audit: AuditLog
  settings: DetectionSettingsStore
  tenantApps: TenantAppDirectory
}

export const SAVE_FAILED = "Couldn't save. Your change wasn't applied and nothing was sent for approval."
const LOAD_FAILED = "Couldn't load detection settings."
const SEARCH_LIMIT = 20
/* A pattern, not format: uuid, which would also admit the urn:uuid: form the stores never hold. */
const uuidInput = {
  type: 'string',
  pattern: '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$',
} as const

const pendingSchema = {
  oneOf: [
    { type: 'null' },
    {
      type: 'object',
      additionalProperties: false,
      required: ['proposalId', 'summary', 'proposedBy', 'proposedAt'],
      properties: {
        proposalId: { type: 'string' },
        summary: { type: 'string' },
        proposedBy: { type: 'string' },
        proposedAt: { type: 'string' },
      },
    },
  ],
} as const

const thresholdSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'thresholdKey',
    'count',
    'windowMinutes',
    'defaultCount',
    'defaultWindowMinutes',
    'inEffectSince',
    'pending',
  ],
  properties: {
    thresholdKey: { type: 'string', enum: THRESHOLD_KEYS },
    count: { type: 'integer' },
    windowMinutes: { type: 'integer' },
    defaultCount: { type: 'integer' },
    defaultWindowMinutes: { type: 'integer' },
    inEffectSince: { type: 'string', format: 'date-time' },
    pending: pendingSchema,
  },
} as const

const sensitiveAppSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['appId', 'appName', 'addedBy', 'addedAt', 'pending'],
  properties: {
    appId: { type: 'string', format: 'uuid' },
    appName: { type: 'string' },
    addedBy: { type: 'string' },
    addedAt: { type: 'string', format: 'date-time' },
    pending: pendingSchema,
  },
} as const

const settingsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['configVersionId', 'thresholds', 'sensitiveApps', 'pendingCount'],
  properties: {
    configVersionId: { type: 'string', format: 'uuid' },
    pendingCount: { type: 'integer' },
    thresholds: { type: 'array', items: thresholdSchema },
    sensitiveApps: { type: 'array', items: sensitiveAppSchema },
  },
} as const

const appliedSchema = (key: 'threshold' | 'app', item: object) =>
  ({
    type: 'object',
    additionalProperties: false,
    required: ['configVersionId', 'appliesFromReportDate', key],
    properties: {
      configVersionId: { type: 'string', format: 'uuid' },
      appliesFromReportDate: { type: 'string', format: 'date' },
      [key]: item,
    },
  }) as const

const thresholdBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['configVersionId', 'count', 'windowMinutes'],
  properties: {
    configVersionId: uuidInput,
    /* Numbers, not integers: the whole-number rule answers with its own message (AC-5). */
    count: { type: 'number' },
    windowMinutes: { type: 'number' },
  },
} as const

const appBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['configVersionId', 'appId'],
  properties: {
    configVersionId: uuidInput,
    appId: uuidInput,
  },
} as const

const problems = (...statuses: number[]) => Object.fromEntries(statuses.map((status) => [status, problemSchema]))

function thresholdView(version: ConfigVersion, key: ThresholdKey) {
  const setting = version.thresholds[key]
  return {
    thresholdKey: key,
    count: setting.count,
    windowMinutes: setting.windowMinutes,
    defaultCount: DEFAULT_THRESHOLDS[key].count,
    defaultWindowMinutes: DEFAULT_THRESHOLDS[key].windowMinutes,
    inEffectSince: setting.inEffectSince.toISOString(),
    pending: null,
  }
}

function appView(app: SensitiveApp) {
  return {
    appId: app.appId,
    appName: app.appName,
    addedBy: app.addedBy,
    addedAt: app.addedAt.toISOString(),
    pending: null,
  }
}

class StoreUnavailable extends Error {}

/* Any store failure becomes this, so neither the store's message nor its kind reaches the caller. */
async function reach<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch {
    throw new StoreUnavailable()
  }
}

export function registerDetectionSettings(app: FastifyInstance, deps: SettingsDeps): void {
  const { clock, audit, settings, tenantApps } = deps

  const unavailable = (request: FastifyRequest, reply: FastifyReply, title: string) =>
    sendProblem(request, reply, 503, { type: '/problems/settings-store-unavailable', title })

  const invalidThreshold = (request: FastifyRequest, reply: FastifyReply, title: string) =>
    sendProblem(request, reply, 400, { type: '/problems/invalid-threshold', title })

  const stale = (request: FastifyRequest, reply: FastifyReply) =>
    sendProblem(request, reply, 409, {
      type: '/problems/stale-version',
      title: 'These settings changed since you opened them. Reload to see the current values.',
    })

  /* Appends the next version, then audits it; false when another save got there first. */
  async function apply(
    request: FastifyRequest,
    current: ConfigVersion,
    next: ConfigVersion,
    change: ConfigAppliedEvent['change'],
  ): Promise<boolean> {
    if (!(await reach(() => settings.append(next)))) return false
    await audit.record({
      type: 'config.applied',
      account: request.session!.account,
      configVersionId: next.id,
      previousConfigVersionId: current.id,
      change,
      traceId: request.id,
      at: next.createdAt.toISOString(),
    })
    return true
  }

  app.get(
    '/api/v1/detection-settings',
    {
      config: { requiredRole: 'config.read' },
      schema: { response: { 200: settingsSchema, ...problems(401, 403, 503) } },
    },
    async (request, reply) => {
      let version: ConfigVersion
      try {
        version = await reach(() => settings.current())
      } catch {
        return unavailable(request, reply, LOAD_FAILED)
      }
      return {
        configVersionId: version.id,
        pendingCount: 0,
        thresholds: THRESHOLD_KEYS.map((key) => thresholdView(version, key)),
        sensitiveApps: version.sensitiveApps.map(appView),
      }
    },
  )

  app.put<{
    Params: { thresholdKey: ThresholdKey }
    Body: { configVersionId: string; count: number; windowMinutes: number }
  }>(
    '/api/v1/detection-settings/thresholds/:thresholdKey',
    {
      config: { requiredRole: 'config.write' },
      /* Before schema coercion, which would turn true into 1 or "8" into 8: only JSON numbers are thresholds (AC-5). */
      preValidation: async (request, reply) => {
        const body: unknown = request.body
        if (typeof body !== 'object' || body === null) return
        const { count, windowMinutes } = body as Record<string, unknown>
        const validation = validateThreshold({ count, windowMinutes })
        if (!validation.ok) return invalidThreshold(request, reply, validation.message)
      },
      schema: {
        params: {
          type: 'object',
          required: ['thresholdKey'],
          properties: { thresholdKey: { type: 'string', enum: THRESHOLD_KEYS } },
        },
        body: thresholdBodySchema,
        response: { 200: appliedSchema('threshold', thresholdSchema), ...problems(400, 401, 403, 409, 415, 503) },
      },
    },
    async (request, reply) => {
      const key = request.params.thresholdKey
      const proposed = { count: request.body.count, windowMinutes: request.body.windowMinutes }
      try {
        const current = await reach(() => settings.current())
        if (current.id !== request.body.configVersionId.toLowerCase()) return stale(request, reply)
        const before = current.thresholds[key]
        const direction = classifyThresholdChange(before, proposed)
        if (direction === 'unchanged') {
          return sendProblem(request, reply, 409, { type: '/problems/unchanged', title: 'Nothing changed.' })
        }
        if (direction === 'loosen') {
          return sendProblem(request, reply, 409, {
            type: '/problems/loosening-requires-approval',
            title: 'This loosens detection and needs a second administrator to approve it.',
          })
        }
        const at = clock.now()
        const next = withThreshold(current, key, proposed, {
          id: randomUUID(),
          at,
          by: request.session!.account,
        })
        const change = {
          setting: key,
          from: { count: before.count, windowMinutes: before.windowMinutes },
          to: proposed,
        }
        if (!(await apply(request, current, next, change))) return stale(request, reply)
        return {
          configVersionId: next.id,
          appliesFromReportDate: reportDateFor(at),
          threshold: thresholdView(next, key),
        }
      } catch (problem) {
        if (problem instanceof StoreUnavailable) return unavailable(request, reply, SAVE_FAILED)
        throw problem
      }
    },
  )

  app.post<{ Body: { configVersionId: string; appId: string } }>(
    '/api/v1/detection-settings/sensitive-apps',
    {
      config: { requiredRole: 'config.write' },
      schema: {
        body: appBodySchema,
        response: { 201: appliedSchema('app', sensitiveAppSchema), ...problems(400, 401, 403, 409, 415, 422, 503) },
      },
    },
    async (request, reply) => {
      const appId = request.body.appId.toLowerCase()
      try {
        const current = await reach(() => settings.current())
        if (current.id !== request.body.configVersionId.toLowerCase()) return stale(request, reply)
        if (isSensitive(current, appId)) {
          return sendProblem(request, reply, 409, {
            type: '/problems/already-sensitive',
            title: 'That application is already a sensitive application.',
          })
        }
        const seen = await reach(() => tenantApps.find(appId))
        if (!seen)
          return sendProblem(request, reply, 422, { type: '/problems/unknown-application', title: UNKNOWN_APP_MESSAGE })
        const at = clock.now()
        const session = request.session!
        const next = withSensitiveApp(
          current,
          { appId: seen.appId, appName: seen.appName, addedBy: session.displayName },
          { id: randomUUID(), at, by: session.account },
        )
        const change = { setting: 'sensitive_apps' as const, added: { appId: seen.appId, appName: seen.appName } }
        if (!(await apply(request, current, next, change))) return stale(request, reply)
        return reply.code(201).send({
          configVersionId: next.id,
          appliesFromReportDate: reportDateFor(at),
          app: appView(next.sensitiveApps.at(-1)!),
        })
      } catch (problem) {
        if (problem instanceof StoreUnavailable) return unavailable(request, reply, SAVE_FAILED)
        throw problem
      }
    },
  )

  app.get<{ Querystring: { q: string } }>(
    '/api/v1/detection-settings/tenant-apps',
    {
      config: { requiredRole: 'config.write' },
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['q'],
          properties: { q: { type: 'string', minLength: 1, maxLength: 100 } },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['appId', 'appName', 'sensitive'],
                  properties: {
                    appId: { type: 'string', format: 'uuid' },
                    appName: { type: 'string' },
                    sensitive: { type: 'boolean' },
                  },
                },
              },
            },
          },
          ...problems(400, 401, 403, 503),
        },
      },
    },
    async (request, reply) => {
      try {
        const [current, matches] = await Promise.all([
          reach(() => settings.current()),
          reach(() => tenantApps.search(request.query.q, SEARCH_LIMIT)),
        ])
        return { items: matches.map((one) => ({ ...one, sensitive: isSensitive(current, one.appId) })) }
      } catch {
        return unavailable(request, reply, "Couldn't search the applications seen in this tenant.")
      }
    },
  )
}
