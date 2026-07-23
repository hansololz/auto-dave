import React from 'react'
import { PageTitle, BtnPrimary } from 'autowright'

// Plain page heading.
export const Plain = () => (
  <div style={{ background: 'var(--bg-window)', padding: 20, borderRadius: 10, width: 500 }}>
    <PageTitle style={{ marginBottom: 0 }}>Executions</PageTitle>
  </div>
)

// With right-slot action, as on the automations list page.
export const WithAction = () => (
  <div style={{ background: 'var(--bg-window)', padding: 20, borderRadius: 10, width: 500 }}>
    <PageTitle style={{ marginBottom: 0 }} right={<BtnPrimary>New automation</BtnPrimary>}>
      Automations
    </PageTitle>
  </div>
)
