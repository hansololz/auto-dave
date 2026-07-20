// Executions list (§7): every execution across all automations, filter All / Succeeded / Failed.
import React, { useState } from 'react'
import { useStore } from '../store'
import { Badge, PageTitle } from '../ui'
import type { Exec } from '../types'

const FILTERS = ['All', 'Succeeded', 'Failed'] as const
type Filter = (typeof FILTERS)[number]

const GRID = '2fr 1.1fr .8fr .6fr 1fr'

const headCell: React.CSSProperties = {
  fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
  letterSpacing: '.09em', color: 'var(--text-faint)',
}

function Row({ e, onOpen }: { e: Exec; onOpen: () => void }) {
  return (
    <div
      className="ad-hover-row"
      onClick={onOpen}
      style={{
        display: 'grid', gridTemplateColumns: GRID, gap: 10, padding: '11px 18px',
        borderBottom: '1px solid var(--hairline-dim)', alignItems: 'center', cursor: 'pointer',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {e.autoName}
          </span>
          {e.autoDeleted && (
            <span style={{ fontSize: 12, color: 'var(--text-faint)', flex: 'none' }}>(deleted)</span>
          )}
        </div>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-faint)', marginTop: 2,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {e.id}
        </div>
      </div>
      <div>
        <Badge
          status={e.status}
          style={e.status === 'executing' ? { animation: 'adPulse 1.4s ease-in-out infinite' } : undefined}
        />
      </div>
      <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{e.trigger + (e.ver ? ' · ' + e.ver : '')}</span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-muted)' }}>{e.dur}</span>
      <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{e.started}</span>
    </div>
  )
}

export default function ExecutionsList() {
  const { execs, go } = useStore()
  const [filt, setFilt] = useState<Filter>('All')

  const shown = execs.filter((e) =>
    filt === 'All' ? true : filt === 'Succeeded' ? e.status === 'succeeded' : e.status === 'failed')

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '26px 30px 70px', animation: 'adFadeUp .4s ease' }}>
      <PageTitle
        right={
          <div style={{ display: 'inline-flex', border: '1px solid var(--border-input)', borderRadius: 8, overflow: 'hidden' }}>
            {FILTERS.map((f) => (
              <button
                key={f}
                className="ad-btn-text"
                onClick={() => setFilt(f)}
                style={{
                  padding: '6px 14px', fontSize: 12, fontWeight: 500, borderRadius: 0,
                  ...(filt === f ? { background: 'rgba(255,255,255,.08)', color: 'var(--text)' } : null),
                }}
              >
                {f}
              </button>
            ))}
          </div>
        }
      >
        Executions
      </PageTitle>

      {shown.length === 0 ? (
        <div style={{
          background: 'var(--bg-card)', border: '1px dashed rgba(255,255,255,.12)',
          borderRadius: 12, padding: 22, textAlign: 'center',
        }}>
          <div style={{ fontSize: 13.5, fontWeight: 500, marginBottom: 4 }}>
            {filt === 'All' ? 'No executions yet' : `No ${filt.toLowerCase()} executions`}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
            {filt === 'All'
              ? 'Execute an automation — every execution will appear right here.'
              : 'Executions matching this filter will appear here.'}
          </div>
        </div>
      ) : (
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{
            display: 'grid', gridTemplateColumns: GRID, gap: 10, padding: '10px 18px',
            borderBottom: '1px solid var(--hairline)',
          }}>
            <span style={headCell}>AUTOMATION</span>
            <span style={headCell}>STATUS</span>
            <span style={headCell}>TRIGGER</span>
            <span style={headCell}>DURATION</span>
            <span style={headCell}>STARTED</span>
          </div>
          {shown.map((e) => (
            <Row key={e.id} e={e} onOpen={() => go('execution', { execId: e.id })} />
          ))}
        </div>
      )}
    </div>
  )
}
