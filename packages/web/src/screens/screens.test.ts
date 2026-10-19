import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { FOCUS, TEXT, type ViewState } from '../session/controller'
import { ADMIN_ONLY, NO_ACCESS, READER, READER_AND_ADMIN } from '../testing/fixtures'
import { all, byText, click, one, render, texts, type HostNode } from '../testing/tree'
import { View, type Actions } from './View'

const base: ViewState = {
  screen: { name: 'checking' },
  idleWarning: false,
  signOutFailed: false,
  title: '',
  announcement: null,
  focus: null,
  focusRequest: 0,
}

function actions(): { [K in keyof Actions]: ReturnType<typeof vi.fn> } & Actions {
  return {
    start: vi.fn(async () => undefined),
    signIn: vi.fn(),
    navigate: vi.fn(async () => undefined),
    staySignedIn: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    signInWithDifferentAccount: vi.fn(async () => undefined),
  }
}

function view(patch: Partial<ViewState>, handlers = actions()) {
  return { tree: render(createElement(View, { state: { ...base, ...patch }, actions: handlers })), handlers }
}

const buttons = (tree: HostNode[]) => texts(tree, 'button')
const paragraphs = (tree: HostNode[]) => texts(tree, 'p')
const liveText = (tree: HostNode[], politeness: string) =>
  one(tree, (node) => node.props['aria-live'] === politeness).text

describe('SCR-1 Sign in, signed out (AC-1)', () => {
  it('shows one Sign in with Microsoft button carrying the focus target', () => {
    const { tree, handlers } = view({ screen: { name: 'signIn', notice: null } })
    expect(buttons(tree)).toEqual(['Sign in with Microsoft'])
    const button = one(tree, byText('button', 'Sign in with Microsoft'))
    expect(button.props.id).toBe(FOCUS.signInButton)
    click(button)
    expect(handlers.signIn).toHaveBeenCalledTimes(1)
  })

  it('states the personal-data notice, read-only and Entra ID lines', () => {
    const { tree } = view({ screen: { name: 'signIn', notice: null } })
    expect(paragraphs(tree)).toEqual([
      'The reports contain personal data. Only the reader group and report administrators can open them.',
      'This application is read-only.',
      "It uses your organization's Entra ID account.",
    ])
  })

  it('shows why the session ended when it did', () => {
    const { tree } = view({ screen: { name: 'signIn', notice: TEXT.sessionEnded } })
    expect(paragraphs(tree)[0]).toBe('Your session ended. Sign in again to continue.')
  })
})

describe('SCR-1 checking access (AC-4)', () => {
  it('reads Signing you in… Checking your access with Microsoft Entra ID. and announces politely', () => {
    const { tree } = view({
      screen: { name: 'checking' },
      announcement: { politeness: 'polite', text: TEXT.checking, id: 1 },
    })
    const main = one(tree, (node) => node.type === 'main')
    expect(main.text).toBe('Signing you in…Checking your access with Microsoft Entra ID.')
    expect(main.props['aria-busy']).toBe('true')
    expect(liveText(tree, 'polite')).toBe('Signing you in')
    expect(liveText(tree, 'assertive')).toBe('')
  })
})

describe('SCR-1 denied (AC-5)', () => {
  const denied = { screen: { name: 'denied', message: NO_ACCESS.title } as const }

  it('heads with You don’t have access and names the account with the server’s title verbatim', () => {
    const { tree } = view({ ...denied, announcement: { politeness: 'assertive', text: NO_ACCESS.title, id: 2 } })
    const heading = one(tree, (node) => node.type === 'h1')
    expect(heading.text).toBe("You don't have access")
    expect(heading.props.id).toBe(FOCUS.deniedHeading)
    expect(heading.props.tabIndex).toBe(-1)
    expect(paragraphs(tree)).toEqual([
      "You don't have access. Signed in as j.smith@contoso.com.",
      'Ask your Entra administrator to add you to the reader group.',
    ])
    expect(liveText(tree, 'assertive')).toBe(NO_ACCESS.title)
  })

  it('offers Sign in with a different account and Sign out, and wires both', () => {
    const { tree, handlers } = view(denied)
    expect(buttons(tree)).toEqual(['Sign in with a different account', 'Sign out'])
    click(one(tree, byText('button', 'Sign in with a different account')))
    click(one(tree, byText('button', 'Sign out')))
    expect(handlers.signInWithDifferentAccount).toHaveBeenCalledTimes(1)
    expect(handlers.signOut).toHaveBeenCalledTimes(1)
  })

  it('shows no report data', () => {
    const { tree } = view(denied)
    expect(all(tree, (node) => node.type === 'nav' || node.type === 'table')).toEqual([])
  })

  it('says when sign-out did not complete', () => {
    const { tree } = view({ ...denied, signOutFailed: true })
    expect(paragraphs(tree)).toContain(TEXT.signOutFailed)
  })
})

describe('SCR-1 sign-in failed (AC-6)', () => {
  const failure = { code: 'AADSTS50105', reference: '7f3c2a91', occurredAt: '2026-10-19 08:00:05 UTC' }

  it('shows the Entra code, that nothing changed, a copyable reference and UTC time, and Try again', () => {
    const { tree, handlers } = view({ screen: { name: 'failed', failure } })
    const heading = one(tree, (node) => node.type === 'h1')
    expect(heading.text).toBe("Sign-in didn't complete")
    expect(heading.props.id).toBe(FOCUS.failedHeading)
    expect(paragraphs(tree)).toEqual(['Microsoft Entra ID returned error AADSTS50105.', 'Nothing was changed.'])
    expect(texts(tree, 'dt')).toEqual(['Error reference', 'Time (UTC)'])
    expect(texts(tree, 'code')).toEqual(['AADSTS50105', '7f3c2a91', '2026-10-19 08:00:05 UTC'])
    click(one(tree, byText('button', 'Try again')))
    expect(handlers.signIn).toHaveBeenCalledTimes(1)
  })

  it('says when the callback carried no reference or time', () => {
    const { tree } = view({ screen: { name: 'failed', failure: { ...failure, reference: null, occurredAt: null } } })
    expect(texts(tree, 'dd')).toEqual(['Not provided', 'Not provided'])
  })
})

describe('access check unavailable', () => {
  it('shows the trace id and Try again checks again', () => {
    const { tree, handlers } = view({ screen: { name: 'unavailable', traceId: 'abc123' } })
    expect(one(tree, (node) => node.type === 'h1').text).toBe("Can't check your access right now")
    expect(texts(tree, 'code')).toEqual(['abc123'])
    click(one(tree, byText('button', 'Try again')))
    expect(handlers.start).toHaveBeenCalledTimes(1)
  })

  it('shows no reference when the server gave none', () => {
    const { tree } = view({ screen: { name: 'unavailable', traceId: null } })
    expect(texts(tree, 'code')).toEqual([])
  })
})

describe('signed-in frame', () => {
  const app = (me = READER, path = '/reports/daily') => ({ screen: { name: 'app', me, path } as const })

  it('a reader lands on the Daily report heading, which takes focus (AC-2)', () => {
    const { tree } = view(app())
    const heading = one(tree, (node) => node.type === 'h1')
    expect(heading.text).toBe('Daily report')
    expect(heading.props.id).toBe(FOCUS.pageHeading)
    expect(heading.props.tabIndex).toBe(-1)
  })

  it('the side navigation shows only the REPORTS group for a reader (AC-2)', () => {
    const { tree } = view(app())
    const nav = one(tree, (node) => node.type === 'nav')
    expect(texts([nav], 'h2')).toEqual(['REPORTS'])
    expect(texts([nav], 'a')).toEqual(['Daily report', 'Suspicious activity', 'Report history'])
    expect(nav.text).not.toContain('SETTINGS')
    expect(one([nav], byText('a', 'Daily report')).props['aria-current']).toBe('page')
    expect(one([nav], byText('a', 'Report history')).props['aria-current']).toBeUndefined()
  })

  it('following a navigation link stays in the app', () => {
    const { tree, handlers } = view(app())
    click(one(tree, byText('a', 'Suspicious activity')))
    expect(handlers.navigate).toHaveBeenCalledWith('/reports/suspicious')
  })

  it('the top bar names the reader role', () => {
    const { tree } = view(app())
    expect(one(tree, (node) => node.props.className === 'top-bar__roles').text).toBe('Reader')
  })

  it('the top bar names both roles for an account holding both claims (AC-3)', () => {
    const { tree } = view(app(READER_AND_ADMIN))
    expect(one(tree, (node) => node.props.className === 'top-bar__roles').text).toBe('Reader · Report administrator')
    expect(one(tree, (node) => node.type === 'h1').text).toBe('Daily report')
  })

  it('an administrator without the reader role sees no report page and no REPORTS group', () => {
    const { tree } = view(app(ADMIN_ONLY))
    expect(one(tree, (node) => node.type === 'h1').text).toBe("This page isn't available")
    expect(texts(tree, 'a')).toEqual([])
  })

  it('the account menu names the account and offers Sign out (AC-9)', () => {
    const { tree, handlers } = view(app())
    const menu = one(tree, (node) => node.type === 'details')
    expect(texts([menu], 'summary')).toEqual(['m.duarte@contoso.com'])
    click(one([menu], byText('button', 'Sign out')))
    expect(handlers.signOut).toHaveBeenCalledTimes(1)
  })

  it('the account menu says when sign-out did not complete', () => {
    const { tree } = view({ ...app(), signOutFailed: true })
    expect(paragraphs(tree)).toContain(TEXT.signOutFailed)
  })
})

describe('idle warning dialog (AC-9)', () => {
  const warning = {
    screen: { name: 'app', me: READER, path: '/reports/daily' } as const,
    idleWarning: true,
    announcement: { politeness: 'assertive', text: TEXT.idleWarning, id: 3 } as const,
  }

  it('offers Stay signed in, which takes focus, and is announced assertively once', () => {
    const { tree, handlers } = view(warning)
    const dialog = one(tree, (node) => node.props.role === 'dialog')
    expect(dialog.props['aria-modal']).toBe('true')
    expect(one([dialog], (node) => node.type === 'h2').text).toBe('Are you still there?')
    const stay = one([dialog], byText('button', 'Stay signed in'))
    expect(stay.props.id).toBe(FOCUS.staySignedIn)
    click(stay)
    expect(handlers.staySignedIn).toHaveBeenCalledTimes(1)
    expect(liveText(tree, 'assertive')).toBe(TEXT.idleWarning)
    expect(all(tree, (node) => node.props.role === 'alertdialog')).toEqual([])
  })

  it('offers Sign out', () => {
    const { tree, handlers } = view(warning)
    const dialog = one(tree, (node) => node.props.role === 'dialog')
    click(one([dialog], byText('button', 'Sign out')))
    expect(handlers.signOut).toHaveBeenCalledTimes(1)
  })

  it('is absent until the warning is due', () => {
    const { tree } = view({ ...warning, idleWarning: false })
    expect(all(tree, (node) => node.props.role === 'dialog')).toEqual([])
  })
})
