import React from 'react'
import { MiniBadge } from 'autowright'

// Default gray geometry — ad-hoc labels on automation rows.
export const Default = () => (
  <div style={{ background: 'var(--bg-window)', padding: 20, borderRadius: 10, width: 'fit-content', display: 'flex', gap: 10, alignItems: 'center' }}>
    <MiniBadge>Draft</MiniBadge>
    <MiniBadge>OFF</MiniBadge>
    <MiniBadge>NOT SET</MiniBadge>
  </div>
)

// Colored variants — palette pairs used across the app.
export const Colored = () => (
  <div style={{ background: 'var(--bg-window)', padding: 20, borderRadius: 10, width: 'fit-content', display: 'flex', gap: 10, alignItems: 'center' }}>
    <MiniBadge c="var(--accent)" bg="var(--accent-bg)">Draft</MiniBadge>
    <MiniBadge c="var(--green)" bg="var(--green-bg)">Ready</MiniBadge>
    <MiniBadge c="var(--amber)" bg="var(--amber-bg)">Paused</MiniBadge>
    <MiniBadge c="var(--red)" bg="var(--red-bg)">Failed</MiniBadge>
  </div>
)

// Inline next to an automation title, as on a list row.
export const InRow = () => (
  <div style={{ background: 'var(--bg-window)', padding: 20, borderRadius: 10, width: 'fit-content', display: 'flex', gap: 12, alignItems: 'center' }}>
    <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>Daily standup digest</span>
    <MiniBadge c="var(--accent)" bg="var(--accent-bg)">Draft</MiniBadge>
  </div>
)
