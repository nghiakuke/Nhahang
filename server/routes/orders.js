'use strict';

const express = require('express');
const db = require('../supabase');
const { ApiError, asyncHandler, authenticate } = require('../middleware');
const {
  recalcOrder,
  syncOrderStatus,
  refreshTable,
  nextOrderCode,
  activeOrderOfTable,
} = require('../lib/order-service');

const router = express.Router();
router.use(authenticate);

const ORDER_STATUSES = ['draft', 'cooking', 'ready', 'served', 'paid', 'cancelled'];

/* ---------------------------- Nạp dữ liệu ------------------------------ */

async function loadOrder(id) {
  const order = await db.get('orders', (q) =>
    q.select(
      '*, dining_tables(name, zone), users(full_name)'
    ).eq('id', id)
  );
  if (!order) throw new ApiError(404, 'Không tìm thấy đơn hàng');
  return shapeOrder(order);
}

/** Chuyển quan hệ lồng của PostgREST về phẳng như bản SQLite. */
function shapeOrder(row) {
  const { dining_tables: table, users: user, ...rest } = row;
  return {
    ...rest,
    table_name: table?.name ?? null,
    table_zone: table?.zone ?? null,
    staff_name: user?.full_name ?? null,
  };
}

async function itemsOf(orderId) {
  const items = await db.all('order_items', (q) =>
    q
      .select('*, dishes(image, categories(name))')
      .eq('order_id', orderId)
      .order('id')
  );
  return items.map((it) => {
    const { dishes: dish, ...rest } = it;
    return {
      ...rest,
      image: dish?.image ?? null,
      category_name: dish?.categories?.name ?? null,
    };
  });
}

async function ordersWithMeta() {
  const orders = await db.all('orders', (q) =>
    q.select('*, dining_tables(name, zone), users(full_name)').order('id', { ascending: false })
  );
  return orders.map(shapeOrder);
}

/* ------------------------------ Danh sách ------------------------------ */

/** GET /api/orders?status=&table_id=&limit= */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const rows = await ordersWithMeta();

    let filtered = rows;
    if (req.query.status && req.query.status !== 'all') {
      filtered = filtered.filter((o) => o.status === req.query.status);
    }
    if (req.query.table_id) {
      const tid = Number(req.query.table_id);
      filtered = filtered.filter((o) => o.table_id === tid);
    }
    if (req.query.date) {
      filtered = filtered.filter((o) => String(o.created_at).slice(0, 10) === req.query.date);
    }

    const page = filtered.slice(0, limit);

    // Đếm số món cho từng đơn trong trang.
    const counts = {};
    if (page.length) {
      const items = await db.all('order_items', (q) =>
        q
          .select('order_id, quantity, status')
          .in(
            'order_id',
            page.map((o) => o.id)
          )
      );
      items.forEach((it) => {
        if (it.status === 'cancelled') return;
        const c = (counts[it.order_id] ||= { item_count: 0, total_qty: 0 });
        c.item_count += 1;
        c.total_qty += it.quantity;
      });
    }

    const orders = page.map((o) => ({
      id: o.id,
      order_code: o.order_code,
      status: o.status,
      total: o.total,
      subtotal: o.subtotal,
      discount: o.discount,
      guest_count: o.guest_count,
      customer_name: o.customer_name,
      created_at: o.created_at,
      updated_at: o.updated_at,
      table_name: o.table_name,
      table_zone: o.table_zone,
      staff_name: o.staff_name,
      item_count: counts[o.id]?.item_count || 0,
      total_qty: counts[o.id]?.total_qty || 0,
    }));
    res.json({ orders });
  })
);

/** GET /api/orders/:id */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const order = await loadOrder(Number(req.params.id));
    res.json({ order, items: await itemsOf(order.id) });
  })
);

/* ------------------------------ Tạo đơn ------------------------------- */

/** POST /api/orders { table_id, customer_name, guest_count, note, customer_id } */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { table_id, customer_name, guest_count, note, customer_id } = req.body || {};
    if (!table_id) throw new ApiError(400, 'Vui lòng chọn bàn');

    const table = await db.get('dining_tables', (q) =>
      q.eq('id', Number(table_id)).eq('active', true)
    );
    if (!table) throw new ApiError(404, 'Bàn không tồn tại');

    const existing = await activeOrderOfTable(table.id);
    if (existing) {
      return res.status(200).json({
        existing: true,
        message: `Bàn ${table.name} đã có đơn ${existing.order_code}, mở đơn hiện tại`,
        order: await loadOrder(existing.id),
        items: await itemsOf(existing.id),
      });
    }

    const customer = customer_id
      ? await db.get('customers', (q) => q.eq('id', Number(customer_id)))
      : null;

    const order = await db.insert('orders', {
      order_code: await nextOrderCode(),
      table_id: table.id,
      customer_name: customer ? customer.name : customer_name || '',
      customer_id: customer ? customer.id : null,
      guest_count: Number(guest_count) || 1,
      user_id: req.user.id,
      status: 'draft',
      note: note || '',
    });
    await refreshTable(table.id);

    res.status(201).json({ order: await loadOrder(order.id), items: [] });
  })
);

/** PATCH /api/orders/:id — sửa thông tin đơn (tên KH, số khách, ghi chú) */
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const order = await loadOrder(Number(req.params.id));
    if (['paid', 'cancelled'].includes(order.status)) {
      throw new ApiError(400, 'Đơn đã kết thúc, không thể chỉnh sửa');
    }
    const { customer_name, guest_count, note, customer_id } = req.body || {};
    await db.update(
      'orders',
      {
        customer_name: customer_name ?? order.customer_name,
        guest_count: guest_count ? Number(guest_count) : order.guest_count,
        note: note ?? order.note,
        customer_id: customer_id === undefined ? order.customer_id : customer_id || null,
        updated_at: new Date().toISOString(),
      },
      (q) => q.eq('id', order.id)
    );
    res.json({ order: await loadOrder(order.id) });
  })
);

/* ------------------------------- Món ăn ------------------------------- */

/** POST /api/orders/:id/items { dish_id, quantity, note } */
router.post(
  '/:id/items',
  asyncHandler(async (req, res) => {
    const order = await loadOrder(Number(req.params.id));
    if (['paid', 'cancelled'].includes(order.status)) {
      throw new ApiError(400, 'Đơn đã kết thúc, không thể thêm món');
    }
    const { dish_id, quantity, note } = req.body || {};
    const dish = await db.get('dishes', (q) => q.eq('id', Number(dish_id)));
    if (!dish) throw new ApiError(404, 'Món ăn không tồn tại');
    if (!dish.available) throw new ApiError(400, `Món "${dish.name}" hiện đã hết`);
    const qty = Math.max(1, Number(quantity) || 1);

    // Gộp vào dòng đang chờ nếu cùng món + cùng ghi chú
    const merged = await db.get('order_items', (q) =>
      q
        .eq('order_id', order.id)
        .eq('dish_id', dish.id)
        .eq('status', 'pending')
        .eq('note', note || '')
        .order('id')
    );
    if (merged) {
      await db.update(
        'order_items',
        { quantity: merged.quantity + qty },
        (q) => q.eq('id', merged.id)
      );
    } else {
      await db.insert('order_items', {
        order_id: order.id,
        dish_id: dish.id,
        dish_name: dish.name,
        price: dish.price,
        quantity: qty,
        note: note || '',
      });
    }

    const updated = await recalcOrder(order.id);
    await syncOrderStatus(order.id);
    res.status(201).json({
      order: await loadOrder(order.id),
      items: await itemsOf(order.id),
      total: updated.total,
    });
  })
);

/** PATCH /api/orders/:id/items/:itemId { quantity, note, status } */
router.patch(
  '/:id/items/:itemId',
  asyncHandler(async (req, res) => {
    const order = await loadOrder(Number(req.params.id));
    if (['paid', 'cancelled'].includes(order.status)) {
      throw new ApiError(400, 'Đơn đã kết thúc');
    }
    const itemId = Number(req.params.itemId);
    const item = await db.get('order_items', (q) =>
      q.eq('id', itemId).eq('order_id', order.id)
    );
    if (!item) throw new ApiError(404, 'Không tìm thấy món trong đơn');

    const { quantity, note, status } = req.body || {};
    if (status && !['pending', 'cooking', 'ready', 'served', 'cancelled'].includes(status)) {
      throw new ApiError(400, 'Trạng thái món không hợp lệ');
    }
    if (status === 'cancelled' && item.status !== 'pending') {
      throw new ApiError(400, 'Chỉ hủy được món chưa chế biến');
    }

    await db.update(
      'order_items',
      {
        quantity: quantity === undefined ? item.quantity : Math.max(1, Number(quantity) || 1),
        note: note === undefined ? item.note : note,
        status: status || item.status,
      },
      (q) => q.eq('id', itemId)
    );

    await recalcOrder(order.id);
    await syncOrderStatus(order.id);
    res.json({ order: await loadOrder(order.id), items: await itemsOf(order.id) });
  })
);

/** DELETE /api/orders/:id/items/:itemId — xóa món chưa chế biến */
router.delete(
  '/:id/items/:itemId',
  asyncHandler(async (req, res) => {
    const order = await loadOrder(Number(req.params.id));
    if (['paid', 'cancelled'].includes(order.status)) {
      throw new ApiError(400, 'Đơn đã kết thúc');
    }
    const itemId = Number(req.params.itemId);
    const item = await db.get('order_items', (q) =>
      q.eq('id', itemId).eq('order_id', order.id)
    );
    if (!item) throw new ApiError(404, 'Không tìm thấy món trong đơn');
    if (item.status !== 'pending') {
      await db.update('order_items', { status: 'cancelled' }, (q) => q.eq('id', itemId));
    } else {
      await db.remove('order_items', (q) => q.eq('id', itemId));
    }
    await recalcOrder(order.id);
    await syncOrderStatus(order.id);
    res.json({ order: await loadOrder(order.id), items: await itemsOf(order.id) });
  })
);

/* --------------------------- Chuyển trạng thái ------------------------- */

/** POST /api/orders/:id/status { status } */
router.post(
  '/:id/status',
  asyncHandler(async (req, res) => {
    const order = await loadOrder(Number(req.params.id));
    const { status } = req.body || {};
    if (!ORDER_STATUSES.includes(status)) throw new ApiError(400, 'Trạng thái không hợp lệ');

    if (status === 'cooking') {
      const changed = await db.update(
        'order_items',
        { status: 'cooking' },
        (q) => q.eq('order_id', order.id).eq('status', 'pending')
      );
      if (!changed.length) {
        const anyCooking = await db.get('order_items', (q) =>
          q.select('id').eq('order_id', order.id).eq('status', 'cooking')
        );
        if (!anyCooking) throw new ApiError(400, 'Đơn chưa có món nào để chế biến');
      }
    }
    if (status === 'cancelled') {
      await db.update(
        'order_items',
        { status: 'cancelled' },
        (q) => q.eq('order_id', order.id).in('status', ['pending', 'cooking'])
      );
      await db.update(
        'orders',
        { status: 'cancelled', total: 0, subtotal: 0, updated_at: new Date().toISOString() },
        (q) => q.eq('id', order.id)
      );
      await refreshTable(order.table_id);
      return res.json({ order: await loadOrder(order.id), items: await itemsOf(order.id) });
    }

    await db.update(
      'orders',
      { status, updated_at: new Date().toISOString() },
      (q) => q.eq('id', order.id)
    );
    if (status === 'paid') await refreshTable(order.table_id);
    res.json({ order: await loadOrder(order.id), items: await itemsOf(order.id) });
  })
);

/* ------------------------------ Thanh toán ----------------------------- */

/** POST /api/orders/:id/checkout { method, discount, customer_id } */
router.post(
  '/:id/checkout',
  asyncHandler(async (req, res) => {
    const order = await loadOrder(Number(req.params.id));
    if (['paid', 'cancelled'].includes(order.status)) {
      throw new ApiError(400, 'Đơn hàng đã được xử lý trước đó');
    }
    const items = await db.all('order_items', (q) =>
      q.select('id').eq('order_id', order.id).neq('status', 'cancelled')
    );
    if (!items.length) throw new ApiError(400, 'Đơn hàng chưa có món nào');

    const { method, discount, customer_id } = req.body || {};
    const METHODS = ['cash', 'card', 'momo', 'zalo', 'bank'];
    if (method && !METHODS.includes(method)) {
      throw new ApiError(400, 'Hình thức thanh toán không hợp lệ');
    }
    const discountValue = Math.max(0, Number(discount) || 0);

    await db.update('orders', { discount: discountValue }, (q) => q.eq('id', order.id));
    const finalOrder = await recalcOrder(order.id);
    await db.update(
      'orders',
      { status: 'paid', updated_at: new Date().toISOString() },
      (q) => q.eq('id', order.id)
    );

    const createdPayment = await db.insert('payments', {
      order_id: order.id,
      user_id: req.user.id,
      method: method || 'cash',
      amount: finalOrder.total,
      discount: discountValue,
    });

    // Tích điểm: 1 điểm / 10.000đ
    const cid = customer_id || finalOrder.customer_id;
    if (cid) {
      const gain = Math.floor(finalOrder.total / 10000);
      const cust = await db.get('customers', (q) => q.eq('id', Number(cid)));
      if (cust) {
        await db.update(
          'customers',
          { points: cust.points + gain, total_spent: cust.total_spent + finalOrder.total },
          (q) => q.eq('id', cust.id)
        );
      }
    }

    await refreshTable(order.table_id);
    res.json({
      ok: true,
      order: await loadOrder(order.id),
      payment: createdPayment,
      message: `Đã thanh toán ${Number(finalOrder.total).toLocaleString('vi-VN')}đ`,
    });
  })
);

/* -------------------------------- Bếp --------------------------------- */

/* ========================= ROUTER RIÊNG: BẾP ========================= */

const kitchenRouter = express.Router();
kitchenRouter.use(authenticate);

/** GET /api/kitchen — các đơn có món đang chờ/chín */
kitchenRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const orders = await db.all('orders', (q) =>
      q
        .select('*, dining_tables(name, zone), users(full_name)')
        .in('status', ['draft', 'cooking', 'ready'])
        .order('id')
    );
    if (!orders.length) return res.json({ queue: [] });

    const items = await db.all('order_items', (q) =>
      q
        .select('id, order_id, dish_id, dish_name, price, quantity, note, status, created_at')
        .in(
          'order_id',
          orders.map((o) => o.id)
        )
        .in('status', ['pending', 'cooking', 'ready'])
        .order('id')
    );

    const queue = orders
      .map((o) => ({
        ...shapeOrder(o),
        items: items.filter((it) => it.order_id === o.id),
      }))
      .filter((o) => o.items.length);

    res.json({ queue });
  })
);

/** PATCH /api/kitchen/item/:itemId { status: cooking|ready|served|pending } */
kitchenRouter.patch(
  '/item/:itemId',
  asyncHandler(async (req, res) => {
    const itemId = Number(req.params.itemId);
    const item = await db.get('order_items', (q) => q.eq('id', itemId));
    if (!item) throw new ApiError(404, 'Không tìm thấy món');
    const { status } = req.body || {};
    if (!['pending', 'cooking', 'ready', 'served'].includes(status)) {
      throw new ApiError(400, 'Trạng thái không hợp lệ');
    }
    const order = await db.get('orders', (q) => q.eq('id', item.order_id));
    if (['paid', 'cancelled'].includes(order.status)) {
      throw new ApiError(400, 'Đơn hàng đã kết thúc');
    }

    await db.update('order_items', { status }, (q) => q.eq('id', itemId));
    const synced = await syncOrderStatus(order.id);
    res.json({ ok: true, order_status: synced?.status ?? order.status });
  })
);

module.exports = { router, kitchenRouter };
