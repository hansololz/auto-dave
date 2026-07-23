import React from 'react'
import { MenuRow, menuStyle } from 'autowright'

// menuStyle is position:absolute for popover use — override to static so the
// menu sits in flow inside the dark frame.
const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: 'var(--bg-window)', padding: 20, borderRadius: 10, width: 280 }}>
    <div style={{ ...menuStyle, position: 'static' }}>{children}</div>
  </div>
)

// Automation card menu: normal, normal, active, danger rows.
export const AutomationMenu = () => (
  <Frame>
    <MenuRow>Edit</MenuRow>
    <MenuRow>Duplicate</MenuRow>
    <MenuRow active>Executions</MenuRow>
    <MenuRow danger>Delete</MenuRow>
  </Frame>
)

// Agent picker menu: plain rows plus a danger remove action.
export const AgentMenu = () => (
  <Frame>
    <MenuRow>Set as default</MenuRow>
    <MenuRow>Rename agent</MenuRow>
    <MenuRow>Change model</MenuRow>
    <MenuRow danger>Remove agent</MenuRow>
  </Frame>
)
