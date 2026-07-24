// §15 e2e harness: one real backend subprocess (isolated tmp AUTOWRIGHT_HOME,
// fake `claude` CLI on PATH) plus one real Electron app per test. Mirrors
// tests/integration/it_harness.py on the Node side.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createConnection } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const APP_DIR = path.resolve(HERE, '..')
export const REPO = path.resolve(HERE, '..', '..')
export const ARTIFACTS = path.join(HERE, 'artifacts')

const PYTHON = path.join(REPO, '.venv', 'bin', 'python')
const FAKE_BIN = path.join(REPO, 'tests', 'bin')

// ---------- generic polling (no fixed sleeps) ----------

export async function waitFor<T>(
  fn: () => Promise<T | null | false | undefined>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown = null
  while (Date.now() < deadline) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) { lastErr = e }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`timed out waiting for ${what}${lastErr ? ` (last error: ${String(lastErr)})` : ''}`)
}

function tcpOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port }, () => {
      sock.destroy()
      resolve(true)
    })
    sock.setTimeout(1000, () => { sock.destroy(); resolve(false) })
    sock.on('error', () => resolve(false))
  })
}

// ---------- backend ----------

export class Backend {
  home = ''
  port = 0
  token = ''
  private proc: ChildProcess | null = null
  private out = ''

  /** Fresh tmp home + real `python -m autowright.main`, ready to answer. */
  async start(): Promise<this> {
    this.home = await mkdtemp(path.join(os.tmpdir(), 'aw-e2e-'))
    this.proc = spawn(PYTHON, ['-m', 'autowright.main'], {
      env: {
        ...process.env,
        AUTOWRIGHT_HOME: this.home,
        PATH: `${FAKE_BIN}:${process.env.PATH ?? ''}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.proc.stdout?.on('data', (d: Buffer) => { this.out += d.toString() })
    this.proc.stderr?.on('data', (d: Buffer) => { this.out += d.toString() })

    const info = await waitFor(async () => {
      const raw = await readFile(path.join(this.home, 'backend.json'), 'utf-8').catch(() => null)
      if (!raw) return null
      const j = JSON.parse(raw) as { port: number; token: string; pid: number }
      return (await tcpOpen(j.port)) ? j : null
    }, 20_000, `backend.json + open port (output so far:\n${this.out.slice(-2000)})`)
    this.port = info.port
    this.token = info.token
    return this
  }

  async api(method: string, route: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`http://127.0.0.1:${this.port}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (!res.ok) throw new Error(`${method} ${route} -> ${res.status}: ${await res.text()}`)
    return res.json()
  }

  /** Seed one automation over the real HTTP API (it_harness.make_draft shape). */
  async createAutomation(name: string): Promise<{ id: string }> {
    const draft = {
      desc: 'Runs end to end through the real stack.',
      note: 'Created',
      params: [],
      steps: [
        {
          file: '01-say.py', name: 'Say', desc: 'prints',
          code: 'log("e2e says hi")\n',
        },
        {
          file: '02-finish.py', name: 'Finish', desc: 'result',
          code: 'result.status("ok")\nresult.chip("All good")\nresult.value("Summary", "done")\n',
        },
      ],
      spec: [{ k: 'h1', text: 'E2E automation' }, { k: 'p', text: 'It runs end to end.' }],
      instr: null,
    }
    return await this.api('POST', '/automations', { draft, name }) as { id: string }
  }

  async stop(): Promise<void> {
    if (this.proc && this.proc.exitCode === null) {
      const gone = new Promise<void>((r) => this.proc!.once('exit', () => r()))
      this.proc.kill('SIGKILL')
      await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))])
    }
    this.proc = null
    if (this.home) await rm(this.home, { recursive: true, force: true }).catch(() => {})
  }
}

// ---------- electron ----------

export interface AppHandle {
  app: ElectronApplication
  page: Page
}

/** Launch the built app against `home`'s backend.json and pin the renderer's
 * `ad-onboarded` flag. The profile lives inside the tmp home (§15), so a fresh
 * home starts clean — pinning just keeps each test's precondition explicit. */
export async function launchApp(home: string, onboarded: boolean): Promise<AppHandle> {
  const require = createRequire(import.meta.url)
  const app = await _electron.launch({
    args: ['.'],
    cwd: APP_DIR,
    executablePath: require('electron') as unknown as string,
    env: { ...process.env, AUTOWRIGHT_HOME: home } as Record<string, string>,
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate((flag: boolean) => {
    localStorage.clear()
    if (flag) localStorage.setItem('ad-onboarded', '1')
  }, onboarded)
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

export async function closeApp(h: AppHandle | null): Promise<void> {
  if (!h) return
  try {
    await Promise.race([h.app.close(), new Promise((r) => setTimeout(r, 5000))])
  } finally {
    try { h.app.process().kill('SIGKILL') } catch { /* already gone */ }
  }
}

export async function shot(page: Page, name: string): Promise<void> {
  await mkdir(ARTIFACTS, { recursive: true })
  await page.screenshot({ path: path.join(ARTIFACTS, name) }).catch(() => {})
}
