import React from 'react'
import { FailureNotice } from 'autowright'

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: 'var(--bg-window)', padding: 20, borderRadius: 10, width: 500 }}>
    {children}
  </div>
)

// Full diagnostics: failing step, classified reason, mono error, View link.
export const StepFailureWithReason = () => (
  <Frame>
    <FailureNotice
      error={{
        step: 'Open pricing page',
        reason: 'The page took longer than 30s to load.',
        message: 'TimeoutError: page.goto: Timeout 30000ms exceeded\n  navigating to "https://competitor.example.com/pricing", waiting until "load"',
      }}
      onView={() => {}}
    />
  </Frame>
)

// Minimal: no step, no classified reason — just the raw error message.
export const MinimalFailure = () => (
  <Frame>
    <FailureNotice
      error={{
        step: null,
        reason: null,
        message: 'RuntimeError: agent process exited with code 137 before reporting a result',
      }}
    />
  </Frame>
)
