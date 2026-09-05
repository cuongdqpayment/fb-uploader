import React, { useState, useEffect } from 'react'

export default function SettingsPage() {
  const [cfg, setCfg]     = useState(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    window.api.getConfig().then(setCfg)
  }, [])

  if (!cfg) return <div style={{ color: 'var(--text-3)', padding: 24 }}>Đang tải cấu hình...</div>

  const set = (key, val) => setCfg(prev => ({ ...prev, [key]: val }))

  const save = async () => {
    await window.api.setConfig(cfg)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const pickServiceAccount = async () => {
    const p = await window.api.openFile([{ name: 'JSON', extensions: ['json'] }])
    if (p) set('serviceAccountPath', p)
  }

  const pickChrome = async () => {
    const p = await window.api.openFile([{ name: 'Executable', extensions: ['*'] }])
    if (p) set('chromePath', p)
  }

  const pickVideoDir = async () => {
    const p = await window.api.openDir()
    if (p) set('videoBaseDir', p)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 700 }}>
      <div className="section-header">
        <div>
          <div className="section-title">Cấu hình</div>
          <div className="section-sub">Thiết lập Google Sheet, Facebook và Chrome</div>
        </div>
        <button className="btn btn-primary" onClick={save}>
          {saved ? '✓ Đã lưu' : '💾 Lưu'}
        </button>
      </div>

      {/* Google Sheets */}
      <div className="card">
        <div className="card-title" style={{ marginBottom: 16 }}>📊 Google Sheets</div>

        <div className="form-group">
          <label className="form-label">Sheet ID</label>
          <input
            type="text"
            value={cfg.sheetId}
            onChange={e => set('sheetId', e.target.value)}
            placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms"
          />
          <p className="form-hint">
            Lấy từ URL: docs.google.com/spreadsheets/d/<strong>[ID]</strong>/edit
          </p>
        </div>

        <div className="form-group">
          <label className="form-label">Tên Sheet Tab</label>
          <input
            type="text"
            value={cfg.sheetTab}
            onChange={e => set('sheetTab', e.target.value)}
            placeholder="Facebook Queue"
          />
        </div>

        <div className="form-group">
          <label className="form-label">Service Account JSON</label>
          <div className="input-row">
            <input type="text" value={cfg.serviceAccountPath} readOnly placeholder="Chọn file JSON..." />
            <button className="btn btn-ghost" onClick={pickServiceAccount}>Chọn file</button>
          </div>
          <p className="form-hint">
            Tạo Service Account trong Google Cloud Console →&nbsp;
            <a
              href="#"
              onClick={() => window.api.openUrl('https://console.cloud.google.com/iam-admin/serviceaccounts')}
              style={{ color: 'var(--blue)' }}
            >IAM & Admin → Service Accounts</a>
            &nbsp;→ tải JSON key → share Sheet với email của Service Account.
          </p>
        </div>
      </div>

      {/* Facebook */}
      <div className="card">
        <div className="card-title" style={{ marginBottom: 16 }}>📘 Facebook Page</div>

        <div className="form-group">
          <label className="form-label">URL Facebook Page</label>
          <input
            type="url"
            value={cfg.facebookPageUrl}
            onChange={e => set('facebookPageUrl', e.target.value)}
            placeholder="https://www.facebook.com/YourPageName"
          />
          <p className="form-hint">URL của Page anh muốn đăng video lên.</p>
        </div>
      </div>

      {/* Files */}
      <div className="card">
        <div className="card-title" style={{ marginBottom: 16 }}>📁 Thư mục Video</div>

        <div className="form-group">
          <label className="form-label">Thư mục chứa video</label>
          <div className="input-row">
            <input type="text" value={cfg.videoBaseDir || ''} readOnly placeholder="Chọn thư mục..." />
            <button className="btn btn-ghost" onClick={pickVideoDir}>Chọn</button>
          </div>
          <p className="form-hint">
            Thư mục chứa các file .mp4. Cột <code>file_name</code> trong Sheet sẽ được ghép với thư mục này.
            <br/>Ubuntu: <code>/data/video/output/upload-youtube-automation</code>
          </p>
        </div>
      </div>

      {/* Chrome */}
      <div className="card">
        <div className="card-title" style={{ marginBottom: 16 }}>🌐 Chrome Browser</div>

        <div className="form-group">
          <label className="form-label">Đường dẫn Chrome</label>
          <div className="input-row">
            <input type="text" value={cfg.chromePath} readOnly placeholder="Tự động tìm..." />
            <button className="btn btn-ghost" onClick={pickChrome}>Chọn</button>
          </div>
          <p className="form-hint">
            Để trống để tự động tìm Chrome. Nếu không tìm được, chọn thủ công.<br/>
            Ubuntu: <code>/usr/bin/google-chrome</code> &nbsp;|&nbsp;
            Mac: <code>/Applications/Google Chrome.app/Contents/MacOS/Google Chrome</code> &nbsp;|&nbsp;
            Win: <code>C:\Program Files\Google\Chrome\Application\chrome.exe</code>
          </p>
        </div>

        <div className="divider" />

        <div className="toggle-row">
          <div className="toggle-info">
            <div className="toggle-name">Headless mode</div>
            <div className="toggle-desc">Chạy Chrome ẩn (không hiện cửa sổ). Tắt khi debug.</div>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={cfg.headless}
              onChange={e => set('headless', e.target.checked)}
            />
            <span className="slider-track" />
          </label>
        </div>
      </div>

      {/* Scheduler */}
      <div className="card">
        <div className="card-title" style={{ marginBottom: 16 }}>⏱ Scheduler</div>

        <div className="form-group">
          <label className="form-label">Cron Expression</label>
          <input
            type="text"
            value={cfg.scheduleCron}
            onChange={e => set('scheduleCron', e.target.value)}
            placeholder="*/15 * * * *"
          />
          <p className="form-hint">
            <code>*/15 * * * *</code> = mỗi 15 phút &nbsp;|&nbsp;
            <code>0 * * * *</code> = mỗi giờ &nbsp;|&nbsp;
            <code>0 8 * * *</code> = 8:00 sáng mỗi ngày
          </p>
        </div>

        <div className="form-group">
          <label className="form-label">Delay giữa các video (giây)</label>
          <input
            type="number"
            value={cfg.delayBetween}
            onChange={e => set('delayBetween', parseInt(e.target.value) || 15)}
            min={5}
            max={300}
            style={{ width: 120 }}
          />
        </div>
      </div>

      {/* Save */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn btn-primary" onClick={save}>
          {saved ? '✓ Đã lưu' : '💾 Lưu cấu hình'}
        </button>
      </div>
    </div>
  )
}
