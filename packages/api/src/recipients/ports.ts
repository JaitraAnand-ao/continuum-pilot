/* The ports the recipient routes depend on. The graph-adapter implements DirectoryPort (IF-58 search and lookup,
 * IF-59 transitive group members, IF-60 transitive reader-group membership); CMP-5 implements RecipientStore. */
import type { GroupMember, RecipientKind, RecipientStatus } from './rules.js'

export type { GroupMember } from './rules.js'

export interface DirectoryEntry {
  id: string
  kind: RecipientKind
  displayName: string
  address: string
}

export interface DirectoryPort {
  search(text: string): Promise<DirectoryEntry[]>
  entry(id: string): Promise<DirectoryEntry | undefined>
  /* Every person in the group, through nested groups. */
  groupMembers(groupId: string): Promise<GroupMember[]>
  /* The subset of the given people who are members of the reader group, directly or through nesting. */
  readersAmong(personIds: readonly string[]): Promise<ReadonlySet<string>>
}

export class DirectoryUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DirectoryUnavailableError'
  }
}

export interface Recipient {
  id: string
  directoryId: string
  kind: RecipientKind
  displayName: string
  address: string
  memberCount: number | null
  status: RecipientStatus
  /* The administrator's account. */
  addedBy: string
  addedAt: string
}

/* Raised by add when the directory id is already listed, so two simultaneous additions cannot both land. */
export class RecipientAlreadyListedError extends Error {
  constructor(readonly existing: Recipient) {
    super('recipient already listed')
    this.name = 'RecipientAlreadyListedError'
  }
}

export interface RecipientStore {
  list(): Promise<Recipient[]>
  find(id: string): Promise<Recipient | undefined>
  findByDirectoryId(directoryId: string): Promise<Recipient | undefined>
  add(recipient: Recipient): Promise<void>
  remove(id: string): Promise<void>
}

export class InMemoryRecipientStore implements RecipientStore {
  protected readonly rows = new Map<string, Recipient>()

  async list(): Promise<Recipient[]> {
    return [...this.rows.values()].map((row) => ({ ...row }))
  }

  async find(id: string): Promise<Recipient | undefined> {
    const row = this.rows.get(id)
    return row && { ...row }
  }

  async findByDirectoryId(directoryId: string): Promise<Recipient | undefined> {
    const row = [...this.rows.values()].find((one) => one.directoryId === directoryId)
    return row && { ...row }
  }

  async add(recipient: Recipient): Promise<void> {
    const existing = [...this.rows.values()].find((one) => one.directoryId === recipient.directoryId)
    if (existing) throw new RecipientAlreadyListedError({ ...existing })
    this.rows.set(recipient.id, { ...recipient })
  }

  async remove(id: string): Promise<void> {
    this.rows.delete(id)
  }
}

export const METRIC_NAMESPACE = 'SigninReports'

export interface Metric {
  namespace: typeof METRIC_NAMESPACE
  name: 'RecipientCheckFailed'
  value: number
  dimensions: Record<string, string>
  timestamp: string
}

/* Metrics for the CloudWatch alarms (CMP-11): RecipientCheckFailed raises the recipient-check failure alarm (AC-5). */
export interface MetricsPort {
  put(metric: Metric): Promise<void>
}

export class InMemoryMetrics implements MetricsPort {
  readonly metrics: Metric[] = []
  async put(metric: Metric): Promise<void> {
    this.metrics.push(metric)
  }
}
