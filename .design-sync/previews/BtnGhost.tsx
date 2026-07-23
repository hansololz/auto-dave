import React from 'react'
import { BtnGhost } from 'autowright'

const frame: React.CSSProperties = {
  background: 'var(--bg-window)', padding: 20, borderRadius: 10,
  width: 'fit-content', display: 'flex', gap: 14, alignItems: 'center',
}

// Bordered ghost button — secondary actions.
export const Default = () => (
  <div style={frame}>
    <BtnGhost onClick={() => {}}>View executions</BtnGhost>
  </div>
)

// Danger variant — red text for destructive actions.
export const Danger = () => (
  <div style={frame}>
    <BtnGhost danger onClick={() => {}}>Delete automation</BtnGhost>
  </div>
)

// Disabled — faded at .45 opacity.
export const Disabled = () => (
  <div style={frame}>
    <BtnGhost disabled>Duplicate</BtnGhost>
  </div>
)
