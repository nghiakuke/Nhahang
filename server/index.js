'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const { SUPABASE_URL } = require('./supabase');
const { ApiError } = require('./middleware');

const authRoutes = require('./routes/auth').router;
const menuRoutes = require('./routes/menu');
const tableRoutes = require('./routes/tables').router;
const orderRoutes = require('./routes/orders');
const reservationRoutes = require('./routes/reservations');
const reportRoutes = require('./routes/reports').router;

const app = express();
const PORT = Number(process.env.PORT || 3000);
// Cho phép đặt cổng qua tham số dòng lệnh: node server/index.js 4000
const portArg = Number(process.argv[2]);
const LISTEN_PORT = Number.isFinite(portArg) && portArg > 0 ? portArg : PORT;

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Log request đơn giản
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api')) {
      console.log(
        `${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - start}ms)`
      );
    }
  });
  next();
});

app.use('/api/auth', authRoutes);

// Các router tách riêng có gắn tiền tố (route con không lặp lại tiền tố)
const categoryRouter = express.Router();
categoryRouter.use(menuRoutes.categoryRouter);
app.use('/api/categories', categoryRouter);

const dishRouter = express.Router();
dishRouter.use(menuRoutes.dishRouter);
app.use('/api/dishes', dishRouter);
app.use('/api/tables', tableRoutes);
app.use('/api/orders', orderRoutes.router);
app.use('/api/kitchen', orderRoutes.kitchenRouter);
app.use('/api/reservations', reservationRoutes.router);
app.use('/api/customers', reservationRoutes.customerRouter);
app.use('/api/reports', reportRoutes);

app.get('/api/health', (req, res) =>
  res.json({ ok: true, time: new Date().toISOString(), db: 'supabase', project: SUPABASE_URL })
);

// Frontend (SPA)
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));
// SPA fallback: mọi đường dẫn không thuộc /api đều trả về index.html
app.get(/^(?!\/api(?:\/|$)).*/, (req, res, next) => {
  res.sendFile(path.join(publicDir, 'index.html'), (err) => (err ? next() : undefined));
});

// 404 cho API (đặt CUỐI CÙNG, sau static & SPA fallback)
app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ message: 'Không tìm thấy endpoint' });
  }
  res.status(404).send('Không tìm thấy trang');
});

// Xử lý lỗi tập trung
app.use((err, req, res, next) => {
  const status = err instanceof ApiError ? err.status : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ message: err.message || 'Lỗi máy chủ' });
});

app.listen(LISTEN_PORT, () => {
  console.log(`✅ Nhà hàng đã chạy tại http://localhost:${LISTEN_PORT}`);
  console.log(`   Database: Supabase (${SUPABASE_URL})`);
  console.log(`   Tài khoản mặc định: admin / admin123`);
});
