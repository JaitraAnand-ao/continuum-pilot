/* Every status pairs its text with an icon; the icon is decorative and hidden from assistive tech. */

export type StatusKind = 'info' | 'warning' | 'locked' | 'error'

const PATHS: Record<StatusKind, string> = {
  info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 15h-2v-6h2v6Zm0-8h-2V7h2v2Z',
  warning: 'M1 21h22L12 2 1 21Zm12-3h-2v-2h2v2Zm0-4h-2v-4h2v4Z',
  locked:
    'M17 9h-1V7a4 4 0 0 0-8 0v2H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2Zm-7-2a2 2 0 1 1 4 0v2h-4V7Z',
  error: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 15h-2v-2h2v2Zm0-4h-2V7h2v6Z',
}

export function StatusIcon({ kind }: { kind: StatusKind }) {
  return (
    <svg className={`status-icon status-icon--${kind}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={PATHS[kind]} fill="currentColor" />
    </svg>
  )
}
