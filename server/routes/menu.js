'use strict';

const express = require('express');
const db = require('../supabase');
const { ApiError, asyncHandler, authenticate, requireRole } = require('../middleware');

const canManage = requireRole('manager');

/* ============================ Danh mục ============================= */

const categoryRouter = express.Router();
categoryRouter.use(authenticate);

/** GET /api/categories — kèm số lượng món của mỗi danh mục */
categoryRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const [categories, dishes] = await Promise.all([
      db.all('categories', (q) => q.order('sort_order').order('id')),
      db.all('dishes', (q) => q.select('id, category_id')),
    ]);
    const counts = dishes.reduce((acc, d) => {
      if (d.category_id != null) acc[d.category_id] = (acc[d.category_id] || 0) + 1;
      return acc;
    }, {});
    res.json({
      categories: categories.map((c) => ({ ...c, dish_count: counts[c.id] || 0 })),
    });
  })
);

/** POST /api/categories */
categoryRouter.post(
  '/',
  canManage,
  asyncHandler(async (req, res) => {
    const { name, sort_order } = req.body || {};
    if (!name || !String(name).trim()) throw new ApiError(400, 'Tên danh mục không được để trống');
    const dup = await db.get('categories', (q) => q.select('id').eq('name', name.trim()));
    if (dup) throw new ApiError(409, 'Danh mục đã tồn tại');
    const category = await db.insert('categories', {
      name: name.trim(),
      sort_order: Number(sort_order) || 0,
    });
    res.status(201).json({ category });
  })
);

/** PUT /api/categories/:id */
categoryRouter.put(
  '/:id',
  canManage,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await db.get('categories', (q) => q.eq('id', id));
    if (!existing) throw new ApiError(404, 'Không tìm thấy danh mục');
    const { name, sort_order } = req.body || {};
    const [category] = await db.update(
      'categories',
      {
        name: name?.trim() || existing.name,
        sort_order: sort_order ?? existing.sort_order,
      },
      (q) => q.eq('id', id)
    );
    res.json({ category });
  })
);

/** DELETE /api/categories/:id */
categoryRouter.delete(
  '/:id',
  canManage,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await db.get('categories', (q) => q.select('id').eq('id', id));
    if (!existing) throw new ApiError(404, 'Không tìm thấy danh mục');
    await db.remove('categories', (q) => q.eq('id', id));
    res.json({ ok: true });
  })
);

/* ============================== Món ăn ============================= */

const dishRouter = express.Router();
dishRouter.use(authenticate);

/** GET /api/dishes?category_id=&q=&all=1 */
dishRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const [dishes, categories] = await Promise.all([
      db.all('dishes', (q) => {
        if (req.query.category_id) q = q.eq('category_id', Number(req.query.category_id));
        if (req.query.q) q = q.or(`name.ilike.%${req.query.q}%,description.ilike.%${req.query.q}%`);
        if (req.query.all !== '1') q = q.eq('available', true);
        return q;
      }),
      db.all('categories', (q) => q.select('id, name, sort_order')),
    ]);
    const catById = Object.fromEntries(categories.map((c) => [c.id, c]));
    const enriched = dishes.map((d) => ({
      ...d,
      category_name: catById[d.category_id]?.name ?? null,
    }));
    // Sắp xếp theo danh mục (sort_order, id) rồi tới id món — giống bản SQLite.
    enriched.sort((a, b) => {
      const ca = catById[a.category_id];
      const cb = catById[b.category_id];
      const oa = ca ? ca.sort_order * 1e6 + ca.id : Number.MAX_SAFE_INTEGER;
      const ob = cb ? cb.sort_order * 1e6 + cb.id : Number.MAX_SAFE_INTEGER;
      return oa - ob || a.id - b.id;
    });
    res.json({ dishes: enriched });
  })
);

/** POST /api/dishes */
dishRouter.post(
  '/',
  canManage,
  asyncHandler(async (req, res) => {
    const { category_id, name, description, price, image, available } = req.body || {};
    if (!name || !String(name).trim()) throw new ApiError(400, 'Tên món ăn không được để trống');
    const p = Number(price);
    if (!Number.isFinite(p) || p < 0) throw new ApiError(400, 'Giá bán không hợp lệ');

    const dish = await db.insert('dishes', {
      category_id: category_id || null,
      name: name.trim(),
      description: description || '',
      price: Math.round(p),
      image: image || '',
      available: !(available === 0 || available === false),
    });
    res.status(201).json({ dish });
  })
);

/** PUT /api/dishes/:id */
dishRouter.put(
  '/:id',
  canManage,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await db.get('dishes', (q) => q.eq('id', id));
    if (!existing) throw new ApiError(404, 'Không tìm thấy món ăn');
    const { category_id, name, description, price, image, available } = req.body || {};
    const p = price === undefined ? existing.price : Number(price);
    if (!Number.isFinite(p) || p < 0) throw new ApiError(400, 'Giá bán không hợp lệ');

    const [dish] = await db.update(
      'dishes',
      {
        category_id: category_id === undefined ? existing.category_id : category_id || null,
        name: name?.trim() || existing.name,
        description: description ?? existing.description,
        price: Math.round(p),
        image: image ?? existing.image,
        available: available === undefined ? existing.available : Boolean(available),
      },
      (q) => q.eq('id', id)
    );
    res.json({ dish });
  })
);

/** DELETE /api/dishes/:id */
dishRouter.delete(
  '/:id',
  canManage,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await db.get('dishes', (q) => q.select('id').eq('id', id));
    if (!existing) throw new ApiError(404, 'Không tìm thấy món ăn');
    await db.remove('dishes', (q) => q.eq('id', id));
    res.json({ ok: true });
  })
);

module.exports = { categoryRouter, dishRouter };
