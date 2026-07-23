import React from 'react'
import { Modal, BtnGhost, BtnPrimary } from 'autowright'

// Modal renders a fixed dimmed backdrop + centered card. The transformed
// wrapper contains the overlay inside the cell.
const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{
    position: 'relative', transform: 'translateZ(0)', height: 360, width: '100%',
    background: 'var(--bg-window)', borderRadius: 10, overflow: 'hidden',
  }}>
    {children}
  </div>
)

// Small dialog composed via the (close) render function: title, body, actions.
export const SkipNextRun = () => (
  <Frame>
    <Modal onClose={() => {}} width={420}>
      {(close) => (
        <div style={{ padding: 22 }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Skip the next scheduled run?</div>
          <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-muted)', marginBottom: 18 }}>
            “Weekly competitor price check” is scheduled for Monday 09:00. Skipping affects only that
            run — the schedule stays on and resumes the following week.
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <BtnGhost onClick={close}>Cancel</BtnGhost>
            <BtnPrimary onClick={close}>Skip next run</BtnPrimary>
          </div>
        </div>
      )}
    </Modal>
  </Frame>
)

// Wider dialog: assign an agent before the first execution.
export const AssignAgent = () => (
  <Frame>
    <Modal onClose={() => {}} width={460}>
      {(close) => (
        <div style={{ padding: 22 }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Assign an agent</div>
          <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-muted)', marginBottom: 18 }}>
            This automation has no agent yet. Executions run on the assigned agent’s harness and
            model; you can change it later from the automation page.
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <BtnGhost onClick={close}>Not now</BtnGhost>
            <BtnPrimary onClick={close}>Choose agent</BtnPrimary>
          </div>
        </div>
      )}
    </Modal>
  </Frame>
)
