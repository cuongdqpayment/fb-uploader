# FB Video Uploader

Ứng dụng Electron tự động upload video lên Facebook Page từ Google Sheet.

## Tech Stack

- **Electron** — desktop app, cross-platform (Ubuntu / Mac / Windows)
- **React** — giao diện
- **Puppeteer** — điều khiển Chrome tự động
- **Google Sheets API** — đọc/ghi danh sách video

## Cài đặt

### Yêu cầu

- Node.js ≥ 18
- Google Chrome đã cài
- Google Cloud Service Account

### Chạy development

```bash
npm install
npm run dev
```

### Build

```bash
# Ubuntu/Linux
npm run build:linux

# macOS
npm run build:mac

# Windows
npm run build:win
```

## Cấu hình

### 1. Google Cloud Service Account

1. Vào [Google Cloud Console](https://console.cloud.google.com)
2. **IAM & Admin → Service Accounts → Create**
3. Tên: `fb-uploader`
4. **Keys → Add Key → JSON** → tải file về
5. Enable **Google Sheets API** trong Library
6. Mở Google Sheet → **Share** với email của Service Account

### 2. Google Sheet

Tạo Sheet với các cột:

| A: seq | B: file_name | C: scheduled_at | D: caption | E: description | F: status | G: fb_video_id |
|--------|-------------|-----------------|------------|----------------|-----------|----------------|
| 1 | story1.mp4 | 2026-09-05 19:00:00 | Chuyện kể... | Mô tả | pending | |

### 3. Cấu hình App

Mở tab **Cấu hình** trong app:

- **Sheet ID**: lấy từ URL Google Sheet
- **Service Account JSON**: chọn file JSON đã tải
- **Facebook Page URL**: URL Page của anh
- **Thư mục video**: thư mục chứa file .mp4
- **Chrome path**: để trống để tự tìm

## Cách dùng

1. Thêm video vào Google Sheet với `status = pending`
2. Mở app → **Dashboard**
3. Bấm **▶ Chạy ngay** để upload ngay
4. Hoặc bật **Tự động chạy** để scheduler tự xử lý

## Lưu ý

- Facebook thay đổi UI thường xuyên → cập nhật selector trong `src/main/index.js` nếu cần
- Tắt **Headless mode** khi debug để thấy Chrome thao tác
- Delay giữa các video: khuyến nghị 15–30 giây
