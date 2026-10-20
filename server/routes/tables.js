'use strict';

const express = require('express');
const db = require('../supabase');
const { ApiError, asyncHandler, authenticate, requireRole } = require('../middleware');
const { ACTIVE_STATUSES } = require('../lib/order-service');

const router = express.Router();
router.use(authenticate);

/**
 * GET /api/tables
 * Trả về trạng thái bàn kèm đơn hàng đang mở (nếu có).
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const [tables, openOrders] = await Promise.all([
      db.all('dining_tables', (q) => q.eq('active', true).order('zone').order('id')),
      db.all('orders', (q) => q.in('status', ACTIVE_STATUSES)),
    ]);

    const itemCounts = {};
    if (openOrders.length) {
      const items = await db.all('order_items', (q) =>
        q
          .select('order_id, status')
          .in(
            'order_id',
            openOrders.map((o) => o.id)
          )
      );
      items.forEach((it) => {
        if (it.status === 'cancelled') return;
        itemCounts[it.order_id] = (itemCounts[it.order_id] || 0) + 1;
      });
    }

    const orderByTable = {};
    openOrders.forEach((o) => {
      if (o.table_id != null) orderByTable[o.table_id] = o;
    });

    const rows = tables.map((t) => {
      const o = orderByTable[t.id];
      return {
        ...t,
        order_id: o?.id ?? null,
        order_code: o?.order_code ?? null,
        order_status: o?.status ?? null,
        order_total: o?.total ?? null,
        guest_count: o?.guest_count ?? null,
        customer_name: o?.customer_name ?? null,
        item_count: o ? itemCounts[o.id] || 0 : null,
      };
    });
    res.json({ tables: rows });
  })
);

/** POST /api/tables */
router.post(
  '/',
  requireRole('manager'),
  asyncHandler(async (req, res) => {
    const { name, zone, seats } = req.body || {};
    if (!name || !String(name).trim()) throw new ApiError(400, 'Tên bàn không được để trống');
    const dup = await db.get('dining_tables', (q) => q.select('id').eq('name', name.trim()));
    if (dup) throw new ApiError(409, 'Tên bàn đã tồn tại');
    const table = await db.insert('dining_tables', {
      name: name.trim(),
      zone: zone || 'Trong nhà',
      seats: Number(seats) || 4,
    });
    res.status(201).json({ table });
  })
);

/** PUT /api/tables/:id */
router.put(
  '/:id',
  requireRole('manager'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await db.get('dining_tables', (q) => q.eq('id', id));
    if (!existing) throw new ApiError(404, 'Không tìm thấy bàn');
    const { name, zone, seats, active } = req.body || {};
    const [table] = await db.update(
      'dining_tables',
      {
        name: name?.trim() || existing.name,
        zone: zone ?? existing.zone,
        seats: seats ? Number(seats) : existing.seats,
        active: active === undefined ? existing.active : Boolean(active),
      },
      (q) => q.eq('id', id)
    );
    res.json({ table });
  })
);

/** DELETE /api/tables/:id */
router.delete(
  '/:id',
  requireRole('manager'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const table = await db.get('dining_tables', (q) => q.eq('id', id));
    if (!table) throw new ApiError(404, 'Không tìm thấy bàn');
    const open = await db.get('orders', (q) =>
      q.select('id').eq('table_id', id).in('status', ACTIVE_STATUSES)
    );
    if (open) throw new ApiError(400, 'Bàn đang có đơn hàng chưa thanh toán');
    await db.remove('dining_tables', (q) => q.eq('id', id));
    res.json({ ok: true });
  })
);

module.exports = { router };
