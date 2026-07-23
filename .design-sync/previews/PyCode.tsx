import React from 'react'
import { PyCode } from 'autowright'

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: 'var(--bg-window)', padding: 20, borderRadius: 10, width: 520 }}>
    {children}
  </div>
)

const preStyle: React.CSSProperties = {
  font: '400 11.5px/1.7 var(--mono)', color: 'var(--text-2em)',
  background: 'var(--bg-code)', borderRadius: 8, padding: '10px 14px',
}

const STEP_SCRIPT = `import asyncio
from playwright.async_api import Page

CHECK_URL = "https://competitor.example.com/pricing"

@step("Open pricing page")
async def run(page: Page, params: dict) -> dict:
    # Wait for the pricing table before scraping rows
    await page.goto(CHECK_URL, timeout=30_000)
    rows = await page.locator("table.pricing tr").all()
    return {"rows": len(rows), "ok": len(rows) > 2}`

// Automation step script: import, decorator, def, strings, comment, numbers.
export const StepScript = () => (
  <Frame>
    <PyCode code={STEP_SCRIPT} style={preStyle} />
  </Frame>
)

const TRANSFORM_SNIPPET = `import json

def summarize(results: list[dict]) -> str:
    # Keep only plans whose price moved since last week
    changed = [r for r in results if r["delta_pct"] != 0.0]
    return json.dumps(changed, indent=2)`

// Shorter transform helper: builtins, comprehension, floats, True/False-free.
export const TransformSnippet = () => (
  <Frame>
    <PyCode code={TRANSFORM_SNIPPET} style={preStyle} />
  </Frame>
)
