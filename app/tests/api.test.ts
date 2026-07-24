// Tests for src/api.ts request plumbing. `req` is module-private, so it is
// exercised through the thin api.* wrappers (api.state, api.executeNow) with
// global fetch stubbed. Discovery reads window.autowright.backendInfo() —
// stubbed before connectInfo() is called, which fills the module-level
// base/token used by every request.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, connectInfo } from '../src/api'

const setBackendInfo = (info: { port: number; token: string } | null) => {
  ;(window as unknown as Record<string, unknown>).autowright = {
    backendInfo: async () => info,
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('connectInfo', () => {
  it('returns false when the preload has no backend info', async () => {
    setBackendInfo(null)
    expect(await connectInfo()).toBe(false)
  })
  it('returns true and stores port + token', async () => {
    setBackendInfo({ port: 4242, token: 'tok' })
    expect(await connectInfo()).toBe(true)
  })
})

describe('req (via api.state / api.executeNow)', () => {
  beforeEach(async () => {
    setBackendInfo({ port: 4242, token: 'tok' })
    await connectInfo()
  })

  it('ok path: GET hits base+path with the bearer token and returns the JSON', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: '1.0' }),
    }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    const s = await api.state()
    expect(s).toEqual({ version: '1.0' })
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4242/state', {
      method: 'GET',
      headers: { Authorization: 'Bearer tok' },
      body: undefined,
    })
  })

  it('a body adds Content-Type and JSON-serializes', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ execId: 'e1' }),
    }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    await api.executeNow('a1')
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4242/automations/a1/execute', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: undefined, trigger: 'Manual' }),
    })
  })

  it('error with a JSON {detail} body → Error message is the detail, .status attached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 404, statusText: 'Not Found',
      json: async () => ({ detail: 'automation not found' }),
    }) as unknown as Response))
    const err = await api.state().then(() => null, (e: Error & { status?: number }) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toBe('automation not found')
    expect(err!.status).toBe(404)
  })

  it('error with a non-JSON body falls back to statusText', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 500, statusText: 'Internal Server Error',
      json: async () => { throw new Error('not json') },
    }) as unknown as Response))
    const err = await api.state().then(() => null, (e: Error & { status?: number }) => e)
    expect(err!.message).toBe('Internal Server Error')
    expect(err!.status).toBe(500)
  })

  it('error with JSON but empty detail also falls back to statusText', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 409, statusText: 'Conflict',
      json: async () => ({}),
    }) as unknown as Response))
    const err = await api.state().then(() => null, (e: Error & { status?: number }) => e)
    expect(err!.message).toBe('Conflict')
    expect(err!.status).toBe(409)
  })
})
