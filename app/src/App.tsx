// App shell (§9): 212px sidebar + independently scrolling content, state-driven nav.
import React, { useEffect, useState } from 'react'
import { useStore } from './store'
import { CountPill, Logo, Spinner, Toast } from './ui'
import AgentNewPage from './pages/AgentNewPage'
import AgentsPage from './pages/AgentsPage'
import AutomationDetail from './pages/AutomationDetail'
import AutomationsList from './pages/AutomationsList'
import CreateFlow from './pages/CreateFlow'
import ExecutionPage from './pages/ExecutionPage'
import ExecutionsList from './pages/ExecutionsList'
import MenuBarPanel from './pages/MenuBarPanel'
import Onboarding from './pages/Onboarding'
import SecretsPage from './pages/SecretsPage'
import SettingsPage from './pages/SettingsPage'

const NAV: { page: string; label: string; icon: string }[] = [
  { page: 'automations', label: 'Automations', icon: 'fa-bolt' },
  { page: 'executions', label: 'Executions', icon: 'fa-clock-rotate-left' },
  { page: 'agents', label: 'Agents', icon: 'fa-robot' },
  { page: 'secrets', label: 'Secrets', icon: 'fa-key' },
  { page: 'settings', label: 'Settings', icon: 'fa-sliders' },
]

// One fixed window position in both sidebar states (§9): right of the traffic lights.
function NavToggle({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      className="ad-nav-row"
      onClick={onClick}
      title={title}
      style={{
        position: 'absolute', left: 82, top: 6, display: 'flex', alignItems: 'center',
        justifyContent: 'center', width: 28, height: 28, borderRadius: 7,
        color: 'var(--text-faint)', zIndex: 101,
      }}
    >
      <i className="fa-solid fa-table-columns" style={{ fontSize: 13 }} />
    </button>
  )
}

function Sidebar({ onCollapse }: { onCollapse: () => void }) {
  const page = useStore((s) => s.page)
  const go = useStore((s) => s.go)
  const nAutos = useStore((s) => s.autos.length)
  // §11 test executions never appear in the Executions list — don't count them
  const nExecs = useStore((s) => s.execs.filter((e) => !e.test).length)
  const nAgents = useStore((s) => s.agents.length)
  const nSecrets = useStore((s) => s.secrets.length)
  const activeRoot = page === 'automation' ? 'automations' : page === 'execution' ? 'executions' : page === 'agentNew' ? 'agents' : page
  const counts: Record<string, number> = {
    automations: nAutos,
    executions: nExecs,
    agents: nAgents,
    secrets: nSecrets,
  }
  return (
    <div style={{
      width: 212, flex: 'none', background: 'var(--bg-sidebar)',
      borderRight: '1px solid var(--hairline)', display: 'flex', flexDirection: 'column',
    }}>
      <div className="ad-drag" style={{ height: 44, flex: 'none', position: 'relative' }}>
        <NavToggle onClick={onCollapse} title="Collapse sidebar" />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '2px 16px 18px' }}>
        <Logo />
        <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-.01em' }}>Autowright</span>
      </div>
      <nav style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '0 10px' }}>
        {NAV.map((n) => {
          const active = activeRoot === n.page
          return (
            <button
              key={n.page}
              className={'ad-nav-row' + (active ? ' active' : '')}
              onClick={() => go(n.page as never, { autoId: null, execId: null })}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 11px',
                borderRadius: 7, fontSize: 13, fontWeight: 500, textAlign: 'left',
                color: active ? 'var(--text)' : 'var(--text-muted)',
                ...(active ? { background: 'rgba(255,255,255,.07)' } : null),
              }}
            >
              <i className={`fa-solid ${n.icon}`} style={{ width: 16, fontSize: 12, opacity: 0.85 }} />
              <span style={{ flex: 1 }}>{n.label}</span>
              <CountPill n={counts[n.page] ?? 0} active={active} />
            </button>
          )
        })}
      </nav>
    </div>
  )
}

function Content() {
  const page = useStore((s) => s.page)
  switch (page) {
    case 'automations': return <AutomationsList />
    case 'automation': return <AutomationDetail />
    case 'executions': return <ExecutionsList />
    case 'execution': return <ExecutionPage />
    case 'agents': return <AgentsPage />
    case 'agentNew': return <AgentNewPage />
    case 'secrets': return <SecretsPage />
    case 'settings': return <SettingsPage />
    default: return <AutomationsList />
  }
}

// Boot gate: plain window background while connecting. The logo/spinner only
// appears if boot is still pending after 300 ms, so a fast boot shows no flash.
function BootSplash({ waiting }: { waiting: boolean }) {
  const [show, setShow] = useState(false)
  useEffect(() => {
    const id = window.setTimeout(() => setShow(true), 300)
    return () => clearTimeout(id)
  }, [])
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, background: 'var(--bg-window)' }} className="ad-drag">
      {show && (
        <>
          <Logo size={40} />
          <Spinner size={18} />
          <div style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>
            {waiting ? 'Waiting for the Autowright backend…' : 'Connecting…'}
          </div>
        </>
      )}
    </div>
  )
}

export default function App() {
  const connected = useStore((s) => s.connected)
  const surface = useStore((s) => s.surface)
  const toast = useStore((s) => s.toast)
  const createFrom = useStore((s) => s.createFrom)
  const boot = useStore((s) => s.boot)
  const disconnect = useStore((s) => s.disconnect)
  const [navCollapsed, setNavCollapsed] = useState(() => localStorage.getItem('ad-nav-collapsed') === '1')
  const setCollapsed = (v: boolean) => {
    if (v) localStorage.setItem('ad-nav-collapsed', '1')
    else localStorage.removeItem('ad-nav-collapsed')
    setNavCollapsed(v)
  }

  useEffect(() => { void boot(); return disconnect }, [])

  if (connected === null || connected === false) {
    return <BootSplash waiting={connected === false} />
  }

  if (surface === 'menubar') return <MenuBarPanel />
  if (surface === 'onboard') return <><Onboarding /><Toast msg={toast} /></>

  const inShell = surface === 'app' || (surface === 'create' && createFrom !== 'onboard')
  const sidebarHidden = !inShell || navCollapsed
  return (
    <div style={{ height: '100vh', display: 'flex', background: 'var(--bg-window)' }}>
      <div className="ad-drag" style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 18, zIndex: 100 }} />
      {!sidebarHidden && <Sidebar onCollapse={() => setCollapsed(true)} />}
      <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg-content)', position: 'relative' }}>
        {sidebarHidden && (
          <div className="ad-drag" style={{ position: 'sticky', top: 0, height: 40, zIndex: 101 }}>
            {inShell && <NavToggle onClick={() => setCollapsed(false)} title="Expand sidebar" />}
          </div>
        )}
        {surface === 'create' ? <CreateFlow /> : <Content />}
      </div>
      <Toast msg={toast} />
    </div>
  )
}
