'use strict';

const { verifyToken } = require('./lib/security');
const db = require('./supabase');

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/** Xác thực JWT gửi kèm header Authorization: Bearer <token> */
async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    const payload = token ? verifyToken(token) : null;
    if (!payload) {
      return next(new ApiError(401, 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn'));
    }
    const user = await db.get('users', (q) =>
      q
        .select('id, username, full_name, role, phone, email, active')
        .eq('id', payload.sub)
    );
    if (!user || !user.active) {
      return next(new ApiError(401, 'Tài khoản không tồn tại hoặc đã bị vô hiệu hóa'));
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/** Kiểm tra vai trò; tài khoản admin luôn được phép */
const requireRole =
  (...roles) =>
  (req, res, next) => {
    if (!req.user) return next(new ApiError(401, 'Chưa đăng nhập'));
    if (req.user.role === 'admin' || roles.includes(req.user.role)) return next();
    next(new ApiError(403, 'Bạn không có quyền thực hiện thao tác này'));
  };

module.exports = { ApiError, asyncHandler, authenticate, requireRole };
