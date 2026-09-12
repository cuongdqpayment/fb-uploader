import React, { useState, useEffect, useCallback } from 'react'

export default function Dashboard({ status }) {
  const [channels, setChannels]         = useState([])
  const [allRows, setAllRows]           = useState({})
  const [loading, setLoading]           = useState(false)
  const [schedulerOn, setSchedulerOn]   = useState(false)
  const [processingRow, setProcessingRow] = useState(null)
  const [activeChannel, setActiveChannel] = useState(null)

  // Subscribe to row events + scheduler state
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
    // Nhận trạng thái scheduler từ main (auto-restore)
    if (window.api.onSchedulerState) {
      window.api.onSchedulerState((enabled) => setSchedulerOn(!!enabled))
    }
    return () => {
      window.api.removeAllListeners('row:processing')
      window.api.removeAllListeners('row:done')
      window.api.removeAllListeners('row:error')
      window.api.removeAllListeners('scheduler:state')
    }
  }, [])

  const fetchAll = useCallback(async () => {
    setLoading(true)
    const cfg = await window.api.getConfig()
    const chs = cfg.channels || []
    setChannels(chs)
    if (chs.length > 0 && !activeChannel) setActiveChannel(chs[0].id)

    // Restore scheduler state từ main process
    if (window.api.getSchedulerState) {
      const state = await window.api.getSchedulerState()
      setSchedulerOn(state?.enabled || false)
    }

    const results = await window.api.fetchAllSheets()
    setAllRows(results ? Object.fromEntries(
      Object.entries(results).map(([id, r]) => [id, r.ok ? r.rows : []])
    ) : {})
    setLoading(false)
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

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
  const handleRunAllScheduled = async () => {
    if (window.api.runScheduled) await window.api.runScheduled(null)
    setTimeout(fetchAll, 3000)
  }
  const handleRunChannel = async (channelId) => {
    await window.api.runNow(channelId)
    setTimeout(fetchAll, 3000)
  }
  const handleRunChannelScheduled = async (channelId) => {
    if (window.api.runScheduled) await window.api.runScheduled(channelId)
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header — responsive wrap */}
      <div style={{
        display: 'flex', alignItems: 'flex-start',
        justifyContent: 'space-between', flexWrap: 'wrap', gap: 8,
      }}>
        <div>
          <div className="section-title">Dashboard</div>
          <div className="section-sub">
            {channels.length} kênh — {channels.filter(c => c.enabled).length} đang bật
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className="btn btn-ghost" onClick={fetchAll} disabled={loading}
            style={{ fontSize: 12 }}>
            {loading ? '⟳' : '↺'} Làm mới
          </button>
          {status === 'running' ? (
            <button className="btn btn-danger" onClick={handleStop}
              style={{ fontSize: 12 }}>■ Dừng</button>
          ) : (
            <>
              <button className="btn btn-ghost" onClick={handleRunAllScheduled}
                title="Chỉ đăng video đến giờ" style={{ fontSize: 12 }}>
                🕐 Theo lịch
              </button>
              <button className="btn btn-primary" onClick={handleRunAll}
                title="Đăng ngay, bỏ qua giờ" style={{ fontSize: 12 }}>
                ▶ Chạy ngay
              </button>
            </>
          )}
        </div>
      </div>

      {/* Stats — responsive grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))',
        gap: 10,
      }}>
        <StatCard value={stats.total}   label="Tổng"    color="var(--text-1)" />
        <StatCard value={stats.pending} label="Chờ đăng" color="var(--amber)" />
        <StatCard value={stats.posted}  label="Đã đăng"  color="var(--green)" />
        <StatCard value={stats.error}   label="Lỗi"      color="var(--red)" />
      </div>

      {/* Scheduler */}
      <div className="card">
        <div className="card-header" style={{ flexWrap: 'wrap', gap: 8 }}>
          <span className="card-title" style={{ fontSize: 13 }}>
            ⏱ Tự động chạy tất cả kênh
          </span>
          <label className="switch">
            <input type="checkbox" checked={schedulerOn} onChange={toggleScheduler} />
            <span className="slider-track" />
          </label>
        </div>
        <p style={{ fontSize: 11, color: 'var(--text-3)', margin: 0 }}>
          {schedulerOn
            ? '✓ Scheduler đang chạy — tự động upload theo lịch.'
            : 'Bật để tự động upload theo lịch đã đặt.'}
        </p>
      </div>

      {/* Channel tabs */}
      {channels.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          {/* Tab bar — scrollable trên màn nhỏ */}
          <div style={{
            display: 'flex', alignItems: 'center',
            borderBottom: '1px solid var(--bg-4)',
            overflowX: 'auto', gap: 0,
          }}>
            {channels.map(ch => {
              const rows = allRows[ch.id] || []
              const pending = rows.filter(r => r.status === 'pending').length
              const isProc = processingRow?.channelId === ch.id
              return (
                <div key={ch.id}
                  onClick={() => setActiveChannel(ch.id)}
                  style={{
                    padding: '10px 14px', cursor: 'pointer', flexShrink: 0,
                    borderBottom: activeChannel === ch.id
                      ? '2px solid var(--blue)' : '2px solid transparent',
                    color: activeChannel === ch.id ? 'var(--blue)' : 'var(--text-2)',
                    fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
                    display: 'flex', alignItems: 'center', gap: 6,
                    opacity: ch.enabled ? 1 : 0.4,
                  }}>
                  {isProc && <span style={{ color: 'var(--amber)' }}>●</span>}
                  {ch.name}
                  {pending > 0 && (
                    <span style={{
                      background: 'var(--amber)', color: '#000',
                      borderRadius: 10, padding: '1px 6px',
                      fontSize: 10, fontWeight: 700,
                    }}>{pending}</span>
                  )}
                  {!ch.enabled && (
                    <span style={{ fontSize: 10, color: 'var(--text-3)' }}>tắt</span>
                  )}
                </div>
              )
            })}
            <div style={{ marginLeft: 'auto', padding: '0 8px', fontSize: 11 }}
              onClick={() => setActiveChannel(null)} />
          </div>

          {/* Channel info + buttons — responsive wrap */}
          <div style={{
            padding: '10px 16px',
            display: 'flex', alignItems: 'flex-start',
            justifyContent: 'space-between', flexWrap: 'wrap', gap: 8,
            borderBottom: '1px solid var(--bg-4)',
          }}>
            <div style={{ minWidth: 0 }}>
              <span className="card-title" style={{ fontSize: 12 }}>
                📋 {currentChannel?.name} — {currentChannelRows.filter(r => r.status === 'pending').length} chờ
              </span>
              {currentChannel && (
                <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
                  {currentChannel.sheetTab}
                </div>
              )}
            </div>
            {status !== 'running' && activeChannel && (
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button className="btn btn-ghost" style={{ fontSize: 10, padding: '4px 8px' }}
                  onClick={() => handleRunChannelScheduled(activeChannel)}
                  title="Chỉ đăng video đến giờ">
                  🕐 Theo lịch
                </button>
                <button className="btn btn-ghost" style={{ fontSize: 10, padding: '4px 8px' }}
                  onClick={() => handleRunChannel(activeChannel)}
                  title="Đăng ngay">
                  ▶ Chạy ngay
                </button>
              </div>
            )}
          </div>

          {/* Queue table — scroll ngang trên màn nhỏ */}
          <div style={{ overflowX: 'auto' }}>
            {currentChannelRows.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>
                {loading ? 'Đang tải...' : 'Không có video nào.'}
              </div>
            ) : (
              <table className="queue-table" style={{ minWidth: 480 }}>
                <thead>
                  <tr>
                    <th style={{ width: 30 }}>#</th>
                    <th>File</th>
                    <th>Caption</th>
                    <th style={{ whiteSpace: 'nowrap' }}>Lịch đăng</th>
                    <th>Trạng thái</th>
                  </tr>
                </thead>
                <tbody>
                  {currentChannelRows.map(r => {
                    const isProc = processingRow?.channelId === r.channelId
                      && processingRow?.rowIndex === r.rowIndex
                    return (
                      <tr key={r.rowIndex}
                        className={isProc ? 'processing' : r.status === 'posted' ? 'done' : ''}>
                        <td style={{ color: 'var(--text-3)', fontSize: 11 }}>{r.seq || r.rowIndex}</td>
                        <td><span className="file-name" style={{ fontSize: 11 }}>{r.file_name}</span></td>
                        <td style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11 }}>
                          {r.caption}
                        </td>
                        <td style={{ fontFamily: 'var(--font-mono)', fontSize: 10, whiteSpace: 'nowrap' }}>
                          {r.scheduled_at || '—'}
                        </td>
                        <td>
                          {isProc
                            ? <span className="badge badge-running" style={{ fontSize: 10 }}>⏳ Upload</span>
                            : <StatusBadge status={r.status} />
                          }
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {channels.length === 0 && !loading && (
        <div className="alert alert-warn" style={{ fontSize: 12 }}>
          ⚠️ Chưa có kênh. Vào <b>Cấu hình</b> để thêm kênh mới.
        </div>
      )}
    </div>
  )
}

function StatCard({ value, label, color }) {
  return (
    <div className="stat-card">
      <div className="stat-value" style={{ color, fontSize: 28 }}>{value}</div>
      <div className="stat-label" style={{ fontSize: 11 }}>{label}</div>
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
  return <span className={`badge ${cls}`} style={{ fontSize: 10 }}>{label}</span>
}
