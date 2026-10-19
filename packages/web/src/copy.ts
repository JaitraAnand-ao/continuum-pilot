/* SCR-1 and shell copy for ST-1, exactly as the story words it. */
export const APP_NAME = 'Entra Sign-In Reports'

export const pageTitle = (page: string): string => `${page} – ${APP_NAME}`

export const copy = {
  signIn: {
    heading: APP_NAME,
    button: 'Sign in with Microsoft',
    personalData: 'These reports contain personal data. Only the reader group and report administrators can open them.',
    readOnly: 'This application is read-only.',
    entraAccount: "It uses your organization's Entra ID account.",
    signedOut: 'You are signed out.',
    expired: 'Your session ended. Sign in again to continue.',
    title: 'Sign in',
  },
  checking: {
    heading: 'Signing you in…',
    detail: 'Checking your access with Microsoft Entra ID.',
    announcement: 'Signing you in',
    title: 'Signing you in',
  },
  noAccess: {
    heading: "You don't have access",
    fallback: "You don't have access.",
    askAdmin: 'Ask your Entra administrator to add you to the reader group.',
    differentAccount: 'Sign in with a different account',
    signOut: 'Sign out',
    title: 'No access',
  },
  failed: {
    heading: "Sign-in didn't complete",
    errorCode: (code: string): string => `Microsoft Entra ID returned error code ${code}.`,
    nothingChanged: 'Nothing was changed.',
    reference: 'Error reference',
    time: 'Time (UTC)',
    notProvided: 'Not provided',
    tryAgain: 'Try again',
    title: "Sign-in didn't complete",
  },
  unavailable: {
    heading: "We couldn't check your access",
    detail: 'The dashboard could not reach the sign-in service. Nothing was changed.',
    tryAgain: 'Try again',
    title: 'Sign-in unavailable',
  },
  shell: {
    roles: 'Roles',
    reader: 'Reader',
    administrator: 'Report administrator',
    accountMenu: 'Account menu',
    signOut: 'Sign out',
    navLabel: 'Main',
    reportsGroup: 'REPORTS',
    dailyReport: 'Daily report',
    suspiciousActivity: 'Suspicious activity',
    reportHistory: 'Report history',
    home: APP_NAME,
  },
  idle: {
    heading: 'Your session is about to end',
    detail: 'You have been inactive. Select Stay signed in to keep working, or you will be signed out.',
    announcement: 'Your session is about to end. Select Stay signed in to keep working.',
    stay: 'Stay signed in',
    signOut: 'Sign out',
  },
} as const
