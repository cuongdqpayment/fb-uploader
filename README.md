# FB Video Uploader

Ứng dụng desktop (Electron + React) tự động đăng video dạng **Reels** lên nhiều **Facebook Page** khác nhau, dựa trên danh sách lấy từ **Google Sheet**. App điều khiển một cửa sổ Chrome thật (qua Puppeteer, kết nối vào Chrome đang chạy sẵn với remote-debugging-port) để bấm đúng các nút trên giao diện Facebook — không dùng API Facebook — nên hoạt động giống người dùng thật thao tác tay: chọn đúng Trang, tải file, chờ quét bản quyền, điền mô tả, đăng bài, rồi ghi lại kết quả (trạng thái + link video) ngược lại vào Google Sheet.

## Tính năng chính

- **Đa kênh (multi-channel)**: quản lý nhiều Facebook Page cùng lúc, mỗi kênh có Google Sheet, thư mục video và cấu hình riêng.
- **Tự động chuyển đúng Trang**: trước khi đăng, app tự bấm avatar → tìm đúng tên Trang trong menu "Chuyển nhanh trang cá nhân" (bấm "Xem tất cả trang cá nhân" nếu chưa thấy) để đảm bảo đăng đúng kênh.
- **Tự động hoá toàn bộ luồng đăng Reels**: mở trang Reels → "Tạo thước phim" → chọn file (chặn dialog chọn file gốc của OS, inject file trực tiếp) → chờ Facebook quét bản quyền xong ("an toàn để đăng") → bấm "Tiếp" 2 lần → điền mô tả → bấm "Đăng" → bắt video ID (qua network response, hoặc fallback bằng cách refresh trang Reels để so sánh danh sách reel mới xuất hiện).
- **Đọc/ghi Google Sheet**: đọc danh sách video cần đăng (status = `pending`) và ghi lại `status`, `fb_video_id`, link Reel sau khi đăng xong hoặc lỗi.
- **Lên lịch đăng theo giờ**: mỗi dòng video có thể có `scheduled_at`; app chỉ đăng những video đã đến giờ (chế độ "Theo lịch"), hoặc đăng ngay toàn bộ (chế độ "Chạy ngay").
- **Scheduler nền (cron)**: bật một công tắc để app tự động kiểm tra & đăng theo chu kỳ (cron expression cấu hình được), không cần mở tay.
- **Cấu hình delay chi tiết**: có thể chỉnh từng khoảng chờ trong luồng đăng (delay ngẫu nhiên kiểu người dùng thật, thời gian chờ quét bản quyền, khoảng refresh tìm link...) để thích nghi với tốc độ máy/mạng.
- **Log Panel + Log Level**: xem log theo thời gian thực ngay trong app, lọc theo mức độ `error` / `warn` / `info` / `debug`.

## Kiến trúc & Tech stack

| Thành phần | Công nghệ |
|---|---|
| Desktop shell | **Electron** (main + renderer process, IPC qua `contextBridge`) |
| Giao diện | **React 18** + Vite |
| Điều khiển trình duyệt | **puppeteer-core** — kết nối vào Chrome thật qua `http://localhost:9222` (remote debugging), không tải Chrome riêng |
| Dữ liệu đầu vào | **Google Sheets API** (`googleapis`, xác thực bằng Service Account) |
| Lưu cấu hình local | **electron-store** |
| Lịch chạy nền | **node-cron** |

Vì Puppeteer **kết nối** (không launch) vào một Chrome đang chạy sẵn, app tận dụng được **session đăng nhập Facebook có sẵn** trong Chrome đó — không cần tự động hoá bước đăng nhập/2FA.

## Cấu trúc thư mục

```
fb-uploader/
├── src/
│   ├── main/
│   │   ├── index.js       # Toàn bộ logic chính: window, IPC, Puppeteer automation,
│   │   │                  # Google Sheets, cron scheduler (~1550 dòng)
│   │   └── preload.js     # Cầu nối an toàn main ⇄ renderer (contextBridge)
│   └── renderer/
│       ├── main.jsx, index.html
│       ├── App.jsx        # Shell: sidebar điều hướng + Log Panel
│       ├── components/LogPanel.jsx
│       ├── pages/
│       │   ├── Dashboard.jsx    # Trang chính: chạy upload, xem trạng thái theo kênh
│       │   ├── QueuePage.jsx    # Xem danh sách video (pending/posted/error), test kết nối Sheet
│       │   └── SettingsPage.jsx # Cấu hình global + cấu hình từng kênh
│       └── styles/global.css
├── vite.config.js
└── package.json
```

## Cài đặt

### Yêu cầu

- Node.js ≥ 18
- Google Chrome đã cài trên máy
- Một Google Cloud Service Account có quyền truy cập Google Sheets API

### Chạy development

```bash
npm install
npm run dev
```

`npm run dev` chạy song song Vite dev server (renderer) và Electron (main), tự chờ Vite sẵn sàng rồi mới mở cửa sổ app.

### Build bản đóng gói

```bash
npm run build:mac      # macOS (.dmg)
npm run build:win      # Windows (.exe/NSIS)
npm run build:linux    # Linux (.AppImage)
```

## Cấu hình

### 1. Chuẩn bị Chrome chạy với remote-debugging-port

App **không tự mở Chrome mới để login** — nó kết nối vào một cửa sổ Chrome bạn đã mở sẵn (đã đăng nhập Facebook), qua cổng debug `9222`. Có 2 cách:

- **Cách khuyến nghị**: viết một script shell (VD `~/start-fb-uploader.sh`) tự khởi động Chrome với flag:
  ```bash
  google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.fb-uploader-chrome-profile"
  ```
  Sau đó khai báo đường dẫn script này trong tab **Cấu hình → Global → Chrome Browser → Script khởi động Chrome**. App sẽ tự gọi script này nếu phát hiện cổng 9222 chưa hoạt động, rồi chờ tối đa 30s để Chrome sẵn sàng.
- **Cách dự phòng**: nếu không có script và cổng 9222 không sống, app sẽ tự mở một Chrome **mới hoàn toàn** bằng Puppeteer (chưa có session đăng nhập Facebook → phải tự đăng nhập tay trong cửa sổ đó).

> Nếu Chrome của bạn đã đăng nhập sẵn Facebook và luôn chạy với `--remote-debugging-port=9222`, không cần cấu hình script — app tự kết nối được ngay.

### 2. Google Cloud Service Account

1. Vào [Google Cloud Console](https://console.cloud.google.com) → **IAM & Admin → Service Accounts → Create**.
2. Vào **Keys → Add Key → JSON**, tải file JSON về máy.
3. Bật **Google Sheets API** trong Library.
4. Mở từng Google Sheet cần dùng → **Share** với email của Service Account (email dạng `...@...iam.gserviceaccount.com`).
5. Trong app, vào **Cấu hình → Global → Google Service Account**, chọn file JSON vừa tải. File này dùng chung cho **tất cả các kênh**.

### 3. Chuẩn bị Google Sheet cho mỗi kênh

Tạo (hoặc dùng) một sheet/tab với các cột theo đúng thứ tự:

| Cột | Tên | Ý nghĩa |
|---|---|---|
| A | `seq` | Số thứ tự (chỉ để hiển thị) |
| B | `file_name` | Tên file video, **hoặc đường dẫn tuyệt đối** (VD `/Users/.../video.mp4`) |
| C | `file_path` | (dự trữ, chưa dùng — để trống) |
| D | `scheduled_at` | Thời điểm dự kiến đăng, định dạng `YYYY-MM-DD HH:mm:ss` hoặc `DD/MM/YYYY HH:mm:ss` (giờ Việt Nam, GMT+7) |
| E | `caption` | Chú thích ngắn — được ghép vào đầu nội dung mô tả khi đăng |
| F | `description` | Mô tả chi tiết — được ghép sau `caption` |
| G | `status` | `pending` → sẽ upload; `posted` → đã đăng; `error` → bị lỗi (app tự cập nhật cột này) |
| H | `fb_video_id` | ID video Facebook sau khi đăng (app tự điền) |
| I | `reel_link` | Link Reels đầy đủ (app tự điền) |

**Cách resolve đường dẫn video (cột B `file_name`)**:
- Nếu là đường dẫn tuyệt đối (bắt đầu bằng `/`) → dùng **nguyên văn**, không ghép thêm gì.
- Nếu chỉ là tên file / đường dẫn tương đối (VD `abc/video.mp4`) → ghép với **Thư mục chứa video** cấu hình ở tab kênh tương ứng.

**Nội dung mô tả khi đăng** = `caption` + xuống dòng + `description` (ghép cả 2, không chỉ dùng riêng `description`). Nếu chỉ có 1 trong 2 cột thì dùng đúng cột đó; nếu cả 2 đều trống thì bỏ qua bước điền mô tả.

App chỉ lấy các dòng có `status = pending` **và** có `file_name` — các trạng thái khác (`draft`, `posted`, `error`, ...) bị bỏ qua ngay khi đọc Sheet, không load vào bộ nhớ.

### 4. Cấu hình từng kênh trong app

Vào tab **Cấu hình**, mỗi kênh là một tab riêng gồm:

- **Tên kênh**: phải khớp (hoặc là một phần của) tên hiển thị của Trang Facebook trong menu "Chuyển nhanh trang cá nhân" — app dùng tên này để tìm và click đúng Trang.
- **Sheet ID**: lấy từ URL `docs.google.com/spreadsheets/d/[ID]/edit`.
- **Tên Sheet Tab**: tên tab chứa dữ liệu (mặc định `upload_facebook`).
- **URL Facebook Page**: URL trang của kênh này (app tự thêm `?sk=reels_tab` để vào thẳng tab Reels).
- **Thư mục chứa video**: thư mục chứa các file `.mp4` — `file_name` trong Sheet sẽ được ghép với thư mục này (trừ khi `file_name` là đường dẫn tuyệt đối).
- **Bật/tắt kênh**: kênh tắt sẽ bị bỏ qua khi chạy "tất cả kênh" hoặc theo scheduler.
- **Bỏ qua kiểm tra bản quyền**: bật nếu đây là **Facebook cá nhân chưa bật Chế độ chuyên nghiệp** — Facebook không quét bản quyền nên không bao giờ hiện "an toàn để đăng"; khi bật, app chuyển sang chờ nút **"Tiếp"** tự bật lên (hết bị khoá) sau khi upload xong, thay vì chờ thông báo đó. Mặc định tắt (dùng cho Trang/tài khoản Chuyên nghiệp có quét bản quyền như bình thường).

Cấu hình **Global** dùng chung cho mọi kênh: Service Account, Chrome, Scheduler (cron + delay giữa các video), Log Level, và bảng **Delay Upload** (tinh chỉnh từng bước trễ trong luồng đăng để giả lập thao tác người dùng thật và chờ Facebook xử lý).

## Cách dùng

1. Thêm các dòng video mới vào Google Sheet của từng kênh, với `status = pending`.
2. Mở app → tab **Dashboard**: xem thống kê tổng/chờ đăng/đã đăng/lỗi, chọn kênh (tab) muốn xem/đăng.
3. Với mỗi kênh (hoặc toàn bộ), có 2 chế độ chạy:
   - **▶ Chạy ngay**: bỏ qua giờ đã đặt, đăng toàn bộ video `pending` ngay lập tức.
   - **🕐 Theo lịch**: chỉ đăng những video có `scheduled_at` đã đến giờ (giờ VN); nếu chưa có video nào đến giờ, log sẽ báo video gần nhất sẽ đến giờ lúc nào.
4. Hoặc bật công tắc **⏱ Tự động chạy tất cả kênh** để scheduler nền (cron) tự kiểm tra & đăng định kỳ mà không cần thao tác thêm — trạng thái bật/tắt được lưu và tự khôi phục khi mở lại app.
5. Theo dõi tiến trình qua **Log Panel** ở cuối màn hình (có thể thu gọn), hoặc bấm **■ Dừng** để huỷ giữa chừng.
6. Sau khi đăng xong, kiểm tra kết quả tại tab **Queue** (danh sách theo trạng thái, có link video đã đăng) hoặc trực tiếp trên Google Sheet.

## Luồng tự động hoá (tóm tắt kỹ thuật)

Với mỗi video đến lượt đăng, [`ReelUploadAction`](src/main/automation/reelUploadAction.js) (kế thừa [`BaseFacebookAction`](src/main/automation/baseFacebookAction.js)) thực hiện:

1. Mở/tái sử dụng tab Facebook, gọi `switchToPage()` để chắc chắn đang ở đúng Trang (bấm avatar → tìm tên kênh trong menu, bấm "Xem tất cả trang cá nhân" nếu cần).
2. Điều hướng tới `<pageUrl>?sk=reels_tab`, bấm **"Tạo thước phim"**.
3. Dùng `page.waitForFileChooser()` để **chặn dialog chọn file gốc của hệ điều hành** và inject thẳng đường dẫn video (fallback: gán trực tiếp vào `<input type="file">` nếu không bắt được dialog).
4. Chờ Facebook xử lý xong upload — mặc định chờ thông báo **"Thước phim của bạn an toàn để đăng!"** (đã quét bản quyền xong); nếu kênh bật **Bỏ qua kiểm tra bản quyền**, thay vào đó chỉ chờ nút **"Tiếp"** hết bị khoá (`aria-disabled`/`pointer-events`) — timeout theo `safeToPostTimeoutMin` (mặc định 10 phút).
5. Bấm **"Tiếp"** hai lần (qua các delay ngẫu nhiên cấu hình được, mô phỏng người dùng thật).
6. Điền **mô tả** = `caption` + xuống dòng + `description` (paste qua clipboard thay vì gõ, tránh gợi ý tự động của Facebook).
7. Bấm **"Đăng"**; đồng thời lắng nghe network response để bắt `video_id`/`reel_id` trong response GraphQL. Nếu không bắt được, tự động **refresh lại trang Reels nhiều lần** và so sánh danh sách reel trước/sau để tìm ID mới.
8. Ghi kết quả (`status`, `fb_video_id`, link) ngược lại vào Google Sheet.

## Lưu ý

- **Facebook thay đổi giao diện thường xuyên** → nếu app không tìm thấy nút/menu (avatar, "Tạo thước phim", "Tiếp", "Đăng"...), cần cập nhật lại các selector/text tương ứng trong [src/main/index.js](src/main/index.js).
- App tìm phần tử chủ yếu theo **text hiển thị tiếng Việt** (VD "Tiếp", "Đăng", "Xem tất cả trang cá nhân") — nếu giao diện Facebook của bạn đang ở ngôn ngữ khác, cần chỉnh lại danh sách text tương ứng.
- Nên **tắt Headless mode** khi mới cấu hình một kênh, để quan sát Chrome thao tác và phát hiện sớm nếu có bước bị lệch.
- Cột `scheduled_at` trong Sheet được parse ưu tiên theo định dạng **ngày Việt Nam (D/M/YYYY)** khi có thể nhập nhằng (cả ngày và tháng đều ≤ 12).
- File Service Account JSON là dữ liệu nhạy cảm — không commit vào git (đã có trong `.gitignore` qua pattern `assets/*.json`).
- Khuyến nghị delay giữa các video: 15–30 giây (điều chỉnh trong **Cấu hình → Global → Scheduler**); còn thời gian chờ trong từng bước đăng bài chỉnh riêng ở mục **Delay Upload**.
