import React from 'react'
import { Badge } from 'autowright'

// Every execution status the app renders (§4.6 vocabulary).
export const AllStatuses = () => (
  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
    <Badge status="queued" />
    <Badge status="executing" />
    <Badge status="succeeded" />
    <Badge status="failed" />
    <Badge status="cancelled" />
    <Badge status="skipped" />
    <Badge status="interrupted" />
    <Badge status="none" />
  </div>
)

// As used on an automation card row: title left, status right.
export const OnCardRow = () => (
  <div style={{
    background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12,
    padding: '14px 18px', width: 420, display: 'flex', alignItems: 'center', gap: 12,
  }}>
    <div style={{ fontSize: 13.5, fontWeight: 600, flex: 1 }}>Weekly competitor price check</div>
    <Badge status="succeeded" />
  </div>
)
