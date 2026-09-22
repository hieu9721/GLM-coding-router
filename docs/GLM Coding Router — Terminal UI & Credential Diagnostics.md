# GLM Coding Router — Terminal UI & Credential Diagnostics

Ngày: 2026-09-22. Trạng thái: **ĐỀ XUẤT — chỉ tài liệu, chưa triển khai**.

Bản cập nhật trước v3, tên phiên bản dự kiến **v2.1**; chưa chốt phát hành hoặc
thay đổi version package. Build spec: [terminal-ui-doctor](../specs/terminal-ui-doctor.md).

## 1. Mục tiêu

Làm cho `glm-router` dễ đọc, có bản sắc và hữu ích hơn trong PowerShell/CMD.
Người dùng cần nhìn ra ngay máy đã sẵn sàng chưa, key nào đang được chọn theo
nguồn, key đó đã được xác thực chưa, quota còn bao nhiêu và bước tiếp theo là gì.

Lỗi ưu tiên cao: `doctor` không được báo HEALTHY chỉ vì tìm thấy một chuỗi API key.
Người dùng không cần chạy thêm `usage` mới biết key hiện tại bị từ chối.

## 2. Hiện trạng đã xác nhận từ code v2.0.0

| Hiện trạng | Hệ quả |
|---|---|
| `runDoctorChecks` đánh dấu ZAI_API_KEY là OK khi resolver trả về một chuỗi | Key tồn tại bị hiểu thành key dùng được |
| `doctor --network` gửi GET không có key; HTTP dưới 500 được coi là reachable | HTTP 401 vẫn chứng minh kết nối được, không chứng minh xác thực thành công |
| Resolver ưu tiên process environment và return ngay nếu có key | Terminal/app đang mở có thể tiếp tục dùng key cũ sau khi key trong Windows được đổi |
| `usage` gọi monitor API có Authorization | Lỗi key thường chỉ xuất hiện khi người dùng xem quota |
| Các màn hình quản lý chủ yếu là dòng văn bản độc lập | Thiếu phân cấp, trạng thái khó quét và không có ngôn ngữ giao diện thống nhất |

Nguồn: [doctor.ts](../src/commands/doctor.ts),
[doctor-command.ts](../src/commands/doctor-command.ts),
[zai-key.ts](../src/core/zai-key.ts), [usage.ts](../src/commands/usage.ts),
[zai-quota.ts](../src/core/zai-quota.ts).

Đây là nguyên nhân có thể tái hiện từ logic hiện tại; chưa kết luận trường hợp của
người dùng là key bị revoke hay terminal giữ key cũ, vì chưa kiểm tra key thật.

## 3. Phạm vi bản cập nhật

| Màn hình | Kết quả mong muốn |
|---|---|
| `glm-router` | Trang bắt đầu gọn, nhóm lệnh phổ biến, hướng dẫn bước tiếp theo |
| `glm-router --help` | Giữ danh sách lệnh đầy đủ, trình bày nhất quán với trang bắt đầu |
| `doctor` | Tổng kết trạng thái, phân biệt phát hiện key / xác thực / kết nối, hướng dẫn sửa lỗi |
| `status` | Tổng quan offline; ghi rõ key chưa được xác thực trong lần chạy này |
| `usage` | Thanh quota, số dùng/còn lại, thời điểm reset, tình trạng lấy dữ liệu |

`dashboard`, `runs`, `watch` và wizard có thể dùng lại bộ trình bày ở đợt sau.
Bản này không thay dashboard thành ứng dụng toàn màn hình hay thêm menu chọn bằng
phím mũi tên. Không đổi worker protocol, routing, MCP hoặc kiến trúc provider của v3.

## 4. Hướng giao diện

Phong cách: công cụ terminal gọn, nền do terminal quyết định, tiêu đề cyan,
thành công xanh lá, cảnh báo vàng, lỗi đỏ; chữ phụ giảm độ nổi. Màu luôn đi kèm
nhãn `[OK]`, `[WARN]`, `[FAIL]`, `[INFO]` để vẫn hiểu khi tắt màu.

- Một header nhỏ với tên sản phẩm, phiên bản thực và tên màn hình.
- Các nhóm có tiêu đề và khoảng trắng rõ ràng; căn cột nhãn/giá trị.
- Chi tiết dài xuống dòng có thụt lề, không cắt mất đường dẫn hoặc lệnh sửa lỗi.
- Kết luận và hành động tiếp theo nằm ở cuối báo cáo.
- Dùng viền và thanh ASCII để PowerShell/CMD cũ vẫn hiển thị đúng; không cần font đặc biệt.
- Co bố cục theo chiều rộng: 80/120 cột có hai cột; 40 cột chuyển dòng; rất hẹp
  bỏ khung trước khi làm mất nội dung.
- Tôn trọng `NO_COLOR`, `TERM=dumb` và output chuyển qua pipe/file. JSON luôn sạch.

Các màn hình dưới đây là **wireframe**, dữ liệu minh họa; màu chưa thể hiện trong code block.
`vX.Y.Z` được thay bằng version từ package khi triển khai.

### Trang bắt đầu

```text
+----------------------------------------------------------+
| GLM CODING ROUTER  vX.Y.Z                                |
| Coding Plan workers for Claude Code and Codex            |
+----------------------------------------------------------+

  CHECK & MONITOR
  glm-router doctor       Check setup and verify API key
  glm-router status       Quick offline overview
  glm-router usage        Coding Plan quota and reset times
  glm-router dashboard    Live quota and worker activity

  WORK
  glm-worker "<task>"      Run an implementation task
  glm-review "<task>"      Run a read-only review
  glm-router runs         Inspect recorded runs

  SETUP
  glm-router init         Guided setup
  glm-router key set      Save a replacement API key

  Start with: glm-router doctor
  All commands: glm-router --help
```

Trang này không gọi mạng, không tự chạy doctor và không tự cài đặt gì.

### Doctor khi terminal đang giữ key cũ

```text
+----------------------------------------------------------+
| GLM CODING ROUTER  vX.Y.Z  /  DOCTOR                     |
| Runtime and credential diagnostics                       |
+----------------------------------------------------------+

  SYSTEM & AGENTS
  [OK]   Windows / Node.js / Claude Code
  [WARN] Codex                   Optional; not installed

  CREDENTIALS
  [OK]   Key presence            Configured
  [INFO] Selected source         Process environment
  [WARN] Saved key comparison    Different from process key
         This terminal's key takes priority over the saved key.
  [FAIL] Monitor authentication  Request rejected (HTTP 401)

  NEXT STEP
  Restart the terminal's hosting app to refresh its environment.
  If using an intentional process override, update that override.
  To replace the saved key: glm-router key set
  Then run: glm-router doctor

  RESULT  ISSUES DETECTED
```

Không hiển thị ký tự đầu/cuối của key hoặc fingerprint. Nếu key process vẫn hợp
lệ nhưng khác key đã lưu, kết quả là ATTENTION, không khẳng định key đó đã hết hạn.
Mở tab mới trong một app còn giữ environment cũ có thể chưa đủ; hướng dẫn phải nói
đến app đang chứa terminal. Shell profile đặt key riêng cũng có thể tiếp tục ghi đè.

### Usage

```text
+----------------------------------------------------------+
| GLM CODING ROUTER  vX.Y.Z  /  USAGE                      |
| Fresh Coding Plan quota snapshot                         |
+----------------------------------------------------------+

  Z.AI CODING PLAN  /  lite
  5-hour window     [#########-----------] 45% used
                    900 / 2000 credits | 1100 remaining
                    Resets: 2026-09-22T18:00:00.000Z

  weekly            [#################---] 85% used
                    8500 / 10000 credits | 1500 remaining
                    Resets: 2026-09-28T18:00:00.000Z

  LOCAL BENCHMARKS
  Runs              3
  Tokens            7055 in / 2240 out

  OTHER PROVIDERS
  Claude / Codex    Usage unavailable through this CLI
```

Thanh biểu diễn **đã dùng**, không phải còn lại: xanh dưới 70%, vàng 70–<90%,
đỏ từ 90%. Đây chỉ là ngưỡng hiển thị; không thay chính sách routing. Dữ liệu thiếu
hiện `unknown`, không biến thành quota bằng 0 hoặc thanh trống ngụ ý chưa dùng.

## 5. Hành vi mới của doctor

`doctor` mặc định kiểm tra online bằng một request monitor giống `usage`, với key
thực tế resolver sẽ chọn. Không gọi model và không tạo coding task. `--offline`
cho phép chỉ kiểm tra local; `--network` giữ tùy chọn kiểm tra thêm kết nối endpoint
Anthropic đã cấu hình. Kết nối và xác thực là hai dòng khác nhau.

| Tình huống | Kết quả hiển thị | Exit |
|---|---|---|
| Key được monitor chấp nhận, local bắt buộc đạt | HEALTHY | 0 |
| Key được chấp nhận nhưng process khác key đã lưu | ATTENTION | 0 |
| Key được chấp nhận nhưng không đọc được store để so sánh | ATTENTION | 0 |
| Thiếu key hoặc thiếu thành phần bắt buộc | ISSUES | 1 |
| HTTP 401 hoặc 403 | ISSUES; key bị từ chối hoặc quyền truy cập bị từ chối | 1 |
| Provider trả lỗi nghiệp vụ chưa phân loại | UNVERIFIED; hiển thị lỗi provider, không kết luận key sai | 1 |
| Timeout, mạng lỗi, 429, 5xx, response không đúng định dạng | UNVERIFIED | 1 |
| Key được chấp nhận nhưng kiểm tra thêm `--network` không đạt | UNVERIFIED; kết nối endpoint chưa đạt | 1 |
| `--offline`, kiểm tra local đạt | UNVERIFIED; authentication skipped | 0 |
| `--offline`, local không đạt | ISSUES | 1 |
| `--offline --network` | Lỗi tham số | 2 |

HEALTHY nghĩa là các kiểm tra bắt buộc đã đạt và key được **monitor endpoint**
chấp nhận; không hứa mọi model đều chạy được. Quota bằng 0 không biến key hợp lệ
thành key không hợp lệ. Codex/skill tùy chọn vắng mặt vẫn là cảnh báo thông thường.

Một key đã đổi trên web Z.ai chỉ có thể bị phát hiện qua phản hồi của provider.
Nếu key cũ vẫn hợp lệ và không có key mới trong local store, router không có bằng
chứng để nói key đã đổi. Bản cập nhật không lưu lịch sử key để suy đoán điều đó.

## 6. Triển khai dự kiến

1. Sửa độ tin cậy của doctor: phân loại response, kiểm tra key, chẩn đoán hai nguồn,
   test các trường hợp lỗi và đảm bảo không lộ secret.
2. Tạo bộ trình bày terminal dùng chung, kiểm tra màu, độ rộng và pipe.
3. Áp dụng vào bốn màn hình; giữ nguyên payload máy đọc được ở status/usage.
4. Nghiệm thu PowerShell 5.1, PowerShell 7 và CMD; cập nhật hướng dẫn rồi mới
   chuẩn bị phát hành theo yêu cầu riêng.

Spec kỹ thuật ghi rõ file, hợp đồng dữ liệu và test matrix. Tài liệu này và spec
đều đang ở trạng thái đề xuất; mọi ô nghiệm thu vẫn chưa đánh dấu.
