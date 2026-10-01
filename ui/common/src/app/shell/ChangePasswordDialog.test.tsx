import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { configureMocks } from '@/mocks/handlers'
import { now, seed, setupPinnedSeed } from '@/test/pinnedSeed'
import { recordRequests, server } from '@/test/setup'
import { renderApp } from '@/test/renderApp'
import { copy as shell } from './copy'
import { passwordCopy as copy } from './passwordCopy'

setupPinnedSeed()
afterEach(() => configureMocks({ seed, now, loggedIn: true, variant: null, superuser: null }))

const T = { timeout: 5000 }
const STRONG = 'A-brand-new-password9'

async function open() {
  await userEvent.click(await screen.findByRole('button', { name: /^Account: / }, T))
  await userEvent.click(await screen.findByRole('menuitem', { name: shell.account.changePassword }))
  return screen.findByRole('dialog', { name: copy.title }, T)
}
async function fill(d: HTMLElement, current: string, next: string, confirm = next) {
  const set = async (label: string, v: string) => {
    const el = within(d).getByLabelText(label)
    await userEvent.clear(el)
    if (v) await userEvent.type(el, v)
  }
  await set(copy.current, current)
  await set(copy.next, next)
  await set(copy.confirm, confirm)
  await userEvent.click(within(d).getByRole('button', { name: copy.submit }))
}

describe('Change password (account menu)', () => {
  it("reports the policy's first broken rule on its field before sending", async () => {
    const rec = recordRequests()
    renderApp('/')
    const d = await open()
    expect(within(d).getByText(copy.policy(12, 64))).toBeInTheDocument()
    await fill(d, 'whatever', 'short')
    expect(await within(d).findByText(copy.problem.short(12))).toBeInTheDocument()
    await fill(d, 'whatever', STRONG, 'different')
    expect(await within(d).findByText(copy.mismatch)).toBeInTheDocument()
    rec.stop()
    expect(rec.urls.some((u) => u.pathname === '/api/auth/change-password')).toBe(false)
  })

  it('changes it, then a wrong current password lands on its field (403, never a sign-out)', async () => {
    const { router } = renderApp('/')
    await fill(await open(), 'whatever', STRONG)
    expect(await screen.findByText(copy.changed, {}, T)).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const d = await open()
    // A fresh dialog each time: nothing typed before survives.
    expect(within(d).getByLabelText(copy.current)).toHaveValue('')
    await fill(d, 'not-it', 'Another-password9')
    expect(await within(d).findByText('Current password is incorrect')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/')
  })

  it('an SSO account gets the server reason as a toast (409 no_local_password)', async () => {
    server.use(
      http.post('/api/auth/change-password', () =>
        HttpResponse.json(
          {
            error: 'this account signs in through your identity provider',
            code: 'no_local_password',
          },
          { status: 409 },
        ),
      ),
    )
    renderApp('/')
    await fill(await open(), 'whatever', STRONG)
    expect(
      await screen.findByText('This account signs in through your identity provider', {}, T),
    ).toBeInTheDocument()
  })

  it('a 204 (changed, no new session) signs out and says why on /login', async () => {
    server.use(
      http.post('/api/auth/change-password', () => {
        configureMocks({ loggedIn: false })
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const { router } = renderApp('/')
    await fill(await open(), 'whatever', STRONG)
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'), T)
    expect(router.state.location.search).toMatchObject({ password: 'changed' })
    expect(await screen.findByText(shell.login.passwordChanged)).toBeInTheDocument()
  })
})
