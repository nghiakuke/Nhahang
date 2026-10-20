'use strict';

const express = require('express');
const db = require('../supabase');
const { hashPassword, verifyPassword, signToken } = require('../lib/security');
const { ApiError, asyncHandler, authenticate, requireRole } = require('../middleware');

const router = express.Router();

/** POST /api/auth/login */
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) throw new ApiError(400, 'Thiếu tên đăng nhập hoặc mật khẩu');

    const user = await db.get('users', (q) => q.eq('username', String(username).trim()));
    if (!user || !verifyPassword(password, user.password)) {
      throw new ApiError(401, 'Tên đăng nhập hoặc mật khẩu không đúng');
    }
    if (!user.active) throw new ApiError(403, 'Tài khoản đã bị vô hiệu hóa');

    const token = signToken({ sub: user.id, role: user.role });
    res.json({ token, user: publicUser(user) });
  })
);

/** GET /api/auth/me */
router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json({ user: req.user });
  })
);

/** POST /api/auth/change-password */
router.post(
  '/change-password',
  authenticate,
  asyncHandler(async (req, res) => {
    const { old_password, new_password } = req.body || {};
    if (!old_password || !new_password) throw new ApiError(400, 'Thiếu mật khẩu cũ hoặc mới');
    if (String(new_password).length < 6) throw new ApiError(400, 'Mật khẩu mới phải từ 6 ký tự');

    const row = await db.get('users', (q) => q.select('password').eq('id', req.user.id));
    if (!verifyPassword(old_password, row.password)) throw new ApiError(400, 'Mật khẩu cũ không đúng');

    await db.update('users', { password: hashPassword(new_password) }, (q) => q.eq('id', req.user.id));
    res.json({ ok: true, message: 'Đổi mật khẩu thành công' });
  })
);

/* ------------------------- Quản lý nhân viên ---------------------- */

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    full_name: u.full_name,
    role: u.role,
    phone: u.phone,
    email: u.email,
    active: u.active,
    created_at: u.created_at,
  };
}

const ROLES = ['admin', 'manager', 'staff', 'chef'];

/** GET /api/users */
router.get(
  '/users',
  authenticate,
  requireRole('manager'),
  asyncHandler(async (req, res) => {
    const users = await db.all('users', (q) => q.order('id'));
    res.json({ users: users.map(publicUser) });
  })
);

/** POST /api/users */
router.post(
  '/users',
  authenticate,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { username, password, full_name, role, phone, email } = req.body || {};
    if (!username || !password || !full_name) {
      throw new ApiError(400, 'Vui lòng nhập tên đăng nhập, mật khẩu và họ tên');
    }
    if (String(password).length < 6) throw new ApiError(400, 'Mật khẩu phải từ 6 ký tự');
    if (role && !ROLES.includes(role)) throw new ApiError(400, 'Vai trò không hợp lệ');

    const existing = await db.get('users', (q) => q.select('id').eq('username', String(username).trim()));
    if (existing) throw new ApiError(409, 'Tên đăng nhập đã tồn tại');

    const user = await db.insert('users', {
      username: String(username).trim(),
      password: hashPassword(password),
      full_name,
      role: role || 'staff',
      phone: phone || null,
      email: email || null,
    });
    res.status(201).json({ user: publicUser(user) });
  })
);

/** PUT /api/users/:id */
router.put(
  '/users/:id',
  authenticate,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await db.get('users', (q) => q.eq('id', id));
    if (!existing) throw new ApiError(404, 'Không tìm thấy nhân viên');

    const { password, full_name, role, phone, email, active } = req.body || {};
    if (role && !ROLES.includes(role)) throw new ApiError(400, 'Vai trò không hợp lệ');
    if (password && String(password).length < 6) {
      throw new ApiError(400, 'Mật khẩu phải từ 6 ký tự');
    }
    if (id === req.user.id && (active === 0 || active === false)) {
      throw new ApiError(400, 'Không thể tự vô hiệu hóa tài khoản của mình');
    }

    const patch = {
      full_name: full_name ?? existing.full_name,
      role: role ?? existing.role,
      phone: phone ?? existing.phone,
      email: email ?? existing.email,
      active: active === undefined ? existing.active : Boolean(active),
    };
    if (password) patch.password = hashPassword(password);

    await db.update('users', patch, (q) => q.eq('id', id));
    res.json({ user: publicUser(await db.get('users', (q) => q.eq('id', id))) });
  })
);

/** DELETE /api/auth/users/:id */
router.delete(
  '/users/:id',
  authenticate,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) throw new ApiError(400, 'Không thể xóa tài khoản của chính mình');
    const existing = await db.get('users', (q) => q.select('id').eq('id', id));
    if (!existing) throw new ApiError(404, 'Không tìm thấy nhân viên');
    await db.remove('users', (q) => q.eq('id', id));
    res.json({ ok: true });
  })
);

module.exports = { router, publicUser };
