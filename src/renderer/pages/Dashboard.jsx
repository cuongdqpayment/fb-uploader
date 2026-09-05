import React, { useState, useEffect, useCallback } from 'react'

export default function Dashboard({ status }) {
  const [rows, setRows]       = useState([])
  const [stats, setStats]     = useState({ total: 0, pending: 0, posted: 0, error: 0 })
  const [loading, setLoading] = useState(false)
  const [schedulerOn, setSchedulerOn] = useState(false)
  const [processingRow, setProcessingRow] = useState(null)

  // Subscribe to row events
  useEffect(() => {
    window.api.onRowProcessing((rowIndex) => setProcessingRow(rowIndex))
    window.api.onRowDone(({ rowIndex, fbVideoId }) => {
      setRows(prev => prev.map(r =>
        r.rowIndex === rowIndex ? { ...r, status: 'posted', fb_video_id: fbVideoId } : r
      ))
      setProcessingRow(null)
    })
    window.api.onRowError(({ rowIndex, error }) => {
      setRows(prev => prev.map(r =>
        r.rowIndex === rowIndex ? { ...r, status: 'error', _error: error } : r
      ))
      setProcessingRow(null)
    })
    return () => {
      window.api.removeAllListeners('row:processing')
      window.api.removeAllListeners('row:done')
      window.api.removeAllListeners('row:error')
    }
  }, [])

  const fetchRows = useCallback(async () => {
    setLoading(true)
    const res = await window.api.fetchSheets()
    setLoading(false)
    if (res.ok) {
      setRows(res.rows)
      const total   = res.rows.length
      const pending = res.rows.filter(r => r.status === 'pending').length
      const posted  = res.rows.filter(r => r.status === 'posted').length
      const error   = res.rows.filter(r => r.status === 'error').length
      setStats({ total, pending, posted, error })
    }
  }, [])

  useEffect(() => { fetchRows() }, [fetchRows])

  const handleRunNow = async () => {
    await window.api.runNow()
    setTimeout(fetchRows, 3000)
  }

  const handleStop = () => window.api.stopRun()

  const toggleScheduler = async () => {
    if (schedulerOn) {
      await window.api.stopScheduler()
      setSchedulerOn(false)
    } else {
      await window.api.startScheduler()
      setSchedulerOn(true)
    }
  }

  const pending = rows.filter(r => r.status === 'pending')
  const doneRows = rows.filter(r => r.status === 'posted')
  const errorRows = rows.filter(r => r.status === 'error')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div className="section-header">
        <div>
          <div className="section-title">Dashboard</div>
          <div className="section-sub">Quản lý upload video lên Facebook Page</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" onClick={fetchRows} disabled={loading}>
            {loading ? '⟳' : '↺'} Làm mới
          </button>
          {status === 'running'
            ? <button className="btn btn-danger" onClick={handleStop}>■ Dừng</button>
            : <button className="btn btn-primary" onClick={handleRunNow}>▶ Chạy ngay</button>
          }
        </div>
      </div>

      {/* Stats */}
      <div className="stats-row">
        <StatCard value={stats.total}   label="Tổng video"    color="var(--text-1)" />
        <StatCard value={stats.pending} label="Chờ đăng"      color="var(--amber)" />
        <StatCard value={stats.posted}  label="Đã đăng"       color="var(--green)" />
        <StatCard value={stats.error}   label="Lỗi"           color="var(--red)" />
      </div>

      {/* Scheduler toggle */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">⏱ Tự động chạy</span>
          <label className="switch">
            <input type="checkbox" checked={schedulerOn} onChange={toggleScheduler} />
            <span className="slider-track" />
          </label>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-3)' }}>
          {schedulerOn
            ? '✓ Scheduler đang chạy — tự động kiểm tra và upload mỗi 15 phút.'
            : 'Bật để n8n-style scheduler tự động kiểm tra Sheet và upload đúng giờ.'}
        </p>
      </div>

      {/* Queue table */}
      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--bg-4)' }}>
          <span className="card-title">📋 Hàng đợi ({pending.length} đang chờ)</span>
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>
            {loading ? 'Đang tải...' : 'Không có video nào. Thêm vào Google Sheet để bắt đầu.'}
          </div>
        ) : (
          <table className="queue-table">
            <thead>
              <tr>
                <th>#</th>
                <th>File</th>
                <th>Caption</th>
                <th>Lịch đăng</th>
                <th>Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr
                  key={r.rowIndex}
                  className={processingRow === r.rowIndex ? 'processing' : r.status === 'posted' ? 'done' : ''}
                >
                  <td style={{ color: 'var(--text-3)', width: 36 }}>{r.seq || r.rowIndex}</td>
                  <td><span className="file-name">{r.file_name}</span></td>
                  <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.caption}
                  </td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
                    {r.scheduled_at || '—'}
                  </td>
                  <td>
                    {processingRow === r.rowIndex
                      ? <span className="badge badge-running"><div className="dot-pulse" />Uploading</span>
                      : <StatusBadge status={r.status} />
                    }
                    {r._error && (
                      <div style={{ fontSize: 10, color: 'var(--red)', marginTop: 2 }}>
                        {r._error}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function StatCard({ value, label, color }) {
  return (
    <div className="stat-card">
      <div className="stat-value" style={{ color }}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  )
}

function StatusBadge({ status }) {
  const map = {
    pending: ['badge-pending', 'Chờ'],
    posted:  ['badge-done',    'Đã đăng ✓'],
    error:   ['badge-error',   'Lỗi ✗'],
  }
  const [cls, label] = map[status] || ['badge-pending', status]
  return <span className={`badge ${cls}`}>{label}</span>
}
