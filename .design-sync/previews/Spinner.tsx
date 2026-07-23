import React from 'react'
import { Spinner } from 'autowright'

const frame: React.CSSProperties = {
  background: 'var(--bg-window)', padding: 20, borderRadius: 10,
  width: 'fit-content', display: 'flex', gap: 14, alignItems: 'center',
}

// Default 16px and larger 24px accent spinner.
export const Sizes = () => (
  <div style={frame}>
    <Spinner size={16} />
    <Spinner size={24} />
  </div>
)

// Inline beside an executing label, cyan to match the executing status color.
export const InlineExecuting = () => (
  <div style={frame}>
    <Spinner size={16} color="var(--cyan)" />
    <span style={{ fontSize: 13, color: 'var(--text-2em)' }}>Executing “Weekly competitor price check”…</span>
  </div>
)
