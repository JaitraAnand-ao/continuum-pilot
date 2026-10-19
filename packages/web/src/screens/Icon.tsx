/* Status icons that always sit beside text, so no state relies on the icon or on colour alone. */
const PATHS = {
  shield: 'M12 2 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5z',
  blocked:
    'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM5 12a7 7 0 0 1 11.2-5.6L6.4 16.2A7 7 0 0 1 5 12zm7 7a7 7 0 0 1-4.2-1.4l9.8-9.8A7 7 0 0 1 12 19z',
  warning: 'M12 2 1 21h22zm-1 7h2v6h-2zm0 8h2v2h-2z',
  clock: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 5h-2v6l5 3 1-1.7-4-2.3z',
} as const

export function Icon({ name }: { name: keyof typeof PATHS }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="24" height="24" className="icon">
      <path d={PATHS[name]} fill="currentColor" />
    </svg>
  )
}
