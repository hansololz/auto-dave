// Unit tests for src/store.ts — the real zustand store, with the api module
// mocked so refresh/loadExec never hit the network. window.autowright is
// stubbed BEFORE the dynamic import so the module-level onOpenTarget hook
// registers against our capture.
//
// Note: autoIdFromHash and navSame are module-private (not exported), so they
// are exercised through their observable behavior — the onOpenTarget deep-link
// callback and history.pushState dedupe — instead of direct calls.
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { Exec, LogLine } from '../src/types'

vi.mock('../src/api', () => ({
  connectInfo: vi.fn(async () => false),
  openWs: vi.fn(() => () => {}),
  api: {
    state: vi.fn(() => Promise.reject(new Error('offline'))),
    getExec: vi.fn(() => Promise.reject(new Error('offline'))),
    getExecLogs: vi.fn(() => Promise.reject(new Error('offline'))),
    getAuto: vi.fn(() => Promise.reject(new Error('offline'))),
  },
}))

let store: typeof import('../src/store')
let openTarget: ((hash: string) => void) | undefined

beforeAll(async () => {
  ;(window as unknown as Record<string, unknown>).autowright = {
    onOpenTarget: (cb: (hash: string) => void) => { openTarget = cb },
    trayAlert: () => Promise.resolve(),
  }
  store = await import('../src/store')
})

const ex = (id: string, startedMs: number, over: Partial<Exec> = {}): Exec => ({
  id, autoId: 'a1', autoName: 'Auto', autoDeleted: false, ver: 'v1',
  status: 'succeeded', trigger: 'Manual', test: false, dur: '1s',
  started: 'now', startedMs, note: null, error: null, ...over,
})
const line = (seq: number, text = 'line'): LogLine => ({ t: '00:00', k: 'out', seq, text })

beforeEach(() => {
  store.useStore.setState({
    surface: 'app', page: 'automations', autoId: null, execId: null, createFrom: null,
    autos: [], execs: [], execFull: {}, execLogs: {}, toast: null,
  })
})
afterEach(() => vi.useRealTimers())

describe('logKey', () => {
  it('null step → the execution log bucket', () => {
    expect(store.logKey(null, null)).toBe('x.0')
    expect(store.logKey(null, 3)).toBe('x.0')
  })
  it('step + attempt select the attempt file, attempt defaults to 1', () => {
    expect(store.logKey(2, 3)).toBe('2.3')
    expect(store.logKey(0, null)).toBe('0.1')
  })
})

describe('autoIdFromHash (via the onOpenTarget deep link)', () => {
  it('a valid 36-char uuid in the hash navigates to the automation', () => {
    expect(openTarget).toBeTypeOf('function')
    openTarget!('#/app?auto=123e4567-e89b-12d3-a456-426614174000')
    const m = store.useStore.getState()
    expect(m.page).toBe('automation')
    expect(m.autoId).toBe('123e4567-e89b-12d3-a456-426614174000')
  })
  it('missing or malformed auto id does not navigate', () => {
    openTarget!('#/app')
    expect(store.useStore.getState().page).toBe('automations')
    openTarget!('#/app?auto=SHORT')
    expect(store.useStore.getState().page).toBe('automations')
    openTarget!('#/app?auto=123E4567-E89B-12D3-A456-426614174000') // uppercase → no match
    expect(store.useStore.getState().page).toBe('automations')
  })
})

describe('navSame (via history.pushState dedupe)', () => {
  it('identical nav snapshots push exactly once; any changed field pushes again', () => {
    const spy = vi.spyOn(history, 'pushState')
    const m = store.useStore.getState()
    m.go('executions')
    const base = spy.mock.calls.length
    m.go('executions')                       // same page + same ids → deduped
    expect(spy.mock.calls.length).toBe(base)
    m.go('executions', { execId: 'e1' })     // execId differs → pushes
    expect(spy.mock.calls.length).toBe(base + 1)
    m.go('execution', { execId: 'e1' })      // page differs → pushes
    expect(spy.mock.calls.length).toBe(base + 2)
    m.go('execution', { execId: 'e1', autoId: 'a9' }) // autoId differs → pushes
    expect(spy.mock.calls.length).toBe(base + 3)
    spy.mockRestore()
  })
})

describe('applyEvent', () => {
  it('exec.started inserts and re-sorts by startedMs desc, replacing an existing id', () => {
    store.useStore.setState({ execs: [ex('e1', 100), ex('e2', 50)] })
    const m = store.useStore.getState()
    m.applyEvent({ ev: 'exec.started', exec_json: ex('e3', 200, { status: 'executing' }) })
    expect(store.useStore.getState().execs.map((e) => e.id)).toEqual(['e3', 'e1', 'e2'])
    store.useStore.getState().applyEvent({ ev: 'exec.started', exec_json: ex('e2', 300) })
    expect(store.useStore.getState().execs.map((e) => e.id)).toEqual(['e2', 'e3', 'e1'])
  })

  it('exec.finished header merge preserves an already-loaded full body', () => {
    const full: Exec = {
      ...ex('e1', 100, { status: 'executing' }),
      steps: [{ name: 's1', status: 'succeeded', dur: '1s', attempts: [] }],
      result: { chip: 'done' },
    }
    store.useStore.setState({ execs: [ex('e1', 100, { status: 'executing' })], execFull: { e1: full } })
    store.useStore.getState().applyEvent({
      ev: 'exec.finished',
      exec_json: ex('e1', 100, { status: 'failed', test: true }), // header: no steps/result
    })
    const got = store.useStore.getState().execFull.e1
    expect(got.status).toBe('failed')
    expect(got.steps).toEqual(full.steps)     // body kept through the merge
    expect(got.result).toEqual(full.result)
  })

  it('exec.log dedupes by seq against the bucket tail, gaps accepted', () => {
    store.useStore.setState({ execLogs: { e9: { 'x.0': [line(5)] } } })
    const m = store.useStore.getState()
    m.applyEvent({ ev: 'exec.log', execId: 'e9', stepIndex: null, attempt: null, line: line(5) })
    expect(store.useStore.getState().execLogs.e9['x.0']).toHaveLength(1)
    store.useStore.getState().applyEvent({ ev: 'exec.log', execId: 'e9', stepIndex: null, attempt: null, line: line(4) })
    expect(store.useStore.getState().execLogs.e9['x.0']).toHaveLength(1)
    store.useStore.getState().applyEvent({ ev: 'exec.log', execId: 'e9', stepIndex: null, attempt: null, line: line(7) })
    expect(store.useStore.getState().execLogs.e9['x.0'].map((l) => l.seq)).toEqual([5, 7])
    // no bucket open → the line is dropped, not crashed on
    store.useStore.getState().applyEvent({ ev: 'exec.log', execId: 'nope', stepIndex: null, attempt: null, line: line(1) })
    expect(store.useStore.getState().execLogs.nope).toBeUndefined()
  })

  it('exec.finished toasts a summary for real executions', () => {
    vi.useFakeTimers()
    store.useStore.getState().applyEvent({
      ev: 'exec.finished',
      exec_json: ex('e5', 1, { status: 'succeeded' }),
      auto_json: { name: 'My Auto', resultChip: '3 changes' },
    })
    expect(store.useStore.getState().toast).toBe('My Auto finished — 3 changes.')
    vi.runAllTimers()
    expect(store.useStore.getState().toast).toBeNull()

    store.useStore.getState().applyEvent({
      ev: 'exec.finished',
      exec_json: ex('e6', 2, { status: 'failed' }),
      auto_json: { name: 'My Auto', resultChip: null },
    })
    expect(store.useStore.getState().toast).toBe('My Auto failed — needs attention.')
    vi.runAllTimers()
  })

  it('toast suppressed for test executions and for cancelled status', () => {
    vi.useFakeTimers()
    store.useStore.getState().applyEvent({
      ev: 'exec.finished',
      exec_json: ex('e7', 3, { status: 'succeeded', test: true }),
      auto_json: { name: 'My Auto', resultChip: null },
    })
    expect(store.useStore.getState().toast).toBeNull()
    store.useStore.getState().applyEvent({
      ev: 'exec.finished',
      exec_json: ex('e8', 4, { status: 'cancelled' }),
      auto_json: { name: 'My Auto', resultChip: null },
    })
    expect(store.useStore.getState().toast).toBeNull()
  })
})
