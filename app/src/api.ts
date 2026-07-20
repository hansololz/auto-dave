// Backend client (§19). Discovers port+token via preload (backend.json).
import type { DraftJob, StateSnapshot } from './types'

declare global {
  interface Window {
    autodave?: {
      backendInfo(): Promise<{ port: number; token: string } | null>
      openApp(hash: string): Promise<void>
      pickFolder(defaultPath?: string): Promise<string | null>
      resizePanel(h: number): Promise<void>
      revealPath(p: string): Promise<void>
      setLoginItem(on: boolean): Promise<void>
      trayAlert(on: boolean): Promise<void>
    }
  }
}

let base = ''
let token = ''

export async function connectInfo(): Promise<boolean> {
  const info = await window.autodave?.backendInfo()
  if (!info) return false
  base = `http://127.0.0.1:${info.port}`
  token = info.token
  return true
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) {
    let detail = ''
    try { detail = (await r.json()).detail } catch { /* ignore */ }
    throw Object.assign(new Error(detail || r.statusText), { status: r.status })
  }
  return r.json()
}

export const api = {
  state: () => req<StateSnapshot>('GET', '/state'),
  instructions: () => req<{ framework: string; defaultBuild: string }>('GET', '/instructions'),
  executeNow: (autoId: string, version?: string, trigger = 'Manual') =>
    req<{ execId: string }>('POST', `/automations/${autoId}/execute`, { version, trigger }),
  cancelExec: (execId: string) => req('POST', `/executions/${execId}/cancel`),
  // §7 in-place retry: same execution record, from the failed step
  retryExec: (execId: string) => req<{ execId: string }>('POST', `/executions/${execId}/retry`),
  // §7 skip: index must be the currently executing step (409 otherwise)
  skipStep: (execId: string, index: number) =>
    req('POST', `/executions/${execId}/skip-step`, { index }),
  getExec: (execId: string) => req<import('./types').Exec>('GET', `/executions/${execId}`),
  // §19 lazy logs: both params → that step attempt's file; neither → the execution log
  getExecLogs: (execId: string, step?: number, attempt?: number) =>
    req<{ lines: import('./types').LogLine[] }>('GET', `/executions/${execId}/logs`
      + (step !== undefined ? `?step=${step}&attempt=${attempt}` : '')),
  getAuto: (autoId: string) => req<import('./types').Auto>('GET', `/automations/${autoId}`),
  patchAuto: (autoId: string, patch: Record<string, unknown>) =>
    req<import('./types').Auto>('PATCH', `/automations/${autoId}`, patch),
  deleteAuto: (autoId: string) => req('DELETE', `/automations/${autoId}`),
  clearMemory: (autoId: string) => req('POST', `/automations/${autoId}/memory/clear`),
  // §6.3 memory snapshots
  createSnapshot: (autoId: string, name?: string) =>
    req<{ snapshot: import('./types').MemorySnapshot }>('POST', `/automations/${autoId}/memory/snapshots`, { name }),
  renameSnapshot: (autoId: string, sid: string, name: string | null) =>
    req<{ snapshot: import('./types').MemorySnapshot }>('PATCH', `/automations/${autoId}/memory/snapshots/${sid}`, { name }),
  restoreSnapshot: (autoId: string, sid: string) =>
    req('POST', `/automations/${autoId}/memory/snapshots/${sid}/restore`),
  deleteSnapshot: (autoId: string, sid: string) =>
    req('DELETE', `/automations/${autoId}/memory/snapshots/${sid}`),
  createAuto: (body: Record<string, unknown>) => req<import('./types').Auto>('POST', '/automations', body),
  saveVersion: (autoId: string, body: Record<string, unknown>) =>
    req<{ version: number }>('POST', `/automations/${autoId}/versions`, body),
  putDraft: (autoId: string, draft: unknown) => req('PUT', `/automations/${autoId}/draft`, { draft }),
  deleteDraft: (autoId: string) => req('DELETE', `/automations/${autoId}/draft`),
  // §4.4 pending create-mode slot (<root>/draft/)
  getPendingDraft: () =>
    req<{ draft: import('./types').DraftPayload | null; agentId: string | null }>('GET', '/draft'),
  putPendingDraft: (draft: unknown, agentId: string | null) => req('PUT', '/draft', { draft, agentId }),
  openPendingDraft: () => req('POST', '/draft/open'),
  deletePendingDraft: () => req('DELETE', '/draft'),
  restore: (autoId: string, v: number) => req<{ version: number }>('POST', `/automations/${autoId}/restore`, { v }),
  // §19 test: executes the sent draft's steps ephemerally; progress via test.* WS events
  postTest: (body: Record<string, unknown>) => req<{ testId: string }>('POST', '/tests', body),
  cancelTest: (testId: string) => req('DELETE', `/tests/${testId}`),
  // §6.2 declared packages: fast installed-check / blocking ensure (§19)
  checkPackages: (packages: { pip: string; import: string }[]) =>
    req<{ packages: import('./types').PackageDep[] }>('POST', '/packages/check', { packages }),
  installPackages: (packages: { pip: string; import: string }[]) =>
    req<{ packages: import('./types').PackageDep[] }>('POST', '/packages/install', { packages }),
  // §6.2 updates: read-only PyPI check / manifest-first pin rewrite + ensure (§19)
  outdatedPackages: (packages: { pip: string; import: string }[]) =>
    req<{ packages: import('./types').PackageDep[] }>('POST', '/packages/outdated', { packages }),
  updatePackages: (packages: { pip: string; import: string }[]) =>
    req<{ packages: import('./types').PackageDep[]; updated: string[] }>('POST', '/packages/update', { packages }),
  postDraftJob: (body: Record<string, unknown>) => req<{ jobId: string }>('POST', '/drafts', body),
  getDraftJob: (jobId: string) => req<DraftJob>('GET', `/drafts/${jobId}`),
  cancelDraftJob: (jobId: string) => req('DELETE', `/drafts/${jobId}`),
  agents: () => req<import('./types').Agent[]>('GET', '/agents'),
  addAgent: (body: Record<string, unknown>) => req<import('./types').Agent>('POST', '/agents', body),
  patchAgent: (id: string, body: Record<string, unknown>) => req('PATCH', `/agents/${id}`, body),
  deleteAgent: (id: string) => req('DELETE', `/agents/${id}`),
  checkAgent: (id: string) => req<{ status: string }>('POST', `/agents/${id}/check`),
  detectAgents: () => req<{ id: string; name: string; detail: string }[]>('GET', '/agents/detect'),
  ollamaStatus: () => req<{ ready: boolean; installed: boolean; models: string[] }>('GET', '/ollama/status'),
  ollamaPull: (model: string) => req('POST', '/ollama/pull', { model }),
  putSecret: (name: string, value: string, desc?: string) =>
    req('PUT', `/secrets/${name}`, desc === undefined ? { value } : { value, desc }),
  deleteSecret: (name: string) => req('DELETE', `/secrets/${name}`),
  patchSettings: (patch: Record<string, unknown>) =>
    req<import('./types').Settings>('PATCH', '/settings', patch),
  setDataPath: (path: string) => req<import('./types').Settings>('POST', '/settings/data-path', { path }),
  // Raw result-dir file (§4.5) — Response, not JSON: callers .text() or .blob() it.
  resultFile: async (execId: string, name: string): Promise<Response> => {
    const r = await fetch(`${base}/executions/${execId}/result/${encodeURIComponent(name)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!r.ok) throw new Error(r.statusText)
    return r
  },
}

export function openWs(onEvent: (msg: Record<string, unknown>) => void): () => void {
  let sock: WebSocket | null = null
  let closed = false
  const connect = () => {
    if (closed) return
    sock = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${token}`)
    sock.onmessage = (e) => onEvent(JSON.parse(e.data))
    sock.onclose = () => { if (!closed) setTimeout(connect, 1500) }
    sock.onopen = () => onEvent({ ev: 'ws.open' })
  }
  connect()
  return () => { closed = true; sock?.close() }
}
