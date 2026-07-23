import React from 'react'
import { RadioRing } from 'autowright'

const frame: React.CSSProperties = {
  background: 'var(--bg-window)', padding: 20, borderRadius: 10,
  width: 'fit-content', display: 'flex', gap: 14, alignItems: 'center',
}

// Selected vs unselected ring, side by side.
export const States = () => (
  <div style={frame}>
    <RadioRing selected={true} />
    <RadioRing selected={false} />
  </div>
)

// As used in a schedule-picker option list: one selected row, one not.
export const OptionRows = () => (
  <div style={{ ...frame, flexDirection: 'column', alignItems: 'stretch', gap: 12 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <RadioRing selected={true} />
      <span style={{ fontSize: 13, color: 'var(--text)' }}>Every weekday at 9:00</span>
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <RadioRing selected={false} />
      <span style={{ fontSize: 13, color: 'var(--text-2)' }}>Only when triggered manually</span>
    </div>
  </div>
)

// Larger 20px ring for prominent pickers.
export const Size20 = () => (
  <div style={frame}>
    <RadioRing selected={true} size={20} />
    <RadioRing selected={false} size={20} />
  </div>
)
