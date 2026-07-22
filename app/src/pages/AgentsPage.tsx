// Agents page (§4.7, §12): agent cards with session-cached connection checks,
// check/make-default/remove via row menu.
import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { useStore, type AgentCheck } from '../store'
import type { Agent } from '../types'
import { BtnGhost, BtnPrimary, ConfirmModal, Eyebrow, MenuRow, menuStyle, MiniBadge, P, PageTitle, Spinner, usePopover, dispModel } from '../ui'
import { openAgentEdit } from './AgentNewPage'


function AgentCard({ ag, check, onDelete }: {
  ag: Agent; check: AgentCheck | undefined; onDelete: (ag: Agent) => void
}) {
  const { autos, go, showToast, runAgentCheck } = useStore()
  const [menuOpen, setMenuOpen, menuRef] = usePopover()
  const checking = check === 'checking' || check === undefined
  const connecting = check === 'connecting'
  const ready = check === 'ready'
  const badge = checking
    ? { label: 'Checking', c: P.cyan, bg: P.cyanBg }
    : connecting
      ? { label: 'Connecting', c: P.cyan, bg: P.cyanBg }
      : ready
        ? { label: 'Ready', c: P.green, bg: P.greenBg }
        : { label: 'Needs setup', c: P.amber, bg: P.amberBg }
  const uses = ag.usedBy ?? []

  const makeDefault = async () => {
    try {
      await api.patchAgent(ag.id, { default: true })
      showToast(`${ag.name || ag.harness} is now the default — new automations use it.`)
    } catch (e) { showToast((e as Error).message) }
  }

  // §12 "Check connection" — a real, timed check that refreshes the cached badge.
  const recheck = async () => {
    const t0 = performance.now()
    const st = await runAgentCheck(ag.id)
    const secs = ((performance.now() - t0) / 1000).toFixed(1)
    showToast(st === 'ready'
      ? `${ag.name || ag.harness} answered in ${secs} s — ready.`
      : `${ag.name || ag.harness} didn't answer — needs setup.`)
  }

  return (
    <div style={{
      background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12,
      padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, fontSize: 15 }}>{ag.name || ag.harness}</span>
        <MiniBadge c={badge.c} bg={badge.bg}>{badge.label}</MiniBadge>
      </div>
      <div style={{ font: `500 11.5px var(--mono)`, color: 'var(--text-faint)', marginTop: -5 }}>
        {ag.harness} · {dispModel(ag)}
      </div>
      {/* Detail line = the §4.7 desc (drafting input) — never generated copy. */}
      <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: ag.desc?.trim() ? 'var(--text-2)' : 'var(--text-faint)' }}>
        {ag.desc?.trim() ? ag.desc : 'No description yet — add one in Edit to tell the drafting AI what this agent is for.'}
      </p>
      {uses.length > 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Eyebrow>USED BY</Eyebrow>
          {uses.map((u) => {
            const auto = autos.find((a) => a.name === u)
            return (
              <button
                key={u}
                className="ad-chip-btn"
                onClick={() => { if (auto) go('automation', { autoId: auto.id }) }}
                style={{ cursor: auto ? 'pointer' : 'default' }}
              >
                {u}
              </button>
            )
          })}
        </div>
      ) : (
        <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>Not used by any automation yet.</div>
      )}
      {checking || connecting ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <Spinner size={13} />
          <span style={{ fontWeight: 500, fontSize: 12.5, color: 'var(--text-2)' }}>
            {connecting ? 'Reconnecting…' : 'Checking locally…'}
          </span>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {!ready && (
            // Needs setup — accent-primary Edit opens the form with the reconnect banner (§12).
            <BtnPrimary onClick={() => { openAgentEdit(ag, true); go('agentNew') }} style={{ flex: 'none' }}>
              Edit
            </BtnPrimary>
          )}
          {ready && (
            <BtnGhost onClick={() => { openAgentEdit(ag, false); go('agentNew') }}>
              Edit
            </BtnGhost>
          )}
          <div ref={menuRef} style={{ position: 'relative' }}>
            <button
              className="ad-btn-ghost"
              onClick={() => setMenuOpen(!menuOpen)}
              title="More actions"
              style={{ padding: '8px 10px' }}
            >
              <i className="fa-solid fa-ellipsis" style={{ fontSize: 12 }} />
            </button>
            {menuOpen && (
              <div style={{ ...menuStyle, top: 'calc(100% + 6px)', left: 0, minWidth: 190 }}>
                {ready && (
                  <MenuRow onClick={() => { setMenuOpen(false); void recheck() }}>
                    <i className="fa-solid fa-plug" style={{ fontSize: 11, width: 14, textAlign: 'center', marginRight: 9 }} />
                    Check connection
                  </MenuRow>
                )}
                {ready && !ag.default && (
                  <MenuRow onClick={() => { setMenuOpen(false); void makeDefault() }}>
                    <i className="fa-solid fa-star" style={{ fontSize: 11, width: 14, textAlign: 'center', marginRight: 9 }} />
                    Make default
                  </MenuRow>
                )}
                <MenuRow danger onClick={() => { setMenuOpen(false); onDelete(ag) }}>
                  <i className="fa-solid fa-trash-can" style={{ fontSize: 11, width: 14, textAlign: 'center', marginRight: 9 }} />
                  Remove agent…
                </MenuRow>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default function AgentsPage() {
  const { agents, agentChecks, go, showToast } = useStore()
  const [delAgent, setDelAgent] = useState<Agent | null>(null)

  // §12 session cache: only agents with no cached status get checked, with a
  // small stagger. The cache entry is claimed synchronously (StrictMode
  // re-mount must not double-check), and in-flight checks outlive the page —
  // results land in the store either way.
  useEffect(() => {
    const cur = useStore.getState().agentChecks
    const fresh = agents.filter((ag) => !cur[ag.id])
    if (!fresh.length) return
    useStore.setState({
      agentChecks: { ...cur, ...Object.fromEntries(fresh.map((ag) => [ag.id, 'checking' as const])) },
    })
    fresh.forEach((ag, i) => {
      window.setTimeout(() => { void useStore.getState().runAgentCheck(ag.id) }, i * 100)
    })
  }, [agents])

  const confirmDelete = async () => {
    if (!delAgent) return
    const ag = delAgent
    setDelAgent(null)
    try {
      await api.deleteAgent(ag.id)
      const { [ag.id]: _gone, ...rest } = useStore.getState().agentChecks
      useStore.setState({ agentChecks: rest })
      showToast('Agent removed — automations it wrote still execute on schedule.')
    } catch (e) { showToast((e as Error).message) }
  }

  const delUses = delAgent?.usedBy ?? []

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '26px 30px 70px', animation: 'adFadeUp .4s ease' }}>
      <PageTitle
        style={{ marginBottom: 6 }}
        right={<BtnGhost onClick={() => go('agentNew')}>Add agent</BtnGhost>}
      >
        Agents
      </PageTitle>
      <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-muted)', margin: '0 0 20px' }}>
        The AI that writes your automations. It never executes anything — Auto Dave does that. New automations use your default agent.
      </p>
      {agents.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {agents.map((ag) => (
            <AgentCard key={ag.id} ag={ag} check={agentChecks[ag.id]} onDelete={setDelAgent} />
          ))}
        </div>
      ) : (
        <div style={{
          background: 'var(--bg-card)', border: '1px dashed rgba(255,255,255,.12)', borderRadius: 12,
          padding: '36px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center',
          gap: 12, textAlign: 'center',
        }}>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: 'var(--text-muted)', maxWidth: 420 }}>
            No agents yet. Existing automations still execute on schedule — but you need an agent to create or edit them.
          </p>
          <BtnPrimary onClick={() => go('agentNew')}>Add your first agent</BtnPrimary>
        </div>
      )}
      {delAgent && (
        <ConfirmModal
          title="Remove this agent?"
          body={(
            <>
              <span style={{ fontWeight: 500, color: 'var(--text)' }}>{delAgent.name || delAgent.harness}</span>
              {' '}will be removed from Auto Dave. Nothing it wrote is deleted.
              {delUses.length > 0 && (
                <p style={{ color: P.amber, margin: '8px 0 0' }}>
                  {delUses.length === 1
                    ? `“${delUses[0]}” uses this agent. It still executes on schedule — you’ll just need another agent to edit it.`
                    : `${delUses.length} automations use this agent — they still execute on schedule, but you’ll need another agent to edit them.`}
                </p>
              )}
            </>
          )}
          confirmLabel="Remove agent"
          danger
          onConfirm={() => { void confirmDelete() }}
          onCancel={() => setDelAgent(null)}
        />
      )}
    </div>
  )
}
