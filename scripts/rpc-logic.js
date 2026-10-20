'use strict';

/**
 * Mô phỏng các Postgres function (RPC) trong server/sql/schema.sql bằng JS,
 * để kiểm thử tầng route mà không cần Postgres thật.
 *
 * Mỗi hàm nhận `tableFn(name)` trả về mảng dòng của bảng đó.
 */

function computeRpc(tableFn, fn, params, seq) {
  switch (fn) {
    case 'recalc_order': {
      const items = tableFn('order_items').filter(
        (i) => i.order_id === params.p_order_id && i.status !== 'cancelled'
      );
      const subtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
      const order = tableFn('orders').find((o) => o.id === params.p_order_id);
      if (!order) return null;
      order.subtotal = subtotal;
      order.total = Math.max(0, subtotal - (order.discount || 0));
      order.updated_at = new Date().toISOString();
      return order;
    }
    case 'sync_order_status': {
      const order = tableFn('orders').find((o) => o.id === params.p_order_id);
      if (!order) return null;
      if (['paid', 'cancelled'].includes(order.status)) return order;
      const items = tableFn('order_items').filter(
        (i) => i.order_id === order.id && i.status !== 'cancelled'
      );
      if (!items.length) return order;
      const count = (s) => items.filter((i) => i.status === s).length;
      let status = order.status;
      if (count('pending') > 0) status = 'draft';
      else if (count('cooking') > 0) status = 'cooking';
      else if (count('ready') > 0) status = 'ready';
      else status = 'served';
      if (status !== order.status) {
        order.status = status;
        order.updated_at = new Date().toISOString();
      }
      return order;
    }
    case 'refresh_table': {
      const tid = params.p_table_id;
      if (tid == null) return null;
      const tbl = tableFn('dining_tables').find((t) => t.id === tid);
      if (!tbl) return null;
      const hasOrder = tableFn('orders').some(
        (o) => o.table_id === tid && ['draft', 'cooking', 'ready', 'served'].includes(o.status)
      );
      if (hasOrder) {
        tbl.status = 'occupied';
        return null;
      }
      const cutoff = Date.now() - 3 * 60 * 60 * 1000;
      const hasResv = tableFn('reservations').some(
        (r) =>
          r.table_id === tid &&
          ['pending', 'confirmed'].includes(r.status) &&
          new Date(r.reserved_at).getTime() >= cutoff
      );
      tbl.status = hasResv ? 'reserved' : 'free';
      return null;
    }
    case 'next_order_code': {
      const today = new Date().toISOString().slice(0, 10);
      const n = tableFn('orders').filter((o) => String(o.created_at).slice(0, 10) === today).length;
      const d = new Date();
      const ymd =
        String(d.getFullYear()).slice(2) +
        String(d.getMonth() + 1).padStart(2, '0') +
        String(d.getDate()).padStart(2, '0');
      return `HD${ymd}-${String(n + 1).padStart(4, '0')}`;
    }
    case 'report_overview': {
      const from = params.p_from || '1970-01-01';
      const to = params.p_to || '2999-12-31';
      const inRange = (ts) => {
        const d = String(ts).slice(0, 10);
        return d >= from && d <= to;
      };
      const payments = tableFn('payments').filter((p) => inRange(p.created_at));
      const orders = tableFn('orders').filter((o) => inRange(o.created_at));
      const byDay = {};
      const byMethod = {};
      payments.forEach((p) => {
        const day = String(p.created_at).slice(0, 10);
        (byDay[day] ||= { day, revenue: 0, bills: 0 });
        byDay[day].revenue += p.amount;
        byDay[day].bills += 1;
        (byMethod[p.method] ||= { method: p.method, revenue: 0, bills: 0 });
        byMethod[p.method].revenue += p.amount;
        byMethod[p.method].bills += 1;
      });
      const dishAgg = {};
      tableFn('order_items').forEach((oi) => {
        const o = tableFn('orders').find((x) => x.id === oi.order_id);
        if (!o || o.status !== 'paid' || oi.status === 'cancelled' || !inRange(o.created_at)) return;
        (dishAgg[oi.dish_name] ||= { dish_name: oi.dish_name, qty: 0, revenue: 0 });
        dishAgg[oi.dish_name].qty += oi.quantity;
        dishAgg[oi.dish_name].revenue += oi.price * oi.quantity;
      });
      return {
        revenue: payments.reduce((s, p) => s + p.amount, 0),
        payments: payments.length,
        orders: orders.length,
        paid_orders: orders.filter((o) => o.status === 'paid').length,
        cancelled_orders: orders.filter((o) => o.status === 'cancelled').length,
        by_day: Object.values(byDay).sort((a, b) => (a.day > b.day ? 1 : -1)),
        by_method: Object.values(byMethod).sort((a, b) => b.revenue - a.revenue),
        top_dishes: Object.values(dishAgg).sort((a, b) => b.qty - a.qty).slice(0, 10),
      };
    }
    case 'report_dashboard': {
      const today = new Date().toISOString().slice(0, 10);
      const month = today.slice(0, 7);
      const payments = tableFn('payments');
      const tables = tableFn('dining_tables').filter((t) => t.active);
      return {
        today_revenue: payments
          .filter((p) => String(p.created_at).slice(0, 10) === today)
          .reduce((s, p) => s + p.amount, 0),
        today_bills: payments.filter((p) => String(p.created_at).slice(0, 10) === today).length,
        month_revenue: payments
          .filter((p) => String(p.created_at).slice(0, 7) === month)
          .reduce((s, p) => s + p.amount, 0),
        tables: {
          total: tables.length,
          occupied: tables.filter((t) => t.status === 'occupied').length,
          reserved: tables.filter((t) => t.status === 'reserved').length,
        },
        active_orders: tableFn('orders').filter((o) =>
          ['draft', 'cooking', 'ready', 'served'].includes(o.status)
        ).length,
        pending_reservations: tableFn('reservations').filter(
          (r) =>
            ['pending', 'confirmed'].includes(r.status) &&
            String(r.reserved_at).slice(0, 10) === today
        ).length,
        cooking_items: tableFn('order_items').filter((i) =>
          ['pending', 'cooking'].includes(i.status)
        ).length,
      };
    }
    default:
      throw new Error(`Chưa mô phỏng RPC: ${fn}`);
  }
}

module.exports = { computeRpc };
