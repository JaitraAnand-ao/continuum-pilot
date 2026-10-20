/* A directory standing in for the graph-adapter behind IF-58, IF-59 and IF-60: people, distribution groups,
 * groups nested in groups, and the reader group whose transitive members may receive the daily email. */
import {
  DirectoryUnavailableError,
  type DirectoryEntry,
  type DirectoryPort,
  type GroupMember,
} from '../../src/recipients/ports.js'

export class FakeDirectory implements DirectoryPort {
  readonly entries = new Map<string, DirectoryEntry>()
  /* Direct members of each group, people or groups, by id. */
  readonly members = new Map<string, string[]>()
  readerGroupId = 'g-readers'
  failing = false
  readonly searches: string[] = []

  person(id: string, displayName: string, address = `${displayName}@contoso.com`): this {
    this.entries.set(id, { id, kind: 'person', displayName, address })
    return this
  }

  group(id: string, displayName: string, address: string, memberIds: string[]): this {
    this.entries.set(id, { id, kind: 'group', displayName, address })
    this.members.set(id, memberIds)
    return this
  }

  addToReaders(...ids: string[]): this {
    this.members.set(this.readerGroupId, [...(this.members.get(this.readerGroupId) ?? []), ...ids])
    return this
  }

  #guard(): void {
    if (this.failing) throw new DirectoryUnavailableError('directory lookup failed')
  }

  #transitivePeople(groupId: string, seen = new Set<string>()): Set<string> {
    const people = new Set<string>()
    if (seen.has(groupId)) return people
    seen.add(groupId)
    for (const id of this.members.get(groupId) ?? []) {
      if (this.members.has(id)) for (const nested of this.#transitivePeople(id, seen)) people.add(nested)
      else people.add(id)
    }
    return people
  }

  async search(text: string): Promise<DirectoryEntry[]> {
    this.#guard()
    this.searches.push(text)
    const needle = text.toLowerCase()
    return [...this.entries.values()].filter(
      (entry) => entry.displayName.toLowerCase().includes(needle) || entry.address.toLowerCase().includes(needle),
    )
  }

  async entry(id: string): Promise<DirectoryEntry | undefined> {
    this.#guard()
    return this.entries.get(id)
  }

  async groupMembers(groupId: string): Promise<GroupMember[]> {
    this.#guard()
    return [...this.#transitivePeople(groupId)].map((id) => ({ id, address: this.entries.get(id)?.address ?? id }))
  }

  async readersAmong(personIds: readonly string[]): Promise<ReadonlySet<string>> {
    this.#guard()
    const readers = this.#transitivePeople(this.readerGroupId)
    return new Set(personIds.filter((id) => readers.has(id)))
  }
}
