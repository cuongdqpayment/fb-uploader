import React, { useState, useEffect, useCallback } from 'react'

export default function Dashboard({ status }) {
  const [channels, setChannels]       = useState([])
  const [allRows, setAllRows]         = useState({}) // { channelId: rows[] }
  const [loading, setLoading]         = useState(false)
  const [schedulerOn, setSchedulerOn] = useState(false)
  const [processingRow, setProcessingRow] = useState(null) // { channelId, rowIndex }
  const [activeChannel, setActiveChannel] = useState(null) // tab đang xem

  // Subscribe to row events
  useEffect(() => {
    window.api.onRowProcessing((data) => setProcessingRow(data))
    window.api.onRowDone(({ channelId, rowIndex, fbVideoId }) => {
      setAllRows(prev => ({
        ...prev,
        [channelId]: (prev[channelId] || []).map(r =>
          r.rowIndex === rowIndex ? { ...r, status: 'posted', fb_video_id: fbVideoId } : r
        )
      }))
      setProcessingRow(null)
    })
    window.api.onRowError(({ channelId, rowIndex, error }) => {
      setAllRows(prev => ({
        ...prev,
        [channelId]: (prev[channelId] || []).map(r =>
          r.rowIndex === rowIndex ? { ...r, status: 'error', _error: error } : r
        )
      }))
      setProcessingRow(null)
    })
    return () => {
      window.api.removeAllListeners('row:processing')
      window.api.removeAllListeners('row:done')
      window.api.removeAllListeners('row:error')
    }
  }, [])

  const fetchAll = useCallback(async () => {
    setLoading(true)
    const cfg = await window.api.getConfig()
    const chs = cfg.channels || []
    setChannels(chs)
    if (chs.length > 0 && !activeChannel) setActiveChannel(chs[0].id)

    const results = await window.api.fetchAllSheets()
    setAllRows(results ? Object.fromEntries(
      Object.entries(results).map(([id, r]) => [id, r.ok ? r.rows : []])
    ) : {})
    setLoading(false)
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  // Tổng stats tất cả kênh
  const allRowsList = Object.values(allRows).flat()
  const stats = {
    total:   allRowsList.length,
    pending: allRowsList.filter(r => r.status === 'pending').length,
    posted:  allRowsList.filter(r => r.status === 'posted').length,
    error:   allRowsList.filter(r => r.status === 'error').length,
  }

  const handleRunAll = async () => {
    await window.api.runNow(null)
    setTimeout(fetchAll, 3000)
  }
  const handleRunChannel = async (channelId) => {
    await window.api.runNow(channelId)
    setTimeout(fetchAll, 3000)
  }

  // Chạy theo lịch — check scheduled_at
  const handleRunAllScheduled = async () => {
    await window.api.runScheduled(null)
    setTimeout(fetchAll, 3000)
  }
  const handleRunChannelScheduled = async (channelId) => {
    await window.api.runScheduled(channelId)
    setTimeout(fetchAll, 3000)
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

  const currentChannelRows = allRows[activeChannel] || []
  const currentChannel = channels.find(c => c.id === activeChannel)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div className="section-header">
        <div>
          <div className="section-title">Dashboard</div>
          <div className="section-sub">
            {channels.length} kênh — {channels.filter(c => c.enabled).length} đang bật
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" onClick={fetchAll} disabled={loading}>
            {loading ? '⟳' : '↺'} Làm mới
          </button>
          {status === 'running' ? (
            <button className="btn btn-danger" onClick={handleStop}>■ Dừng</button>
          ) : (
            <>
              <button className="btn btn-ghost" onClick={handleRunAllScheduled}
                title="Chỉ đăng video đến giờ scheduled_at">
                🕐 Theo lịch
              </button>
              <button className="btn btn-primary" onClick={handleRunAll}
                title="Đăng ngay, bỏ qua giờ">
                ▶ Chạy ngay
              </button>
            </>
          )}
        </div>
      </div>

      {/* Stats tổng */}
      <div className="stats-row">
        <StatCard value={stats.total}   label="Tổng video"  color="var(--text-1)" />
        <StatCard value={stats.pending} label="Chờ đăng"    color="var(--amber)" />
        <StatCard value={stats.posted}  label="Đã đăng"     color="var(--green)" />
        <StatCard value={stats.error}   label="Lỗi"         color="var(--red)" />
      </div>

      {/* Scheduler */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">⏱ Tự động chạy tất cả kênh</span>
          <label className="switch">
            <input type="checkbox" checked={schedulerOn} onChange={toggleScheduler} />
            <span className="slider-track" />
          </label>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-3)' }}>
          {schedulerOn
            ? '✓ Scheduler đang chạy — tự động kiểm tra tất cả kênh theo lịch.'
            : 'Bật để tự động kiểm tra và upload tất cả kênh theo lịch.'}
        </p>
      </div>

      {/* Channel tabs + per-channel run */}
      {channels.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          {/* Tab bar */}
          <div style={{
            display: 'flex', alignItems: 'center',
            borderBottom: '1px solid var(--bg-4)',
            overflowX: 'auto', gap: 0,
          }}>
            {channels.map(ch => {
              const rows = allRows[ch.id] || []
              const pending = rows.filter(r => r.status === 'pending').length
              const isProcessing = processingRow?.channelId === ch.id
              return (
                <div
                  key={ch.id}
                  onClick={() => setActiveChannel(ch.id)}
                  style={{
                    padding: '12px 18px',
                    cursor: 'pointer',
                    borderBottom: activeChannel === ch.id
                      ? '2px solid var(--blue)' : '2px solid transparent',
                    color: activeChannel === ch.id ? 'var(--blue)' : 'var(--text-2)',
                    fontSize: 13, fontWeight: 600,
                    whiteSpace: 'nowrap',
                    display: 'flex', alignItems: 'center', gap: 8,
                    opacity: ch.enabled ? 1 : 0.4,
                  }}
                >
                  {isProcessing && <div className="dot-pulse" style={{ color: 'var(--amber)' }} />}
                  {ch.name}
                  {pending > 0 && (
                    <span style={{
                      background: 'var(--amber)', color: '#000',
                      borderRadius: 10, padding: '1px 7px', fontSize: 10, fontWeight: 700,
                    }}>{pending}</span>
                  )}
                  {!ch.enabled && (
                    <span style={{ fontSize: 10, color: 'var(--text-3)' }}>tắt</span>
                  )}
                </div>
              )
            })}
          </div>

          {/* Channel header + run button */}
          <div style={{
            padding: '12px 20px',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            borderBottom: '1px solid var(--bg-4)',
          }}>
            <div>
              <span className="card-title">
                📋 {currentChannel?.name} —&nbsp;
                {currentChannelRows.filter(r => r.status === 'pending').length} đang chờ
              </span>
              {currentChannel && (
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                  {currentChannel.sheetTab} · {currentChannel.pageUrl || 'Chưa cấu hình Page'}
                </div>
              )}
            </div>
            {status !== 'running' && activeChannel && (
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-ghost" style={{ fontSize: 11 }}
                  onClick={() => handleRunChannelScheduled(activeChannel)}
                  title="Chỉ đăng video đến giờ scheduled_at">
                  🕐 Theo lịch
                </button>
                <button className="btn btn-ghost" style={{ fontSize: 11 }}
                  onClick={() => handleRunChannel(activeChannel)}
                  title="Đăng ngay, bỏ qua giờ">
                  ▶ Chạy ngay
                </button>
              </div>
            )}
          </div>

          {/* Queue table */}
          {currentChannelRows.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>
              {loading ? 'Đang tải...' : 'Không có video nào trong kênh này.'}
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
                {currentChannelRows.map(r => {
                  const isProc = processingRow?.channelId === r.channelId
                    && processingRow?.rowIndex === r.rowIndex
                  return (
                    <tr
                      key={r.rowIndex}
                      className={isProc ? 'processing' : r.status === 'posted' ? 'done' : ''}
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
                        {isProc
                          ? <span className="badge badge-running">
                              <div className="dot-pulse" />Uploading
                            </span>
                          : <StatusBadge status={r.status} />
                        }
                        {r._error && (
                          <div style={{ fontSize: 10, color: 'var(--red)', marginTop: 2 }}>
                            {r._error}
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {channels.length === 0 && !loading && (
        <div className="alert alert-warn">
          ⚠️ Chưa có kênh nào. Vào <b>Cấu hình</b> để thêm kênh mới.
        </div>
      )}
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