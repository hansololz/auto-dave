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
  runNow: (autoId: string, version?: string, trigger = 'Manual') =>
    req<{ execId: string }>('POST', `/automations/${autoId}/run`, { version, trigger }),
  cancelExec: (execId: string) => req('POST', `/executions/${execId}/cancel`),
  rerunExec: (execId: string) => req<{ execId: string }>('POST', `/executions/${execId}/rerun`),
  getExec: (execId: string) => req<import('./types').Exec>('GET', `/executions/${execId}`),
  getAuto: (autoId: string) => req<import('./types').Auto>('GET', `/automations/${autoId}`),
  patchAuto: (autoId: string, patch: Record<string, unknown>) =>
    req<import('./types').Auto>('PATCH', `/automations/${autoId}`, patch),
  deleteAuto: (autoId: string) => req('DELETE', `/automations/${autoId}`),
  clearMemory: (autoId: string) => req('POST', `/automations/${autoId}/memory/clear`),
  createAuto: (body: Record<string, unknown>) => req<import('./types').Auto>('POST', '/automations', body),
  saveVersion: (autoId: string, body: Record<string, unknown>) =>
    req<{ version: number }>('POST', `/automations/${autoId}/versions`, body),
  putDraft: (autoId: string, draft: unknown) => req('PUT', `/automations/${autoId}/draft`, { draft }),
  deleteDraft: (autoId: string) => req('DELETE', `/automations/${autoId}/draft`),
  restore: (autoId: string, v: number) => req<{ version: number }>('POST', `/automations/${autoId}/restore`, { v }),
  dryrun: (autoId: string, draft?: unknown, grants?: { enabledAgents: string[]; allowedSecrets: string[] }) =>
    req('POST', `/automations/${autoId}/dryrun`, { draft, ...(grants ?? {}) }),
  dryrunDraft: (draft: unknown, grants?: { enabledAgents: string[]; allowedSecrets: string[] }) =>
    req('POST', '/dryrun', { draft, ...(grants ?? {}) }),
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
  putSecret: (name: string, value: string) => req('PUT', `/secrets/${name}`, { value }),
  deleteSecret: (name: string) => req('DELETE', `/secrets/${name}`),
  patchSettings: (patch: Record<string, unknown>) =>
    req<import('./types').Settings>('PATCH', '/settings', patch),
  setDataPath: (path: string) => req<import('./types').Settings>('POST', '/settings/data-path', { path }),
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
