import React from 'react'
import { ProgressBar } from 'autowright'

const frame: React.CSSProperties = {
  background: 'var(--bg-window)', padding: 20, borderRadius: 10,
  width: 'fit-content', display: 'flex', flexDirection: 'column', gap: 8,
}

// Execution roughly a third through its steps.
export const Pct35 = () => (
  <div style={frame}>
    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Step 2 of 6 — Fetching competitor pages</div>
    <div style={{ width: 320 }}>
      <ProgressBar pct={35} />
    </div>
  </div>
)

// Near-complete execution.
export const Pct80 = () => (
  <div style={frame}>
    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Step 5 of 6 — Writing summary</div>
    <div style={{ width: 320 }}>
      <ProgressBar pct={80} />
    </div>
  </div>
)
