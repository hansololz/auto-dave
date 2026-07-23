import React from 'react'
import { ConfirmModal } from 'autowright'

// ConfirmModal renders a position:fixed overlay. A sized, transformed wrapper
// (transform makes it the fixed-position containing block) frames it inside
// the card, over the app's dark window background.
const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{
    position: 'relative', transform: 'translateZ(0)', height: 320, width: '100%',
    background: 'var(--bg-window)', borderRadius: 10, overflow: 'hidden',
  }}>
    {children}
  </div>
)

// Destructive confirm (danger) — red-tinted confirm button.
export const DeleteAutomation = () => (
  <Frame>
    <ConfirmModal
      title="Delete this automation?"
      body="“Weekly competitor price check” and its 14 past executions will be removed. This cannot be undone."
      confirmLabel="Delete"
      danger
      onConfirm={() => {}}
      onCancel={() => {}}
    />
  </Frame>
)

// Non-destructive confirm — primary accent confirm button.
export const StopExecution = () => (
  <Frame>
    <ConfirmModal
      title="Stop the running execution?"
      body="The current step finishes its in-flight request, then the execution is marked cancelled."
      confirmLabel="Stop execution"
      onConfirm={() => {}}
      onCancel={() => {}}
    />
  </Frame>
)
