import React from 'react'
import { GreenCheck } from 'autowright'

const frame: React.CSSProperties = {
  background: 'var(--bg-window)', padding: 20, borderRadius: 10,
  width: 'fit-content', display: 'flex', gap: 14, alignItems: 'center',
}

// Confirmation after a dry check completes.
export const DryCheckPassed = () => (
  <div style={frame}>
    <GreenCheck label="Dry check passed" />
  </div>
)

// Save confirmation on the automation editor.
export const Saved = () => (
  <div style={frame}>
    <GreenCheck label="Saved" />
  </div>
)
