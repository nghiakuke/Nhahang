'use strict';

const db = require('../supabase');

const ACTIVE_STATUSES = ['draft', 'cooking', 'ready', 'served'];

/** Đơn đang mở của một bàn (chưa thanh toán / chưa hủy). */
async function activeOrderOfTable(tableId) {
  return db.get('orders', (q) =>
    q
      .eq('table_id', tableId)
      .in('status', ACTIVE_STATUSES)
      .order('id', { ascending: false })
  );
}

/** Tính lại subtotal/total của đơn (Postgres function). */
async function recalcOrder(orderId) {
  return db.rpc('recalc_order', { p_order_id: orderId });
}

/** Đồng bộ trạng thái đơn theo trạng thái từng món (Postgres function). */
async function syncOrderStatus(orderId) {
  return db.rpc('sync_order_status', { p_order_id: orderId });
}

/** Cập nhật trạng thái bàn theo đơn + đặt bàn (Postgres function). */
async function refreshTable(tableId) {
  if (!tableId) return;
  await db.rpc('refresh_table', { p_table_id: tableId });
}

/**
 * Sinh mã đơn hàng duy nhất theo ngày: HD-YYMMDD-0001
 * Dùng Postgres function rồi thêm hậu tố nếu trùng (phòng khi gọi song song).
 */
async function nextOrderCode() {
  const base = await db.rpc('next_order_code');
  return base;
}

module.exports = {
  ACTIVE_STATUSES,
  recalcOrder,
  syncOrderStatus,
  refreshTable,
  nextOrderCode,
  activeOrderOfTable,
};
