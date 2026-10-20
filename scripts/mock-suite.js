'use strict';

/**
 * Bootstrap dữ liệu + chạy kiểm thử route qua HTTP với Supabase giả lập.
 * Được gọi từ scripts/supabase-mock.js
 */

const path = require('path');
const { store, table, nextId } = require('./supabase-mock');

function bootstrap() {
  const { hashPassword } = require('../server/lib/security');
  const users = [
    ['admin', 'admin123', 'Nguyễn Văn Admin', 'admin'],
    ['quanly', 'quanly123', 'Trần Thị Quyên', 'manager'],
    ['bep', 'bep12345', 'Lê Văn Bếp', 'chef'],
    ['nhanvien', 'nhanvien123', 'Phạm Văn Nam', 'staff'],
  ];
  users.forEach(([username, pass, full_name, role]) => {
    table('users').push({
      id: nextId('users'),
      username,
      password: hashPassword(pass),
      full_name,
      role,
      phone: null,
      email: null,
      active: true,
      created_at: new Date().toISOString(),
    });
  });

  const cats = [
    ['Khai vị', 1],
    ['Món chính', 2],
    ['Đồ uống', 3],
  ];
  const catId = {};
  cats.forEach(([name, sort_order]) => {
    const row = { id: nextId('categories'), name, sort_order };
    table('categories').push(row);
    catId[name] = row.id;
  });

  [
    ['Khai vị', 'Gỏi cuốn', 45000],
    ['Khai vị', 'Chả giò', 50000],
    ['Món chính', 'Bò kho', 120000],
    ['Món chính', 'Cá kho tộ', 135000],
    ['Đồ uống', 'Trà đá', 10000],
  ].forEach(([cat, name, price]) => {
    table('dishes').push({
      id: nextId('dishes'),
      category_id: catId[cat],
      name,
      description: '',
      price,
      image: '',
      available: true,
      created_at: new Date().toISOString(),
    });
  });

  [
    ['A1', 'Trong nhà', 4],
    ['A2', 'Trong nhà', 4],
    ['B1', 'Sân thượng', 6],
  ].forEach(([name, zone, seats]) => {
    table('dining_tables').push({
      id: nextId('dining_tables'),
      name,
      zone,
      seats,
      status: 'free',
      active: true,
      created_at: new Date().toISOString(),
    });
  });

  table('settings').push(
    { key: 'restaurant_name', value: 'Nhà hàng Test' },
    { key: 'currency', value: 'VNĐ' },
    { key: 'tax_rate', value: '0' }
  );
}

let pass = 0;
let fail = 0;
const failures = [];

function check(label, cond) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    pass++;
  } else {
    console.log(`  ✗ ${label}`);
    fail++;
    failures.push(label);
  }
}

async function runTests() {
  const express = require('express');
  const { ApiError } = require('../server/middleware');

  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../server/routes/auth').router);
  const catR = express.Router();
  catR.use(require('../server/routes/menu').categoryRouter);
  app.use('/api/categories', catR);
  const dishR = express.Router();
  dishR.use(require('../server/routes/menu').dishRouter);
  app.use('/api/dishes', dishR);
  app.use('/api/tables', require('../server/routes/tables').router);
  const orderMod = require('../server/routes/orders');
  app.use('/api/orders', orderMod.router);
  app.use('/api/kitchen', orderMod.kitchenRouter);
  const resvMod = require('../server/routes/reservations');
  app.use('/api/reservations', resvMod.router);
  app.use('/api/customers', resvMod.customerRouter);
  app.use('/api/reports', require('../server/routes/reports').router);
  app.use((err, req, res, next) => {
    const status = err instanceof ApiError ? err.status : 500;
    if (status >= 500) console.error('   [500]', err.message);
    res.status(status).json({ message: err.message || 'Lỗi máy chủ' });
  });

  const server = app.listen(0);
  const port = server.address().port;
  const BASE = `http://127.0.0.1:${port}`;

  const call = async (method, url, { token, body } = {}) => {
    const res = await fetch(BASE + url, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    return { status: res.status, data };
  };

  try {
    console.log('== 1. Đăng nhập ==');
    let r = await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'sai' } });
    check('sai mật khẩu -> 401', r.status === 401);
    r = await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
    check('đăng nhập admin -> 200', r.status === 200);
    const admin = r.data.token;
    check('trả về token', typeof admin === 'string' && admin.split('.').length === 3);

    r = await call('POST', '/api/auth/login', { body: { username: 'nhanvien', password: 'nhanvien123' } });
    const staff = r.data.token;

    console.log('== 2. Danh mục & món ăn ==');
    r = await call('GET', '/api/categories', { token: admin });
    check('liệt kê danh mục', r.data.categories?.length === 3);
    check('danh mục có dish_count', r.data.categories?.[0]?.dish_count >= 0);
    r = await call('GET', '/api/dishes', { token: admin });
    check('liệt kê món ăn', r.data.dishes?.length === 5);
    check('món có category_name', !!r.data.dishes?.[0]?.category_name);
    r = await call('POST', '/api/dishes', {
      token: admin,
      body: { name: 'Phở bò', price: 95000, category_id: 1 },
    });
    check('admin thêm món -> 201', r.status === 201);
    r = await call('POST', '/api/dishes', { token: staff, body: { name: 'X', price: 1 } });
    check('nhân viên thêm món -> 403', r.status === 403);

    console.log('== 3. Bàn ==');
    r = await call('GET', '/api/tables', { token: admin });
    check('liệt kê bàn', r.data.tables?.length === 3);
    check('bàn có trạng thái', r.data.tables?.[0]?.status === 'free');

    console.log('== 4. Mở đơn & gọi món ==');
    r = await call('POST', '/api/orders', { token: admin, body: { table_id: 1, guest_count: 2 } });
    check('tạo đơn -> 201', r.status === 201);
    const orderId = r.data.order?.id;
    check('đơn có mã HD...', /^HD\d{6}-\d{4}$/.test(r.data.order?.order_code || ''));
    check('đơn có tên bàn', r.data.order?.table_name === 'A1');

    r = await call('POST', `/api/orders/${orderId}/items`, {
      token: admin,
      body: { dish_id: 3, quantity: 2 },
    });
    check('thêm món -> 201', r.status === 201);
    check('tổng tiền = 240000', r.data.total === 240000);
    check('subtotal cập nhật', r.data.order?.subtotal === 240000);

    r = await call('POST', `/api/orders/${orderId}/items`, {
      token: admin,
      body: { dish_id: 3, quantity: 1 },
    });
    check('gộp món cùng loại', r.data.items?.length === 1 && r.data.items[0].quantity === 3);

    r = await call('GET', '/api/tables', { token: admin });
    const t1 = r.data.tables.find((t) => t.id === 1);
    check('bàn chuyển "occupied"', t1.status === 'occupied');
    check('bàn hiện mã đơn', t1.order_code === r.data.order_code || !!t1.order_code);
    check('bàn đếm số món', t1.item_count === 1);

    console.log('== 5. Gửi bếp & đồng bộ trạng thái ==');
    r = await call('POST', `/api/orders/${orderId}/status`, { token: admin, body: { status: 'cooking' } });
    check('gửi bếp -> cooking', r.data.order?.status === 'cooking');
    check('món chuyển cooking', r.data.items?.[0]?.status === 'cooking');

    r = await call('GET', '/api/kitchen', { token: admin });
    check('bếp thấy phiếu', r.data.queue?.length === 1);
    check('phiếu có món', r.data.queue?.[0]?.items?.length === 1);
    const itemId = r.data.queue[0].items[0].id;

    r = await call('PATCH', `/api/kitchen/item/${itemId}`, { token: admin, body: { status: 'ready' } });
    check('bấm "Đã chín" -> ready', r.data.order_status === 'ready');

    console.log('== 6. Thanh toán ==');
    r = await call('POST', `/api/orders/${orderId}/checkout`, {
      token: admin,
      body: { method: 'cash', discount: 10000 },
    });
    check('thanh toán -> 200', r.status === 200);
    check('đơn -> paid', r.data.order?.status === 'paid');
    check('tổng sau giảm = 350000', r.data.order?.total === 350000);
    check('có bản ghi payment', !!r.data.payment?.id);

    r = await call('GET', '/api/tables', { token: admin });
    check('bàn trở về "free"', r.data.tables.find((t) => t.id === 1).status === 'free');

    r = await call('POST', `/api/orders/${orderId}/checkout`, { token: admin, body: { method: 'cash' } });
    check('thanh toán lại -> 400', r.status === 400);

    console.log('== 7. Danh sách đơn ==');
    r = await call('GET', '/api/orders', { token: admin });
    check('có đơn đã thanh toán', r.data.orders?.some((o) => o.status === 'paid'));
    check('đơn có item_count', r.data.orders?.[0]?.item_count === 1);
    r = await call('GET', '/api/orders?status=paid', { token: admin });
    check('lọc theo trạng thái', r.data.orders?.every((o) => o.status === 'paid'));

    console.log('== 8. Đặt bàn ==');
    r = await call('POST', '/api/reservations', {
      token: admin,
      body: { customer_name: 'Trần Khách', phone: '0905556667', table_id: 2, party_size: 4, reserved_at: '2026-10-20T19:00:00' },
    });
    check('tạo đặt bàn -> 201', r.status === 201);
    check('đặt bàn có tên bàn', r.data.reservation?.table_name === 'A2');
    r = await call('POST', '/api/reservations', {
      token: admin,
      body: { customer_name: 'Trùng', phone: '0901112222', table_id: 2, reserved_at: '2026-10-20T20:00:00' },
    });
    check('trùng khung giờ -> 409', r.status === 409);

    console.log('== 9. Khách hàng ==');
    r = await call('POST', '/api/customers', { token: admin, body: { name: 'Lê Thân', phone: '0911222333' } });
    check('thêm khách -> 201', r.status === 201);
    r = await call('GET', '/api/customers?q=0911', { token: admin });
    check('tìm khách theo SĐT', r.data.customers?.length === 1);

    console.log('== 10. Báo cáo ==');
    r = await call('GET', '/api/reports/overview', { token: admin });
    check('tổng doanh thu = 350000', r.data.revenue === 350000);
    check('có doanh thu theo ngày', Array.isArray(r.data.by_day) && r.data.by_day.length >= 1);
    check('có doanh thu theo hình thức', Array.isArray(r.data.by_method));
    check('có top món bán chạy', Array.isArray(r.data.top_dishes) && r.data.top_dishes.length >= 1);
    check('top món đúng số lượng', r.data.top_dishes[0]?.qty === 3);
    check('avg_ticket tính đúng', r.data.avg_ticket === 350000);

    r = await call('GET', '/api/reports/dashboard', { token: admin });
    check('dashboard doanh thu hôm nay', r.data.today_revenue === 350000);
    check('dashboard có số bàn', typeof r.data.tables?.total === 'number');
    check('dashboard có đơn gần đây', Array.isArray(r.data.recent_orders));

    console.log('== 11. Cài đặt ==');
    r = await call('GET', '/api/reports/settings', { token: admin });
    check('đọc cài đặt', r.data.settings?.restaurant_name === 'Nhà hàng Test');
    r = await call('PUT', '/api/reports/settings', { token: admin, body: { restaurant_name: 'Nhà hàng Mới' } });
    check('lưu cài đặt', r.data.settings?.restaurant_name === 'Nhà hàng Mới');

    console.log('== 12. Nhân viên & phân quyền ==');
    r = await call('GET', '/api/auth/users', { token: staff });
    check('nhân viên xem nhân viên -> 403', r.status === 403);
    r = await call('POST', '/api/auth/users', {
      token: admin,
      body: { username: 'tanbinh', password: 'matkhau123', full_name: 'Tân Binh', role: 'staff' },
    });
    check('admin thêm nhân viên -> 201', r.status === 201);
    r = await call('POST', '/api/auth/users', {
      token: admin,
      body: { username: 'tanbinh', password: 'matkhau123', full_name: 'Trùng' },
    });
    check('trùng username -> 409', r.status === 409);
    r = await call('GET', '/api/reports/overview', { token: staff });
    check('nhân viên xem báo cáo -> 403', r.status === 403);

    console.log('== 13. Đổi mật khẩu ==');
    r = await call('POST', '/api/auth/change-password', {
      token: staff,
      body: { old_password: 'nhanvien123', new_password: 'matmoi123' },
    });
    check('đổi mật khẩu -> 200', r.status === 200);
    r = await call('POST', '/api/auth/login', { body: { username: 'nhanvien', password: 'matmoi123' } });
    check('đăng nhập bằng mật khẩu mới', r.status === 200);

    console.log(`\nKẾT QUẢ (mock): ${pass} đạt / ${fail} lỗi`);
    if (fail) {
      console.log('Mục lỗi:');
      failures.forEach((f) => console.log('  - ' + f));
      process.exitCode = 1;
    }
  } finally {
    server.close();
  }
}

module.exports = { bootstrap, runTests };
