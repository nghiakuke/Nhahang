# 🍜 Quản lý nhà hàng — Webapp

Webapp quản lý nhà hàng đầy đủ **frontend + backend + database + đăng nhập**, giao diện
tiếng Việt, chạy được ngay không cần build hay cài dịch vụ ngoài.

| Thành phần | Công nghệ |
|---|---|
| Frontend | SPA viết tay bằng JavaScript thuần (`public/`) — không framework, không CDN |
| Backend | Node.js 22 + Express 5 (`server/`) |
| Database | SQLite qua `node:sqlite` có sẵn trong Node (không cần biên dịch native) |
| Đăng nhập | JWT HS256 + băm mật khẩu scrypt, tự viết bằng module `crypto` |

Chỉ có **một** thư viện phụ thuộc: `express`.

---

## 1. Chạy nhanh

```bash
npm install          # chỉ cài express
npm start            # http://localhost:3000
```

Đổi cổng: `node server/index.js 8080` hoặc `PORT=8080 npm start`.

Lần chạy đầu tiên sẽ tự tạo `data/restaurant.db`, tạo bảng và nạp **dữ liệu mẫu**
(11 bàn, 21 món, 4 tài khoản, đặt bàn, khách hàng, vài đơn hàng đã thanh toán).
Muốn làm lại từ đầu, xóa file DB rồi chạy lại:

```bash
rm -f data/restaurant.db*
npm start
```

## 2. Tài khoản demo

| Vai trò | Tên đăng nhập | Mật khẩu | Quyền |
|---|---|---|---|
| Quản trị viên | `admin` | `admin123` | Toàn quyền |
| Quản lý | `quanly` | `quanly123` | Nghiệp vụ + báo cáo + nhân viên |
| Nhân viên | `nhanvien` | `nhanvien123` | Bán hàng, bàn, đặt bàn, khách hàng |
| Bếp | `bep` | `bep12345` | Chỉ màn hình bếp |

Ở màn hình đăng nhập, bấm vào một thẻ tài khoản demo để tự điền nhanh.

## 3. Tính năng

- **Đăng nhập / phân quyền**: JWT lưu trong `localStorage`, 4 vai trò với menu và quyền API
  khác nhau; có đổi mật khẩu; phiên hết hạn tự chuyển về màn hình đăng nhập.
- **Tổng quan**: doanh thu hôm nay, số đơn, khách, bàn trống, món bán chạy, cảnh báo sắp hết hàng.
- **Bán hàng (POS)**: chọn bàn → chọn món theo nhóm → tăng/giảm số lượng → gửi bếp →
  thanh toán (tiền mặt / thẻ / MoMo / ZaloPay / chuyển khoản) kèm giảm giá.
- **Sơ đồ bàn**: bàn trống / có khách / đã đặt, thêm–sửa–xóa bàn (quản lý trở lên).
- **Màn hình bếp**: hàng đợi phiếu theo thời gian thực (tự làm mới), chuyển món
  *Chờ chế biến → Đang nấu → Đã chín*, tự đồng bộ trạng thái đơn và bàn.
- **Đơn hàng**: danh sách, lọc theo trạng thái, xem chi tiết, hủy đơn.
- **Đặt bàn**: đặt trước, xác nhận, xếp vào bàn, hủy; **chặn trùng khung giờ** trên cùng bàn.
- **Khách hàng**: hồ sơ khách, số điện thoại, ghi chú, lịch sử chi tiêu.
- **Thực đơn**: nhóm món + món ăn, giá, mô tả, trạng thái còn/hết.
- **Nhân viên**: thêm–sửa–xóa tài khoản, vai trò, khóa/mở tài khoản.
- **Báo cáo**: doanh thu theo ngày, top món bán chạy, doanh thu theo nhóm/thanh toán, lọc theo khoảng ngày.
- **Cài đặt**: tên nhà hàng, địa chỉ, điện thoại, thuế/phí phục vụ, đơn vị tiền tệ.

## 4. Cấu trúc thư mục

```
server/
  index.js              Khởi động Express, gắn router, phục vụ SPA, xử lý lỗi
  db.js                 Mở SQLite, tạo bảng, nạp dữ liệu mẫu, helper all/get/run/tx
  middleware.js         ApiError, asyncHandler, authenticate, requireRole
  lib/security.js       Băm scrypt + ký/kiểm tra JWT HS256
  lib/order-service.js  Tính lại đơn, đồng bộ trạng thái, trạng thái bàn, mã đơn
  routes/
    auth.js             Đăng nhập, /me, đổi mật khẩu, quản lý nhân viên
    menu.js             Nhóm món và món ăn
    tables.js           Bàn
    orders.js           Đơn hàng, món trong đơn, hàng đợi bếp, thanh toán
    reservations.js     Đặt bàn và khách hàng
    reports.js          Tổng quan, báo cáo, cài đặt
public/
  index.html            Trang gốc
  styles.css            Giao diện
  app.js                Toàn bộ SPA (đăng nhập, router, các màn hình)
scripts/
  test-api.sh           Kiểm thử backend (34 phép thử)
  test-ui.js            Kiểm thử giao diện bằng jsdom (44 phép thử)
  query.js              Trích xuất giá trị JSON cho test-api.sh
data/
  restaurant.db         CSDL SQLite (tự sinh)
```

## 5. API chính

Tất cả đều nằm dưới `/api`, dùng `Authorization: Bearer <token>`.

**Xác thực & nhân viên** (`auth.js`)

```
POST   /api/auth/login              Đăng nhập → { token, user }
GET    /api/auth/me                 Thông tin người đang đăng nhập
POST   /api/auth/change-password    Đổi mật khẩu
GET    /api/auth/users              Danh sách nhân viên        (quản lý)
POST   /api/auth/users              Thêm nhân viên             (admin)
PUT    /api/auth/users/:id          Sửa nhân viên              (admin)
DELETE /api/auth/users/:id          Xóa nhân viên              (admin)
```

**Thực đơn** — `/api/categories`, `/api/dishes`: `GET/POST /`, `PUT/DELETE /:id`
(ghi cần quyền quản lý).

**Bàn** — `/api/tables`: `GET /`; `POST /`, `PUT /:id`, `DELETE /:id` (quản lý).

**Đơn hàng** — `/api/orders`

```
GET    /api/orders                  Danh sách (lọc ?status=)
GET    /api/orders/:id              Chi tiết
POST   /api/orders                  Mở đơn cho bàn
POST   /api/orders/:id/items        Thêm món
PUT    /api/orders/:id/items/:itemId    Sửa số lượng / ghi chú
DELETE /api/orders/:id/items/:itemId    Bỏ món
POST   /api/orders/:id/status       Gửi bếp / đổi trạng thái
POST   /api/orders/:id/checkout     Thanh toán
```

**Bếp** — `/api/kitchen`: `GET /` hàng đợi, `PUT /item/:itemId` đổi trạng thái món.

**Đặt bàn** — `/api/reservations`: `GET/POST /`, `PUT /:id`, `DELETE /:id`.

**Khách hàng** — `/api/customers`: `GET/POST /`, `PUT/DELETE /:id`.

**Báo cáo & cài đặt** (`reports.js`)

```
GET /api/reports/overview     Tổng quan (có ?from=&to=)
GET /api/reports/dashboard    Số liệu bảng điều khiển
GET /api/reports/settings     Đọc cài đặt
PUT /api/reports/settings     Lưu cài đặt (quản lý)
```

## 6. Kiểm thử

```bash
npm test        # backend: 34/34
npm run test:ui # giao diện: 44/44 (cần server đang chạy)
```

`test-api.sh` chạy trên server thật: đăng nhập, phân quyền, luồng POS trọn vẹn,
đồng bộ trạng thái bếp ↔ đơn ↔ bàn, thanh toán, chặn trùng đặt bàn, báo cáo, đổi mật khẩu.

`test-ui.js` dùng jsdom nạp trang thật rồi mô phỏng thao tác người dùng: đăng nhập sai/đúng,
mở POS từ sơ đồ bàn, gọi món, gửi bếp, bấm "Đã chín", thanh toán, xem đơn, đặt bàn,
thêm khách, thêm món, thêm nhân viên, xem báo cáo, lưu cài đặt, đăng xuất và kiểm tra
menu thay đổi theo vai trò. jsdom chỉ dùng để kiểm thử, **không** nằm trong `package.json`:

```bash
npm i --no-save jsdom
```

## 7. Ghi chú kỹ thuật

- **SQLite `node:sqlite`**: Node ≥ 22.5 in ra `ExperimentalWarning` khi khởi động — vô hại.
  Ưu điểm là không phải biên dịch module native như `better-sqlite3`.
- **Bảo mật**: mật khẩu băm bằng scrypt kèm salt ngẫu nhiên; JWT ký HS256 với khóa sinh
  và lưu trong bảng `settings` của DB (đổi khóa sẽ vô hiệu hóa mọi token cũ).
- **Kiểm tra quyền**: `authenticate` xác thực token, `requireRole('manager')` chặn theo vai trò.
- **Express 5**: các router con được gắn với tiền tố riêng (`/api/categories`, `/api/dishes`,
  `/api/kitchen`, `/api/customers`) để tránh việc `app.use('/api', ...)` che các mount phía sau.
- **SPA fallback**: mọi đường dẫn không phải tệp tĩnh hay `/api/*` đều trả về `index.html`.

## 8. Giấy phép

MIT.
