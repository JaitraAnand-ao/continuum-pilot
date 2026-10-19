import type { Announcement } from './session/controller'

/* The page's one polite and one assertive live region. Both stay mounted so screen readers
 * register them before anything is announced; keying by id re-announces repeated text. */
export function LiveRegions({ announcement }: { announcement: Announcement | null }) {
  const polite = announcement?.politeness === 'polite' ? announcement : null
  const assertive = announcement?.politeness === 'assertive' ? announcement : null
  return (
    <div className="visually-hidden">
      <div role="status" aria-live="polite" aria-atomic="true" data-testid="live-polite">
        {polite && <span key={polite.id}>{polite.text}</span>}
      </div>
      <div aria-live="assertive" aria-atomic="true" data-testid="live-assertive">
        {assertive && <span key={assertive.id}>{assertive.text}</span>}
      </div>
    </div>
  )
}
