/* SCR-1 and shell copy, word for word from ST-1. */
export const APP_NAME = 'Entra Sign-In Reports'

export const pageTitle = (screen?: string) => (screen ? `${screen} – ${APP_NAME}` : APP_NAME)

export const COPY = {
  signIn: {
    title: 'Sign in',
    heading: 'Sign in',
    button: 'Sign in with Microsoft',
    personalDataLabel: 'Personal data',
    personalData:
      'Reports contain personal data. Only members of the reader group and report administrators can open them.',
    readOnly: 'This application is read-only.',
    entraAccount: "It uses your organization's Entra ID account.",
    signedOut: 'You have been signed out.',
    expired: 'Your session ended. Sign in again to continue.',
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
  signInError: {
    title: "Sign-in didn't complete",
    heading: "Sign-in didn't complete",
    nothingChanged: 'Nothing was changed.',
    code: 'Entra error code',
    reference: 'Error reference',
    time: 'Time (UTC)',
    tryAgain: 'Try again',
  },
  unavailable: {
    title: 'Service unavailable',
    heading: "We couldn't check your access",
    detail: 'Nothing was changed. Try again in a moment.',
    tryAgain: 'Try again',
  },
  signOut: {
    failed: "Sign-out didn't complete. Try again.",
  },
  shell: {
    navigation: 'Reports navigation',
    roles: 'Roles',
    accountMenu: 'Account menu',
    signOut: 'Sign out',
    noReaderRole: 'Your account holds the report administrator role. Reports need the reader role.',
  },
  idle: {
    title: 'Your session is about to end',
    body: (time: string) => `You will be signed out at ${time} unless you stay signed in.`,
    stay: 'Stay signed in',
    signOut: 'Sign out',
    stillSignedIn: "You're still signed in.",
  },
} as const

/** Ids of the elements that receive focus when a screen, dialog or menu opens, and of the widgets' parts. */
export const FOCUS = {
  signInButton: 'sign-in-button',
  signingIn: 'signing-in-heading',
  noAccess: 'no-access-heading',
  signInError: 'sign-in-error-heading',
  unavailable: 'unavailable-heading',
  main: 'main-heading',
  staySignedIn: 'stay-signed-in',
  idleSignOut: 'idle-sign-out',
  accountMenuButton: 'account-menu-button',
  accountMenu: 'account-menu',
  accountSignOut: 'account-sign-out',
} as const
