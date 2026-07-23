import React from 'react'
import { Toast } from 'autowright'

// Toast is position:fixed at the viewport bottom. The transformed wrapper
// becomes its containing block, so it pins to the frame bottom instead.
const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{
    position: 'relative', transform: 'translateZ(0)', height: 160, width: '100%',
    background: 'var(--bg-window)', borderRadius: 10, overflow: 'hidden',
  }}>
    {children}
  </div>
)

// Short confirmation toast after a save.
export const Saved = () => (
  <Frame>
    <Toast msg="Automation saved" />
  </Frame>
)

// The 409 one-execution-at-a-time toast — longest message the app shows.
export const AlreadyExecuting = () => (
  <Frame>
    <Toast msg="Already executing — one execution at a time. A trigger firing now would be skipped." />
  </Frame>
)
