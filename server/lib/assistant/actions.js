'use strict';

/**
 * Thư viện hành động của Trợ lý AI (toàn quyền CRUD).
 *
 * Mỗi hành động là một thao tác thật trên hệ thống, dùng chung logic với
 * các route API (order-service, băm mật khẩu…) nên dữ liệu luôn nhất quán.
 * Trợ lý AI chỉ dành cho tài khoản admin — toàn quyền như người vận hành.
 */

const db = require('../../supabase');
const { ApiError } = require('../../middleware');
const { hashPassword } = require('../security');
const { publicUser } = require('../../routes/auth');
const {
  ACTIVE_STATUSES,
  recalcOrder,
  syncOrderStatus,
  refreshTable,
  nextOrderCode,
  activeOrderOfTable,
} = require('../order-service');

/* ----------------------------- Tiện ích ----------------------------- */

/** Bỏ dấu tiếng Việt + thường hóa để so khớp tên linh hoạt. */
const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .toLowerCase()
    .trim();

const money = (n) => `${Number(n || 0).toLocaleString('vi-VN')}đ`;

const ORDER_LABEL = {
  draft: 'đang mở',
  cooking: 'đang nấu',
  ready: 'sẵn sàng',
  served: 'đã phục vụ',
  paid: 'đã thanh toán',
  cancelled: 'đã hủy',
};
const ITEM_LABEL = {
  pending: 'chờ chế biến',
  cooking: 'đang nấu',
  ready: 'đã chín',
  served: 'đã phục vụ',
  cancelled: 'đã hủy',
};
const METHOD_LABEL = { cash: 'tiền mặt', card: 'thẻ', momo: 'MoMo', zalo: 'ZaloPay', bank: 'chuyển khoản' };
const RES_LABEL = { pending: 'chờ xác nhận', confirmed: 'đã xác nhận', seated: 'đã xếp bàn', cancelled: 'đã hủy' };
const ROLE_LABEL = { admin: 'quản trị viên', manager: 'quản lý', staff: 'nhân viên', chef: 'bếp' };

/** Chấp nhận cả "tiền mặt", "cash", "momo"… trả về khóa chuẩn. */
function normMethod(m) {
  if (!m) return 'cash';
  const n = norm(m);
  if (/tien mat|tien|cash/.test(n)) return 'cash';
  if (/the|card/.test(n)) return 'card';
  if (/momo/.test(n)) return 'momo';
  if (/zalo/.test(n)) return 'zalo';
  if (/chuyen khoan|ck|bank/.test(n)) return 'bank';
  throw new ApiError(400, `Hình thức thanh toán "${m}" không hợp lệ (tiền mặt/thẻ/MoMo/ZaloPay/chuyển khoản)`);
}

/* ------------------------------ Truy vấn ---------------------------- */

async function findTable(ref) {
  const n = norm(ref).replace(/^ban\s*/, '').replace(/^so\s*/, '').trim();
  if (!n) return null;
  const tables = await db.all('dining_tables', (q) => q.eq('active', true).order('id'));
  return (
    tables.find((t) => String(t.id) === n) ||
    tables.find((t) => norm(t.name) === n) ||
    tables.find((t) => norm(t.name).includes(n)) ||
    null
  );
}

async function requireTable(ref) {
  const t = await findTable(ref);
  if (!t) throw new ApiError(404, `Không tìm thấy bàn "${ref}"`);
  return t;
}

async function findDish(ref) {
  const n = norm(ref).replace(/^mon\s*/, '').replace(/^mon an\s*/, '').trim();
  if (!n) return null;
  const dishes = await db.all('dishes', (q) => q.order('id'));
  return (
    dishes.find((d) => String(d.id) === n) ||
    dishes.find((d) => norm(d.name) === n) ||
    dishes.find((d) => norm(d.name).includes(n)) ||
    null
  );
}

async function requireDish(ref) {
  const d = await findDish(ref);
  if (!d) throw new ApiError(404, `Không tìm thấy món "${ref}"`);
  return d;
}

async function findOrder(ref) {
  const n = norm(ref).replace(/^don\s*/, '').replace(/^dh\s*/, '').trim();
  if (!n) return null;
  const orders = await db.all('orders', (q) =>
    q.select('*, dining_tables(name)').order('id', { ascending: false })
  );
  const rows = orders.map((o) => ({ ...o, _table: o.dining_tables?.name ?? null }));
  const hit = (list) => list.find((o) => norm(o.order_code).includes(n)) || list.find((o) => String(o.id) === n);
  return hit(rows.filter((o) => ACTIVE_STATUSES.includes(o.status))) || hit(rows) || null;
}

/** Trả về đơn theo args.order, hoặc đơn đang mở của args.table. */
async function requireOrder(args, { openOnly = true } = {}) {
  if (args.order) {
    const o = await findOrder(args.order);
    if (!o) throw new ApiError(404, `Không tìm thấy đơn "${args.order}"`);
    return o;
  }
  if (args.table) {
    const t = await requireTable(args.table);
    const o = await activeOrderOfTable(t.id);
    if (!o) throw new ApiError(404, `Bàn ${t.name} không có đơn hàng đang mở`);
    return o;
  }
  throw new ApiError(400, 'Cần chỉ định đơn hàng hoặc bàn');
}

async function itemsOf(orderId) {
  const items = await db.all('order_items', (q) => q.eq('order_id', orderId).order('id'));
  return items;
}

async function findCustomer(ref) {
  const n = norm(ref).replace(/^khach\s*/, '').trim();
  if (!n) return null;
  const rows = await db.all('customers', (q) => q.order('id', { ascending: false }));
  return (
    rows.find((c) => String(c.id) === n) ||
    rows.find((c) => String(c.phone) === String(ref).trim()) ||
    rows.find((c) => norm(c.name) === n) ||
    rows.find((c) => norm(c.name).includes(n)) ||
    null
  );
}

async function findUser(ref) {
  const n = norm(ref).replace(/^nhan vien\s*/, '').trim();
  if (!n) return null;
  const rows = await db.all('users', (q) => q.order('id'));
  return (
    rows.find((u) => String(u.id) === n) ||
    rows.find((u) => norm(u.username) === n) ||
    rows.find((u) => norm(u.full_name) === n) ||
    rows.find((u) => norm(u.full_name).includes(n) || norm(u.username).includes(n)) ||
    null
  );
}

/* ================================ HÀNH ĐỘNG ================================ */

const ACTIONS = {
  /* ------------------------------- Bàn ------------------------------- */

  list_tables: {
    desc: 'Xem trạng thái tất cả các bàn (trống / có khách / đã đặt)',
    props: {},
    async exec() {
      const [tables, openOrders] = await Promise.all([
        db.all('dining_tables', (q) => q.eq('active', true).order('id')),
        db.all('orders', (q) => q.in('status', ACTIVE_STATUSES)),
      ]);
      const byTable = Object.fromEntries(openOrders.map((o) => [o.table_id, o]));
      const rows = tables.map((t) => ({
        id: t.id,
        name: t.name,
        zone: t.zone,
        status: t.status,
        order_code: byTable[t.id]?.order_code || null,
      }));
      const c = (s) => rows.filter((r) => r.status === s).length;
      const busy = rows.filter((r) => r.status === 'occupied').map((r) => r.name);
      let msg = `Hiện có ${rows.length} bàn: ${c('free')} trống, ${c('occupied')} có khách, ${c('reserved')} đã đặt.`;
      if (busy.length) msg += ` Đang có khách: ${busy.join(', ')}.`;
      return { message: msg, data: { tables: rows } };
    },
  },

  create_table: {
    desc: 'Thêm bàn mới vào sơ đồ bàn',
    props: {
      name: { type: 'string', description: 'Tên bàn, ví dụ "Bàn 12" hoặc "VIP-2"' },
      zone: { type: 'string', description: 'Khu vực: Trong nhà / Ngoài trời / Phòng VIP' },
      seats: { type: 'integer', description: 'Số ghế' },
    },
    required: ['name'],
    async exec(args) {
      const name = String(args.name || '').trim();
      if (!name) throw new ApiError(400, 'Tên bàn không được để trống');
      const dup = await db.get('dining_tables', (q) => q.select('id').eq('name', name));
      if (dup) throw new ApiError(409, 'Tên bàn đã tồn tại');
      const table = await db.insert('dining_tables', {
        name,
        zone: args.zone || 'Trong nhà',
        seats: Number(args.seats) || 4,
      });
      return { message: `Đã thêm bàn "${name}" (${table.zone}, ${table.seats} ghế).`, data: { table } };
    },
  },

  update_table: {
    desc: 'Sửa thông tin bàn (tên, khu vực, số ghế)',
    props: {
      table: { type: 'string', description: 'Tên hoặc id bàn cần sửa' },
      name: { type: 'string' },
      zone: { type: 'string' },
      seats: { type: 'integer' },
    },
    required: ['table'],
    async exec(args) {
      const t = await requireTable(args.table);
      const [updated] = await db.update(
        'dining_tables',
        {
          name: args.name?.trim() || t.name,
          zone: args.zone ?? t.zone,
          seats: args.seats ? Number(args.seats) : t.seats,
        },
        (q) => q.eq('id', t.id)
      );
      return { message: `Đã cập nhật bàn "${t.name}" → tên ${updated.name}, khu ${updated.zone}, ${updated.seats} ghế.`, data: { table: updated } };
    },
  },

  delete_table: {
    desc: 'Xóa một bàn khỏi sơ đồ bàn (chặn nếu bàn đang có đơn)',
    props: { table: { type: 'string', description: 'Tên hoặc id bàn cần xóa' } },
    required: ['table'],
    async exec(args) {
      const t = await requireTable(args.table);
      const open = await db.get('orders', (q) =>
        q.select('id').eq('table_id', t.id).in('status', ACTIVE_STATUSES)
      );
      if (open) throw new ApiError(400, `Bàn ${t.name} đang có đơn hàng chưa thanh toán, không xóa được`);
      await db.remove('dining_tables', (q) => q.eq('id', t.id));
      return { message: `Đã xóa bàn "${t.name}".`, data: { id: t.id } };
    },
  },

  /* ----------------------------- Thực đơn ---------------------------- */

  list_categories: {
    desc: 'Xem danh sách nhóm món (danh mục thực đơn)',
    props: {},
    async exec() {
      const [cats, dishes] = await Promise.all([
        db.all('categories', (q) => q.order('sort_order').order('id')),
        db.all('dishes', (q) => q.select('id, category_id')),
      ]);
      const rows = cats.map((c) => ({
        id: c.id,
        name: c.name,
        dish_count: dishes.filter((d) => d.category_id === c.id).length,
      }));
      return {
        message: rows.length
          ? `Có ${rows.length} nhóm món: ${rows.map((r) => `${r.name} (${r.dish_count} món)`).join(', ')}.`
          : 'Chưa có nhóm món nào.',
        data: { categories: rows },
      };
    },
  },

  create_category: {
    desc: 'Thêm nhóm món mới (vd: Đồ uống, Món chính)',
    props: { name: { type: 'string', description: 'Tên nhóm món' } },
    required: ['name'],
    async exec(args) {
      const name = String(args.name || '').trim();
      if (!name) throw new ApiError(400, 'Tên nhóm không được để trống');
      const dup = await db.get('categories', (q) => q.select('id').eq('name', name));
      if (dup) throw new ApiError(409, 'Nhóm món đã tồn tại');
      const category = await db.insert('categories', { name, sort_order: 0 });
      return { message: `Đã thêm nhóm món "${name}".`, data: { category } };
    },
  },

  delete_category: {
    desc: 'Xóa một nhóm món khỏi thực đơn',
    props: { category: { type: 'string', description: 'Tên hoặc id nhóm món' } },
    required: ['category'],
    async exec(args) {
      const n = norm(args.category).replace(/^nhom\s*/, '').trim();
      const cats = await db.all('categories', (q) => q.order('id'));
      const c =
        cats.find((x) => String(x.id) === n) ||
        cats.find((x) => norm(x.name) === n) ||
        cats.find((x) => norm(x.name).includes(n));
      if (!c) throw new ApiError(404, `Không tìm thấy nhóm món "${args.category}"`);
      await db.remove('categories', (q) => q.eq('id', c.id));
      return { message: `Đã xóa nhóm món "${c.name}".`, data: { id: c.id } };
    },
  },

  list_dishes: {
    desc: 'Xem thực đơn: danh sách món ăn và giá',
    props: { q: { type: 'string', description: 'Từ khóa tìm món (để trống để xem tất cả)' } },
    async exec(args) {
      const dishes = await db.all('dishes', (q) => {
        if (args.q) q = q.or(`name.ilike.%${args.q}%,description.ilike.%${args.q}%`);
        return q;
      });
      const top = dishes.slice(0, 15);
      return {
        message: dishes.length
          ? `Thực đơn có ${dishes.length} món: ${top.map((d) => `${d.name} ${money(d.price)}${d.available ? '' : ' (hết)'};`).join(' ')}${dishes.length > 15 ? '…' : ''}`
          : 'Không tìm thấy món nào.',
        data: { dishes },
      };
    },
  },

  create_dish: {
    desc: 'Thêm món ăn mới vào thực đơn',
    props: {
      name: { type: 'string', description: 'Tên món ăn' },
      price: { type: 'number', description: 'Giá bán (đồng)' },
      category: { type: 'string', description: 'Tên hoặc id nhóm món' },
      description: { type: 'string', description: 'Mô tả món' },
    },
    required: ['name', 'price'],
    async exec(args) {
      const name = String(args.name || '').trim();
      const price = Number(args.price);
      if (!name) throw new ApiError(400, 'Tên món ăn không được để trống');
      if (!Number.isFinite(price) || price < 0) throw new ApiError(400, 'Giá bán không hợp lệ');
      let categoryId = null;
      if (args.category) {
        const n = norm(args.category).replace(/^nhom\s*/, '').trim();
        const cats = await db.all('categories', (q) => q.order('id'));
        const c =
          cats.find((x) => String(x.id) === n) ||
          cats.find((x) => norm(x.name).includes(n));
        if (c) categoryId = c.id;
      }
      const dish = await db.insert('dishes', {
        category_id: categoryId,
        name,
        description: args.description || '',
        price: Math.round(price),
        image: '',
        available: true,
      });
      return { message: `Đã thêm món "${name}" giá ${money(dish.price)}.`, data: { dish } };
    },
  },

  update_dish: {
    desc: 'Sửa món ăn: đổi giá, đổi tên, đổi mô tả, đưa vào/ra danh sách hết món',
    props: {
      dish: { type: 'string', description: 'Tên hoặc id món cần sửa' },
      name: { type: 'string' },
      price: { type: 'number', description: 'Giá mới (đồng)' },
      description: { type: 'string' },
      available: { type: 'boolean', description: 'true = còn món, false = hết món' },
    },
    required: ['dish'],
    async exec(args) {
      const d = await requireDish(args.dish);
      const price = args.price === undefined ? d.price : Number(args.price);
      if (!Number.isFinite(price) || price < 0) throw new ApiError(400, 'Giá bán không hợp lệ');
      const [updated] = await db.update(
        'dishes',
        {
          name: args.name?.trim() || d.name,
          price: Math.round(price),
          description: args.description ?? d.description,
          available: args.available === undefined ? d.available : Boolean(args.available),
        },
        (q) => q.eq('id', d.id)
      );
      return {
        message: `Đã cập nhật món "${d.name}" → tên ${updated.name}, giá ${money(updated.price)}${updated.available ? '' : ', trạng thái HẾT MÓN'}.`,
        data: { dish: updated },
      };
    },
  },

  delete_dish: {
    desc: 'Xóa một món khỏi thực đơn',
    props: { dish: { type: 'string', description: 'Tên hoặc id món cần xóa' } },
    required: ['dish'],
    async exec(args) {
      const d = await requireDish(args.dish);
      await db.remove('dishes', (q) => q.eq('id', d.id));
      return { message: `Đã xóa món "${d.name}" khỏi thực đơn.`, data: { id: d.id } };
    },
  },

  /* ------------------------------ Đơn hàng ---------------------------- */

  list_orders: {
    desc: 'Xem danh sách đơn hàng, có thể lọc theo trạng thái',
    props: {
      status: {
        type: 'string',
        enum: ['draft', 'cooking', 'ready', 'served', 'paid', 'cancelled'],
        description: 'Lọc theo trạng thái đơn',
      },
    },
    async exec(args) {
      const rows = await db.all('orders', (q) =>
        q.select('*, dining_tables(name), order_items(status, quantity)').order('id', { ascending: false })
      );
      let list = rows;
      if (args.status) list = rows.filter((o) => o.status === args.status);
      const slim = list.slice(0, 20).map((o) => ({
        id: o.id,
        order_code: o.order_code,
        table: o.dining_tables?.name || '—',
        status: o.status,
        total: o.total,
        items: (o.order_items || []).filter((i) => i.status !== 'cancelled').length,
      }));
      return {
        message: list.length
          ? `Có ${list.length} đơn${args.status ? ` ở trạng thái "${ORDER_LABEL[args.status] || args.status}"` : ''}: ${slim.map((o) => `${o.order_code} (bàn ${o.table}, ${ORDER_LABEL[o.status]}, ${money(o.total)})`).join('; ')}${list.length > 20 ? '…' : ''}`
          : 'Không có đơn hàng nào phù hợp.',
        data: { orders: slim },
      };
    },
  },

  create_order: {
    desc: 'Mở đơn hàng mới cho một bàn (nếu bàn đã có đơn thì dùng đơn hiện tại)',
    props: {
      table: { type: 'string', description: 'Tên hoặc id bàn' },
      customer_name: { type: 'string' },
      guests: { type: 'integer', description: 'Số khách' },
    },
    required: ['table'],
    async exec(args, ctx) {
      const t = await requireTable(args.table);
      const existing = await activeOrderOfTable(t.id);
      if (existing) {
        return {
          message: `Bàn ${t.name} đã có đơn ${existing.order_code} (${ORDER_LABEL[existing.status]}), mình dùng đơn hiện tại nhé.`,
          data: { existing: true, order_code: existing.order_code },
        };
      }
      const order = await db.insert('orders', {
        order_code: await nextOrderCode(),
        table_id: t.id,
        customer_name: args.customer_name || '',
        customer_id: null,
        guest_count: Number(args.guests) || 1,
        user_id: ctx.user.id,
        status: 'draft',
        note: '',
      });
      await refreshTable(t.id);
      return { message: `Đã mở đơn ${order.order_code} cho bàn ${t.name}.`, data: { order_id: order.id, order_code: order.order_code } };
    },
  },

  add_item: {
    desc: 'Thêm món vào đơn hàng của một bàn (tự mở đơn nếu bàn chưa có đơn)',
    props: {
      dish: { type: 'string', description: 'Tên hoặc id món ăn' },
      table: { type: 'string', description: 'Tên hoặc id bàn' },
      order: { type: 'string', description: 'Mã đơn (vd HD-261020-0001) nếu biết' },
      quantity: { type: 'integer', description: 'Số lượng (mặc định 1)' },
      note: { type: 'string', description: 'Ghi chú cho món (vd: ít cay)' },
    },
    required: ['dish'],
    async exec(args, ctx) {
      const dish = await requireDish(args.dish);
      if (!dish.available) throw new ApiError(400, `Món "${dish.name}" hiện đã hết`);
      let order;
      try {
        order = await requireOrder(args);
      } catch (e) {
        if (!args.table || e.status !== 404) throw e;
        const t = await requireTable(args.table);
        order = await db.insert('orders', {
          order_code: await nextOrderCode(),
          table_id: t.id,
          customer_name: '',
          customer_id: null,
          guest_count: 1,
          user_id: ctx.user.id,
          status: 'draft',
          note: '',
        });
        await refreshTable(t.id);
      }
      if (['paid', 'cancelled'].includes(order.status)) {
        throw new ApiError(400, `Đơn ${order.order_code} đã kết thúc, không thêm món được`);
      }
      const qty = Math.max(1, Number(args.quantity) || 1);
      const merged = await db.get('order_items', (q) =>
        q
          .eq('order_id', order.id)
          .eq('dish_id', dish.id)
          .eq('status', 'pending')
          .eq('note', args.note || '')
          .order('id')
      );
      if (merged) {
        await db.update('order_items', { quantity: merged.quantity + qty }, (q) => q.eq('id', merged.id));
      } else {
        await db.insert('order_items', {
          order_id: order.id,
          dish_id: dish.id,
          dish_name: dish.name,
          price: dish.price,
          quantity: qty,
          note: args.note || '',
        });
      }
      const updated = await recalcOrder(order.id);
      await syncOrderStatus(order.id);
      return {
        message: `Đã thêm ${qty} × ${dish.name} vào đơn ${order.order_code}. Tổng tiền hiện tại: ${money(updated?.total)}.`,
        data: { order_code: order.order_code, total: updated?.total },
      };
    },
  },

  change_item_quantity: {
    desc: 'Đổi số lượng một món trong đơn (nhập 0 để xóa món đó)',
    props: {
      dish: { type: 'string', description: 'Tên hoặc id món cần đổi' },
      table: { type: 'string', description: 'Tên hoặc id bàn của đơn' },
      order: { type: 'string', description: 'Mã đơn nếu biết' },
      quantity: { type: 'integer', description: 'Số lượng mới' },
    },
    required: ['dish', 'quantity'],
    async exec(args) {
      const order = await requireOrder(args);
      if (['paid', 'cancelled'].includes(order.status)) throw new ApiError(400, 'Đơn đã kết thúc');
      const items = await itemsOf(order.id);
      const n = norm(args.dish).replace(/^mon\s*/, '');
      const item =
        items.find((i) => String(i.dish_id) === n || String(i.id) === n) ||
        items.find((i) => norm(i.dish_name).includes(n) && i.status !== 'cancelled');
      if (!item) throw new ApiError(404, `Đơn ${order.order_code} không có món "${args.dish}"`);
      const qty = Number(args.quantity);
      if (Number(qty) === 0) {
        await db.remove('order_items', (q) => q.eq('id', item.id));
      } else {
        if (!Number.isFinite(qty) || qty < 0) throw new ApiError(400, 'Số lượng không hợp lệ');
        await db.update('order_items', { quantity: qty }, (q) => q.eq('id', item.id));
      }
      const updated = await recalcOrder(order.id);
      await syncOrderStatus(order.id);
      return {
        message:
          qty === 0
            ? `Đã xóa ${item.dish_name} khỏi đơn ${order.order_code}. Tổng tiền mới: ${money(updated?.total)}.`
            : `Đã đổi ${item.dish_name} còn ${qty} phần. Tổng tiền mới: ${money(updated?.total)}.`,
        data: { total: updated?.total },
      };
    },
  },

  remove_item: {
    desc: 'Xóa một món khỏi đơn hàng của một bàn',
    props: {
      dish: { type: 'string', description: 'Tên hoặc id món cần xóa khỏi đơn' },
      table: { type: 'string', description: 'Tên hoặc id bàn' },
      order: { type: 'string', description: 'Mã đơn nếu biết' },
    },
    required: ['dish'],
    async exec(args) {
      const order = await requireOrder(args);
      if (['paid', 'cancelled'].includes(order.status)) throw new ApiError(400, 'Đơn đã kết thúc');
      const items = await itemsOf(order.id);
      const n = norm(args.dish).replace(/^mon\s*/, '');
      const item =
        items.find((i) => String(i.dish_id) === n || String(i.id) === n) ||
        items.find((i) => norm(i.dish_name).includes(n) && i.status !== 'cancelled');
      if (!item) throw new ApiError(404, `Đơn ${order.order_code} không có món "${args.dish}"`);
      if (item.status !== 'pending') {
        await db.update('order_items', { status: 'cancelled' }, (q) => q.eq('id', item.id));
      } else {
        await db.remove('order_items', (q) => q.eq('id', item.id));
      }
      const updated = await recalcOrder(order.id);
      await syncOrderStatus(order.id);
      return {
        message: `Đã xóa ${item.dish_name} khỏi đơn ${order.order_code}. Tổng tiền mới: ${money(updated?.total)}.`,
        data: { total: updated?.total },
      };
    },
  },

  checkout_order: {
    desc: 'Thanh toán một đơn hàng (tiền mặt/thẻ/MoMo/ZaloPay/chuyển khoản, có thể giảm giá)',
    props: {
      table: { type: 'string', description: 'Tên hoặc id bàn cần thanh toán' },
      order: { type: 'string', description: 'Mã đơn nếu biết' },
      method: { type: 'string', description: 'cash | card | momo | zalo | bank (mặc định cash)' },
      discount: { type: 'number', description: 'Số tiền giảm giá (đồng)' },
    },
    async exec(args) {
      const order = await requireOrder(args);
      if (['paid', 'cancelled'].includes(order.status)) throw new ApiError(400, 'Đơn hàng đã được xử lý trước đó');
      const items = await itemsOf(order.id);
      if (!items.filter((i) => i.status !== 'cancelled').length) throw new ApiError(400, 'Đơn hàng chưa có món nào');
      const method = normMethod(args.method);
      const discount = Math.max(0, Number(args.discount) || 0);

      await db.update('orders', { discount }, (q) => q.eq('id', order.id));
      const finalOrder = await recalcOrder(order.id);
      await db.update(
        'orders',
        { status: 'paid', updated_at: new Date().toISOString() },
        (q) => q.eq('id', order.id)
      );
      const payment = await db.insert('payments', {
        order_id: order.id,
        user_id: null,
        method,
        amount: finalOrder.total,
        discount,
      });
      if (order.customer_id) {
        const gain = Math.floor(finalOrder.total / 10000);
        const cust = await db.get('customers', (q) => q.eq('id', order.customer_id));
        if (cust) {
          await db.update(
            'customers',
            { points: cust.points + gain, total_spent: cust.total_spent + finalOrder.total },
            (q) => q.eq('id', cust.id)
          );
        }
      }
      await refreshTable(order.table_id);
      return {
        message: `Đã thanh toán đơn ${order.order_code}${discount ? ` (giảm ${money(discount)})` : ''}: ${money(finalOrder.total)} bằng ${METHOD_LABEL[method]}. Bàn đã trở lại trạng thái trống.`,
        data: { order_code: order.order_code, total: finalOrder.total, method },
      };
    },
  },

  cancel_order: {
    desc: 'Hủy một đơn hàng đang mở (hủy toàn bộ món chưa chế biến)',
    props: {
      table: { type: 'string', description: 'Tên hoặc id bàn' },
      order: { type: 'string', description: 'Mã đơn nếu biết' },
    },
    async exec(args) {
      const order = await requireOrder(args);
      if (['paid', 'cancelled'].includes(order.status)) {
        throw new ApiError(400, `Đơn ${order.order_code} đã kết thúc (${ORDER_LABEL[order.status]})`);
      }
      await db.update('order_items', { status: 'cancelled' }, (q) =>
        q.eq('order_id', order.id).in('status', ['pending', 'cooking'])
      );
      await db.update(
        'orders',
        { status: 'cancelled', total: 0, subtotal: 0, updated_at: new Date().toISOString() },
        (q) => q.eq('id', order.id)
      );
      await refreshTable(order.table_id);
      return { message: `Đã hủy đơn ${order.order_code}. Bàn đã trống trở lại.`, data: { order_code: order.order_code } };
    },
  },

  /* -------------------------------- Bếp ------------------------------- */

  kitchen_queue: {
    desc: 'Xem hàng đợi món của bếp (đang chờ / đang nấu / đã chín)',
    props: {},
    async exec() {
      const orders = await db.all('orders', (q) =>
        q.select('*, dining_tables(name)').in('status', ['draft', 'cooking', 'ready']).order('id')
      );
      if (!orders.length) return { message: 'Bếp đang rảnh, không có món nào phải chế biến.', data: { queue: [] } };
      const items = await db.all('order_items', (q) =>
        q.select('*').in('order_id', orders.map((o) => o.id)).in('status', ['pending', 'cooking', 'ready']).order('id')
      );
      const queue = orders
        .map((o) => ({
          order_code: o.order_code,
          table: o.dining_tables?.name || '—',
          items: items.filter((i) => i.order_id === o.id),
        }))
        .filter((o) => o.items.length);
      const parts = queue.flatMap((o) =>
        o.items.map((i) => `${i.quantity}× ${i.dish_name} [${ITEM_LABEL[i.status]}] (đơn ${o.order_code}, bàn ${o.table})`)
      );
      return { message: `Bếp có ${parts.length} món cần xử lý: ${parts.join('; ')}.`, data: { queue } };
    },
  },

  kitchen_mark: {
    desc: 'Cập nhật trạng thái một món trong bếp: đang nấu / đã chín / đã phục vụ',
    props: {
      dish: { type: 'string', description: 'Tên món cần chuyển trạng thái' },
      status: { type: 'string', enum: ['cooking', 'ready', 'served'], description: 'Trạng thái mới' },
    },
    required: ['dish', 'status'],
    async exec(args) {
      if (!['cooking', 'ready', 'served'].includes(args.status)) {
        throw new ApiError(400, 'Trạng thái phải là cooking / ready / served');
      }
      const orders = await db.all('orders', (q) =>
        q.select('id, order_code, status').in('status', ['draft', 'cooking', 'ready'])
      );
      if (!orders.length) throw new ApiError(404, 'Không có món nào đang chờ ở bếp');
      const items = await db.all('order_items', (q) =>
        q.select('*').in('order_id', orders.map((o) => o.id)).in('status', ['pending', 'cooking', 'ready'])
      );
      const n = norm(args.dish).replace(/^mon\s*/, '');
      const item =
        items.find((i) => norm(i.dish_name) === n) ||
        items.find((i) => norm(i.dish_name).includes(n));
      if (!item) throw new ApiError(404, `Không tìm thấy món "${args.dish}" trong hàng đợi bếp`);
      await db.update('order_items', { status: args.status }, (q) => q.eq('id', item.id));
      const synced = await syncOrderStatus(item.order_id);
      const order = orders.find((o) => o.id === item.order_id);
      return {
        message: `Đã chuyển ${item.dish_name} sang "${ITEM_LABEL[args.status]}" (đơn ${order?.order_code}). Trạng thái đơn: ${ORDER_LABEL[synced?.status] || synced?.status}.`,
        data: { item_id: item.id, order_status: synced?.status },
      };
    },
  },

  /* ------------------------------ Đặt bàn ----------------------------- */

  list_reservations: {
    desc: 'Xem danh sách đặt bàn',
    props: {
      status: {
        type: 'string',
        enum: ['pending', 'confirmed', 'seated', 'cancelled'],
        description: 'Lọc theo trạng thái',
      },
    },
    async exec(args) {
      const rows = await db.all('reservations', (q) =>
        q.select('*, dining_tables(name)').order('reserved_at')
      );
      const list = (args.status ? rows.filter((r) => r.status === args.status) : rows).slice(0, 20);
      return {
        message: list.length
          ? `Có ${list.length} đặt bàn: ${list.map((r) => `#${r.id} ${r.customer_name} (${r.phone}) ${r.dining_tables?.name || 'chưa xếp bàn'} lúc ${String(r.reserved_at).slice(0, 16).replace('T', ' ')} [${RES_LABEL[r.status]}]`).join('; ')}`
          : 'Không có đặt bàn nào.',
        data: { reservations: list },
      };
    },
  },

  create_reservation: {
    desc: 'Tạo đặt bàn mới (tên khách, điện thoại, giờ đặt)',
    props: {
      customer_name: { type: 'string', description: 'Tên khách hàng' },
      phone: { type: 'string', description: 'Số điện thoại' },
      table: { type: 'string', description: 'Tên hoặc id bàn muốn đặt (để trống nếu chưa biết)' },
      party_size: { type: 'integer', description: 'Số khách' },
      time: { type: 'string', description: 'Thời gian đặt, dạng ISO: 2026-10-21 19:00:00' },
    },
    required: ['customer_name', 'phone', 'time'],
    async exec(args) {
      if (!args.customer_name || !args.phone) throw new ApiError(400, 'Vui lòng nhập tên và số điện thoại');
      if (!args.time) throw new ApiError(400, 'Vui lòng chọn thời gian đặt bàn');
      let table = null;
      if (args.table) {
        table = await requireTable(args.table);
        const target = new Date(args.time).getTime();
        const nearby = await db.all('reservations', (q) =>
          q.select('id, reserved_at').eq('table_id', table.id).in('status', ['pending', 'confirmed'])
        );
        if (nearby.some((r) => Math.abs(new Date(r.reserved_at).getTime() - target) < 2 * 3600 * 1000)) {
          throw new ApiError(409, `Bàn ${table.name} đã được đặt trong khung giờ đó`);
        }
      }
      const created = await db.insert('reservations', {
        customer_name: String(args.customer_name).trim(),
        phone: String(args.phone).trim(),
        table_id: table ? table.id : null,
        party_size: Number(args.party_size) || 2,
        reserved_at: args.time,
        note: '',
      });
      if (table) await refreshTable(table.id);
      return {
        message: `Đã đặt bàn cho ${created.customer_name} (${created.phone}), ${created.party_size} khách, lúc ${String(created.reserved_at).slice(0, 16).replace('T', ' ')}${table ? ` tại ${table.name}` : ' (chưa xếp bàn)'} [mã #${created.id}].`,
        data: { reservation_id: created.id },
      };
    },
  },

  set_reservation_status: {
    desc: 'Đổi trạng thái đặt bàn: xác nhận, xếp bàn, hủy',
    props: {
      id: { type: 'integer', description: 'Mã đặt bàn (#)' },
      status: { type: 'string', enum: ['pending', 'confirmed', 'seated', 'cancelled'] },
    },
    required: ['id', 'status'],
    async exec(args) {
      const id = Number(args.id);
      const existing = await db.get('reservations', (q) => q.eq('id', id));
      if (!existing) throw new ApiError(404, 'Không tìm thấy đặt bàn');
      if (!['pending', 'confirmed', 'seated', 'cancelled'].includes(args.status)) {
        throw new ApiError(400, 'Trạng thái không hợp lệ');
      }
      await db.update('reservations', { status: args.status }, (q) => q.eq('id', id));
      if (existing.table_id) await refreshTable(existing.table_id);
      return { message: `Đã đổi đặt bàn #${id} (${existing.customer_name}) sang "${RES_LABEL[args.status]}".`, data: { id, status: args.status } };
    },
  },

  delete_reservation: {
    desc: 'Xóa một đặt bàn',
    props: { id: { type: 'integer', description: 'Mã đặt bàn (#)' } },
    required: ['id'],
    async exec(args) {
      const id = Number(args.id);
      const existing = await db.get('reservations', (q) => q.eq('id', id));
      if (!existing) throw new ApiError(404, 'Không tìm thấy đặt bàn');
      await db.remove('reservations', (q) => q.eq('id', id));
      if (existing.table_id) await refreshTable(existing.table_id);
      return { message: `Đã xóa đặt bàn #${id} (${existing.customer_name}).`, data: { id } };
    },
  },

  /* ----------------------------- Khách hàng --------------------------- */

  list_customers: {
    desc: 'Xem danh sách khách hàng',
    props: { q: { type: 'string', description: 'Tìm theo tên hoặc số điện thoại' } },
    async exec(args) {
      const rows = await db.all('customers', (q) => {
        if (args.q) q = q.or(`name.ilike.%${args.q}%,phone.ilike.%${args.q}%`);
        return q.order('id', { ascending: false });
      });
      const list = rows.slice(0, 20);
      return {
        message: rows.length
          ? `Có ${rows.length} khách hàng: ${list.map((c) => `${c.name} (${c.phone}, ${c.points} điểm)`).join('; ')}${rows.length > 20 ? '…' : ''}`
          : 'Chưa có khách hàng nào.',
        data: { customers: list },
      };
    },
  },

  create_customer: {
    desc: 'Thêm khách hàng mới',
    props: {
      name: { type: 'string' },
      phone: { type: 'string' },
      email: { type: 'string' },
    },
    required: ['name', 'phone'],
    async exec(args) {
      if (!args.name || !args.phone) throw new ApiError(400, 'Vui lòng nhập tên và số điện thoại');
      const customer = await db.insert('customers', {
        name: String(args.name).trim(),
        phone: String(args.phone).trim(),
        email: args.email || '',
      });
      return { message: `Đã thêm khách hàng ${customer.name} (${customer.phone}).`, data: { customer } };
    },
  },

  update_customer: {
    desc: 'Sửa thông tin khách hàng (tên, SĐT, email, điểm)',
    props: {
      customer: { type: 'string', description: 'Tên, SĐT hoặc id khách' },
      name: { type: 'string' },
      phone: { type: 'string' },
      email: { type: 'string' },
      points: { type: 'integer' },
    },
    required: ['customer'],
    async exec(args) {
      const c = await findCustomer(args.customer);
      if (!c) throw new ApiError(404, `Không tìm thấy khách "${args.customer}"`);
      const [updated] = await db.update(
        'customers',
        {
          name: args.name?.trim() || c.name,
          phone: args.phone?.trim() || c.phone,
          email: args.email ?? c.email,
          points: args.points === undefined ? c.points : Number(args.points) || 0,
        },
        (q) => q.eq('id', c.id)
      );
      return { message: `Đã cập nhật khách hàng ${updated.name}.`, data: { customer: updated } };
    },
  },

  delete_customer: {
    desc: 'Xóa một khách hàng',
    props: { customer: { type: 'string', description: 'Tên, SĐT hoặc id khách' } },
    required: ['customer'],
    async exec(args) {
      const c = await findCustomer(args.customer);
      if (!c) throw new ApiError(404, `Không tìm thấy khách "${args.customer}"`);
      await db.remove('customers', (q) => q.eq('id', c.id));
      return { message: `Đã xóa khách hàng ${c.name}.`, data: { id: c.id } };
    },
  },

  /* ------------------------------ Nhân viên --------------------------- */

  list_users: {
    desc: 'Xem danh sách nhân viên và vai trò',
    props: {},
    async exec() {
      const users = await db.all('users', (q) => q.order('id'));
      return {
        message: `Có ${users.length} nhân viên: ${users.map((u) => `${u.full_name} (@${u.username}, ${ROLE_LABEL[u.role] || u.role}${u.active ? '' : ', ĐÃ KHÓA'})`).join('; ')}.`,
        data: { users: users.map(publicUser) },
      };
    },
  },

  create_user: {
    desc: 'Thêm tài khoản nhân viên mới',
    props: {
      username: { type: 'string', description: 'Tên đăng nhập' },
      password: { type: 'string', description: 'Mật khẩu (từ 6 ký tự)' },
      full_name: { type: 'string', description: 'Họ tên nhân viên' },
      role: { type: 'string', enum: ['admin', 'manager', 'staff', 'chef'], description: 'Vai trò (mặc định staff)' },
      phone: { type: 'string' },
    },
    required: ['username', 'password', 'full_name'],
    async exec(args) {
      if (!args.username || !args.password || !args.full_name) {
        throw new ApiError(400, 'Vui lòng nhập tên đăng nhập, mật khẩu và họ tên');
      }
      if (String(args.password).length < 6) throw new ApiError(400, 'Mật khẩu phải từ 6 ký tự');
      if (args.role && !['admin', 'manager', 'staff', 'chef'].includes(args.role)) {
        throw new ApiError(400, 'Vai trò không hợp lệ');
      }
      const existing = await db.get('users', (q) => q.select('id').eq('username', String(args.username).trim()));
      if (existing) throw new ApiError(409, 'Tên đăng nhập đã tồn tại');
      const user = await db.insert('users', {
        username: String(args.username).trim(),
        password: hashPassword(args.password),
        full_name: args.full_name,
        role: args.role || 'staff',
        phone: args.phone || null,
        email: null,
      });
      return {
        message: `Đã tạo tài khoản @${user.username} (${user.full_name}, ${ROLE_LABEL[user.role]}).`,
        data: { user: publicUser(user) },
      };
    },
  },

  update_user: {
    desc: 'Sửa tài khoản nhân viên: đổi vai trò, khóa/mở khóa, đổi mật khẩu',
    props: {
      user: { type: 'string', description: 'Username, họ tên hoặc id nhân viên' },
      role: { type: 'string', enum: ['admin', 'manager', 'staff', 'chef'] },
      active: { type: 'boolean', description: 'true = mở khóa, false = khóa tài khoản' },
      password: { type: 'string', description: 'Mật khẩu mới (từ 6 ký tự)' },
      full_name: { type: 'string' },
      phone: { type: 'string' },
    },
    required: ['user'],
    async exec(args, ctx) {
      const u = await findUser(args.user);
      if (!u) throw new ApiError(404, `Không tìm thấy nhân viên "${args.user}"`);
      if (args.role && !['admin', 'manager', 'staff', 'chef'].includes(args.role)) {
        throw new ApiError(400, 'Vai trò không hợp lệ');
      }
      if (args.password && String(args.password).length < 6) {
        throw new ApiError(400, 'Mật khẩu phải từ 6 ký tự');
      }
      if (u.id === ctx.user.id && args.active === false) {
        throw new ApiError(400, 'Không thể tự vô hiệu hóa tài khoản của mình');
      }
      const patch = {
        full_name: args.full_name ?? u.full_name,
        role: args.role ?? u.role,
        phone: args.phone ?? u.phone,
        active: args.active === undefined ? u.active : Boolean(args.active),
      };
      if (args.password) patch.password = hashPassword(args.password);
      await db.update('users', patch, (q) => q.eq('id', u.id));
      return {
        message: `Đã cập nhật nhân viên ${u.full_name}${args.role ? ` → vai trò ${ROLE_LABEL[args.role]}` : ''}${args.active === false ? ' (đã khóa tài khoản)' : args.active === true ? ' (đã mở khóa)' : ''}.`,
        data: { user: publicUser(await db.get('users', (q) => q.eq('id', u.id))) },
      };
    },
  },

  delete_user: {
    desc: 'Xóa tài khoản nhân viên',
    props: { user: { type: 'string', description: 'Username, họ tên hoặc id nhân viên' } },
    required: ['user'],
    async exec(args, ctx) {
      const u = await findUser(args.user);
      if (!u) throw new ApiError(404, `Không tìm thấy nhân viên "${args.user}"`);
      if (u.id === ctx.user.id) throw new ApiError(400, 'Không thể xóa tài khoản của chính mình');
      await db.remove('users', (q) => q.eq('id', u.id));
      return { message: `Đã xóa tài khoản ${u.full_name} (@${u.username}).`, data: { id: u.id } };
    },
  },

  /* --------------------- Báo cáo & cài đặt ----------------------- */

  dashboard: {
    desc: 'Xem số liệu tổng quan hôm nay: doanh thu, đơn hàng, bàn, khách',
    props: {},
    async exec() {
      const d = await db.rpc('report_dashboard');
      return {
        message:
          `Hôm nay: doanh thu ${money(d.today_revenue)} từ ${d.today_bills} hóa đơn; ` +
          `tháng này ${money(d.month_revenue)}. Bàn: ${d.tables?.occupied}/${d.tables?.total} đang có khách, ${d.tables?.reserved} đã đặt. ` +
          `Đơn đang mở: ${d.active_orders}; món đang nấu: ${d.cooking_items}; đặt bàn chờ xác nhận: ${d.pending_reservations}.`,
        data: d,
      };
    },
  },

  revenue_report: {
    desc: 'Báo cáo doanh thu theo khoảng ngày (mặc định toàn bộ)',
    props: {
      from: { type: 'string', description: 'Từ ngày YYYY-MM-DD' },
      to: { type: 'string', description: 'Đến ngày YYYY-MM-DD' },
    },
    async exec(args) {
      const data = await db.rpc('report_overview', { p_from: args.from || '1970-01-01', p_to: args.to || '2999-12-31' });
      const revenue = Number(data.revenue || 0);
      const payments = Number(data.payments || 0);
      const top = (data.top_dishes || []).slice(0, 5);
      return {
        message:
          `Doanh thu ${args.from || 'từ trước'} → ${args.to || 'nay'}: ${money(revenue)} từ ${payments} hóa đơn ` +
          `(${data.paid_orders} đơn đã thanh toán, ${data.cancelled_orders} đơn hủy, trung bình ${money(payments ? Math.round(revenue / payments) : 0)}/hóa đơn).` +
          (top.length ? ` Top món: ${top.map((t) => `${t.dish_name} (${t.qty})`).join(', ')}.` : ''),
        data: { revenue, payments, top_dishes: top },
      };
    },
  },

  get_settings: {
    desc: 'Xem cài đặt nhà hàng (tên, tiền tệ, thuế)',
    props: {},
    async exec() {
      const s = await db.getSettings();
      return {
        message: `Cài đặt hiện tại: tên "${s.restaurant_name || '—'}", tiền tệ ${s.currency || 'VNĐ'}, thuế ${s.tax_rate || 0}%.`,
        data: { settings: s },
      };
    },
  },

  update_settings: {
    desc: 'Đổi cài đặt nhà hàng (tên nhà hàng, tiền tệ, thuế suất)',
    props: {
      restaurant_name: { type: 'string' },
      currency: { type: 'string' },
      tax_rate: { type: 'string', description: 'Thuế suất, vd "8"' },
    },
    async exec(args) {
      const allowed = ['restaurant_name', 'currency', 'tax_rate'];
      const patch = Object.fromEntries(
        allowed.filter((k) => args[k] !== undefined).map((k) => [k, String(args[k])])
      );
      if (!Object.keys(patch).length) throw new ApiError(400, 'Không có cài đặt nào được gửi lên');
      const s = await db.saveSettings(patch);
      return {
        message: `Đã lưu cài đặt: ${Object.entries(patch).map(([k, v]) => `${k} = "${v}"`).join(', ')}.`,
        data: { settings: s },
      };
    },
  },
};

const HELP_TEXT =
  'Mình là trợ lý AI toàn quyền của nhà hàng. Mình có thể: ' +
  'xem tổng quan/doanh thu; mở đơn, thêm món, đổi số lượng, xóa món, thanh toán, hủy đơn theo bàn; ' +
  'xem bếp và chuyển món sang đang nấu/đã chín; quản lý bàn (thêm/sửa/xóa); thực đơn (thêm/sửa/xóa món, đổi giá, hết món); ' +
  'đặt bàn (tạo/xác nhận/hủy); khách hàng (thêm/sửa/xóa); nhân viên (thêm/sửa/xóa, khóa tài khoản); cài đặt nhà hàng. ' +
  'Hãy thử nói: "mở đơn cho bàn 3", "thêm 2 phở bò cho bàn 3", "thanh toán bàn 3 bằng momo", "xóa món phở gà", "doanh thu hôm nay".';

module.exports = { ACTIONS, HELP_TEXT, norm, money, ORDER_LABEL, ITEM_LABEL, METHOD_LABEL, RES_LABEL, ROLE_LABEL };
