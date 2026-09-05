import React, { useState, useEffect, useCallback } from 'react'
import Dashboard from './pages/Dashboard.jsx'
import QueuePage from './pages/QueuePage.jsx'
import SettingsPage from './pages/SettingsPage.jsx'
import LogPanel from './components/LogPanel.jsx'

const NAV = [
  { id: 'dashboard', icon: '⬡', label: 'Dashboard' },
  { id: 'queue',     icon: '▤',  label: 'Queue' },
  { id: 'settings',  icon: '⚙',  label: 'Cấu hình' },
]

export default function App() {
  const [page, setPage] = useState('dashboard')
  const [status, setStatus] = useState('idle')   // idle | running
  const [logs, setLogs] = useState([])

  const addLog = useCallback((entry) => {
    setLogs(prev => [...prev.slice(-199), entry])
  }, [])

  useEffect(() => {
    window.api.onStatus(setStatus)
    window.api.onLog(addLog)
    return () => {
      window.api.removeAllListeners('status')
      window.api.removeAllListeners('log')
    }
  }, [addLog])

  const pages = { dashboard: Dashboard, queue: QueuePage, settings: SettingsPage }
  const PageComponent = pages[page] || Dashboard

  return (
    <div className="app-shell">
      {/* Sidebar */}
      <nav className="sidebar">
        <div className="nav-logo">
          <h1>FB Uploader</h1>
          <span>Video automation</span>
        </div>
        {NAV.map(n => (
          <div
            key={n.id}
            className={`nav-item ${page === n.id ? 'active' : ''}`}
            onClick={() => setPage(n.id)}
          >
            <span className="icon">{n.icon}</span>
            <span>{n.label}</span>
          </div>
        ))}

        {/* Status indicator */}
        <div style={{ marginTop: 'auto', padding: '12px 16px' }}>
          <div className={`badge ${status === 'running' ? 'badge-running' : 'badge-idle'}`}>
            {status === 'running' && <div className="dot-pulse" />}
            {status === 'running' ? 'Đang chạy' : 'Sẵn sàng'}
          </div>
        </div>
      </nav>

      {/* Main */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div className="main-content">
          <PageComponent status={status} logs={logs} />
        </div>
        <LogPanel logs={logs} />
      </div>
    </div>
  )
}
