/* SCR-1 copy, word for word from ST-1's acceptance criteria. */

export const APP_NAME = 'Entra Sign-In Reports'

export const pageTitle = (screen: string): string => `${screen} – ${APP_NAME}`

export const COPY = {
  signIn: {
    title: 'Sign in',
    button: 'Sign in with Microsoft',
    personalData: 'Reports contain personal data. Only the reader group and report administrators can open them.',
    readOnly: 'This application is read-only.',
    entraAccount: "It uses your organization's Entra ID account.",
  },
  signingIn: {
    title: 'Signing in',
    heading: 'Signing you in…',
    detail: 'Checking your access with Microsoft Entra ID.',
    announcement: 'Signing you in',
  },
  noAccess: {
    title: 'No access',
    heading: "You don't have access",
    askAdministrator: 'Ask your Entra administrator to add you to the reader group.',
    differentAccount: 'Sign in with a different account',
    signOut: 'Sign out',
  },
  failed: {
    title: "Sign-in didn't complete",
    heading: "Sign-in didn't complete",
    errorCode: 'Microsoft Entra ID returned error code',
    nothingChanged: 'Nothing was changed.',
    reference: 'Error reference',
    time: 'Time (UTC)',
    tryAgain: 'Try again',
  },
  unavailable: {
    title: "Couldn't check access",
    heading: "We couldn't check your access",
    detail: "The sign-in service didn't answer. Nothing was changed.",
    tryAgain: 'Try again',
  },
  shell: {
    accountMenu: 'Account',
    signedInAs: 'Signed in as',
    roles: 'Roles',
    signOut: 'Sign out',
  },
  idle: {
    heading: 'Your session is about to end',
    detail: (time: string) =>
      `You haven't used the dashboard for a while. You will be signed out at ${time} UTC unless you stay signed in.`,
    staySignedIn: 'Stay signed in',
    signOut: 'Sign out',
  },
} as const
