import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { AUDIT_EVENT_TYPES, RECIPIENT_KINDS, RECIPIENT_STATUSES, emailRecipients } from '../schema.js'

describe('email recipient schema (ST-18)', () => {
  it('stores each recipient with its type, member count, status, who added it and who approved it', () => {
    const config = getTableConfig(emailRecipients)
    expect(config.name).toBe('email_recipient')
    expect(config.columns.map((c) => c.name).sort()).toEqual(
      [
        'added_by_name',
        'added_by_oid',
        'address',
        'approved_at',
        'approved_by_name',
        'approved_by_oid',
        'display_name',
        'entra_object_id',
        'id',
        'kind',
        'member_count',
        'proposed_at',
        'status',
      ].sort(),
    )
    expect(config.columns.filter((c) => c.primary).map((c) => c.name)).toEqual(['id'])
    expect(
      config.columns
        .filter((c) => !c.notNull)
        .map((c) => c.name)
        .sort(),
    ).toEqual(['approved_at', 'approved_by_name', 'approved_by_oid', 'member_count'])
  })

  it('guards the type, the member count, the status, the address and four-eyes with CHECK constraints', () => {
    expect(
      getTableConfig(emailRecipients)
        .checks.map((c) => c.name)
        .sort(),
    ).toEqual(
      [
        'email_recipient_address_shape',
        'email_recipient_approval_after_proposal',
        'email_recipient_approver_is_not_proposer',
        'email_recipient_kind_known',
        'email_recipient_member_count_matches_kind',
        'email_recipient_status_known',
        'email_recipient_status_matches_approval',
      ].sort(),
    )
  })

  it('lists a directory object once and indexes the status the mail worker filters on', () => {
    const config = getTableConfig(emailRecipients)
    const unique = config.indexes.filter((i) => i.config.unique).map((i) => i.config.name)
    expect(unique).toEqual(['email_recipient_entra_object_id_key'])
    expect(config.indexes.map((i) => i.config.name)).toContain('email_recipient_status_idx')
  })

  it('names a person and a group, the two statuses, and the recipient audit events', () => {
    expect(RECIPIENT_KINDS).toEqual(['person', 'group'])
    expect(RECIPIENT_STATUSES).toEqual(['pending_approval', 'active'])
    expect(AUDIT_EVENT_TYPES).toEqual([
      'access_denied',
      'recipient.check_passed',
      'recipient.check_rejected',
      'recipient.check_failed',
      'recipient.proposed',
      'recipient.removed',
    ])
  })
})
