import type { Announcement } from '../session/controller'

/* Both regions stay mounted so screen readers track them; only the one matching the
 * announcement's politeness carries its text. */
export function LiveRegion({ announcement }: { announcement: Announcement | null }) {
  const text = (politeness: Announcement['politeness']) =>
    announcement !== null && announcement.politeness === politeness ? announcement.text : ''
  return (
    <div className="visually-hidden">
      <div role="status" aria-live="polite" aria-atomic="true" data-testid="live-polite">
        {text('polite')}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="true" data-testid="live-assertive">
        {text('assertive')}
      </div>
    </div>
  )
}
