import React from 'react'
import { Logo } from 'autowright'

// Default header size.
export const Sizes = () => (
  <div style={{ background: 'var(--bg-window)', padding: 20, borderRadius: 10, width: 'fit-content', display: 'flex', gap: 16, alignItems: 'center' }}>
    <Logo size={26} />
    <Logo size={48} />
  </div>
)

// As in the app header: logo beside the wordmark.
export const WithWordmark = () => (
  <div style={{ background: 'var(--bg-window)', padding: 20, borderRadius: 10, width: 'fit-content', display: 'flex', gap: 10, alignItems: 'center' }}>
    <Logo size={26} />
    <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', letterSpacing: '-.01em' }}>Autowright</span>
  </div>
)
