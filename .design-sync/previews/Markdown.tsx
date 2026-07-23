import React from 'react'
import { Markdown } from 'autowright'

const REPORT = `## Price changes detected

Two competitors moved prices since the last run:

- **Acme Pro** dropped from $49 to **$44** (-10%)
- **Zenith Basic** raised from $19 to $21

| Product | Old | New |
| --- | --- | --- |
| Acme Pro | $49 | $44 |
| Zenith Basic | $19 | $21 |

Next check runs \`Mon 09:00\`. See the [pricing page](https://example.com) for details.`

// The shared §4.5 renderer inside a result card (18px side padding assumed by .ad-md).
export const ResultReport = () => (
  <div style={{
    background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12,
    padding: '16px 18px', width: 460,
  }}>
    <Markdown text={REPORT} />
  </div>
)

// Code block + task list rendering.
export const CodeAndTasks = () => (
  <div style={{
    background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12,
    padding: '16px 18px', width: 460,
  }}>
    <Markdown text={'### Setup steps\n\n- [x] Install the CLI\n- [ ] Add the API token\n\n```\nnpm install -g autowright\nautowright login\n```'} />
  </div>
)
