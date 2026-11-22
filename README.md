# Robot 2027 Pro — Phiên Bản V1.4 Pro (Update 8)

Gói mã nguồn đầy đủ kiến trúc Hybrid Capacitor 6 + Android Native Java cho Robot 2027.

## Các nâng cấp chính trong Update 8:
1. **Kiến trúc Giọng nói 3 Chế độ & Chống Tự Nghe Lặp Lại (`www/app.js` & `RobotNativePlugin.java`)**:
   - **Chế độ 1 (`COMMAND_IDLE`)**: Gỡ bỏ hoàn toàn câu nhắc chen ngang sau 10s. Nghỉ 850ms sau `ttsEnd` trước khi mở lại mic, lọc bỏ tiếng vọng trùng >60% trong 4.5s, và không phát lại TTS khi câu chưa khớp lệnh.
   - **Chế độ 2 (`TOPIC_SELECT`)**: Đọc/hiển thị danh sách chủ đề kèm số ID, bắt lệnh chọn số hoặc tên chủ đề, và hỏi chọn **Học theo thứ tự** hay **Học ngẫu nhiên** (kèm 2 nút chạm nhanh).
   - **Chế độ 3 (`LESSON_LOCKED`)**: Khóa hoàn toàn mic nghe lệnh tự do khi mở bảng luyện đọc; chỉ thu âm tiếng Anh 1 lượt khi bấm nút `🎤 Bé đọc` hoặc nút cứng `BTN_2`.
2. **Bàn Phím Ảo Toàn Diện (`#virtual-kb-modal`)**:
   - Hỗ trợ chuyển đổi mượt giữa **Numpad (`0–9`)** và **QWERTY đầy đủ (`a–z`, Shift, số, ký tự đặc biệt)** cho tất cả ô mật khẩu/PIN (Đổi PIN Phụ huynh, Mật khẩu Wi-Fi, PIN Bluetooth BLE, Mã Nhà phát triển).
3. **Quét & Cấu hình Bluetooth BLE Trực Tiếp Trong App (`#ble-modal`)**:
   - Sử dụng `BleClient.requestLEScan()` đổ danh sách thiết bị theo thời gian thực vào giao diện App, ưu tiên thiết bị `ESP32`/`Robot`, lưu PIN và tự động kết nối lại ở các lần khởi động sau.
4. **QR Code Cố Định & Camera Giám Sát P2P 24/7 (`www/qrcode.min.js` & `camera_live.php`)**:
   - Sinh mã QR offline trỏ tới `camera_live.php?uid=<DEVICE_UID>` theo mã phần cứng cố định của Robot.
   - Chạy bộ lắng nghe tín hiệu ngầm mỗi 2.5s để tự động bật Camera trước và truyền hình ảnh/âm thanh WebRTC P2P trực tiếp khi phụ huynh gọi xem từ xa.
