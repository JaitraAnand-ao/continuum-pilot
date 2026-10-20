/* ST-18: the recipient endpoints behind SCR-8 Email recipients (IF-51 to IF-56). Only report administrators
 * (config.write) reach them. Each addition passes the reader-group check, fails closed when the directory cannot
 * answer, and waits for approval; a removal applies at once. Every check, proposal and removal is audited (AC-10). */
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AuditLog, RecipientAuditTrail, RecipientEvent } from '../audit.js'
import type { Clock } from '../clock.js'
import { problemSchema, sendProblem } from '../http/problem.js'
import type { DirectoryEntry, DirectoryPort, MetricsPort, Recipient, RecipientStore } from './ports.js'
import { METRIC_NAMESPACE, RecipientAlreadyListedError } from './ports.js'
import {
  actionLabel,
  assessGroup,
  assessPerson,
  checkText,
  messages,
  statusText,
  typeText,
  type Assessment,
} from './rules.js'

export interface RecipientDeps {
  clock: Clock
  audit: AuditLog
  auditTrail: RecipientAuditTrail
  recipients: RecipientStore
  directory: DirectoryPort
  metrics: MetricsPort
}

const ROUTE_CONFIG = {
  requiredRole: 'config.write',
  forbidden: { type: '/problems/admin-only', title: messages.adminOnly },
} as const

const SEARCH_LIMIT = 25
const ID = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } as const

const recipientSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'kind',
    'displayName',
    'address',
    'memberCount',
    'typeText',
    'checkText',
    'status',
    'statusText',
    'addedBy',
    'addedAt',
    'action',
  ],
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: ['person', 'group'] },
    displayName: { type: 'string' },
    address: { type: 'string' },
    memberCount: { type: ['integer', 'null'] },
    typeText: { type: 'string' },
    checkText: { type: 'string' },
    status: { type: 'string', enum: ['active', 'pending'] },
    statusText: { type: 'string' },
    addedBy: { type: 'string' },
    addedAt: { type: 'string' },
    action: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'label'],
      properties: { kind: { type: 'string', enum: ['remove', 'withdraw'] }, label: { type: 'string' } },
    },
  },
} as const

const rejectionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'title', 'status', 'traceId', 'reason'],
  properties: {
    ...problemSchema.properties,
    reason: { type: 'string' },
    outsiders: {
      type: 'object',
      additionalProperties: false,
      required: ['count', 'total', 'addresses'],
      properties: {
        count: { type: 'integer' },
        total: { type: 'integer' },
        addresses: { type: 'array', items: { type: 'string' } },
      },
    },
  },
} as const

const announcementSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['announcement'],
  properties: { announcement: { type: 'string' }, confirmation: { type: 'string' } },
} as const

const denials = { 401: problemSchema, 403: problemSchema } as const

function view(recipient: Recipient) {
  const { id, kind, displayName, address, memberCount, status, addedBy, addedAt } = recipient
  return {
    id,
    kind,
    displayName,
    address,
    memberCount,
    typeText: typeText(kind, memberCount),
    checkText: checkText(kind, memberCount),
    status,
    statusText: statusText(status),
    addedBy,
    addedAt,
    action: {
      kind: status === 'active' ? 'remove' : 'withdraw',
      label: actionLabel(status, displayName, address),
    },
  }
}

class StoreError extends Error {}

/* Store failures become one typed problem; the cause never reaches the response. */
async function stored<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation
  } catch (problem) {
    if (problem instanceof RecipientAlreadyListedError) throw problem
    throw new StoreError()
  }
}

export function registerRecipientRoutes(app: FastifyInstance, deps: RecipientDeps): void {
  const { clock, audit, auditTrail, recipients, directory, metrics } = deps

  const record = (request: FastifyRequest, event: Omit<RecipientEvent, 'account' | 'traceId' | 'at'>) =>
    audit.record({ ...event, account: request.session!.account, traceId: request.id, at: clock.now().toISOString() })

  const storeUnavailable = (request: FastifyRequest, reply: FastifyReply) =>
    sendProblem(request, reply, 503, {
      type: '/problems/recipient-store-unavailable',
      title: "Couldn't load recipients. Try again.",
    })

  const saveFailed = (request: FastifyRequest, reply: FastifyReply) =>
    sendProblem(request, reply, 503, { type: '/problems/recipient-save-failed', title: messages.saveFailed })

  async function assess(entry: DirectoryEntry): Promise<Assessment> {
    if (entry.kind === 'person') return assessPerson(entry.id, await directory.readersAmong([entry.id]))
    const members = await directory.groupMembers(entry.id)
    if (members.length === 0) return assessGroup(members, new Set())
    return assessGroup(members, await directory.readersAmong(members.map((member) => member.id)))
  }

  function rejection(entry: DirectoryEntry, assessment: Exclude<Assessment, { verdict: 'eligible' }>) {
    switch (assessment.verdict) {
      case 'not-reader':
        return { type: '/problems/recipient-not-reader', title: messages.notReader(entry.displayName) }
      case 'empty-group':
        return { type: '/problems/recipient-empty-group', title: messages.emptyGroup(entry.displayName) }
      case 'group-outsiders': {
        const { outsiders, memberCount } = assessment
        return {
          type: '/problems/recipient-group-outsiders',
          title: messages.outsiders(entry.displayName, outsiders.length, memberCount),
          outsiders: { count: outsiders.length, total: memberCount, addresses: outsiders },
        }
      }
    }
  }

  /* IF-51 */
  app.get(
    '/api/v1/recipients',
    {
      config: ROUTE_CONFIG,
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['recipients'],
            properties: {
              recipients: { type: 'array', items: recipientSchema },
              empty: {
                type: 'object',
                additionalProperties: false,
                required: ['title', 'note'],
                properties: { title: { type: 'string' }, note: { type: 'string' } },
              },
            },
          },
          ...denials,
          503: problemSchema,
        },
      },
    },
    async (request, reply) => {
      let rows: Recipient[]
      try {
        rows = await recipients.list()
      } catch {
        return storeUnavailable(request, reply)
      }
      if (rows.length === 0) return { recipients: [], empty: { title: messages.nobody, note: messages.stillGenerated } }
      rows.sort((a, b) => a.displayName.localeCompare(b.displayName, 'en', { sensitivity: 'base' }))
      return { recipients: rows.map(view) }
    },
  )

  /* IF-52: the text is length- and character-limited here; the adapter still treats it as a value, never as filter syntax. */
  app.get<{ Querystring: { q: string } }>(
    '/api/v1/recipients/directory',
    {
      config: ROUTE_CONFIG,
      schema: {
        querystring: {
          type: 'object',
          required: ['q'],
          properties: { q: { type: 'string', minLength: 2, maxLength: 64, pattern: '^[\\p{L}\\p{N} ._@-]+$' } },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['results'],
            properties: {
              results: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['directoryId', 'kind', 'displayName', 'address'],
                  properties: {
                    directoryId: { type: 'string' },
                    kind: { type: 'string' },
                    displayName: { type: 'string' },
                    address: { type: 'string' },
                  },
                },
              },
            },
          },
          400: problemSchema,
          ...denials,
          503: problemSchema,
        },
      },
    },
    async (request, reply) => {
      let found: DirectoryEntry[]
      try {
        found = await directory.search(request.query.q)
      } catch {
        return sendProblem(request, reply, 503, {
          type: '/problems/directory-unavailable',
          title: "Couldn't search the directory. Try again later.",
        })
      }
      return {
        results: found.slice(0, SEARCH_LIMIT).map(({ id, kind, displayName, address }) => ({
          directoryId: id,
          kind,
          displayName,
          address,
        })),
      }
    },
  )

  /* IF-53: Check and add (AC-2 to AC-5). */
  app.post<{ Body: { directoryId: string } }>(
    '/api/v1/recipients',
    {
      config: ROUTE_CONFIG,
      /* Fastify coerces 123 or ['x'] into a string; the contract asks for a string, so anything else is refused. */
      preValidation: async (request, reply) => {
        const body = request.body as { directoryId?: unknown } | null
        if (typeof body?.directoryId !== 'string') return sendProblem(request, reply, 400)
      },
      schema: {
        /* maxProperties rejects an unknown field before Fastify's removeAdditional could strip it silently. */
        body: {
          type: 'object',
          additionalProperties: false,
          maxProperties: 1,
          required: ['directoryId'],
          properties: { directoryId: ID },
        },
        response: {
          201: {
            type: 'object',
            additionalProperties: false,
            required: ['recipient', 'announcement'],
            properties: { recipient: recipientSchema, announcement: { type: 'string' } },
          },
          400: problemSchema,
          ...denials,
          404: problemSchema,
          409: problemSchema,
          422: rejectionSchema,
          503: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const { directoryId } = request.body
      const alreadyListed = (listed: Recipient) =>
        sendProblem(request, reply, 409, {
          type: '/problems/recipient-already-listed',
          title: messages.alreadyListed(listed.displayName),
        })
      try {
        const listed = await stored(recipients.findByDirectoryId(directoryId))
        if (listed) return alreadyListed(listed)

        /* Fail closed: any error from the directory, at any step, rejects the recipient (AC-5). */
        let entry: DirectoryEntry | undefined
        let assessment: Assessment
        try {
          entry = await directory.entry(directoryId)
          if (!entry) return sendProblem(request, reply, 404)
          assessment = await assess(entry)
        } catch {
          /* Settled independently: a broken audit sink must not silence the alarm, nor a broken metric the audit. */
          await Promise.allSettled([
            record(request, { type: 'recipient.check_failed', target: directoryId }),
            metrics.put({
              namespace: METRIC_NAMESPACE,
              name: 'RecipientCheckFailed',
              value: 1,
              dimensions: {},
              timestamp: clock.now().toISOString(),
            }),
          ])
          return sendProblem(request, reply, 503, {
            type: '/problems/recipient-check-failed',
            title: messages.checkFailed(entry?.displayName),
          })
        }

        await record(request, { type: 'recipient.checked', target: directoryId, outcome: assessment.verdict })
        if (assessment.verdict !== 'eligible') {
          const problem = {
            ...rejection(entry, assessment),
            status: 422,
            traceId: request.id,
            reason: assessment.verdict,
          }
          return reply.code(422).type('application/problem+json').send(problem)
        }

        const recipient: Recipient = {
          id: randomUUID(),
          directoryId,
          kind: entry.kind,
          displayName: entry.displayName,
          address: entry.address,
          memberCount: assessment.memberCount,
          status: 'pending',
          addedBy: request.session!.account,
          addedAt: clock.now().toISOString(),
        }
        await stored(recipients.add(recipient))
        await record(request, { type: 'recipient.proposed', target: directoryId })
        return reply.code(201).send({ recipient: view(recipient), announcement: messages.passed(entry.displayName) })
      } catch (problem) {
        if (problem instanceof RecipientAlreadyListedError) return alreadyListed(problem.existing)
        if (problem instanceof StoreError) return saveFailed(request, reply)
        throw problem
      }
    },
  )

  /* IF-54 removes an active recipient at once (AC-6); IF-55 withdraws one waiting for approval. */
  const removal = (
    path: string,
    expected: Recipient['status'],
    event: 'recipient.removed' | 'recipient.withdrawn',
    wrongStatus: (name: string) => string,
    done: (name: string) => { announcement: string; confirmation?: string },
  ) =>
    app.delete<{ Params: { id: string } }>(
      path,
      {
        config: ROUTE_CONFIG,
        schema: {
          params: { type: 'object', required: ['id'], properties: { id: ID } },
          response: {
            200: announcementSchema,
            400: problemSchema,
            ...denials,
            404: problemSchema,
            409: problemSchema,
            503: problemSchema,
          },
        },
      },
      async (request, reply) => {
        try {
          const recipient = await stored(recipients.find(request.params.id))
          if (!recipient) return sendProblem(request, reply, 404)
          if (recipient.status !== expected) {
            return sendProblem(request, reply, 409, {
              type: '/problems/recipient-wrong-status',
              title: wrongStatus(recipient.displayName),
            })
          }
          await stored(recipients.remove(recipient.id))
          await record(request, { type: event, target: recipient.directoryId })
          return done(recipient.displayName)
        } catch (problem) {
          if (problem instanceof StoreError) return saveFailed(request, reply)
          throw problem
        }
      },
    )

  removal(
    '/api/v1/recipients/:id',
    'active',
    'recipient.removed',
    (name) => `${name} is waiting for approval; withdraw it instead.`,
    (name) => ({ announcement: messages.removed(name), confirmation: messages.removeConfirmation }),
  )
  removal(
    '/api/v1/recipients/:id/proposal',
    'pending',
    'recipient.withdrawn',
    (name) => `${name} is already active; remove it instead.`,
    (name) => ({ announcement: messages.withdrawn(name) }),
  )

  /* IF-56: the recipient audit trail (AC-10). */
  app.get(
    '/api/v1/recipients/audit',
    {
      config: ROUTE_CONFIG,
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['events'],
            properties: {
              events: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['type', 'account', 'target', 'at'],
                  properties: {
                    type: { type: 'string' },
                    account: { type: 'string' },
                    target: { type: 'string' },
                    outcome: { type: 'string' },
                    at: { type: 'string' },
                  },
                },
              },
            },
          },
          ...denials,
          503: problemSchema,
        },
      },
    },
    async (request, reply) => {
      let events: RecipientEvent[]
      try {
        events = await auditTrail.recipientEvents()
      } catch {
        return sendProblem(request, reply, 503, {
          type: '/problems/audit-unavailable',
          title: "Couldn't load the audit trail. Try again.",
        })
      }
      return {
        events: events.map(({ type, account, target, outcome, at }) => ({ type, account, target, outcome, at })),
      }
    },
  )
}
