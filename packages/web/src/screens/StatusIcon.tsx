/* Statuses carry text plus an icon; the icon is decorative and hidden from assistive tech. */
export function StatusIcon({ tone }: { tone: 'error' | 'info' | 'progress' }) {
  const paths = {
    error: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1 5h2v7h-2V7Zm0 9h2v2h-2v-2Z',
    info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1 8h2v8h-2v-8Zm0-4h2v2h-2V6Z',
    progress: 'M12 2a10 10 0 1 0 10 10h-2a8 8 0 1 1-8-8V2Z',
  }
  return (
    <svg className={`status-icon status-icon--${tone}`} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path d={paths[tone]} />
    </svg>
  )
}
