import React, { useState, useEffect } from 'react'

// Tạo ID ngẫu nhiên cho channel mới
const genId = () => 'ch_' + Math.random().toString(36).slice(2, 8)

export default function SettingsPage() {
  const [cfg, setCfg]           = useState(null)
  const [saved, setSaved]       = useState(false)
  const [activeTab, setActiveTab] = useState('global') // 'global' | channelId

  useEffect(() => {
    window.api.getConfig().then(cfg => {
      // Migrate: nếu config cũ (single channel), convert sang channels[]
      if (!cfg.channels) {
        cfg.channels = [{
          id: 'channel_1',
          name: 'Kênh 1',
          enabled: true,
          sheetId: cfg.sheetId || '',
          sheetTab: cfg.sheetTab || 'upload_facebook',
          pageUrl: cfg.facebookPageUrl || '',
          videoBaseDir: cfg.videoBaseDir || '',
        }]
      }
      setCfg(cfg)
    })
  }, [])

  if (!cfg) return <div style={{ color: 'var(--text-3)', padding: 24 }}>Đang tải...</div>

  const setGlobal = (key, val) => setCfg(prev => ({ ...prev, [key]: val }))

  // Helper: set delay sub-field
  const setDelay = (key, val) => setCfg(prev => ({
    ...prev,
    delay: { ...(prev.delay || {}), [key]: val }
  }))

  const setChannel = (id, key, val) => setCfg(prev => ({
    ...prev,
    channels: prev.channels.map(ch => ch.id === id ? { ...ch, [key]: val } : ch)
  }))

  const addChannel = () => {
    const newCh = {
      id: genId(),
      name: `Kênh ${(cfg.channels?.length || 0) + 1}`,
      enabled: true,
      sheetId: '',
      sheetTab: 'upload_facebook',
      pageUrl: '',
      videoBaseDir: '',
    }
    const updated = [...(cfg.channels || []), newCh]
    setCfg(prev => ({ ...prev, channels: updated }))
    setActiveTab(newCh.id)
  }

  const removeChannel = (id) => {
    if (cfg.channels.length <= 1) return alert('Phải có ít nhất 1 kênh!')
    if (!confirm('Xoá kênh này?')) return
    setCfg(prev => ({ ...prev, channels: prev.channels.filter(c => c.id !== id) }))
    setActiveTab('global')
  }

  const save = async () => {
    await window.api.setConfig(cfg)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const pickFile = async (filters, callback) => {
    const p = await window.api.openFile(filters)
    if (p) callback(p)
  }

  const pickDir = async (callback) => {
    const p = await window.api.openDir()
    if (p) callback(p)
  }

  const channels = cfg.channels || []
  const activeChannel = channels.find(c => c.id === activeTab)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 760 }}>
      {/* Header */}
      <div className="section-header">
        <div>
          <div className="section-title">Cấu hình</div>
          <div className="section-sub">Global settings + {channels.length} kênh</div>
        </div>
        <button className="btn btn-primary" onClick={save}>
          {saved ? '✓ Đã lưu' : '💾 Lưu'}
        </button>
      </div>

      {/* Tab bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 0,
        background: 'var(--bg-1)', borderRadius: 'var(--r-lg)',
        border: '1px solid var(--bg-4)', overflow: 'hidden',
      }}>
        {/* Global tab */}
        <div
          onClick={() => setActiveTab('global')}
          style={{
            padding: '10px 16px', cursor: 'pointer', fontSize: 13, fontWeight: 600,
            borderRight: '1px solid var(--bg-4)',
            color: activeTab === 'global' ? 'var(--blue)' : 'var(--text-2)',
            background: activeTab === 'global' ? 'var(--blue-glow)' : 'transparent',
          }}
        >
          ⚙ Global
        </div>

        {/* Channel tabs */}
        {channels.map(ch => (
          <div
            key={ch.id}
            onClick={() => setActiveTab(ch.id)}
            style={{
              padding: '10px 16px', cursor: 'pointer', fontSize: 13, fontWeight: 600,
              borderRight: '1px solid var(--bg-4)',
              color: activeTab === ch.id ? 'var(--blue)' : 'var(--text-2)',
              background: activeTab === ch.id ? 'var(--blue-glow)' : 'transparent',
              display: 'flex', alignItems: 'center', gap: 8,
              opacity: ch.enabled ? 1 : 0.5,
            }}
          >
            {ch.name}
            {!ch.enabled && <span style={{ fontSize: 10, color: 'var(--text-3)' }}>tắt</span>}
          </div>
        ))}

        {/* Nút thêm kênh */}
        <div
          onClick={addChannel}
          style={{
            padding: '10px 14px', cursor: 'pointer',
            color: 'var(--text-3)', fontSize: 18, fontWeight: 300,
            marginLeft: 'auto',
          }}
          title="Thêm kênh mới"
        >
          +
        </div>
      </div>

      {/* ── Global settings ── */}
      {activeTab === 'global' && (
        <>
          <div className="card">
            <div className="card-title" style={{ marginBottom: 16 }}>🔑 Google Service Account</div>
            <div className="form-group">
              <label className="form-label">Service Account JSON</label>
              <div className="input-row">
                <input type="text" value={cfg.serviceAccountPath || ''} readOnly placeholder="Chọn file JSON..." />
                <button className="btn btn-ghost"
                  onClick={() => pickFile([{ name: 'JSON', extensions: ['json'] }],
                    v => setGlobal('serviceAccountPath', v))}>
                  Chọn file
                </button>
              </div>
              <p className="form-hint">
                Dùng chung cho tất cả kênh. Share từng Google Sheet với email của Service Account.&nbsp;
                <a href="#" onClick={() => window.api.openUrl('https://console.cloud.google.com/iam-admin/serviceaccounts')}
                  style={{ color: 'var(--blue)' }}>Tạo tại đây</a>
              </p>
            </div>
          </div>

          <div className="card">
            <div className="card-title" style={{ marginBottom: 16 }}>🌐 Chrome Browser</div>

            {/* Script khởi động Chrome — ưu tiên dùng thay chromePath */}
            <div className="form-group">
              <label className="form-label">Script khởi động Chrome</label>
              <div className="input-row">
                <input
                  type="text"
                  value={cfg.chromeStartScript || ''}
                  onChange={e => setGlobal('chromeStartScript', e.target.value)}
                  placeholder="~/start-fb-uploader.sh"
                />
                <button className="btn btn-ghost"
                  onClick={() => pickFile(
                    [{ name: 'Shell Script', extensions: ['sh', '*'] }],
                    v => setGlobal('chromeStartScript', v)
                  )}>
                  Chọn
                </button>
              </div>
              <p className="form-hint">
                App tự gọi script này nếu Chrome chưa chạy trước khi upload.<br />
                Script phải khởi động Chrome với <code>--remote-debugging-port=9222</code>.<br />
                VD: <code>~/start-fb-uploader.sh</code>
              </p>
            </div>

            <div className="divider" />

            <div className="form-group">
              <label className="form-label">Đường dẫn Chrome (fallback)</label>
              <div className="input-row">
                <input type="text" value={cfg.chromePath || ''} readOnly placeholder="Tự động tìm..." />
                <button className="btn btn-ghost"
                  onClick={() => pickFile([{ name: 'Executable', extensions: ['*'] }],
                    v => setGlobal('chromePath', v))}>
                  Chọn
                </button>
              </div>
              <p className="form-hint">
                Chỉ dùng khi không có script. Để trống để tự động tìm.<br />
                Ubuntu: <code>/usr/bin/google-chrome</code> ·
                Mac: <code>/Applications/Google Chrome.app/Contents/MacOS/Google Chrome</code>
              </p>
            </div>

            <div className="divider" />
            <div className="toggle-row">
              <div className="toggle-info">
                <div className="toggle-name">Headless mode</div>
                <div className="toggle-desc">Chạy Chrome ẩn. Tắt khi debug.</div>
              </div>
              <label className="switch">
                <input type="checkbox" checked={cfg.headless || false}
                  onChange={e => setGlobal('headless', e.target.checked)} />
                <span className="slider-track" />
              </label>
            </div>
          </div>

          <div className="card">
            <div className="card-title" style={{ marginBottom: 16 }}>⏱ Scheduler</div>
            <div className="form-group">
              <label className="form-label">Cron Expression</label>
              <input type="text" value={cfg.scheduleCron || '*/15 * * * *'}
                onChange={e => setGlobal('scheduleCron', e.target.value)}
                placeholder="*/15 * * * *" />
              <p className="form-hint">
                <code>*/15 * * * *</code> = 15 phút &nbsp;·&nbsp;
                <code>0 * * * *</code> = mỗi giờ &nbsp;·&nbsp;
                <code>0 8 * * *</code> = 8h sáng
              </p>
            </div>
            <div className="form-group">
              <label className="form-label">Delay giữa các video (giây)</label>
              <input type="number" value={cfg.delayBetween || 15}
                onChange={e => setGlobal('delayBetween', parseInt(e.target.value) || 15)}
                min={5} max={300} style={{ width: 120 }} />
            </div>
          </div>

          {/* Log Level */}
          <div className="card">
            <div className="card-title" style={{ marginBottom: 16 }}>🔍 Log & Debug</div>
            <div className="form-group">
              <label className="form-label">Log Level</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {['error', 'warn', 'info', 'debug'].map(level => (
                  <label key={level} style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '6px 14px', borderRadius: 8, cursor: 'pointer',
                    border: `1px solid ${(cfg.logLevel || 'info') === level ? 'var(--blue)' : 'var(--bg-4)'}`,
                    background: (cfg.logLevel || 'info') === level ? 'var(--blue-glow)' : 'transparent',
                    color: (cfg.logLevel || 'info') === level ? 'var(--blue)' : 'var(--text-2)',
                    fontSize: 13, fontWeight: 600,
                  }}>
                    <input type="radio" name="logLevel" value={level}
                      checked={(cfg.logLevel || 'info') === level}
                      onChange={() => setGlobal('logLevel', level)}
                      style={{ display: 'none' }} />
                    {level === 'error' && '🔴 Error'}
                    {level === 'warn'  && '🟡 Warn'}
                    {level === 'info'  && '🔵 Info'}
                    {level === 'debug' && '🟣 Debug'}
                  </label>
                ))}
              </div>
              <p className="form-hint" style={{ marginTop: 8 }}>
                <b>Error</b>: chỉ lỗi &nbsp;·&nbsp;
                <b>Warn</b>: lỗi + cảnh báo &nbsp;·&nbsp;
                <b>Info</b>: bình thường (mặc định) &nbsp;·&nbsp;
                <b>Debug</b>: verbose, in tất cả chi tiết
              </p>
            </div>
          </div>

          {/* Delay Settings */}
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div className="card-title">⏱ Delay Upload (ms)</div>
              <button className="btn btn-ghost" style={{ fontSize: 11 }}
                onClick={() => setGlobal('delay', {})}>
                ↺ Reset mặc định
              </button>
            </div>

            {/* Hàm helper để render 1 input delay */}
            {(() => {
              const d = cfg.delay || {}
              const DEFAULTS = {
                afterFileSelect: 2000, afterEscape: 1500,
                beforeNext1Min: 2000, beforeNext1Max: 4500, afterNext1: 4500,
                beforeNext2Min: 2500, beforeNext2Max: 5000, afterNext2: 5000,
                beforeDescription: 5000, afterDescription: 5000,
                beforePublishMin: 3500, beforePublishMax: 5000,
                safeToPostTimeoutMin: 20, waitAfterPublishMin: 5,
                refreshAttempts: 3, refreshInterval: 60000,
              }
              const field = (key, label, hint, unit = 'ms') => (
                <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: 'var(--text-1)', fontWeight: 600 }}>{label}</div>
                    {hint && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 1 }}>{hint}</div>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <input type="number"
                      value={d[key] ?? DEFAULTS[key]}
                      onChange={e => setDelay(key, parseInt(e.target.value) || DEFAULTS[key])}
                      style={{ width: 90, textAlign: 'right' }}
                      min={0} step={unit === 'ms' ? 500 : 1}
                    />
                    <span style={{ fontSize: 11, color: 'var(--text-3)', width: 28 }}>{unit}</span>
                  </div>
                </div>
              )
              return (
                <div>
                  <p style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 12 }}>
                    Tăng nếu Facebook chậm / mạng chậm. Giảm nếu máy mạnh và muốn upload nhanh hơn.
                  </p>

                  {/* Upload flow */}
                  <div style={{ fontSize: 12, color: 'var(--blue)', fontWeight: 700, marginBottom: 8 }}>
                    📤 Upload & Kiểm tra bản quyền
                  </div>
                  {field('safeToPostTimeoutMin', 'Timeout chờ "an toàn để đăng"',
                    'Tăng nếu hay timeout khi Facebook quét bản quyền lâu', 'phút')}
                  {field('afterFileSelect', 'Sau khi chọn file',
                    'Chờ Facebook nhận file xong trước khi tiếp tục')}

                  {/* Tiếp bước 1 & 2 */}
                  <div style={{ fontSize: 12, color: 'var(--blue)', fontWeight: 700, margin: '12px 0 8px' }}>
                    ▶ Bước "Tiếp" lần 1 (sau upload)
                  </div>
                  {field('beforeNext1Min', 'Delay tối thiểu trước "Tiếp" 1', '')}
                  {field('beforeNext1Max', 'Delay tối đa trước "Tiếp" 1', 'Random trong khoảng min→max')}
                  {field('afterNext1', 'Sau "Tiếp" 1 — chờ màn chỉnh sửa load', '')}

                  <div style={{ fontSize: 12, color: 'var(--blue)', fontWeight: 700, margin: '12px 0 8px' }}>
                    ▶ Bước "Tiếp" lần 2 (qua màn cài đặt)
                  </div>
                  {field('beforeNext2Min', 'Delay tối thiểu trước "Tiếp" 2', '')}
                  {field('beforeNext2Max', 'Delay tối đa trước "Tiếp" 2', 'Random trong khoảng min→max')}
                  {field('afterNext2', 'Sau "Tiếp" 2 — chờ màn cài đặt load', '')}

                  {/* Mô tả & Đăng */}
                  <div style={{ fontSize: 12, color: 'var(--blue)', fontWeight: 700, margin: '12px 0 8px' }}>
                    📝 Mô tả & Đăng
                  </div>
                  {field('beforeDescription', 'Trước khi điền mô tả', 'Chờ ô mô tả sẵn sàng')}
                  {field('afterDescription', 'Sau khi điền mô tả', 'Chờ trước khi click Đăng')}
                  {field('beforePublishMin', 'Delay tối thiểu trước "Đăng"', '')}
                  {field('beforePublishMax', 'Delay tối đa trước "Đăng"', 'Random trong khoảng min→max')}

                  {/* Refresh lấy link */}
                  <div style={{ fontSize: 12, color: 'var(--blue)', fontWeight: 700, margin: '12px 0 8px' }}>
                    🔗 Refresh lấy link video
                  </div>
                  {field('waitAfterPublishMin', 'Chờ sau khi Đăng trước khi refresh',
                    'Facebook cần ~3-5 phút xử lý Reels', 'phút')}
                  {field('refreshAttempts', 'Số lần refresh tối đa', 'Nếu chưa thấy link mới', 'lần')}
                  {field('refreshInterval', 'Khoảng cách giữa mỗi lần refresh',
                    'Nếu lần refresh trước chưa thấy link')}
                </div>
              )
            })()}
          </div>
        </>
      )}

      {/* ── Channel settings ── */}
      {activeTab !== 'global' && activeChannel && (
        <>
          {/* Channel header */}
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div className="card-title">📺 Thông tin kênh</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <div className="toggle-row" style={{ border: 'none', padding: 0 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-2)', marginRight: 8 }}>
                    {activeChannel.enabled ? 'Đang bật' : 'Đang tắt'}
                  </span>
                  <label className="switch">
                    <input type="checkbox" checked={activeChannel.enabled}
                      onChange={e => setChannel(activeChannel.id, 'enabled', e.target.checked)} />
                    <span className="slider-track" />
                  </label>
                </div>
                <button className="btn btn-danger" style={{ fontSize: 11, padding: '4px 10px' }}
                  onClick={() => removeChannel(activeChannel.id)}>
                  Xoá kênh
                </button>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Tên kênh</label>
              <input type="text" value={activeChannel.name}
                onChange={e => setChannel(activeChannel.id, 'name', e.target.value)}
                placeholder="Chuyện Kể Đêm Khuya" />
            </div>
          </div>

          {/* Google Sheet */}
          <div className="card">
            <div className="card-title" style={{ marginBottom: 16 }}>📊 Google Sheet</div>
            <div className="form-group">
              <label className="form-label">Sheet ID</label>
              <input type="text" value={activeChannel.sheetId}
                onChange={e => setChannel(activeChannel.id, 'sheetId', e.target.value)}
                placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms" />
              <p className="form-hint">
                Lấy từ URL: docs.google.com/spreadsheets/d/<strong>[ID]</strong>/edit
              </p>
            </div>
            <div className="form-group">
              <label className="form-label">Tên Sheet Tab</label>
              <input type="text" value={activeChannel.sheetTab}
                onChange={e => setChannel(activeChannel.id, 'sheetTab', e.target.value)}
                placeholder="upload_facebook" />
            </div>
          </div>

          {/* Facebook Page */}
          <div className="card">
            <div className="card-title" style={{ marginBottom: 16 }}>📘 Facebook Page</div>
            <div className="form-group">
              <label className="form-label">URL Facebook Page</label>
              <input type="url" value={activeChannel.pageUrl}
                onChange={e => setChannel(activeChannel.id, 'pageUrl', e.target.value)}
                placeholder="https://www.facebook.com/YourPageName" />
              <p className="form-hint">URL của Page của kênh này.</p>
            </div>
          </div>

          {/* Video directory */}
          <div className="card">
            <div className="card-title" style={{ marginBottom: 16 }}>📁 Thư mục Video</div>
            <div className="form-group">
              <label className="form-label">Thư mục chứa video</label>
              <div className="input-row">
                <input type="text" value={activeChannel.videoBaseDir || ''} readOnly
                  placeholder="Chọn thư mục..." />
                <button className="btn btn-ghost"
                  onClick={() => pickDir(v => setChannel(activeChannel.id, 'videoBaseDir', v))}>
                  Chọn
                </button>
              </div>
              <p className="form-hint">
                Thư mục chứa file .mp4 của kênh này.<br />
                VD: <code>/data/video/{activeChannel.id}/</code>
              </p>
            </div>
          </div>
        </>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button className="btn btn-primary" onClick={save}>
          {saved ? '✓ Đã lưu' : '💾 Lưu cấu hình'}
        </button>
      </div>
    </div>
  )
}