'use strict';

const express = require('express');
const db = require('../supabase');
const { ApiError, asyncHandler, authenticate, requireRole } = require('../middleware');

const router = express.Router();
router.use(authenticate);

const canReport = requireRole('manager');

/* ------------------------------ Báo cáo ------------------------------- */

/** GET /api/reports/overview?from=&to= */
router.get(
  '/overview',
  canReport,
  asyncHandler(async (req, res) => {
    const from = req.query.from || '1970-01-01';
    const to = req.query.to || '2999-12-31';

    const data = await db.rpc('report_overview', { p_from: from, p_to: to });
    const revenue = Number(data.revenue || 0);
    const payments = Number(data.payments || 0);

    res.json({
      revenue,
      payments,
      orders: Number(data.orders || 0),
      paid_orders: Number(data.paid_orders || 0),
      cancelled_orders: Number(data.cancelled_orders || 0),
      avg_ticket: payments > 0 ? Math.round(revenue / payments) : 0,
      by_day: (data.by_day || []).map((r) => ({
        day: r.day,
        revenue: Number(r.revenue),
        bills: Number(r.bills),
      })),
      by_method: (data.by_method || []).map((r) => ({
        method: r.method,
        revenue: Number(r.revenue),
        bills: Number(r.bills),
      })),
      top_dishes: (data.top_dishes || []).map((r) => ({
        dish_name: r.dish_name,
        qty: Number(r.qty),
        revenue: Number(r.revenue),
      })),
    });
  })
);

/** GET /api/reports/dashboard — số liệu cho trang tổng quan (mọi vai trò) */
router.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    const data = await db.rpc('report_dashboard');

    const lastPayments = await db.all('payments', (q) =>
      q.select('*, orders(order_code, dining_tables(name))').order('id', { ascending: false })
    );
    const recentOrders = await db.all('orders', (q) =>
      q
        .select('id, order_code, status, total, created_at, updated_at, dining_tables(name)')
        .order('updated_at', { ascending: false })
    );

    res.json({
      today_revenue: Number(data.today_revenue || 0),
      today_bills: Number(data.today_bills || 0),
      month_revenue: Number(data.month_revenue || 0),
      tables: {
        total: Number(data.tables?.total || 0),
        occupied: Number(data.tables?.occupied || 0),
        reserved: Number(data.tables?.reserved || 0),
      },
      active_orders: Number(data.active_orders || 0),
      pending_reservations: Number(data.pending_reservations || 0),
      cooking_items: Number(data.cooking_items || 0),
      last_payments: lastPayments.slice(0, 8).map((p) => ({
        ...p,
        order_code: p.orders?.order_code ?? null,
        table_name: p.orders?.dining_tables?.name ?? null,
        orders: undefined,
      })),
      recent_orders: recentOrders.slice(0, 8).map((o) => ({
        ...o,
        table_name: o.dining_tables?.name ?? null,
        dining_tables: undefined,
      })),
    });
  })
);

/* ------------------------------ Cài đặt ------------------------------- */

/** GET /api/reports/settings */
router.get(
  '/settings',
  asyncHandler(async (req, res) => {
    res.json({ settings: await db.getSettings() });
  })
);

/** PUT /api/reports/settings */
router.put(
  '/settings',
  canReport,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const allowed = ['restaurant_name', 'currency', 'tax_rate'];
    const found = allowed.filter((k) => body[k] !== undefined);
    if (!found.length) throw new ApiError(400, 'Không có cài đặt nào được gửi lên');

    const patch = Object.fromEntries(found.map((k) => [k, String(body[k])]));
    res.json({ settings: await db.saveSettings(patch) });
  })
);

module.exports = { router };
