import React from 'react'
import { BtnPrimary } from 'autowright'

const frame: React.CSSProperties = {
  background: 'var(--bg-window)', padding: 20, borderRadius: 10,
  width: 'fit-content', display: 'flex', gap: 14, alignItems: 'center',
}

// The accent-filled primary action.
export const Default = () => (
  <div style={frame}>
    <BtnPrimary onClick={() => {}}>Create automation</BtnPrimary>
  </div>
)

// Disabled — gray fill, faint text (e.g. nothing changed yet to save).
export const Disabled = () => (
  <div style={frame}>
    <BtnPrimary disabled>Save changes</BtnPrimary>
  </div>
)

// Beside a ghost cancel, as at the foot of an editor modal.
export const WithCancelRow = () => (
  <div style={frame}>
    <button className="ad-btn-ghost">Cancel</button>
    <BtnPrimary onClick={() => {}}>Save changes</BtnPrimary>
  </div>
)
