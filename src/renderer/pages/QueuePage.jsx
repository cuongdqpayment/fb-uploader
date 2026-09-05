import React, { useState, useCallback, useEffect } from 'react'

export default function QueuePage({ status }) {
  const [rows, setRows]     = useState([])
  const [loading, setLoading] = useState(false)
  const [testResult, setTestResult] = useState(null)

  const fetchRows = useCallback(async () => {
    setLoading(true)
    const res = await window.api.fetchSheets()
    setLoading(false)
    if (res.ok) setRows(res.rows)
    else setTestResult({ ok: false, error: res.error })
  }, [])

  useEffect(() => { fetchRows() }, [fetchRows])

  const testConnection = async () => {
    setTestResult(null)
    const res = await window.api.testSheets()
    setTestResult(res)
  }

  const pending = rows.filter(r => r.status === 'pending')
  const done    = rows.filter(r => r.status === 'posted')
  const errors  = rows.filter(r => r.status === 'error')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="section-header">
        <div>
          <div className="section-title">Queue</div>
          <div className="section-sub">Danh sách video từ Google Sheet</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" onClick={testConnection}>🔌 Test kết nối</button>
          <button className="btn btn-ghost" onClick={fetchRows} disabled={loading}>
            {loading ? '⟳' : '↺'} Làm mới
          </button>
        </div>
      </div>

      {/* Test result */}
      {testResult && (
        <div className={`alert ${testResult.ok ? 'alert-info' : 'alert-error'}`}>
          {testResult.ok
            ? `✓ Kết nối thành công — tìm thấy ${testResult.count} video pending`
            : `✗ Lỗi: ${testResult.error}`}
        </div>
      )}

      {/* Format guide */}
      <div className="card">
        <div className="card-title" style={{ marginBottom: 10 }}>📄 Cấu trúc Google Sheet</div>
        <div style={{ overflowX: 'auto' }}>
          <table className="queue-table">
            <thead>
              <tr>
                <th>A: seq</th>
                <th>B: file_name</th>
                <th>C: file_path</th>
                <th>D: scheduled_at</th>
                <th>E: caption</th>
                <th>F: description</th>
                <th>G: status</th>
                <th>H: fb_video_id</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>1</td>
                <td><span className="file-name">story1.mp4</span></td>
                <td>/data/video/output/story1.mp4</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>2026-09-05 19:00:00</td>
                <td>Chuyện kể đêm khuya</td>
                <td>Mô tả video...</td>
                <td><span className="badge badge-pending">pending</span></td>
                <td style={{ color: 'var(--text-3)' }}>—</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="form-hint" style={{ marginTop: 10 }}>
          Cột G (status): <code>pending</code> → sẽ upload; <code>posted</code> → đã xong; <code>error</code> → bị lỗi.<br/>
          Cột H (fb_video_id): tự động điền sau khi upload thành công.
        </p>
      </div>

      {/* Queue sections */}
      <QueueSection title={`⏳ Đang chờ (${pending.length})`} rows={pending} emptyMsg="Không có video pending" />
      {errors.length > 0 && (
        <QueueSection title={`✗ Lỗi (${errors.length})`} rows={errors} emptyMsg="" isError />
      )}
      <QueueSection title={`✓ Đã đăng (${done.length})`} rows={done} emptyMsg="Chưa có video nào được đăng" isDone />
    </div>
  )
}

function QueueSection({ title, rows, emptyMsg, isError, isDone }) {
  return (
    <div className="card" style={{ padding: 0 }}>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--bg-4)' }}>
        <span className="card-title">{title}</span>
      </div>
      {rows.length === 0 ? (
        <div style={{ padding: '20px', color: 'var(--text-3)', fontSize: 12 }}>{emptyMsg}</div>
      ) : (
        <table className="queue-table">
          <thead>
            <tr>
              <th>#</th>
              <th>File</th>
              <th>Caption</th>
              <th>Lịch đăng</th>
              {isError && <th>Lỗi</th>}
              {isDone && <th>Video ID</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.rowIndex} className={isDone ? 'done' : ''}>
                <td style={{ color: 'var(--text-3)' }}>{r.seq}</td>
                <td><span className="file-name">{r.file_name}</span></td>
                <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.caption}
                </td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                  {r.scheduled_at || '—'}
                </td>
                {isError && (
                  <td style={{ color: 'var(--red)', fontSize: 11 }}>{r._error || 'Xem log'}</td>
                )}
                {isDone && (
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                    {r.fb_video_id
                      ? <a
                          href="#"
                          onClick={() => window.api.openUrl(`https://www.facebook.com/video/${r.fb_video_id}`)}
                          style={{ color: 'var(--blue)', textDecoration: 'none' }}
                        >{r.fb_video_id}</a>
                      : '—'}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
