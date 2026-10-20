'use strict';

/**
 * Nạp dữ liệu mẫu vào Supabase (chạy một lần, sau khi đã tạo schema).
 *
 *   node scripts/seed-supabase.js
 *
 * Script tự bỏ qua nếu bảng users đã có dữ liệu (trừ khi dùng --force).
 * Với --force, script sẽ XÓA toàn bộ dữ liệu hiện có rồi nạp lại.
 */

require('dotenv').config();
const db = require('../server/supabase');
const { hashPassword } = require('../server/lib/security');

const FORCE = process.argv.includes('--force');

async function clearAll() {
  // Xóa theo thứ tự để không vi phạm khóa ngoại.
  for (const t of [
    'payments',
    'order_items',
    'orders',
    'reservations',
    'customers',
    'dishes',
    'categories',
    'dining_tables',
    'users',
    'settings',
  ]) {
    await db.remove(t, (q) => q.neq('id', -1));
  }
  // settings dùng khóa text, xóa riêng cho chắc.
  await db.supabase.from('settings').delete().neq('key', '');
}

const USERS = [
  ['admin', 'admin123', 'Nguyễn Văn Admin', 'admin', '0901000001', 'admin@nhahang.vn'],
  ['quanly', 'quanly123', 'Trần Thị Quyên', 'manager', '0901000002', 'quanly@nhahang.vn'],
  ['bep', 'bep12345', 'Lê Văn Bếp', 'chef', '0901000003', 'bep@nhahang.vn'],
  ['nhanvien', 'nhanvien123', 'Phạm Văn Nam', 'staff', '0901000004', 'nv@nhahang.vn'],
];

const CATEGORIES = [
  ['Khai vị', 1],
  ['Món chính', 2],
  ['Cơm & Mì', 3],
  ['Đồ uống', 4],
  ['Tráng miệng', 5],
];

const DISHES = [
  ['Khai vị', 'Gỏi cuốn (4 pcs)', 'Tôm thịt, bún, rau sống, nước chấm pha', 45000, '🥗'],
  ['Khai vị', 'Chả giò (4 pcs)', 'Giò heo, miến, nấm mèu, chấm ngót chua', 50000, '🥢'],
  ['Khai vị', 'Gỏi ngó sen tôm thịt', 'Giòn mát, chua ngọt', 75000, '🍤'],
  ['Khai vị', 'Súp cua bông cải', 'Thanh đạm, nóng hổi', 55000, '🥣'],
  ['Món chính', 'Bò kho cà rốt', 'Thịt bò hầm mềm, ăn kèm bánh mì', 120000, '🥩'],
  ['Món chính', 'Cá kho tộ', 'Cá lóc kho cháy cạnh, đậm vị', 135000, '🐟'],
  ['Món chính', 'Gà nướng mật ong', 'Ức gà nướng vàng, sốt mật ong', 145000, '🍗'],
  ['Món chính', 'Tôm rang me', 'Tôm sú to, sốt me chua cay', 165000, '🦐'],
  ['Món chính', 'Lẩu thái hải sản', 'Đủ cho 2-3 người, chua cay', 250000, '🍲'],
  ['Món chính', 'Rau muống xào tỏi', 'Rau xanh, tỏi phi', 45000, '🥬'],
  ['Cơm & Mì', 'Cơm tấm sườn nướng', 'Sườn non nướng than, bì, chả', 95000, '🍚'],
  ['Cơm & Mì', 'Mì xào hải sản', 'Mì trứng, tôm, mực, rau', 110000, '🍜'],
  ['Cơm & Mì', 'Cơm chiên dương châu', 'Trứng, thịt xông khói, đậu Hà Lan', 85000, '🍳'],
  ['Cơm & Mì', 'Bún bò Huế', 'Cay nồng, đậm chất Huế', 90000, '🌶️'],
  ['Đồ uống', 'Trà đá', 'Trà sen đá', 10000, '🧊'],
  ['Đồ uống', 'Nước chanh muối', 'Chanh tươi, đá viên', 25000, '🍋'],
  ['Đồ uống', 'Sinh tố bơ', 'Bơ tươi, sữa đặc', 45000, '🥑'],
  ['Đồ uống', 'Nước ép cam', 'Cam vắt nguyên chất', 40000, '🍊'],
  ['Tráng miệng', 'Chè chuối nướng', 'Chuối nướng, nước cốt dừa', 35000, '🍌'],
  ['Tráng miệng', 'Bánh flan cà phê', 'Mềm mịn, thơm cà phê', 30000, '🍮'],
  ['Tráng miệng', 'Kem dừa', 'Dừa sấy, hạt điều', 40000, '🍨'],
];

const ZONES = [
  ['Trong nhà', ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'], 4],
  ['Sân thượng', ['B1', 'B2', 'B3'], 6],
  ['VIP', ['V1', 'V2'], 8],
];

async function main() {
  const existing = await db.all('users', (q) => q.select('id'));
  if (existing.length && !FORCE) {
    console.log(`ℹ️  Đã có ${existing.length} người dùng trong Supabase — bỏ qua seed.`);
    console.log('   Dùng "node scripts/seed-supabase.js --force" để xóa và nạp lại.');
    return;
  }
  if (FORCE) {
    console.log('🧹 Đang xóa dữ liệu cũ...');
    await clearAll();
  }

  console.log('👤 Đang tạo người dùng...');
  await db.insertMany(
    'users',
    USERS.map(([username, pass, full_name, role, phone, email]) => ({
      username,
      password: hashPassword(pass),
      full_name,
      role,
      phone,
      email,
    }))
  );

  console.log('📂 Đang tạo danh mục...');
  const cats = await db.insertMany(
    'categories',
    CATEGORIES.map(([name, sort_order]) => ({ name, sort_order }))
  );
  const catId = Object.fromEntries(cats.map((c) => [c.name, c.id]));

  console.log('🍽️  Đang tạo món ăn...');
  await db.insertMany(
    'dishes',
    DISHES.map(([cat, name, description, price, image]) => ({
      category_id: catId[cat],
      name,
      description,
      price,
      image,
    }))
  );

  console.log('🪑 Đang tạo bàn...');
  const tableRows = [];
  ZONES.forEach(([zone, names, seats]) =>
    names.forEach((name) => tableRows.push({ name, zone, seats }))
  );
  await db.insertMany('dining_tables', tableRows);

  console.log('⚙️  Đang tạo cài đặt...');
  await db.saveSettings({
    restaurant_name: 'Nhà hàng Hương Việt',
    currency: 'VNĐ',
    tax_rate: '0',
  });

  console.log('✅ Nạp dữ liệu mẫu hoàn tất.');
  console.log('   Đăng nhập: admin / admin123');
}

main().catch((err) => {
  console.error('❌ Lỗi khi nạp dữ liệu:', err.message);
  if (err.details) console.error('   ', err.details);
  process.exit(1);
});
