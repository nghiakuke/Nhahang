'use strict';

const express = require('express');
const db = require('../supabase');
const { ApiError, asyncHandler, authenticate } = require('../middleware');
const { refreshTable } = require('../lib/order-service');

const router = express.Router();
router.use(authenticate);

// Router con cho khách hàng (được gắn tại /api/customers)
const customerRouter = express.Router();
customerRouter.use(authenticate);

const RESERVATION_STATUSES = ['pending', 'confirmed', 'seated', 'cancelled'];

/** Nạp một đặt bàn kèm tên bàn. */
async function loadReservation(id) {
  const r = await db.get('reservations', (q) =>
    q.select('*, dining_tables(name, zone, seats)').eq('id', id)
  );
  return shapeReservation(r);
}

function shapeReservation(row) {
  if (!row) return null;
  const { dining_tables: table, ...rest } = row;
  return {
    ...rest,
    table_name: table?.name ?? null,
    table_zone: table?.zone ?? null,
    seats: table?.seats ?? null,
  };
}

/** GET /api/reservations?status=&date= */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await db.all('reservations', (q) => {
      if (req.query.status && req.query.status !== 'all') q = q.eq('status', req.query.status);
      return q.select('*, dining_tables(name, zone, seats)').order('reserved_at');
    });
    let list = rows.map(shapeReservation);
    if (req.query.date) {
      list = list.filter((r) => String(r.reserved_at).slice(0, 10) === req.query.date);
    }
    res.json({ reservations: list });
  })
);

/** POST /api/reservations */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { customer_name, phone, table_id, party_size, reserved_at, note } = req.body || {};
    if (!customer_name || !phone) throw new ApiError(400, 'Vui lòng nhập tên và số điện thoại');
    if (!reserved_at) throw new ApiError(400, 'Vui lòng chọn thời gian đặt bàn');

    let table = null;
    if (table_id) {
      table = await db.get('dining_tables', (q) =>
        q.eq('id', Number(table_id)).eq('active', true)
      );
      if (!table) throw new ApiError(404, 'Bàn không tồn tại');

      // Chặn trùng khung giờ: trong vòng 2 giờ quanh thời điểm đặt.
      const target = new Date(reserved_at).getTime();
      const windowMs = 2 * 60 * 60 * 1000;
      const nearby = await db.all('reservations', (q) =>
        q
          .select('id, reserved_at')
          .eq('table_id', table.id)
          .in('status', ['pending', 'confirmed'])
      );
      const clash = nearby.some(
        (r) => Math.abs(new Date(r.reserved_at).getTime() - target) < windowMs
      );
      if (clash) throw new ApiError(409, 'Bàn này đã được đặt trong khung giờ đó');
    }

    const created = await db.insert('reservations', {
      customer_name: customer_name.trim(),
      phone: phone.trim(),
      table_id: table ? table.id : null,
      party_size: Number(party_size) || 2,
      reserved_at,
      note: note || '',
    });
    if (table) await refreshTable(table.id);
    res.status(201).json({ reservation: await loadReservation(created.id) });
  })
);

/** PUT /api/reservations/:id { status } */
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await db.get('reservations', (q) => q.eq('id', id));
    if (!existing) throw new ApiError(404, 'Không tìm thấy đặt bàn');
    const { status, ...rest } = req.body || {};
    if (status && !RESERVATION_STATUSES.includes(status)) {
      throw new ApiError(400, 'Trạng thái không hợp lệ');
    }

    await db.update(
      'reservations',
      {
        status: status || existing.status,
        customer_name: rest.customer_name ?? existing.customer_name,
        phone: rest.phone ?? existing.phone,
        table_id: rest.table_id === undefined ? existing.table_id : rest.table_id || null,
        party_size: rest.party_size ? Number(rest.party_size) : existing.party_size,
        reserved_at: rest.reserved_at ?? existing.reserved_at,
        note: rest.note ?? existing.note,
      },
      (q) => q.eq('id', id)
    );
    if (existing.table_id) await refreshTable(existing.table_id);
    res.json({ reservation: await loadReservation(id) });
  })
);

/** DELETE /api/reservations/:id */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await db.get('reservations', (q) => q.eq('id', id));
    if (!existing) throw new ApiError(404, 'Không tìm thấy đặt bàn');
    await db.remove('reservations', (q) => q.eq('id', id));
    if (existing.table_id) await refreshTable(existing.table_id);
    res.json({ ok: true });
  })
);

// Khách hàng (gắn tại /api/customers)
customerRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = req.query.q;
    const rows = await db.all('customers', (query) => {
      if (q) query = query.or(`name.ilike.%${q}%,phone.ilike.%${q}%`);
      return query.order('id', { ascending: false });
    });
    res.json({ customers: rows });
  })
);

customerRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const { name, phone, email } = req.body || {};
    if (!name || !phone) throw new ApiError(400, 'Vui lòng nhập tên và số điện thoại');
    const customer = await db.insert('customers', {
      name: name.trim(),
      phone: phone.trim(),
      email: email || '',
    });
    res.status(201).json({ customer });
  })
);

customerRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await db.get('customers', (q) => q.eq('id', id));
    if (!existing) throw new ApiError(404, 'Không tìm thấy khách hàng');
    const { name, phone, email, points } = req.body || {};
    const [customer] = await db.update(
      'customers',
      {
        name: name?.trim() || existing.name,
        phone: phone?.trim() || existing.phone,
        email: email ?? existing.email,
        points: points === undefined ? existing.points : Number(points) || 0,
      },
      (q) => q.eq('id', id)
    );
    res.json({ customer });
  })
);

customerRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await db.get('customers', (q) => q.select('id').eq('id', id));
    if (!existing) throw new ApiError(404, 'Không tìm thấy khách hàng');
    await db.remove('customers', (q) => q.eq('id', id));
    res.json({ ok: true });
  })
);

module.exports = { router, customerRouter };
