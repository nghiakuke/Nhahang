'use strict';

/**
 * Lớp truy cập dữ liệu Supabase (PostgREST).
 *
 * Thay thế cho `server/db.js` của bản SQLite. Điểm khác biệt quan trọng:
 * mọi thao tác đều BẤT ĐỒNG BỘ (trả về Promise) vì đi qua HTTP.
 *
 * Cấu hình qua biến môi trường (.env):
 *   SUPABASE_URL          https://<project-ref>.supabase.co
 *   SUPABASE_SERVICE_KEY  service_role key (BẮT BUỘC — key này bỏ qua RLS)
 *
 * LƯU Ý BẢO MẬT: service_role key có toàn quyền trên database. Chỉ đặt ở
 * backend, KHÔNG bao giờ gửi xuống trình duyệt.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error(
    'Thiếu cấu hình Supabase. Hãy tạo file .env với SUPABASE_URL và ' +
      'SUPABASE_SERVICE_KEY (xem .env.example).'
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Ném lỗi gọn gàng từ phản hồi PostgREST. */
function unwrap({ data, error }) {
  if (error) {
    const err = new Error(error.message || 'Lỗi truy vấn Supabase');
    err.code = error.code;
    err.details = error.details;
    throw err;
  }
  return data;
}

/* ------------------------------------------------------------------ *
 * Truy vấn bảng — API tương tự db.js nhưng bất đồng bộ
 * ------------------------------------------------------------------ */

/**
 * Lấy nhiều dòng.
 * @param {string} table
 * @param {(q: any) => any} [build] hàm tùy biến truy vấn
 */
async function all(table, build = (q) => q) {
  const data = unwrap(await build(supabase.from(table).select('*')));
  return data || [];
}

/**
 * Lấy một dòng đầu tiên.
 * @returns {Promise<object|null>}
 */
async function get(table, build = (q) => q) {
  const data = unwrap(await build(supabase.from(table).select('*')).limit(1));
  return (data && data[0]) || null;
}

/** Thêm một dòng, trả về dòng vừa tạo. */
async function insert(table, row) {
  const data = unwrap(await supabase.from(table).insert(row).select().single());
  return data;
}

/** Thêm nhiều dòng, trả về mảng dòng vừa tạo. */
async function insertMany(table, rows) {
  const data = unwrap(await supabase.from(table).insert(rows).select());
  return data || [];
}

/** Cập nhật theo điều kiện, trả về các dòng đã đổi. */
async function update(table, patch, build) {
  const data = unwrap(await build(supabase.from(table).update(patch)).select());
  return data || [];
}

/** Xóa theo điều kiện, trả về số dòng đã xóa. */
async function remove(table, build) {
  const data = unwrap(await build(supabase.from(table).delete()).select('id'));
  return (data || []).length;
}

/* ------------------------------------------------------------------ *
 * Gọi Postgres function (RPC) — dùng cho truy vấn phức tạp / tính toán
 * ------------------------------------------------------------------ */

async function rpc(fn, params = {}) {
  return unwrap(await supabase.rpc(fn, params));
}

/* ------------------------------------------------------------------ *
 * Tiện ích dùng chung
 * ------------------------------------------------------------------ */

/** Đếm số dòng khớp điều kiện. */
async function count(table, build = (q) => q) {
  const { count: n, error } = await build(
    supabase.from(table).select('id', { count: 'exact', head: true })
  );
  if (error) throw new Error(error.message);
  return n || 0;
}

/** Lấy danh sách settings dưới dạng object { key: value }. */
async function getSettings() {
  const rows = await all('settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** Lưu settings (upsert từng khóa). */
async function saveSettings(patch) {
  const rows = Object.entries(patch).map(([key, value]) => ({ key, value: String(value) }));
  if (!rows.length) return getSettings();
  unwrap(await supabase.from('settings').upsert(rows, { onConflict: 'key' }));
  return getSettings();
}

module.exports = {
  supabase,
  unwrap,
  all,
  get,
  insert,
  insertMany,
  update,
  remove,
  rpc,
  count,
  getSettings,
  saveSettings,
  SUPABASE_URL,
};
