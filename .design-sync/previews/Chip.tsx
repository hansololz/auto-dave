import React from 'react'
import { Chip } from 'autowright'

// Default mono pills — schedule and parameter summaries.
export const ScheduleChips = () => (
  <div style={{ background: 'var(--bg-window)', padding: 20, borderRadius: 10, width: 'fit-content', display: 'flex', gap: 8, alignItems: 'center' }}>
    <Chip>Mon 09:00</Chip>
    <Chip>Every 2h</Chip>
    <Chip>1st of month</Chip>
  </div>
)

// Value summaries as shown on parameter rows.
export const ValueChips = () => (
  <div style={{ background: 'var(--bg-window)', padding: 20, borderRadius: 10, width: 'fit-content', display: 'flex', gap: 8, alignItems: 'center' }}>
    <Chip>12 links</Chip>
    <Chip>3 entries</Chip>
    <Chip>Not set</Chip>
  </div>
)

// Colored result chips — changes / ok / attention flavors.
export const ResultChips = () => (
  <div style={{ background: 'var(--bg-window)', padding: 20, borderRadius: 10, width: 'fit-content', display: 'flex', gap: 8, alignItems: 'center' }}>
    <Chip c="var(--accent)" bg="var(--accent-bg)">4 changes</Chip>
    <Chip c="var(--green)" bg="var(--green-bg)">All ok</Chip>
    <Chip c="var(--orange)" bg="var(--orange-bg)">Needs attention</Chip>
  </div>
)
