// §15 Electron e2e: two high-value flows over the real stack — renderer,
// preload bridge, backend.json discovery, HTTP + WS, real execution engine.
// The fake `claude` CLI (tests/bin, real detection code path) stands in for AI.
import { afterEach, describe, expect, it } from 'vitest'
import { Backend, closeApp, launchApp, shot, type AppHandle } from './harness'

describe('autowright e2e', () => {
  let backend: Backend | null = null
  let handle: AppHandle | null = null

  afterEach(async () => {
    await closeApp(handle)
    handle = null
    await backend?.stop()
    backend = null
  })

  it('empty home shows onboarding and detects the fake claude CLI', async () => {
    backend = await new Backend().start()
    handle = await launchApp(backend.home, false)
    const { page } = handle

    // Step 1: welcome + live self-check.
    await page.getByText('Step 1 of 3').waitFor({ timeout: 20_000 })
    await page.getByText('Recurring jobs, done exactly the same way every time.').waitFor()
    await page.getByText('Getting Autowright ready').waitFor()
    // Self-check finishes (~4 s of staged timers + real connected gate).
    const toConnect = page.getByRole('button', { name: 'Connect your AI →' })
    await toConnect.waitFor({ timeout: 30_000 })
    await shot(page, 'onboarding-step1.png')

    // Advance to step 2: real agent detection.
    await toConnect.click()
    await page.getByText('Step 2 of 3').waitFor({ timeout: 10_000 })
    await page.getByRole('heading', { name: 'Connect your AI' }).waitFor()
    // Detection spinner holds ≥1.9 s, then cards land.
    await page.getByText('FOUND ON THIS MAC').waitFor({ timeout: 20_000 })
    await page.getByText('Claude Code', { exact: true }).waitFor()
    // The fake CLI surfaced through the real detect path (`claude --version`).
    await page.getByText(/autowright test fake/).waitFor()
    // The automatic read-only connection check passes (fake `claude auth status`).
    await page.getByRole('button', { name: 'Continue with Claude Code →' }).waitFor({ timeout: 20_000 })
    await shot(page, 'onboarding-step2.png')

    // Never proceed further: suggestion-card "Set up …" buttons run real installs.
  }, 120_000)

  it('seeded home skips onboarding and executes an automation from the UI', async () => {
    backend = await new Backend().start()
    await backend.createAutomation('E2E automation')
    handle = await launchApp(backend.home, true)
    const { page } = handle

    // Straight to the app shell: the seeded row is on the automations list.
    await page.getByText('E2E automation').waitFor({ timeout: 20_000 })
    await page.getByRole('heading', { name: 'Automations' }).waitFor()
    expect(await page.getByText('Step 1 of 3').count()).toBe(0)
    await shot(page, 'automations-list.png')

    // Into the detail page, then execute for real.
    await page.getByText('E2E automation').click()
    const execBtn = page.getByRole('button', { name: 'Execute now' })
    await execBtn.waitFor({ timeout: 10_000 })
    await shot(page, 'automation-detail.png')
    await execBtn.click()

    // The execution runs through the real engine; the WS stream flips the
    // badge to Succeeded and lands the result chip in LATEST RESULT.
    await page.getByText('Succeeded').first().waitFor({ timeout: 60_000 })
    await page.getByText('All good').first().waitFor({ timeout: 20_000 })
    await shot(page, 'automation-detail-succeeded.png')
  }, 120_000)
})
