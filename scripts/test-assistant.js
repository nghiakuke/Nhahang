#!/usr/bin/env node
// Kiểm thử end-to-end Trợ lý AI: đăng nhập admin, ra lệnh, xác minh dữ liệu đổi thật.
'use strict';
const B = 'http://localhost:3000/api';
const J = { 'Content-Type': 'application/json' };
let pass = 0, fail = 0;
const chk = (l, c) => { if (c) { console.log('  ✓ ' + l); pass++; } else { console.log('  ✗ ' + l); fail++; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(u, p) {
  const r = await fetch(B + '/auth/login', { method: 'POST', headers: J, body: JSON.stringify({ username: u, password: p }) });
  return r.json();
}
function api(path, method = 'GET', body, token) {
  return fetch(B + path, {
    method, headers: { ...J, ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());
}
async function chat(token, message) {
  const r = await fetch(B + '/assistant/chat', { method: 'POST', headers: { ...J, Authorization: 'Bearer ' + token }, body: JSON.stringify({ message }) });
  return r.json();
}

(async () => {
  const { token: admin } = await login('admin', 'admin123');
  chk('đăng nhập admin', !!admin);
  const { token: staff } = await login('nhanvien', 'nhanvien123');
  chk('đăng nhập nhân viên', !!staff);

  // 1. Phân quyền: nhân viên bị chặn
  const deny = await fetch(B + '/assistant/chat', { method: 'POST', headers: { ...J, Authorization: 'Bearer ' + staff }, body: JSON.stringify({ message: 'xem bàn' }) });
  chk('nhân viên bị chặn gọi trợ lý (403)', deny.status === 403);
  const noauth = await fetch(B + '/assistant/chat', { method: 'POST', headers: J, body: JSON.stringify({ message: 'xem bàn' }) });
  chk('không token bị chặn (401)', noauth.status === 401);

  // 2. Truy vấn
  let r = await chat(admin, 'tổng quan');
  chk('hỏi tổng quan → có doanh thu', /doanh thu/i.test(r.reply || ''));
  chk('mode là parser', r.mode === 'parser');

  r = await chat(admin, 'xem bàn');
  chk('xem bàn → liệt kê trạng thái', /bàn/i.test(r.reply || '') && r.actions?.[0]?.ok);

  // 3. Tạo món qua chat → kiểm tra có trong DB → xóa
  const TEN_MON = 'Món AI Test ' + Date.now();
  r = await chat(admin, `tạo món ${TEN_MON} giá 123000`);
  chk('tạo món qua chat', r.actions?.[0]?.ok);
  let dishes = await api('/dishes?all=1', 'GET', null, admin);
  let found = dishes.dishes.find((d) => d.name === TEN_MON);
  chk('món đã vào thực đơn với giá 123000', found && found.price === 123000);
  chk('món giữ nguyên dấu tiếng Việt', found && found.name === TEN_MON);

  // 4. Đổi giá
  r = await chat(admin, `đổi giá ${TEN_MON} thành 99000`);
  chk('đổi giá qua chat', r.actions?.[0]?.ok);
  dishes = await api('/dishes?all=1', 'GET', null, admin);
  found = dishes.dishes.find((d) => d.name === TEN_MON);
  chk('giá đã là 99000', found && found.price === 99000);

  // 5. Hết món
  r = await chat(admin, `hết món ${TEN_MON}`);
  dishes = await api('/dishes?all=1', 'GET', null, admin);
  found = dishes.dishes.find((d) => d.name === TEN_MON);
  chk('đánh dấu hết món', found && found.available === false);

  // 6. Mở đơn + thêm món + thanh toán theo bàn
  const tables = await api('/tables', 'GET', null, admin);
  const free = tables.tables.find((t) => t.status === 'free');
  const BAN = free.name.replace(/^Bàn\s*/i, '');
  r = await chat(admin, `mở đơn cho bàn ${BAN}`);
  chk('mở đơn qua chat', r.actions?.[0]?.ok);
  const dishMenu = (await api('/dishes', 'GET', null, admin)).dishes.find((d) => d.available);
  r = await chat(admin, `thêm 2 ${dishMenu.name} cho bàn ${BAN}`);
  chk('thêm món qua chat', r.actions?.[0]?.ok);
  const openOrders = await api('/orders?status=draft', 'GET', null, admin);
  const order = openOrders.orders.find((o) => o.table_name === free.name);
  chk('đơn có món và tổng tiền > 0', order && order.total > 0);
  r = await chat(admin, `thanh toán bàn ${BAN} bằng tiền mặt`);
  chk('thanh toán qua chat', r.actions?.[0]?.ok && /thanh toán/i.test(r.reply));
  const paid = await api('/orders?status=paid', 'GET', null, admin);
  chk('đơn đã chuyển paid', paid.orders.some((o) => o.id === order.id));

  // 7. Lệnh mơ hồ → trả lời hướng dẫn, không lỗi
  r = await chat(admin, 'abcxyz lèo lèo');
  chk('lệnh không rõ → trả lời hỗ trợ', typeof r.reply === 'string' && r.reply.length > 0);

  // 8. Thao tác xóa: xóa món test
  r = await chat(admin, `xóa món ${TEN_MON}`);
  chk('xóa món qua chat', r.actions?.[0]?.ok);
  dishes = await api('/dishes?all=1', 'GET', null, admin);
  chk('món đã biến mất', !dishes.dishes.some((d) => d.name === TEN_MON));

  console.log(`\nKẾT QUẢ: ${pass} đạt / ${fail} lỗi`);
  process.exit(fail === 0 ? 0 : 1);
})();
