'use strict';

/**
 * Di trú dữ liệu từ SQLite (data/restaurant.db) lên Supabase.
 *
 *   node scripts/migrate-to-supabase.js [--force]
 *
 * --force: xóa dữ liệu đang có trên Supabase trước khi nạp (giữ nguyên id).
 *
 * Yêu cầu: đã chạy server/sql/schema.sql trong SQL Editor của Supabase.
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const db = require('../server/supabase');

const FORCE = process.argv.includes('--force');
const SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, '..', 'data', 'restaurant.db');

/** Bảng theo đúng thứ tự phụ thuộc khóa ngoại. */
const TABLES = [
  'users',
  'categories',
  'dishes',
  'dining_tables',
  'customers',
  'orders',
  'order_items',
  'payments',
  'reservations',
  'settings',
];

/** Cột boolean trong Postgres (SQLite lưu 0/1). */
const BOOL_COLS = {
  users: ['active'],
  dishes: ['available'],
  dining_tables: ['active'],
};

/** Chuẩn hóa một dòng SQLite sang dạng Postgres chấp nhận. */
function normalize(table, row) {
  const out = { ...row };
  (BOOL_COLS[table] || []).forEach((c) => {
    if (out[c] !== undefined && out[c] !== null) out[c] = Boolean(out[c]);
  });
  // created_at dạng "2026-10-20 10:30:00" (giờ địa phương) -> ISO UTC.
  for (const col of ['created_at', 'updated_at', 'reserved_at']) {
    if (typeof out[col] === 'string' && out[col] && !out[col].includes('T')) {
      out[col] = out[col].replace(' ', 'T') + '+07:00';
    }
  }
  return out;
}

async function clearAll() {
  for (const t of TABLES) {
    if (t === 'settings') {
      await db.supabase.from('settings').delete().neq('key', '');
    } else {
      await db.remove(t, (q) => q.neq('id', -1));
    }
  }
}

async function main() {
  if (!fs.existsSync(SQLITE_PATH)) {
    throw new Error(`Không tìm thấy CSDL SQLite tại ${SQLITE_PATH}`);
  }

  const sqlite = new DatabaseSync(SQLITE_PATH);
  console.log(`📖 Đọc dữ liệu từ ${SQLITE_PATH}`);

  if (FORCE) {
    console.log('🧹 Đang xóa dữ liệu trên Supabase...');
    await clearAll();
  }

  let total = 0;
  for (const table of TABLES) {
    const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
    if (!rows.length) {
      console.log(`   ${table}: 0 dòng (bỏ qua)`);
      continue;
    }
    const payload = rows.map((r) => normalize(table, r));

    // Nạp theo lô 500 dòng để tránh payload quá lớn.
    for (let i = 0; i < payload.length; i += 500) {
      const chunk = payload.slice(i, i + 500);
      const { error } = await db.supabase.from(table).insert(chunk);
      if (error) throw new Error(`${table}: ${error.message}${error.details ? ' — ' + error.details : ''}`);
    }

    // Đồng bộ lại sequence để id tự tăng không đụng id vừa chèn.
    if (table !== 'settings') {
      await db.supabase.rpc('exec', {}).catch(() => null); // no-op nếu chưa có
    }

    total += rows.length;
    console.log(`   ${table}: ${rows.length} dòng ✓`);
  }

  sqlite.close();
  console.log(`\n✅ Đã di trú ${total} dòng lên Supabase.`);
  console.log('   Nhớ chạy SQL sau trong SQL Editor để chỉnh lại bộ đếm id:');
  console.log('   ' + TABLES.filter((t) => t !== 'settings')
    .map((t) => `select setval(pg_get_serial_sequence('public.${t}','id'), coalesce((select max(id) from public.${t}), 1));`)
    .join('\n   '));
}

main().catch((err) => {
  console.error('❌ Lỗi di trú:', err.message);
  process.exit(1);
});
