/* ST-18: who may receive the daily email. Pure: the directory answers who the members and readers are,
 * these functions decide and word the outcome (AC-1 to AC-4, AC-6 to AC-9). */
export type RecipientKind = 'person' | 'group'
export type RecipientStatus = 'active' | 'pending'

export interface GroupMember {
  id: string
  address: string
}

export type Assessment =
  | { verdict: 'eligible'; memberCount: number | null }
  | { verdict: 'not-reader' }
  | { verdict: 'empty-group' }
  | { verdict: 'group-outsiders'; memberCount: number; outsiders: string[] }

export type Verdict = Assessment['verdict']

/* A person passes when the directory reports them a member of the reader group, directly or through nesting (AC-2, AC-3). */
export function assessPerson(personId: string, readers: ReadonlySet<string>): Assessment {
  return readers.has(personId) ? { verdict: 'eligible', memberCount: null } : { verdict: 'not-reader' }
}

/* A group passes only when every member is a reader; one outsider rejects it (AC-4). A group of nobody reaches nobody. */
export function assessGroup(members: readonly GroupMember[], readers: ReadonlySet<string>): Assessment {
  const unique = new Map(members.map((member) => [member.id, member.address]))
  if (unique.size === 0) return { verdict: 'empty-group' }
  const outsiders = [...unique]
    .filter(([id]) => !readers.has(id))
    .map(([, address]) => address)
    .sort()
  return outsiders.length === 0
    ? { verdict: 'eligible', memberCount: unique.size }
    : { verdict: 'group-outsiders', memberCount: unique.size, outsiders }
}

const members = (count: number) => `${count} ${count === 1 ? 'member' : 'members'}`

export function typeText(kind: RecipientKind, memberCount: number | null): string {
  return kind === 'person' ? 'Person' : `Group with ${members(memberCount ?? 0)}`
}

export function checkText(kind: RecipientKind, memberCount: number | null): string {
  if (kind === 'person') return 'In the reader group'
  return memberCount === 1 ? 'Its 1 member' : `All ${members(memberCount ?? 0)}`
}

export function statusText(status: RecipientStatus): string {
  return status === 'active' ? 'Active' : 'Waiting for approval'
}

/* An active recipient is removed at once; one waiting for approval is withdrawn (AC-1, AC-6). */
export function actionLabel(status: RecipientStatus, displayName: string, address: string): string {
  return `${status === 'active' ? 'Remove' : 'Withdraw'} ${displayName}, ${address}`
}

export const messages = {
  passed: (name: string) => `${name} passed the check and was sent for approval; no email until approved`,
  notReader: (name: string) =>
    `${name} isn't in the reader group, so they can't receive reports. Ask your Entra administrator to add them first.`,
  outsiders: (name: string, count: number, total: number) =>
    `${name} has ${count} of ${total} members outside the reader group`,
  emptyGroup: (name: string) => `${name} has no members, so nobody would receive the email.`,
  checkFailed: (name: string | undefined) =>
    `Couldn't check the reader group, so ${name ?? 'the recipient'} wasn't added. Try again later.`,
  alreadyListed: (name: string) => `${name} is already a recipient.`,
  removed: (name: string) => `${name} removed. They won't get tomorrow's email`,
  withdrawn: (name: string) => `${name} withdrawn. No approval is needed now`,
  removeConfirmation: "They won't get tomorrow's email",
  saveFailed: "Couldn't save. The recipient list is unchanged.",
  nobody: 'Nobody receives the daily email',
  stillGenerated: 'Reports are still generated in the dashboard.',
  adminOnly: 'Only report administrators can manage recipients.',
} as const
