import React from 'react'
import { Eyebrow } from 'autowright'

// Section labels used across automation detail pages.
export const SectionLabels = () => (
  <div style={{ background: 'var(--bg-window)', padding: 20, borderRadius: 10, width: 'fit-content', display: 'flex', flexDirection: 'column', gap: 14 }}>
    <Eyebrow>Triggers</Eyebrow>
    <Eyebrow>Parameters</Eyebrow>
    <Eyebrow>Recent executions</Eyebrow>
  </div>
)

// Heading a section: eyebrow above content, as on the detail page.
export const AboveContent = () => (
  <div style={{ background: 'var(--bg-window)', padding: 20, borderRadius: 10, width: 320 }}>
    <Eyebrow style={{ marginBottom: 8 }}>Agents</Eyebrow>
    <div style={{ fontSize: 13, color: 'var(--text-2em)' }}>Claude Code — Default model</div>
  </div>
)
