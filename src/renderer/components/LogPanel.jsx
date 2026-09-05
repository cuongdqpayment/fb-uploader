import React, { useEffect, useRef, useState } from 'react'

export default function LogPanel({ logs }) {
  const ref = useRef(null)
  const [collapsed, setCollapsed] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)

  useEffect(() => {
    if (autoScroll && ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight
    }
  }, [logs, autoScroll])

  return (
    <div style={{
      borderTop: '1px solid var(--bg-4)',
      background: 'var(--bg-0)',
      flexShrink: 0,
    }}>
      {/* Log header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '6px 16px',
        borderBottom: collapsed ? 'none' : '1px solid var(--bg-4)',
        cursor: 'pointer',
      }} onClick={() => setCollapsed(v => !v)}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', userSelect: 'none' }}>
          LOG
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-3)', marginLeft: 4 }}>
          {logs.length} entries
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-3)' }}>
          {collapsed ? '▲' : '▼'}
        </span>
        {!collapsed && (
          <label
            style={{ fontSize: 11, color: 'var(--text-3)', display: 'flex', gap: 4, cursor: 'pointer' }}
            onClick={e => e.stopPropagation()}
          >
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={e => setAutoScroll(e.target.checked)}
            />
            Auto-scroll
          </label>
        )}
      </div>

      {!collapsed && (
        <div
          ref={ref}
          className="log-box"
          style={{ height: 140, borderRadius: 0, border: 'none' }}
        >
          {logs.length === 0 && (
            <div className="log-line">
              <span className="log-time">—</span>
              <span className="log-msg info">Chưa có log nào. Bấm "Chạy ngay" để bắt đầu.</span>
            </div>
          )}
          {logs.map((entry, i) => (
            <div className="log-line" key={i}>
              <span className="log-time">
                {new Date(entry.time).toLocaleTimeString('vi-VN')}
              </span>
              <span className={`log-msg ${entry.type || 'info'}`}>
                {entry.message}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
