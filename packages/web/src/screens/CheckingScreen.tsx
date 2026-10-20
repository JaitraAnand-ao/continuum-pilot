/* SCR-1, back from Microsoft while /api/v1/me answers (AC-4). The polite announcement is the
 * live region's job, so this text is not itself live. */
export function CheckingScreen() {
  return (
    <main className="sign-in" aria-busy="true">
      <h1>Signing you in…</h1>
      <p>Checking your access with Microsoft Entra ID.</p>
    </main>
  )
}
