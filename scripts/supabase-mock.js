'use strict';

/**
 * Kiểm thử logic route với Supabase giả lập trong bộ nhớ.
 *
 * Mục đích: xác minh tầng route (orders, menu, reservations…) chạy đúng với
 * API BẤT ĐỒNG BỘ trước khi kết nối Supabase thật. Không thay thế test tích hợp.
 *
 *   node scripts/test-supabase-mock.js
 */

require('dotenv').config();
const path = require('path');
const Module = require('module');

/* ------------------------------------------------------------------ *
 * 1. Bộ đệm dữ liệu trong bộ nhớ + trình dựng truy vấn kiểu PostgREST
 * ------------------------------------------------------------------ */

let store = {};
let seq = {};

function resetStore() {
  store = {};
  seq = {};
}

function table(name) {
  if (!store[name]) store[name] = [];
  return store[name];
}

function nextId(name) {
  seq[name] = (seq[name] || 0) + 1;
  return seq[name];
}

/** Bản sao quan hệ lồng tối thiểu cho .select('*, dining_tables(name, zone)') */
function expandRelations(name, row, selectStr) {
  if (!selectStr || !selectStr.includes('(')) return { ...row };
  const out = { ...row };
  const rel = selectStr.match(/(\w+)\(([^)]*)\)/g) || [];
  const relationMap = {
    dining_tables: 'dining_tables',
    users: 'users',
    orders: 'orders',
    customers: 'customers',
    dishes: 'dishes',
  };
  rel.forEach((token) => {
    const m = token.match(/(\w+)\(([^)]*)\)/);
    const [, relName, cols] = m;
    const fk = relName === 'users' ? 'user_id' : relName === 'orders' ? 'order_id' : 'table_id';
    const target = relationMap[relName];
    if (!target) return;
    const parentId = row[fk];
    const found = parentId != null ? table(target).find((r) => r.id === Number(parentId)) : null;
    if (!found) {
      out[relName] = null;
      return;
    }
    const picked = {};
    cols.split(',').forEach((c) => {
      const key = c.trim();
      if (key) picked[key] = found[key];
    });
    out[relName] = picked;
  });
  return out;
}

/** Tìm theo giá trị lồng của dishes: order_items.dishes(...) */
function selectItems(name, rows, selectStr) {
  return rows.map((r) => expandRelations(name, r, selectStr));
}

class Query {
  constructor(name) {
    this.name = name;
    this.filters = [];
    this._select = '*';
    this._order = [];
    this._limit = null;
    this._single = false;
    this._action = 'select';
    this._payload = null;
    this._count = false;
    this._head = false;
  }
  select(s = '*', opts = {}) {
    this._select = s;
    if (opts.count) this._count = true;
    if (opts.head) this._head = true;
    return this;
  }
  insert(payload) {
    this._action = 'insert';
    this._payload = payload;
    return this;
  }
  update(payload) {
    this._action = 'update';
    this._payload = payload;
    return this;
  }
  delete() {
    this._action = 'delete';
    return this;
  }
  upsert(payload, opts = {}) {
    this._action = 'upsert';
    this._payload = payload;
    this._conflict = opts.onConflict;
    return this;
  }
  eq(col, val) {
    this.filters.push((r) => String(r[col]) === String(val));
    return this;
  }
  neq(col, val) {
    this.filters.push((r) => String(r[col]) !== String(val));
    return this;
  }
  in(col, arr) {
    const set = arr.map(String);
    this.filters.push((r) => set.includes(String(r[col])));
    return this;
  }
  or(expr) {
    // Dạng: name.ilike.%q%,phone.ilike.%q%
    const parts = String(expr).split(',').map((p) => {
      const m = p.match(/^(\w+)\.ilike\.(.*)$/);
      return m ? { col: m[1], needle: m[2].replace(/%/g, '').toLowerCase() } : null;
    }).filter(Boolean);
    this.filters.push((r) => parts.some((p) => String(r[p.col] || '').toLowerCase().includes(p.needle)));
    return this;
  }
  order(col, opts = {}) {
    this._order.push({ col, asc: opts.ascending !== false });
    return this;
  }
  limit(n) {
    this._limit = n;
    return this;
  }
  single() {
    this._single = true;
    return this;
  }
  _match() {
    let rows = table(this.name).filter((r) => this.filters.every((f) => f(r)));
    for (const { col, asc } of this._order.slice().reverse()) {
      rows = rows.slice().sort((a, b) => {
        const x = a[col], y = b[col];
        if (x === y) return 0;
        return (x > y ? 1 : -1) * (asc ? 1 : -1);
      });
    }
    if (this._limit != null) rows = rows.slice(0, this._limit);
    return rows;
  }
  then(resolve, reject) {
    return Promise.resolve().then(() => this._run()).then(resolve, reject);
  }
  _run() {
    const t = table(this.name);
    if (this._action === 'rpc') {
      return { data: null, error: null };
    }
    if (this._action === 'insert' || this._action === 'upsert') {
      const rows = Array.isArray(this._payload) ? this._payload : [this._payload];
      const created = rows.map((r) => {
        if (this._action === 'upsert' && this._conflict) {
          const key = this._conflict;
          const existing = t.find((x) => String(x[key]) === String(r[key]));
          if (existing) {
            Object.assign(existing, r);
            return expandRelations(this.name, existing, this._select);
          }
        }
        const defaults = {
          order_items: { status: 'pending', note: '', quantity: 1 },
          orders: { status: 'draft', subtotal: 0, total: 0, discount: 0, note: '', guest_count: 1, customer_name: '' },
          dishes: { available: true, description: '', image: '' },
          dining_tables: { status: 'free', active: true, zone: 'Trong nhà', seats: 4 },
          users: { active: true, role: 'staff' },
          reservations: { status: 'pending', note: '' },
        }[this.name] || {};
        const row = { ...defaults, id: r.id ?? nextId(this.name), ...r };
        // Postgres tự điền created_at/updated_at; mock cũng phải làm vậy.
        if (row.created_at === undefined) row.created_at = new Date().toISOString();
        if (this.name === 'orders' && row.updated_at === undefined) row.updated_at = row.created_at;
        if (row.id >= (seq[this.name] || 0)) seq[this.name] = row.id;
        t.push(row);
        return expandRelations(this.name, row, this._select);
      });
      return { data: this._single ? created[0] : created, error: null };
    }
    if (this._action === 'update') {
      const rows = this._match();
      rows.forEach((r) => Object.assign(r, this._payload));
      const data = rows.map((r) => expandRelations(this.name, r, this._select));
      return { data, error: null };
    }
    if (this._action === 'delete') {
      const rows = this._match();
      const ids = rows.map((r) => r.id);
      store[this.name] = t.filter((r) => !ids.includes(r.id));
      return { data: rows.map((r) => ({ id: r.id })), error: null };
    }
    let rows = this._match();
    if (this._count) return { count: rows.length, data: null, error: null };
    if (this._head) return { data: null, error: null };
    // Với select có quan hệ lồng, mở rộng từng dòng.
    const data = rows.map((r) => expandRelations(this.name, r, this._select));
    return { data: this._single ? data[0] ?? null : data, error: null };
  }
}

const MOCK = {
  from(name) {
    return new Query(name);
  },
  async rpc(fn, params = {}) {
    try {
      const result = computeRpc(name => table(name), fn, params, seq);
      return { data: result, error: null };
    } catch (err) {
      return { data: null, error: { message: err.message } };
    }
  },
};

/* ------------------------------------------------------------------ *
 * 2. Ghi đè module './supabase' bằng MOCK trước khi route nạp nó
 * ------------------------------------------------------------------ */

const supabaseModulePath = require.resolve(path.join(__dirname, '..', 'server', 'supabase.js'));
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const resolved = (() => {
    try {
      return Module._resolveFilename(request, parent, isMain);
    } catch {
      return null;
    }
  })();
  if (resolved === supabaseModulePath) {
    return {
      supabase: MOCK,
      all: async (t, build = (q) => q) => (build(MOCK.from(t).select('*'))._run().data) || [],
      get: async (t, build = (q) => q) => {
        const rows = build(MOCK.from(t).select('*')).limit(1)._run().data || [];
        return rows[0] || null;
      },
      insert: async (t, row) => MOCK.from(t).insert(row).select().single()._run().data,
      insertMany: async (t, rows) => MOCK.from(t).insert(rows).select()._run().data,
      update: async (t, patch, build) => build(MOCK.from(t).update(patch)).select()._run().data || [],
      remove: async (t, build) => (build(MOCK.from(t).delete()).select('id')._run().data || []).length,
      rpc: async (fn, params) => (await MOCK.rpc(fn, params)).data,
      count: async (t, build = (q) => q) => build(MOCK.from(t).select('id', { count: 'exact', head: true }))._run().count || 0,
      getSettings: async () => {
        const rows = table('settings');
        return Object.fromEntries(rows.map((r) => [r.key, r.value]));
      },
      saveSettings: async (patch) => {
        Object.entries(patch).forEach(([key, value]) => {
          const row = table('settings').find((r) => r.key === key);
          if (row) row.value = String(value);
          else table('settings').push({ key, value: String(value) });
        });
        return Object.fromEntries(table('settings').map((r) => [r.key, r.value]));
      },
      SUPABASE_URL: 'mock://supabase',
    };
  }
  return originalLoad.apply(this, arguments);
};

/* ------------------------------------------------------------------ *
 * 3. Khởi tạo store và chạy kiểm thử
 * ------------------------------------------------------------------ */

const { hashPassword } = require('../server/lib/security');
const { computeRpc } = require('./rpc-logic');

module.exports = { resetStore, store: () => store, table, nextId };

if (require.main === module) {
  const { bootstrap, runTests } = require('./mock-suite');
  bootstrap();
  runTests().catch((e) => {
    console.error('❌', e.message);
    process.exit(1);
  });
}
