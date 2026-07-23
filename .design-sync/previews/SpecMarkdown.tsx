import React from 'react'
import { SpecMarkdown } from 'autowright'

// SpecBlock (app/src/types.ts) — the type itself is not re-exported by ds-entry.
type SpecBlock = { k: 'h1' | 'h2' | 'p' | 'li'; text: string }

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: 'var(--bg-window)', padding: 20, borderRadius: 10, width: 500 }}>
    {children}
  </div>
)

const FULL_SPEC: SpecBlock[] = [
  { k: 'h1', text: 'Weekly competitor price check' },
  { k: 'p', text: 'Every Monday at 09:00, open each tracked competitor pricing page and record the listed plan prices.' },
  { k: 'h2', text: 'Steps' },
  { k: 'li', text: 'Open the pricing page for each tracked competitor' },
  { k: 'li', text: 'Extract plan names and monthly prices' },
  { k: 'li', text: 'Compare against last week and flag changes over 5%' },
  { k: 'h2', text: 'Output' },
  { k: 'p', text: 'A markdown table of price changes, attached to the execution result.' },
]

// Full spec card: h1, intro paragraph, two h2 sections, adjacent li list.
export const FullSpec = () => (
  <Frame>
    <SpecMarkdown blocks={FULL_SPEC} />
  </Frame>
)

const DRAFT_SPEC: SpecBlock[] = [
  { k: 'h1', text: 'Inbox triage digest' },
  { k: 'li', text: 'Collect unread support emails from the shared inbox' },
  { k: 'li', text: 'Group them by product area and urgency' },
  { k: 'li', text: 'Post a digest to the team channel before 08:30' },
]

// Draft spec straight from the create flow: title plus a bare step list.
export const DraftSpec = () => (
  <Frame>
    <SpecMarkdown blocks={DRAFT_SPEC} />
  </Frame>
)
