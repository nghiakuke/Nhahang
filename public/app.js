/* ==================================================================
 * Quản lý nhà hàng — ứng dụng SPA (Vanilla JS)
 * ================================================================== */

'use strict';

/* ------------------------------- Trạng thái ------------------------------ */

const state = {
  token: localStorage.getItem('rm_token') || null,
  user: JSON.parse(localStorage.getItem('rm_user') || 'null'),
  route: 'dashboard',
  pos: null,        // { orderId, tableName, items, order }
  posCategory: null,
  kitchenQueue: [],
  timer: null,
};

const money = (n) => Number(n || 0).toLocaleString('vi-VN') + '₫';
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

const ORDER_STATUS = {
  draft: { label: 'Chưa gửi bếp', cls: 'gray' },
  cooking: { label: 'Đang chế biến', cls: 'orange' },
  ready: { label: 'Chín - chờ bưng', cls: 'blue' },
  served: { label: 'Đã phục vụ', cls: 'purple' },
  paid: { label: 'Đã thanh toán', cls: 'green' },
  cancelled: { label: 'Đã hủy', cls: 'red' },
};
const ITEM_STATUS = {
  pending: { label: 'Chờ chế biến', cls: 'gray' },
  cooking: { label: 'Đang nấu', cls: 'orange' },
  ready: { label: 'Đã chín', cls: 'blue' },
  served: { label: 'Đã bưng', cls: 'green' },
  cancelled: { label: 'Đã hủy', cls: 'red' },
};
const TABLE_STATUS = {
  free: { label: 'Trống', cls: 'green' },
  occupied: { label: 'Có khách', cls: 'orange' },
  reserved: { label: 'Đã đặt', cls: 'blue' },
};
const PAY_METHODS = {
  cash: 'Tiền mặt', card: 'Thẻ', momo: 'MoMo', zalo: 'ZaloPay', bank: 'Chuyển khoản',
};
const ROLE_LABEL = { admin: 'Quản trị viên', manager: 'Quản lý', staff: 'Nhân viên', chef: 'Bếp' };
const RESV_STATUS = {
  pending: { label: 'Chờ xác nhận', cls: 'gray' },
  confirmed: { label: 'Đã xác nhận', cls: 'blue' },
  seated: { label: 'Đã vào bàn', cls: 'green' },
  cancelled: { label: 'Đã hủy', cls: 'red' },
};

const can = (...roles) =>
  !!state.user && (state.user.role === 'admin' || roles.includes(state.user.role));
const isManager = () => can('manager');

const statusTag = (status, map) => {
  const meta = (map[status] || { label: status, cls: 'gray' });
  return `<span class="tag ${meta.cls}">${esc(meta.label)}</span>`;
};

/* --------------------------------- API ---------------------------------- */

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(auth && state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  // 401 chỉ có nghĩa "phiên hết hạn" khi yêu cầu kèm token đã lưu.
  // Với chính màn hình đăng nhập (auth: false) thì 401 là sai tài khoản/mật khẩu.
  if (res.status === 401 && auth && state.token) {
    logout('Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại');
    throw new Error('Chưa đăng nhập');
  }
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error('Máy chủ trả về dữ liệu không hợp lệ');
  }
  if (!res.ok) throw new Error(data.message || `Lỗi ${res.status}`);
  return data;
}

/* -------------------------------- Toast --------------------------------- */

function toast(message, type = 'ok') {
  const wrap = document.getElementById('toast');
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'ok' ? '' : ` ${type}`);
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = '.25s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(20px)';
    setTimeout(() => el.remove(), 260);
  }, 2800);
}

/* -------------------------------- Modal --------------------------------- */

function openModal({ title, body, footer, wide }) {
  closeModal();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.id = 'modal';
  backdrop.innerHTML = `
    <div class="modal${wide ? ' wide' : ''}">
      <div class="modal-head">
        <h3>${esc(title)}</h3>
        <button class="btn ghost sm" data-close>✕</button>
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div>`;
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });
  backdrop.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', closeModal)
  );
  document.body.appendChild(backdrop);
  return backdrop;
}
const closeModal = () => document.getElementById('modal')?.remove();
const confirmDialog = (message, onYes, yesLabel = 'Xác nhận') => {
  const m = openModal({
    title: 'Xác nhận',
    body: `<p>${esc(message)}</p>`,
    footer: `<button class="btn" data-close>Hủy</button>
             <button class="btn danger" id="m-yes">${esc(yesLabel)}</button>`,
  });
  m.querySelector('#m-yes').addEventListener('click', async () => {
    closeModal();
    await onYes();
  });
};

/* ------------------------------ Đăng nhập ------------------------------- */

function saveSession(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem('rm_token', token);
  localStorage.setItem('rm_user', JSON.stringify(user));
}

function logout(message) {
  state.token = null;
  state.user = null;
  state.pos = null;
  stopPolling();
  localStorage.removeItem('rm_token');
  localStorage.removeItem('rm_user');
  if (message) toast(message, 'warn');
  renderLogin();
}

function renderLogin() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="login-page">
      <div class="login-card">
        <div class="login-logo">🍜</div>
        <h1>Quản lý nhà hàng</h1>
        <p class="sub">Đăng nhập để tiếp tục</p>
        <form id="login-form">
          <div class="field">
            <label for="lg-user">Tên đăng nhập</label>
            <input id="lg-user" autocomplete="username" required autofocus />
          </div>
          <div class="field">
            <label for="lg-pass">Mật khẩu</label>
            <input id="lg-pass" type="password" autocomplete="current-password" required />
          </div>
          <div id="lg-error" class="tag red hidden" style="margin-bottom:12px"></div>
          <button class="btn primary block" type="submit" id="lg-submit">Đăng nhập</button>
        </form>
        <div class="demo-accounts">
          <div class="mb"><b>Tài khoản demo</b> (bấm để điền nhanh):</div>
          <div class="row" style="gap:8px">
            <code data-u="admin" data-p="admin123">admin / admin123</code>
            <code data-u="quanly" data-p="quanly123">quanly / quanly123</code>
          </div>
          <div class="row mt" style="gap:8px">
            <code data-u="nhanvien" data-p="nhanvien123">nhanvien / nhanvien123</code>
            <code data-u="bep" data-p="bep12345">bep / bep12345</code>
          </div>
        </div>
      </div>
    </div>`;

  app.querySelectorAll('.demo-accounts code').forEach((c) =>
    c.addEventListener('click', () => {
      app.querySelector('#lg-user').value = c.dataset.u;
      app.querySelector('#lg-pass').value = c.dataset.p;
    })
  );

  app.querySelector('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = app.querySelector('#lg-submit');
    const errBox = app.querySelector('#lg-error');
    btn.disabled = true;
    btn.textContent = 'Đang đăng nhập...';
    errBox.classList.add('hidden');
    try {
      const data = await api('/auth/login', {
        method: 'POST',
        auth: false,
        body: {
          username: app.querySelector('#lg-user').value.trim(),
          password: app.querySelector('#lg-pass').value,
        },
      });
      saveSession(data.token, data.user);
      state.route = 'dashboard';
      renderApp();
      toast(`Xin chào ${data.user.full_name}!`);
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Đăng nhập';
    }
  });
}

/* ------------------------------- Khung app ------------------------------ */

const NAV = [
  { id: 'dashboard', icon: '📊', label: 'Tổng quan' },
  { id: 'pos', icon: '🧾', label: 'Bán hàng (POS)' },
  { id: 'tables', icon: '🪑', label: 'Sơ đồ bàn' },
  { id: 'kitchen', icon: '👨‍🍳', label: 'Màn hình bếp' },
  { id: 'orders', icon: '📋', label: 'Đơn hàng' },
  { id: 'reservations', icon: '📅', label: 'Đặt bàn' },
  { id: 'customers', icon: '👥', label: 'Khách hàng' },
  { id: 'menu', icon: '🍽️', label: 'Thực đơn' },
  { id: 'tables-manage', icon: '🏗️', label: 'Quản lý bàn', manager: true },
  { id: 'staff', icon: '🧑‍💼', label: 'Nhân viên', manager: true },
  { id: 'reports', icon: '📈', label: 'Báo cáo', manager: true },
  { id: 'settings', icon: '⚙️', label: 'Cài đặt' },
];

const ROUTE_TITLE = {
  dashboard: 'Tổng quan',
  pos: 'Bán hàng (POS)',
  tables: 'Sơ đồ bàn',
  kitchen: 'Màn hình bếp',
  orders: 'Đơn hàng',
  reservations: 'Đặt bàn',
  customers: 'Khách hàng',
  menu: 'Thực đơn',
  'tables-manage': 'Quản lý bàn',
  staff: 'Nhân viên',
  reports: 'Báo cáo doanh thu',
  settings: 'Cài đặt',
};

function navItems() {
  return NAV.filter((n) => !n.manager || isManager());
}

function renderApp() {
  const app = document.getElementById('app');
  const items = navItems();
  if (!items.some((i) => i.id === state.route)) state.route = 'dashboard';

  app.innerHTML = `
    <div class="layout">
      <aside class="sidebar" id="sidebar">
        <div class="brand">
          <span class="logo">🍜</span>
          <div>
            <b id="brand-name">Nhà hàng</b>
            <small>Hệ thống quản lý</small>
          </div>
        </div>
        <nav class="nav">
          ${items
            .map(
              (i) => `<button data-route="${i.id}" class="${state.route === i.id ? 'active' : ''}">
                        <span class="icon">${i.icon}</span><span>${i.label}</span>
                        <span class="badge-count hidden" data-badge="${i.id}"></span>
                      </button>`
            )
            .join('')}
        </nav>
        <div class="user-box">
          <div class="name">${esc(state.user.full_name)}</div>
          <div class="role">${esc(ROLE_LABEL[state.user.role] || state.user.role)}</div>
          <button class="btn sm" style="width:100%;justify-content:center" id="btn-change-pass">
            🔑 Đổi mật khẩu
          </button>
          <button class="btn sm danger mt" style="width:100%;justify-content:center" id="btn-logout">
            ⏻ Đăng xuất
          </button>
        </div>
      </aside>

      <div class="main">
        <header class="topbar">
          <button class="btn ghost menu-toggle" id="nav-toggle">☰</button>
          <h2 id="page-title">${ROUTE_TITLE[state.route]}</h2>
          <div class="spacer"></div>
          <span class="small muted" id="clock"></span>
        </header>
        <main class="content" id="view"></main>
      </div>
    </div>`;

  app.querySelectorAll('[data-route]').forEach((b) =>
    b.addEventListener('click', () => {
      state.route = b.dataset.route;
      state.pos = null;
      document.getElementById('sidebar').classList.remove('open');
      renderApp();
    })
  );
  app.querySelector('#nav-toggle').addEventListener('click', () =>
    document.getElementById('sidebar').classList.toggle('open')
  );
  app.querySelector('#btn-logout').addEventListener('click', () =>
    confirmDialog('Bạn có chắc muốn đăng xuất?', () => logout())
  );
  app.querySelector('#btn-change-pass').addEventListener('click', openChangePassword);

  const tick = () => {
    const el = document.getElementById('clock');
    if (el) el.textContent = new Date().toLocaleString('vi-VN', { hour12: false });
  };
  tick();
  clearInterval(state.timer);
  state.timer = setInterval(tick, 1000);

  renderRoute();
}

function renderRoute() {
  const view = document.getElementById('view');
  document.getElementById('page-title').textContent = ROUTE_TITLE[state.route] || '';
  view.innerHTML = '<div class="empty">Đang tải…</div>';
  const renderers = {
    dashboard: viewDashboard,
    pos: viewPos,
    tables: viewTables,
    kitchen: viewKitchen,
    orders: viewOrders,
    reservations: viewReservations,
    customers: viewCustomers,
    menu: viewMenu,
    'tables-manage': viewTablesManage,
    staff: viewStaff,
    reports: viewReports,
    settings: viewSettings,
  };
  Promise.resolve(renderers[state.route](view)).catch((err) => {
    view.innerHTML = `<div class="empty"><div class="big">⚠️</div>${esc(err.message)}</div>`;
  });
  updateBadges();
}

/** Cập nhật số lượng trên menu (đơn đang mở, món đang chờ bếp) */
async function updateBadges() {
  try {
    const set = (route, value) => {
      document.querySelectorAll(`[data-badge="${route}"]`).forEach((el) => {
        el.textContent = value;
        el.classList.toggle('hidden', !value);
      });
    };
    const [tables, kitchen] = await Promise.all([
      api('/tables'),
      api('/kitchen'),
    ]);
    const occupied = tables.tables.filter((t) => t.status === 'occupied').length;
    const items = kitchen.queue.reduce(
      (sum, o) => sum + o.items.filter((i) => i.status === 'pending' || i.status === 'cooking').length,
      0
    );
    set('pos', occupied);
    set('kitchen', items);
  } catch {
    /* bỏ qua lỗi cập nhật badge */
  }
}

function openChangePassword() {
  const m = openModal({
    title: 'Đổi mật khẩu',
    body: `
      <div class="field"><label>Mật khẩu hiện tại</label><input type="password" id="cp-old" /></div>
      <div class="field"><label>Mật khẩu mới (tối thiểu 6 ký tự)</label><input type="password" id="cp-new" /></div>
      <div class="field"><label>Nhập lại mật khẩu mới</label><input type="password" id="cp-new2" /></div>`,
    footer: `<button class="btn" data-close>Hủy</button>
             <button class="btn primary" id="cp-save">Lưu</button>`,
  });
  m.querySelector('#cp-save').addEventListener('click', async () => {
    const oldP = m.querySelector('#cp-old').value;
    const newP = m.querySelector('#cp-new').value;
    const new2 = m.querySelector('#cp-new2').value;
    if (newP !== new2) return toast('Mật khẩu nhập lại không khớp', 'error');
    try {
      await api('/auth/change-password', {
        method: 'POST',
        body: { old_password: oldP, new_password: newP },
      });
      closeModal();
      toast('Đổi mật khẩu thành công');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/* ------------------------------ 1. Tổng quan ---------------------------- */

async function viewDashboard(view) {
  const [d, tables] = await Promise.all([api('/reports/dashboard'), api('/tables')]);
  const occupied = tables.tables.filter((t) => t.status === 'occupied').length;

  view.innerHTML = `
    <div class="grid cols-4 mb">
      <div class="stat">
        <div class="label">Doanh thu hôm nay</div>
        <div class="value">${money(d.today_revenue)}</div>
        <div class="hint">${d.today_bills} hóa đơn</div>
      </div>
      <div class="stat">
        <div class="label">Doanh thu tháng này</div>
        <div class="value small">${money(d.month_revenue)}</div>
        <div class="hint">Từ đầu tháng</div>
      </div>
      <div class="stat">
        <div class="label">Bàn đang phục vụ</div>
        <div class="value">${occupied}/${d.tables.total}</div>
        <div class="hint">${d.tables.reserved || 0} bàn đã đặt trước</div>
      </div>
      <div class="stat">
        <div class="label">Món chờ chế biến</div>
        <div class="value">${d.cooking_items}</div>
        <div class="hint">${d.pending_reservations} lượt đặt bàn hôm nay</div>
      </div>
    </div>

    <div class="grid cols-2">
      <div class="card">
        <div class="row between mb">
          <h3 style="margin:0">Hoạt động gần đây</h3>
          <button class="btn sm" data-go="orders">Xem tất cả</button>
        </div>
        ${
          d.recent_orders.length
            ? `<div class="table-wrap"><table>
                 <thead><tr><th>Mã đơn</th><th>Bàn</th><th>Trạng thái</th><th class="right">Tổng</th></tr></thead>
                 <tbody>${d.recent_orders
                   .map(
                     (o) => `<tr>
                       <td><b>${esc(o.order_code)}</b></td>
                       <td>${esc(o.table_name || '—')}</td>
                       <td>${statusTag(o.status, ORDER_STATUS)}</td>
                       <td class="right">${money(o.total)}</td>
                     </tr>`
                   )
                   .join('')}</tbody></table></div>`
            : `<div class="empty"><div class="big">🧾</div>Chưa có đơn hàng nào</div>`
        }
      </div>

      <div class="card">
        <h3>Hóa đơn mới nhất</h3>
        ${
          d.last_payments.length
            ? `<div class="table-wrap"><table>
                 <thead><tr><th>Mã đơn</th><th>Hình thức</th><th class="right">Số tiền</th></tr></thead>
                 <tbody>${d.last_payments
                   .map(
                     (p) => `<tr>
                       <td>${esc(p.order_code)}<div class="small muted">${esc(p.table_name || '')}</div></td>
                       <td>${esc(PAY_METHODS[p.method] || p.method)}<div class="small muted">${esc(new Date(p.created_at).toLocaleString('vi-VN'))}</div></td>
                       <td class="right"><b>${money(p.amount)}</b></td>
                     </tr>`
                   )
                   .join('')}</tbody></table></div>`
            : `<div class="empty"><div class="big">💳</div>Chưa có hóa đơn nào</div>`
        }
      </div>
    </div>

    <div class="card">
      <h3>Bàn trống nhanh</h3>
      <div class="row">
        ${tables.tables
          .filter((t) => t.status === 'free')
          .map((t) => `<button class="btn sm" data-open-table="${t.id}">🪑 ${esc(t.name)}</button>`)
          .join('') || '<span class="muted">Không còn bàn trống</span>'}
      </div>
    </div>

    ${
      state.user?.role === 'admin'
        ? `<div class="card" style="margin-top:16px">
      <div class="row between mb">
        <h3 style="margin:0">🤖 Trợ lý AI</h3>
        <span class="tag blue">Chat</span>
      </div>
      <div id="ai-chat-bubble" style="position:relative;height:320px;border:1px solid var(--border);border-radius:12px;overflow:hidden;background:var(--panel-2);display:flex;flex-direction:column">
        <div id="ai-chat-messages" style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;scroll-behavior:smooth"></div>
        <div style="padding:12px;border-top:1px solid var(--border);background:var(--panel);display:flex;gap:8px;align-items:center">
          <input id="ai-chat-input" type="text" placeholder='Thử: "thêm 2 phở bò cho bàn 3", "thanh toán bàn 3", "doanh thu hôm nay"...' style="flex:1;padding:10px 14px;border:1px solid var(--border);border-radius:24px;background:var(--bg);color:var(--text);font-size:13px" />
          <button class="btn" id="ai-chat-mic" style="border-radius:50%;width:40px;height:40px;padding:0;flex-shrink:0" title="Nói bằng giọng nói">🎤</button>
          <button class="btn primary" id="ai-chat-send" style="border-radius:50%;width:40px;height:40px;padding:0;flex-shrink:0" title="Gửi">➤</button>
        </div>
        <div id="ai-chat-typing" style="display:none;padding:0 16px 8px;font-size:11px;color:var(--muted)">Trợ lý đang trả lời...</div>
      </div>
    </div>`
        : ''
    }`;

  view.querySelectorAll('[data-go]').forEach((b) =>
    b.addEventListener('click', () => {
      state.route = b.dataset.go;
      state.pos = null;
      renderApp();
    })
  );
  view.querySelectorAll('[data-open-table]').forEach((b) =>
    b.addEventListener('click', () => openPosForTable(Number(b.dataset.openTable)))
  );

  setupAIChatBubble(view);
}

function setupAIChatBubble(view) {
  const messagesDiv = view.querySelector('#ai-chat-messages');
  const input = view.querySelector('#ai-chat-input');
  const sendBtn = view.querySelector('#ai-chat-send');
  const micBtn = view.querySelector('#ai-chat-mic');
  const typingDiv = view.querySelector('#ai-chat-typing');
  
  if (!messagesDiv) return;
  
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const speechSynthesis = window.speechSynthesis;
  
  // Welcome message
  setTimeout(() => {
    addBubbleMessage("Xin chào! Mình là trợ lý AI toàn quyền của nhà hàng — mình có thể mở đơn, thêm món, thanh toán, quản lý bàn, thực đơn, nhân viên... Bạn cứ ra lệnh tự nhiên nhé!", false);
  }, 300);
  
  function addBubbleMessage(text, isUser) {
    const msgWrap = document.createElement('div');
    msgWrap.style.cssText = `display:flex;gap:8px;align-items:flex-end;${isUser ? 'flex-direction:row-reverse' : ''}`;
    
    if (!isUser) {
      const avatar = document.createElement('div');
      avatar.style.cssText = 'width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:16px';
      avatar.textContent = '🤖';
      msgWrap.appendChild(avatar);
    }
    
    const bubble = document.createElement('div');
    bubble.style.cssText = `max-width:70%;padding:10px 14px;border-radius:18px;word-wrap:break-word;font-size:13px;line-height:1.5;${isUser ? 'background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;border-bottom-right-radius:4px' : 'background:var(--panel);color:var(--text);border:1px solid var(--border);border-bottom-left-radius:4px'}`;
    bubble.textContent = text;
    msgWrap.appendChild(bubble);
    messagesDiv.appendChild(msgWrap);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }
  
  function speak(text) {
    if (speechSynthesis) {
      speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'vi-VN';
      utterance.rate = 0.95;
      utterance.pitch = 1;
      speechSynthesis.speak(utterance);
    }
  }
  
  async function getAIResponse(userMessage) {
    typingDiv.style.display = 'block';
    messagesDiv.scrollTop = messagesDiv.scrollHeight;

    let reply = 'Xin lỗi, đã có lỗi xảy ra.';
    let actions = [];
    try {
      const data = await api('/assistant/chat', { method: 'POST', body: { message: userMessage } });
      reply = data.reply || '(trống)';
      actions = data.actions || [];
      const done = actions.filter((a) => a.ok).length;
      if (actions.length) {
        addBubbleMessage(
          done === actions.length
            ? `✅ Đã thực hiện ${done}/${actions.length} thao tác`
            : `⚠️ Thực hiện được ${done}/${actions.length} thao tác`,
          false
        );
      }
    } catch (e) {
      reply = `Xin lỗi, mình gặp lỗi: ${e.message}`;
    }

    typingDiv.style.display = 'none';
    addBubbleMessage(reply, false);
    speak(reply);
  }
  
  function sendMessage() {
    const text = input.value.trim();
    if (!text) return;
    addBubbleMessage(text, true);
    input.value = '';
    getAIResponse(text);
  }
  
  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
  });
  
  if (SpeechRecognition) {
    micBtn.addEventListener('click', () => {
      const recognition = new SpeechRecognition();
      recognition.lang = 'vi-VN';
      recognition.interimResults = false;
      
      micBtn.style.background = 'var(--danger)';
      micBtn.textContent = '⏹';
      input.placeholder = 'Đang nghe...';
      
      recognition.onresult = (event) => {
        const transcript = event.results[0][0].transcript;
        input.value = transcript;
        micBtn.style.background = '';
        micBtn.textContent = '🎤';
        input.placeholder = 'Nhập tin nhắn hoặc nhấn mic để nói...';
        sendMessage();
      };
      
      recognition.onerror = () => {
        micBtn.style.background = '';
        micBtn.textContent = '🎤';
        input.placeholder = 'Nhập tin nhắn hoặc nhấn mic để nói...';
      };
      
      recognition.onend = () => {
        micBtn.style.background = '';
        micBtn.textContent = '🎤';
        input.placeholder = 'Nhập tin nhắn hoặc nhấn mic để nói...';
      };
      
      recognition.start();
    });
  } else {
    micBtn.disabled = true;
    micBtn.title = 'Trình duyệt không hỗ trợ';
  }
}

/* ------------------------------ 2. Sơ đồ bàn ---------------------------- */

async function viewTables(view) {
  const { tables } = await api('/tables');
  const zones = [...new Set(tables.map((t) => t.zone))];

  view.innerHTML = `
    <div class="row mb">
      <button class="btn primary" id="t-refresh">🔄 Làm mới</button>
      <span class="spacer"></span>
      <span class="tag green">Trống ${tables.filter((t) => t.status === 'free').length}</span>
      <span class="tag orange">Có khách ${tables.filter((t) => t.status === 'occupied').length}</span>
      <span class="tag blue">Đã đặt ${tables.filter((t) => t.status === 'reserved').length}</span>
    </div>
    ${zones
      .map(
        (z) => `
      <div class="zone-title">${esc(z)}</div>
      <div class="tables-grid">
        ${tables
          .filter((t) => t.zone === z)
          .map(
            (t) => `
          <div class="table-card ${t.status}" data-table="${t.id}">
            <span class="status-dot"></span>
            <div class="tname">${esc(t.name)}</div>
            <div class="tzone">${t.seats} chỗ</div>
            <div class="tmeta">${
              t.order_id
                ? `${esc(t.order_code)} • ${t.item_count} món`
                : t.status === 'reserved'
                  ? 'Đã có khách đặt trước'
                  : 'Sẵn sàng phục vụ'
            }</div>
            ${t.order_total ? `<div class="tprice">${money(t.order_total)}</div>` : ''}
          </div>`
          )
          .join('')}
      </div>`
      )
      .join('')}`;

  view.querySelector('#t-refresh').addEventListener('click', renderRoute);
  view.querySelectorAll('[data-table]').forEach((card) =>
    card.addEventListener('click', () => openPosForTable(Number(card.dataset.table)))
  );
}

/* ------------------------------ 3. Bán hàng ----------------------------- */

async function openPosForTable(tableId) {
  const { tables } = await api('/tables');
  const table = tables.find((t) => t.id === tableId);
  if (!table) return toast('Không tìm thấy bàn', 'error');
  if (table.status === 'reserved' && !table.order_id) {
    toast(`Bàn ${table.name} đã được đặt trước`, 'warn');
  }

  if (table.order_id) {
    const data = await api(`/orders/${table.order_id}`);
    state.pos = {
      orderId: data.order.id,
      order: data.order,
      items: data.items,
      tableName: table.name,
    };
  } else {
    state.pos = { orderId: null, order: null, items: [], tableName: table.name, tableId };
  }
  state.posCategory = state.posCategory || 'all';
  state.route = 'pos';
  renderApp();
}

async function viewPos(view) {
  const [{ dishes }, { categories }] = await Promise.all([api('/dishes'), api('/categories')]);

  let tableInfo = null;
  if (state.pos) {
    const { tables } = await api('/tables');
    tableInfo = tables.find((t) => t.name === state.pos.tableName) || null;
  }

  view.innerHTML = `
    <div class="row mb">
      <span class="tag ${state.pos ? 'orange' : 'gray'}">
        🪑 ${esc(state.pos?.tableName || 'Chưa chọn bàn')}
      </span>
      ${state.pos?.order ? `<span class="tag gray">${esc(state.pos.order.order_code)}</span>` : ''}
      ${state.pos ? `<button class="btn sm" id="pos-close">Đóng đơn / kết thúc</button>` : ''}
      <span class="spacer"></span>
      <select id="pos-table" style="max-width:220px">
        <option value="">— Chọn bàn để mở đơn —</option>
        ${(tableInfo ? [tableInfo] : []).length ? '' : ''}
      </select>
    </div>

    ${!state.pos ? renderPosTablePicker() : ''}

    <div class="pos-layout ${state.pos ? '' : 'hidden'}" id="pos-body">
      <div>
        <div class="card">
          <div class="row mb">
            <input id="dish-search" placeholder="🔍 Tìm món ăn…" style="max-width:280px" />
            <span class="spacer"></span>
          </div>
          <div class="row mb" id="cat-filter">
            <button class="btn sm ${state.posCategory === 'all' ? 'primary' : ''}" data-cat="all">Tất cả</button>
            ${categories
              .map(
                (c) => `<button class="btn sm ${state.posCategory == c.id ? 'primary' : ''}" data-cat="${c.id}">${esc(c.name)}</button>`
              )
              .join('')}
          </div>
          <div class="menu-grid" id="menu-grid"></div>
        </div>
      </div>
      <div class="cart" id="cart"></div>
    </div>`;

  // Chọn bàn khi chưa mở đơn
  if (!state.pos) {
    const picker = view.querySelector('#pos-picker');
    if (picker) {
      const { tables } = await api('/tables');
      picker.innerHTML = tables
        .map(
          (t) => `<div class="table-card ${t.status}" data-pos-table="${t.id}">
             <span class="status-dot"></span>
             <div class="tname">${esc(t.name)}</div>
             <div class="tzone">${esc(t.zone)} • ${t.seats} chỗ</div>
             <div class="tmeta">${t.order_id ? `Đang có khách` : t.status === 'reserved' ? 'Đã đặt trước' : 'Trống'}</div>
           </div>`
        )
        .join('');
      picker.querySelectorAll('[data-pos-table]').forEach((c) =>
        c.addEventListener('click', () => openPosForTable(Number(c.dataset.posTable)))
      );
    }
    return;
  }

  const grid = view.querySelector('#menu-grid');
  const drawDishes = (keyword = '') => {
    const list = dishes.filter(
      (d) =>
        (state.posCategory === 'all' || d.category_id === Number(state.posCategory)) &&
        (!keyword || d.name.toLowerCase().includes(keyword.toLowerCase()))
    );
    grid.innerHTML = list.length
      ? list
          .map(
            (d) => `<div class="dish-card" data-dish="${d.id}">
              <div class="emoji">${esc(d.image || '🍽️')}</div>
              <div class="dname">${esc(d.name)}</div>
              <div class="dprice">${money(d.price)} <small>· ${esc(d.category_name || '')}</small></div>
            </div>`
          )
          .join('')
      : `<div class="empty">Không tìm thấy món phù hợp</div>`;
    grid.querySelectorAll('[data-dish]').forEach((c) =>
      c.addEventListener('click', () => addDishToOrder(Number(c.dataset.dish)))
    );
  };
  drawDishes();

  view.querySelector('#dish-search').addEventListener('input', (e) => drawDishes(e.target.value));
  view.querySelectorAll('[data-cat]').forEach((b) =>
    b.addEventListener('click', () => {
      state.posCategory = b.dataset.cat === 'all' ? 'all' : Number(b.dataset.cat);
      renderRoute();
    })
  );

  const closeBtn = view.querySelector('#pos-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      state.pos = null;
      renderRoute();
    });
  }

  drawCart();
}

function renderPosTablePicker() {
  return `<div class="card"><h3>Chọn bàn để bắt đầu</h3>
    <div class="tables-grid" id="pos-picker"><div class="empty">Đang tải…</div></div></div>`;
}

async function addDishToOrder(dishId) {
  if (!state.pos) return;
  try {
    if (!state.pos.orderId) {
      const created = await api('/orders', {
        method: 'POST',
        body: { table_id: state.pos.tableId, guest_count: 2 },
      });
      state.pos.orderId = created.order.id;
      state.pos.order = created.order;
    }
    const res = await api(`/orders/${state.pos.orderId}/items`, {
      method: 'POST',
      body: { dish_id: dishId, quantity: 1 },
    });
    state.pos.items = res.items;
    state.pos.order = res.order;
    drawCart();
    updateBadges();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function drawCart() {
  const cart = document.getElementById('cart');
  if (!cart || !state.pos) return;
  const items = state.pos.items.filter((i) => i.status !== 'cancelled');

  cart.innerHTML = `
    <div class="card">
      <div class="row between mb">
        <h3 style="margin:0">Đơn hàng</h3>
        <span class="tag gray">${items.length} món</span>
      </div>
      <div class="cart-items">
        ${
          items.length
            ? items
                .map(
                  (i) => `
          <div class="cart-item">
            <div class="info">
              <div class="iname">${esc(i.dish_name)}</div>
              <div class="iprice">${money(i.price)} × ${i.quantity} = <b>${money(i.price * i.quantity)}</b></div>
              ${i.note ? `<div class="inote">📝 ${esc(i.note)}</div>` : ''}
              <div class="mt" style="margin-top:6px">${statusTag(i.status, ITEM_STATUS)}</div>
            </div>
            <div>
              <div class="qty">
                <button data-dec="${i.id}">−</button>
                <span>${i.quantity}</span>
                <button data-inc="${i.id}">+</button>
              </div>
              <button class="btn ghost sm mt" data-del="${i.id}" style="width:100%;justify-content:center">🗑</button>
            </div>
          </div>`
                )
                .join('')
            : `<div class="empty">Chưa có món nào.<br />Bấm vào món ăn để thêm.</div>`
        }
      </div>

      <div class="cart-total">
        <div class="line"><span>Tạm tính</span><b>${money(state.pos.order?.subtotal)}</b></div>
        <div class="line"><span>Giảm giá</span><b>−${money(state.pos.order?.discount)}</b></div>
        <div class="line grand"><span>Tổng cộng</span><span>${money(state.pos.order?.total)}</span></div>
      </div>

      <div class="row mt">
        <button class="btn block" id="cart-send" ${items.some((i) => i.status === 'pending') ? '' : 'disabled'}>
          👨‍🍳 Gửi bếp
        </button>
        <button class="btn success block" id="cart-pay" ${items.length ? '' : 'disabled'}>
          💳 Thanh toán
        </button>
      </div>
      <div class="row mt">
        <button class="btn ghost sm block" id="cart-note">📝 Ghi chú / thông tin đơn</button>
      </div>
    </div>`;

  cart.querySelectorAll('[data-inc]').forEach((b) =>
    b.addEventListener('click', () => changeItemQty(Number(b.dataset.inc), 1))
  );
  cart.querySelectorAll('[data-dec]').forEach((b) =>
    b.addEventListener('click', () => changeItemQty(Number(b.dataset.dec), -1))
  );
  cart.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', () => removeItem(Number(b.dataset.del)))
  );
  cart.querySelector('#cart-send').addEventListener('click', () => sendToKitchen());
  cart.querySelector('#cart-pay').addEventListener('click', () => openCheckout());
  cart.querySelector('#cart-note').addEventListener('click', openOrderInfo);
}

async function changeItemQty(itemId, delta) {
  const item = state.pos.items.find((i) => i.id === itemId);
  if (!item) return;
  const qty = item.quantity + delta;
  if (qty < 1) return removeItem(itemId);
  try {
    const res = await api(`/orders/${state.pos.orderId}/items/${itemId}`, {
      method: 'PATCH',
      body: { quantity: qty },
    });
    state.pos.items = res.items;
    state.pos.order = res.order;
    drawCart();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function removeItem(itemId) {
  const item = state.pos.items.find((i) => i.id === itemId);
  if (!item) return;
  confirmDialog(`Xóa món "${item.dish_name}" khỏi đơn?`, async () => {
    try {
      const res = await api(`/orders/${state.pos.orderId}/items/${itemId}`, { method: 'DELETE' });
      state.pos.items = res.items;
      state.pos.order = res.order;
      drawCart();
      toast('Đã xóa món');
    } catch (err) {
      toast(err.message, 'error');
    }
  }, 'Xóa món');
}

async function sendToKitchen() {
  try {
    const res = await api(`/orders/${state.pos.orderId}/status`, {
      method: 'POST',
      body: { status: 'cooking' },
    });
    state.pos.order = res.order;
    state.pos.items = res.items;
    drawCart();
    updateBadges();
    toast('Đã gửi đơn xuống bếp 👨‍🍳');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function openOrderInfo() {
  const o = state.pos.order || {};
  const m = openModal({
    title: 'Thông tin đơn hàng',
    body: `
      <div class="field"><label>Tên khách hàng</label>
        <input id="oi-name" value="${esc(o.customer_name || '')}" placeholder="Khách lẻ" /></div>
      <div class="field"><label>Số khách</label>
        <input id="oi-guests" type="number" min="1" value="${o.guest_count || 2}" /></div>
      <div class="field"><label>Ghi chú</label>
        <textarea id="oi-note" placeholder="Ví dụ: bàn gần cửa sổ, dị ứng hải sản…">${esc(o.note || '')}</textarea></div>`,
    footer: `<button class="btn" data-close>Hủy</button>
             <button class="btn primary" id="oi-save">Lưu</button>`,
  });
  m.querySelector('#oi-save').addEventListener('click', async () => {
    try {
      const res = await api(`/orders/${state.pos.orderId}`, {
        method: 'PATCH',
        body: {
          customer_name: m.querySelector('#oi-name').value,
          guest_count: Number(m.querySelector('#oi-guests').value),
          note: m.querySelector('#oi-note').value,
        },
      });
      state.pos.order = res.order;
      closeModal();
      toast('Đã cập nhật thông tin đơn');
      drawCart();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

async function openCheckout() {
  const { customers } = await api('/customers');
  const total = state.pos.order.total;
  const m = openModal({
    title: 'Thanh toán',
    body: `
      <div class="stat mb">
        <div class="label">Tổng tiền cần thu</div>
        <div class="value" id="co-total">${money(total)}</div>
      </div>
      <div class="field"><label>Hình thức thanh toán</label>
        <select id="co-method">
          ${Object.entries(PAY_METHODS)
            .map(([k, v]) => `<option value="${k}">${v}</option>`)
            .join('')}
        </select></div>
      <div class="field"><label>Giảm giá (₫)</label>
        <input id="co-discount" type="number" min="0" step="1000" value="0" /></div>
      <div class="field"><label>Khách hàng (tích điểm)</label>
        <select id="co-customer">
          <option value="">— Khách lẻ —</option>
          ${customers.map((c) => `<option value="${c.id}">${esc(c.name)} • ${esc(c.phone)}</option>`).join('')}
        </select></div>
      <div class="row between mt">
        <span class="muted">Thành tiền</span>
        <b id="co-final" style="font-size:19px;color:var(--primary)">${money(total)}</b>
      </div>`,
    footer: `<button class="btn" data-close>Hủy</button>
             <button class="btn success" id="co-confirm">✅ Xác nhận thanh toán</button>`,
  });

  const discountEl = m.querySelector('#co-discount');
  const updateFinal = () => {
    const d = Math.max(0, Number(discountEl.value) || 0);
    m.querySelector('#co-final').textContent = money(Math.max(0, total - d));
  };
  discountEl.addEventListener('input', updateFinal);

  m.querySelector('#co-confirm').addEventListener('click', async () => {
    try {
      const res = await api(`/orders/${state.pos.orderId}/checkout`, {
        method: 'POST',
        body: {
          method: m.querySelector('#co-method').value,
          discount: Number(discountEl.value) || 0,
          customer_id: m.querySelector('#co-customer').value || null,
        },
      });
      closeModal();
      toast(res.message || 'Thanh toán thành công');
      state.pos = null;
      state.route = 'tables';
      renderApp();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/* --------------------------------- 4. Bếp -------------------------------- */

async function viewKitchen(view) {
  const { queue } = await api('/kitchen');
  state.kitchenQueue = queue;

  view.innerHTML = `
    <div class="row mb">
      <button class="btn primary" id="k-refresh">🔄 Làm mới</button>
      <label class="row small muted" style="gap:6px">
        <input type="checkbox" id="k-auto" style="width:auto" /> Tự động làm mới (10s)
      </label>
      <span class="spacer"></span>
      <span class="tag orange">${queue.length} đơn đang xử lý</span>
    </div>
    ${
      queue.length
        ? `<div class="kitchen-grid">${queue.map(renderTicket).join('')}</div>`
        : `<div class="empty"><div class="big">✅</div>Không còn món nào chờ chế biến</div>`
    }`;

  view.querySelector('#k-refresh').addEventListener('click', renderRoute);
  const auto = view.querySelector('#k-auto');
  auto.addEventListener('change', () => {
    clearInterval(window.__kTimer);
    if (auto.checked) window.__kTimer = setInterval(() => {
      if (state.route === 'kitchen') renderRoute();
      else clearInterval(window.__kTimer);
    }, 10000);
  });

  view.querySelectorAll('[data-item]').forEach((b) =>
    b.addEventListener('click', async () => {
      const itemId = Number(b.dataset.item);
      const next = b.dataset.next;
      try {
        await api(`/kitchen/item/${itemId}`, { method: 'PATCH', body: { status: next } });
        toast('Đã cập nhật trạng thái món');
        renderRoute();
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );
}

function renderTicket(order) {
  return `
    <div class="ticket">
      <div class="ticket-head">
        <div>
          <div class="code">${esc(order.order_code)}</div>
          <div class="small muted">🪑 ${esc(order.table_name || 'Mang về')} • ${order.guest_count} khách</div>
        </div>
        ${statusTag(order.status, ORDER_STATUS)}
      </div>
      <ul>
        ${order.items
          .map((i) => {
            const nextAction =
              i.status === 'pending'
                ? { s: 'cooking', l: '▶ Bắt đầu nấu' }
                : i.status === 'cooking'
                  ? { s: 'ready', l: '✓ Đã chín' }
                  : { s: 'served', l: '🍽 Đã bưng ra' };
            return `<li>
              <span class="q">×${i.quantity}</span>
              <div class="d">
                ${esc(i.dish_name)}
                ${i.note ? `<small>📝 ${esc(i.note)}</small>` : ''}
                <small>${statusTag(i.status, ITEM_STATUS)}</small>
              </div>
              <button class="btn sm" data-item="${i.id}" data-next="${nextAction.s}">${nextAction.l}</button>
            </li>`;
          })
          .join('')}
      </ul>
      ${order.note ? `<div style="padding:10px 14px;border-top:1px solid var(--border)" class="small muted">📌 ${esc(order.note)}</div>` : ''}
    </div>`;
}

/* ------------------------------ 5. Đơn hàng ------------------------------ */

async function viewOrders(view) {
  const statusOptions = ['all', ...Object.keys(ORDER_STATUS)];
  view.innerHTML = `
    <div class="card">
      <div class="row mb">
        <select id="o-status" style="max-width:210px">
          ${statusOptions
            .map((s) => `<option value="${s}">${s === 'all' ? 'Tất cả trạng thái' : ORDER_STATUS[s].label}</option>`)
            .join('')}
        </select>
        <input id="o-date" type="date" style="max-width:180px" />
        <button class="btn" id="o-filter">🔍 Lọc</button>
        <button class="btn ghost" id="o-clear">Xóa lọc</button>
        <span class="spacer"></span>
        <button class="btn" id="o-refresh">🔄 Làm mới</button>
      </div>
      <div id="o-list"><div class="empty">Đang tải…</div></div>
    </div>`;

  const load = async () => {
    const status = view.querySelector('#o-status').value;
    const date = view.querySelector('#o-date').value;
    const params = new URLSearchParams();
    if (status !== 'all') params.set('status', status);
    if (date) params.set('date', date);
    const { orders } = await api('/orders?' + params.toString());
    const box = view.querySelector('#o-list');
    box.innerHTML = orders.length
      ? `<div class="table-wrap"><table>
           <thead><tr>
             <th>Mã đơn</th><th>Bàn</th><th>Khách</th><th>Món</th>
             <th>Trạng thái</th><th>Thời gian</th><th class="right">Tổng tiền</th><th></th>
           </tr></thead>
           <tbody>${orders
             .map(
               (o) => `<tr>
                 <td><b>${esc(o.order_code)}</b></td>
                 <td>${esc(o.table_name || '—')}<div class="small muted">${esc(o.table_zone || '')}</div></td>
                 <td>${esc(o.customer_name || 'Khách lẻ')}<div class="small muted">${o.guest_count} khách</div></td>
                 <td>${o.total_qty || 0}</td>
                 <td>${statusTag(o.status, ORDER_STATUS)}</td>
                 <td class="small muted">${esc(o.created_at)}</td>
                 <td class="right"><b>${money(o.total)}</b></td>
                 <td class="right"><button class="btn sm" data-view="${o.id}">Chi tiết</button></td>
               </tr>`
             )
             .join('')}</tbody></table></div>`
      : `<div class="empty"><div class="big">📋</div>Không có đơn hàng nào</div>`;

    box.querySelectorAll('[data-view]').forEach((b) =>
      b.addEventListener('click', () => openOrderDetail(Number(b.dataset.view)))
    );
  };

  view.querySelector('#o-filter').addEventListener('click', load);
  view.querySelector('#o-clear').addEventListener('click', () => {
    view.querySelector('#o-status').value = 'all';
    view.querySelector('#o-date').value = '';
    load();
  });
  view.querySelector('#o-refresh').addEventListener('click', load);
  await load();
}

async function openOrderDetail(orderId) {
  const { order, items } = await api(`/orders/${orderId}`);
  const m = openModal({
    wide: true,
    title: `Đơn ${order.order_code}`,
    body: `
      <div class="grid cols-2 mb">
        <div>
          <div class="small muted">Bàn</div>
          <div><b>${esc(order.table_name || '—')}</b> ${order.table_zone ? `(${esc(order.table_zone)})` : ''}</div>
        </div>
        <div>
          <div class="small muted">Trạng thái</div>
          <div>${statusTag(order.status, ORDER_STATUS)}</div>
        </div>
        <div>
          <div class="small muted">Khách hàng</div>
          <div>${esc(order.customer_name || 'Khách lẻ')} • ${order.guest_count} khách</div>
        </div>
        <div>
          <div class="small muted">Nhân viên / thời gian</div>
          <div>${esc(order.staff_name || '—')} • ${esc(order.created_at)}</div>
        </div>
      </div>
      ${order.note ? `<div class="card" style="background:#fafbfe">📌 ${esc(order.note)}</div>` : ''}
      <div class="table-wrap">
        <table>
          <thead><tr><th>Món</th><th class="right">Đơn giá</th><th class="right">SL</th><th class="right">Thành tiền</th><th>Trạng thái</th></tr></thead>
          <tbody>
            ${items
              .map(
                (i) => `<tr>
                  <td>${esc(i.dish_name)}${i.note ? `<div class="small muted">📝 ${esc(i.note)}</div>` : ''}</td>
                  <td class="right">${money(i.price)}</td>
                  <td class="right">${i.quantity}</td>
                  <td class="right"><b>${money(i.price * i.quantity)}</b></td>
                  <td>${statusTag(i.status, ITEM_STATUS)}</td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
      <div class="cart-total mt">
        <div class="line"><span>Tạm tính</span><b>${money(order.subtotal)}</b></div>
        <div class="line"><span>Giảm giá</span><b>−${money(order.discount)}</b></div>
        <div class="line grand"><span>Tổng cộng</span><span>${money(order.total)}</span></div>
      </div>`,
    footer: `${
      !['paid', 'cancelled'].includes(order.status)
        ? `<button class="btn danger" id="od-cancel">Hủy đơn</button>`
        : ''
    }<button class="btn" data-close>Đóng</button>`,
  });

  const cancelBtn = m.querySelector('#od-cancel');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () =>
      confirmDialog('Hủy toàn bộ đơn hàng này?', async () => {
        try {
          await api(`/orders/${orderId}/status`, { method: 'POST', body: { status: 'cancelled' } });
          toast('Đã hủy đơn hàng');
          renderRoute();
        } catch (err) {
          toast(err.message, 'error');
        }
      }, 'Hủy đơn')
    );
  }
}

/* ------------------------------- 6. Đặt bàn ------------------------------ */

async function viewReservations(view) {
  const [{ reservations }, { tables }, { customers }] = await Promise.all([
    api('/reservations'),
    api('/tables'),
    api('/customers'),
  ]);

  view.innerHTML = `
    <div class="card">
      <div class="row mb">
        <button class="btn primary" id="r-new">＋ Thêm đặt bàn</button>
        <div class="spacer"></div>
        <select id="r-status" style="max-width:200px">
          <option value="all">Tất cả trạng thái</option>
          ${Object.entries(RESV_STATUS)
            .map(([k, v]) => `<option value="${k}">${v.label}</option>`)
            .join('')}
        </select>
        <input type="date" id="r-date" style="max-width:170px" />
        <button class="btn" id="r-filter">🔍 Lọc</button>
      </div>
      <div id="r-list"></div>
    </div>`;

  const load = async () => {
    const status = view.querySelector('#r-status').value;
    const date = view.querySelector('#r-date').value;
    const params = new URLSearchParams();
    if (status !== 'all') params.set('status', status);
    if (date) params.set('date', date);
    const data = await api('/reservations?' + params.toString());
    view.querySelector('#r-list').innerHTML = data.reservations.length
      ? `<div class="table-wrap"><table>
           <thead><tr><th>Khách</th><th>SĐT</th><th>Bàn</th><th>Thời gian</th><th>Trạng thái</th><th></th></tr></thead>
           <tbody>${data.reservations
             .map(
               (r) => `<tr>
                 <td><b>${esc(r.customer_name)}</b><div class="small muted">${r.party_size} khách</div></td>
                 <td>${esc(r.phone)}</td>
                 <td>${esc(r.table_name || 'Chưa xếp bàn')}</td>
                 <td class="small">${esc(r.reserved_at)}</td>
                 <td>${statusTag(r.status, RESV_STATUS)}</td>
                 <td class="right">
                   ${
                     r.status !== 'cancelled' && r.status !== 'seated'
                       ? `<button class="btn sm" data-seat="${r.id}">Vào bàn</button>
                          <button class="btn sm ghost" data-cancel="${r.id}">Hủy</button>`
                       : ''
                   }
                 </td>
               </tr>`
             )
             .join('')}</tbody></table></div>`
      : `<div class="empty"><div class="big">📅</div>Chưa có lượt đặt bàn nào</div>`;

    view.querySelectorAll('[data-seat]').forEach((b) =>
      b.addEventListener('click', async () => {
        try {
          await api(`/reservations/${b.dataset.seat}`, { method: 'PUT', body: { status: 'seated' } });
          toast('Đã đánh dấu khách vào bàn');
          renderRoute();
        } catch (err) {
          toast(err.message, 'error');
        }
      })
    );
    view.querySelectorAll('[data-cancel]').forEach((b) =>
      b.addEventListener('click', () =>
        confirmDialog('Hủy lượt đặt bàn này?', async () => {
          try {
            await api(`/reservations/${b.dataset.cancel}`, { method: 'PUT', body: { status: 'cancelled' } });
            toast('Đã hủy đặt bàn');
            renderRoute();
          } catch (err) {
            toast(err.message, 'error');
          }
        }, 'Hủy đặt bàn')
      )
    );
  };

  view.querySelector('#r-new').addEventListener('click', () => openReservationForm(tables, customers));
  view.querySelector('#r-filter').addEventListener('click', load);
  await load();
}

function openReservationForm(tables, customers) {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
  const m = openModal({
    title: 'Thêm đặt bàn',
    body: `
      <div class="grid cols-2">
        <div class="field"><label>Tên khách *</label>
          <input id="rv-name" list="rv-customers" placeholder="Nguyễn Văn A" />
          <datalist id="rv-customers">
            ${customers.map((c) => `<option value="${esc(c.name)}">${esc(c.phone)}</option>`).join('')}
          </datalist>
        </div>
        <div class="field"><label>Số điện thoại *</label><input id="rv-phone" placeholder="09xxxxxxxx" /></div>
        <div class="field"><label>Bàn</label>
          <select id="rv-table">
            <option value="">— Chưa xếp bàn —</option>
            ${tables.map((t) => `<option value="${t.id}">${esc(t.name)} • ${esc(t.zone)} (${t.seats} chỗ)</option>`).join('')}
          </select></div>
        <div class="field"><label>Số khách</label><input id="rv-party" type="number" min="1" value="2" /></div>
      </div>
      <div class="field"><label>Thời gian *</label><input id="rv-time" type="datetime-local" value="${local}" /></div>
      <div class="field"><label>Ghi chú</label><textarea id="rv-note" placeholder="Yêu cầu đặc biệt…"></textarea></div>`,
    footer: `<button class="btn" data-close>Hủy</button>
             <button class="btn primary" id="rv-save">Lưu đặt bàn</button>`,
  });
  m.querySelector('#rv-save').addEventListener('click', async () => {
    try {
      const value = m.querySelector('#rv-time').value;
      if (!value) return toast('Vui lòng chọn thời gian', 'error');
      await api('/reservations', {
        method: 'POST',
        body: {
          customer_name: m.querySelector('#rv-name').value.trim(),
          phone: m.querySelector('#rv-phone').value.trim(),
          table_id: m.querySelector('#rv-table').value || null,
          party_size: Number(m.querySelector('#rv-party').value) || 2,
          reserved_at: value.replace('T', ' ') + ':00',
          note: m.querySelector('#rv-note').value,
        },
      });
      closeModal();
      toast('Đã thêm lượt đặt bàn');
      renderRoute();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/* ------------------------------ 7. Khách hàng ---------------------------- */

async function viewCustomers(view) {
  view.innerHTML = `
    <div class="card">
      <div class="row mb">
        <input id="c-search" placeholder="🔍 Tìm theo tên hoặc SĐT…" style="max-width:300px" />
        <button class="btn" id="c-find">Tìm</button>
        <div class="spacer"></div>
        <button class="btn primary" id="c-new">＋ Thêm khách hàng</button>
      </div>
      <div id="c-list"></div>
    </div>`;

  const load = async () => {
    const q = view.querySelector('#c-search').value.trim();
    const { customers } = await api('/customers' + (q ? `?q=${encodeURIComponent(q)}` : ''));
    view.querySelector('#c-list').innerHTML = customers.length
      ? `<div class="table-wrap"><table>
           <thead><tr><th>Tên</th><th>SĐT</th><th>Email</th><th class="right">Điểm</th><th class="right">Tổng chi tiêu</th><th></th></tr></thead>
           <tbody>${customers
             .map(
               (c) => `<tr>
                 <td><b>${esc(c.name)}</b></td>
                 <td>${esc(c.phone)}</td>
                 <td class="muted">${esc(c.email || '—')}</td>
                 <td class="right"><span class="tag purple">${c.points} điểm</span></td>
                 <td class="right">${money(c.total_spent)}</td>
                 <td class="right">
                   <button class="btn sm" data-edit="${c.id}">Sửa</button>
                   <button class="btn sm ghost" data-del="${c.id}">Xóa</button>
                 </td>
               </tr>`
             )
             .join('')}</tbody></table></div>`
      : `<div class="empty"><div class="big">👥</div>Chưa có khách hàng nào</div>`;

    view.querySelectorAll('[data-edit]').forEach((b) =>
      b.addEventListener('click', () => {
        const c = customers.find((x) => x.id === Number(b.dataset.edit));
        openCustomerForm(c);
      })
    );
    view.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', () =>
        confirmDialog('Xóa khách hàng này?', async () => {
          try {
            await api(`/customers/${b.dataset.del}`, { method: 'DELETE' });
            toast('Đã xóa khách hàng');
            renderRoute();
          } catch (err) {
            toast(err.message, 'error');
          }
        }, 'Xóa')
      )
    );
  };

  view.querySelector('#c-find').addEventListener('click', load);
  view.querySelector('#c-search').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') load();
  });
  view.querySelector('#c-new').addEventListener('click', () => openCustomerForm(null));
  await load();
}

function openCustomerForm(customer) {
  const m = openModal({
    title: customer ? 'Sửa khách hàng' : 'Thêm khách hàng',
    body: `
      <div class="field"><label>Tên khách *</label><input id="cf-name" value="${esc(customer?.name || '')}" /></div>
      <div class="field"><label>Số điện thoại *</label><input id="cf-phone" value="${esc(customer?.phone || '')}" /></div>
      <div class="field"><label>Email</label><input id="cf-email" value="${esc(customer?.email || '')}" /></div>
      ${customer ? `<div class="field"><label>Điểm tích lũy</label><input id="cf-points" type="number" value="${customer.points}" /></div>` : ''}`,
    footer: `<button class="btn" data-close>Hủy</button>
             <button class="btn primary" id="cf-save">Lưu</button>`,
  });
  m.querySelector('#cf-save').addEventListener('click', async () => {
    const body = {
      name: m.querySelector('#cf-name').value.trim(),
      phone: m.querySelector('#cf-phone').value.trim(),
      email: m.querySelector('#cf-email').value.trim(),
    };
    if (customer) body.points = Number(m.querySelector('#cf-points').value) || 0;
    try {
      if (customer) await api(`/customers/${customer.id}`, { method: 'PUT', body });
      else await api('/customers', { method: 'POST', body });
      closeModal();
      toast('Đã lưu khách hàng');
      renderRoute();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/* ------------------------------- 8. Thực đơn ----------------------------- */

async function viewMenu(view) {
  const [{ dishes }, { categories }] = await Promise.all([
    api('/dishes?all=1'),
    api('/categories'),
  ]);

  view.innerHTML = `
    <div class="card">
      <div class="row mb">
        <button class="btn primary" id="m-new-dish" ${isManager() ? '' : 'disabled'}>＋ Thêm món</button>
        <button class="btn" id="m-new-cat" ${isManager() ? '' : 'disabled'}>＋ Thêm danh mục</button>
        <span class="spacer"></span>
        <input id="m-search" placeholder="🔍 Tìm món…" style="max-width:240px" />
      </div>
      <div class="row mb">
        <button class="btn sm primary" data-mcat="all">Tất cả (${dishes.length})</button>
        ${categories
          .map((c) => `<button class="btn sm" data-mcat="${c.id}">${esc(c.name)} (${c.dish_count})</button>`)
          .join('')}
      </div>
      <div id="m-list"></div>
    </div>`;

  let filterCat = 'all';
  const draw = () => {
    const kw = view.querySelector('#m-search').value.toLowerCase();
    const list = dishes.filter(
      (d) =>
        (filterCat === 'all' || d.category_id === Number(filterCat)) &&
        (!kw || d.name.toLowerCase().includes(kw))
    );
    view.querySelector('#m-list').innerHTML = list.length
      ? `<div class="table-wrap"><table>
           <thead><tr><th>Món</th><th>Danh mục</th><th class="right">Giá bán</th><th>Trạng thái</th><th></th></tr></thead>
           <tbody>${list
             .map(
               (d) => `<tr>
                 <td><span style="font-size:17px">${esc(d.image || '🍽️')}</span> <b>${esc(d.name)}</b>
                     ${d.description ? `<div class="small muted">${esc(d.description)}</div>` : ''}</td>
                 <td>${esc(d.category_name || '—')}</td>
                 <td class="right"><b>${money(d.price)}</b></td>
                 <td>${d.available ? '<span class="tag green">Đang bán</span>' : '<span class="tag red">Hết hàng</span>'}</td>
                 <td class="right">
                   <button class="btn sm" data-edit-dish="${d.id}" ${isManager() ? '' : 'disabled'}>Sửa</button>
                   <button class="btn sm ghost" data-del-dish="${d.id}" ${isManager() ? '' : 'disabled'}>Xóa</button>
                 </td>
               </tr>`
             )
             .join('')}</tbody></table></div>`
      : `<div class="empty"><div class="big">🍽️</div>Không có món nào</div>`;

    view.querySelectorAll('[data-edit-dish]').forEach((b) =>
      b.addEventListener('click', () =>
        openDishForm(dishes.find((d) => d.id === Number(b.dataset.editDish)), categories)
      )
    );
    view.querySelectorAll('[data-del-dish]').forEach((b) =>
      b.addEventListener('click', () =>
        confirmDialog('Xóa món ăn này khỏi thực đơn?', async () => {
          try {
            await api(`/dishes/${b.dataset.delDish}`, { method: 'DELETE' });
            toast('Đã xóa món ăn');
            renderRoute();
          } catch (err) {
            toast(err.message, 'error');
          }
        }, 'Xóa món')
      )
    );
  };

  view.querySelectorAll('[data-mcat]').forEach((b) =>
    b.addEventListener('click', () => {
      filterCat = b.dataset.mcat;
      view.querySelectorAll('[data-mcat]').forEach((x) => x.classList.remove('primary'));
      b.classList.add('primary');
      draw();
    })
  );
  view.querySelector('#m-search').addEventListener('input', draw);
  view.querySelector('#m-new-dish').addEventListener('click', () => openDishForm(null, categories));
  view.querySelector('#m-new-cat').addEventListener('click', openCategoryForm);
  draw();
}

function openDishForm(dish, categories) {
  const m = openModal({
    title: dish ? 'Sửa món ăn' : 'Thêm món ăn',
    body: `
      <div class="field"><label>Tên món *</label><input id="df-name" value="${esc(dish?.name || '')}" /></div>
      <div class="grid cols-2">
        <div class="field"><label>Danh mục</label>
          <select id="df-cat">
            <option value="">— Chọn danh mục —</option>
            ${categories
              .map(
                (c) => `<option value="${c.id}" ${dish?.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`
              )
              .join('')}
          </select></div>
        <div class="field"><label>Giá bán (₫) *</label>
          <input id="df-price" type="number" min="0" step="1000" value="${dish?.price ?? 0}" /></div>
      </div>
      <div class="field"><label>Biểu tượng (emoji)</label><input id="df-image" value="${esc(dish?.image || '🍽️')}" /></div>
      <div class="field"><label>Mô tả</label><textarea id="df-desc">${esc(dish?.description || '')}</textarea></div>
      <div class="field"><label>Còn hàng</label>
        <select id="df-available">
          <option value="1" ${dish?.available !== 0 ? 'selected' : ''}>Đang bán</option>
          <option value="0" ${dish?.available === 0 ? 'selected' : ''}>Hết hàng</option>
        </select></div>`,
    footer: `<button class="btn" data-close>Hủy</button>
             <button class="btn primary" id="df-save">Lưu món ăn</button>`,
  });
  m.querySelector('#df-save').addEventListener('click', async () => {
    const body = {
      name: m.querySelector('#df-name').value.trim(),
      category_id: m.querySelector('#df-cat').value || null,
      price: Number(m.querySelector('#df-price').value),
      image: m.querySelector('#df-image').value,
      description: m.querySelector('#df-desc').value,
      available: Number(m.querySelector('#df-available').value),
    };
    try {
      if (dish) await api(`/dishes/${dish.id}`, { method: 'PUT', body });
      else await api('/dishes', { method: 'POST', body });
      closeModal();
      toast('Đã lưu món ăn');
      renderRoute();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

function openCategoryForm() {
  const m = openModal({
    title: 'Thêm danh mục',
    body: `
      <div class="field"><label>Tên danh mục *</label><input id="cf2-name" placeholder="Ví dụ: Món ăn kèm" /></div>
      <div class="field"><label>Thứ tự hiển thị</label><input id="cf2-sort" type="number" value="99" /></div>`,
    footer: `<button class="btn" data-close>Hủy</button>
             <button class="btn primary" id="cf2-save">Lưu</button>`,
  });
  m.querySelector('#cf2-save').addEventListener('click', async () => {
    try {
      await api('/categories', {
        method: 'POST',
        body: {
          name: m.querySelector('#cf2-name').value.trim(),
          sort_order: Number(m.querySelector('#cf2-sort').value) || 0,
        },
      });
      closeModal();
      toast('Đã thêm danh mục');
      renderRoute();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/* ---------------------------- 9. Quản lý bàn ----------------------------- */

async function viewTablesManage(view) {
  const { tables } = await api('/tables');
  view.innerHTML = `
    <div class="card">
      <div class="row mb">
        <button class="btn primary" id="tm-new">＋ Thêm bàn</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Bàn</th><th>Khu vực</th><th class="right">Số chỗ</th><th>Trạng thái</th><th></th></tr></thead>
        <tbody>${tables
          .map(
            (t) => `<tr>
              <td><b>${esc(t.name)}</b></td>
              <td>${esc(t.zone)}</td>
              <td class="right">${t.seats}</td>
              <td>${statusTag(t.status, TABLE_STATUS)}</td>
              <td class="right">
                <button class="btn sm" data-edit-table="${t.id}">Sửa</button>
                <button class="btn sm ghost" data-del-table="${t.id}">Xóa</button>
              </td>
            </tr>`
          )
          .join('')}</tbody></table></div>
    </div>`;

  view.querySelector('#tm-new').addEventListener('click', () => openTableForm(null));
  view.querySelectorAll('[data-edit-table]').forEach((b) =>
    b.addEventListener('click', () => openTableForm(tables.find((t) => t.id === Number(b.dataset.editTable))))
  );
  view.querySelectorAll('[data-del-table]').forEach((b) =>
    b.addEventListener('click', () =>
      confirmDialog('Xóa bàn này?', async () => {
        try {
          await api(`/tables/${b.dataset.delTable}`, { method: 'DELETE' });
          toast('Đã xóa bàn');
          renderRoute();
        } catch (err) {
          toast(err.message, 'error');
        }
      }, 'Xóa bàn')
    )
  );
}

function openTableForm(table) {
  const m = openModal({
    title: table ? 'Sửa bàn' : 'Thêm bàn',
    body: `
      <div class="field"><label>Tên bàn *</label><input id="tf-name" value="${esc(table?.name || '')}" placeholder="A7 / VIP3" /></div>
      <div class="field"><label>Khu vực</label><input id="tf-zone" value="${esc(table?.zone || 'Trong nhà')}" /></div>
      <div class="field"><label>Số chỗ ngồi</label><input id="tf-seats" type="number" min="1" value="${table?.seats || 4}" /></div>`,
    footer: `<button class="btn" data-close>Hủy</button>
             <button class="btn primary" id="tf-save">Lưu</button>`,
  });
  m.querySelector('#tf-save').addEventListener('click', async () => {
    const body = {
      name: m.querySelector('#tf-name').value.trim(),
      zone: m.querySelector('#tf-zone').value.trim(),
      seats: Number(m.querySelector('#tf-seats').value) || 4,
    };
    try {
      if (table) await api(`/tables/${table.id}`, { method: 'PUT', body });
      else await api('/tables', { method: 'POST', body });
      closeModal();
      toast('Đã lưu bàn');
      renderRoute();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/* ---------------------------- 10. Nhân viên ------------------------------ */

async function viewStaff(view) {
  const { users } = await api('/auth/users');
  view.innerHTML = `
    <div class="card">
      <div class="row mb">
        <button class="btn primary" id="s-new" ${can('admin') ? '' : 'disabled title="Chỉ quản trị viên thêm được tài khoản"'}>＋ Thêm nhân viên</button>
        <span class="spacer"></span>
        <span class="small muted">${users.length} tài khoản</span>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Họ tên</th><th>Tên đăng nhập</th><th>Vai trò</th><th>Liên hệ</th><th>Trạng thái</th><th></th></tr></thead>
        <tbody>${users
          .map(
            (u) => `<tr>
              <td><b>${esc(u.full_name)}</b></td>
              <td class="muted">${esc(u.username)}</td>
              <td><span class="tag blue">${esc(ROLE_LABEL[u.role] || u.role)}</span></td>
              <td class="small muted">${esc(u.phone || '—')}<br />${esc(u.email || '')}</td>
              <td>${u.active ? '<span class="tag green">Đang làm</span>' : '<span class="tag red">Đã khóa</span>'}</td>
              <td class="right">
                <button class="btn sm" data-edit-user="${u.id}" ${can('admin') ? '' : 'disabled'}>Sửa</button>
                <button class="btn sm ghost" data-del-user="${u.id}" ${can('admin') ? '' : 'disabled'}>Xóa</button>
              </td>
            </tr>`
          )
          .join('')}</tbody></table></div>
    </div>`;

  view.querySelector('#s-new').addEventListener('click', () => openStaffForm(null));
  view.querySelectorAll('[data-edit-user]').forEach((b) =>
    b.addEventListener('click', () => openStaffForm(users.find((u) => u.id === Number(b.dataset.editUser))))
  );
  view.querySelectorAll('[data-del-user]').forEach((b) =>
    b.addEventListener('click', () =>
      confirmDialog('Xóa tài khoản nhân viên này?', async () => {
        try {
          await api(`/auth/users/${b.dataset.delUser}`, { method: 'DELETE' });
          toast('Đã xóa tài khoản');
          renderRoute();
        } catch (err) {
          toast(err.message, 'error');
        }
      }, 'Xóa tài khoản')
    )
  );
}

function openStaffForm(user) {
  const m = openModal({
    title: user ? 'Sửa nhân viên' : 'Thêm nhân viên',
    body: `
      <div class="grid cols-2">
        <div class="field"><label>Họ tên *</label><input id="sf-name" value="${esc(user?.full_name || '')}" /></div>
        <div class="field"><label>Tên đăng nhập *</label>
          <input id="sf-user" value="${esc(user?.username || '')}" ${user ? 'disabled' : ''} /></div>
        <div class="field"><label>Vai trò</label>
          <select id="sf-role">
            ${Object.entries(ROLE_LABEL)
              .map(([k, v]) => `<option value="${k}" ${user?.role === k ? 'selected' : ''}>${v}</option>`)
              .join('')}
          </select></div>
        <div class="field"><label>Số điện thoại</label><input id="sf-phone" value="${esc(user?.phone || '')}" /></div>
      </div>
      <div class="field"><label>Email</label><input id="sf-email" value="${esc(user?.email || '')}" /></div>
      <div class="field"><label>${user ? 'Mật khẩu mới (bỏ trống nếu không đổi)' : 'Mật khẩu *'}</label>
        <input id="sf-pass" type="password" /></div>
      ${user ? `<div class="field"><label>Trạng thái</label>
        <select id="sf-active">
          <option value="1" ${user.active ? 'selected' : ''}>Đang làm việc</option>
          <option value="0" ${!user.active ? 'selected' : ''}>Khóa tài khoản</option>
        </select></div>` : ''}`,
    footer: `<button class="btn" data-close>Hủy</button>
             <button class="btn primary" id="sf-save">Lưu</button>`,
  });
  m.querySelector('#sf-save').addEventListener('click', async () => {
    const body = {
      full_name: m.querySelector('#sf-name').value.trim(),
      role: m.querySelector('#sf-role').value,
      phone: m.querySelector('#sf-phone').value.trim(),
      email: m.querySelector('#sf-email').value.trim(),
    };
    const pass = m.querySelector('#sf-pass').value;
    if (pass) body.password = pass;
    try {
      if (user) {
        body.active = Number(m.querySelector('#sf-active').value);
        await api(`/auth/users/${user.id}`, { method: 'PUT', body });
      } else {
        body.username = m.querySelector('#sf-user').value.trim();
        await api('/auth/users', { method: 'POST', body });
      }
      closeModal();
      toast('Đã lưu nhân viên');
      renderRoute();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/* ------------------------------ 11. Báo cáo ------------------------------ */

async function viewReports(view) {
  const today = new Date().toISOString().slice(0, 10);
  const firstDay = today.slice(0, 8) + '01';

  view.innerHTML = `
    <div class="card">
      <div class="row">
        <div class="field" style="margin:0">
          <label>Từ ngày</label><input type="date" id="rp-from" value="${firstDay}" />
        </div>
        <div class="field" style="margin:0">
          <label>Đến ngày</label><input type="date" id="rp-to" value="${today}" />
        </div>
        <button class="btn primary" id="rp-run" style="align-self:flex-end">📊 Xem báo cáo</button>
        <button class="btn" id="rp-today" style="align-self:flex-end">Hôm nay</button>
        <button class="btn" id="rp-month" style="align-self:flex-end">Tháng này</button>
      </div>
    </div>
    <div id="rp-body"></div>`;

  const load = async () => {
    const from = view.querySelector('#rp-from').value;
    const to = view.querySelector('#rp-to').value;
    const d = await api(`/reports/overview?from=${from}&to=${to}`);
    const maxRevenue = Math.max(1, ...d.by_day.map((x) => x.revenue));

    view.querySelector('#rp-body').innerHTML = `
      <div class="grid cols-4 mb">
        <div class="stat"><div class="label">Tổng doanh thu</div>
          <div class="value">${money(d.revenue)}</div>
          <div class="hint">${d.payments} hóa đơn</div></div>
        <div class="stat"><div class="label">Giá trị TB / hóa đơn</div>
          <div class="value small">${money(d.avg_ticket)}</div>
          <div class="hint">Trung bình mỗi lượt thanh toán</div></div>
        <div class="stat"><div class="label">Tổng đơn hàng</div>
          <div class="value">${d.orders}</div>
          <div class="hint">${d.paid_orders} đã thanh toán • ${d.cancelled_orders} đã hủy</div></div>
        <div class="stat"><div class="label">Món bán chạy nhất</div>
          <div class="value small">${esc(d.top_dishes[0]?.dish_name || '—')}</div>
          <div class="hint">${d.top_dishes[0] ? `${d.top_dishes[0].qty} phần đã bán` : 'Chưa có dữ liệu'}</div></div>
      </div>

      <div class="grid cols-2">
        <div class="card">
          <h3>Doanh thu theo ngày</h3>
          ${
            d.by_day.length
              ? `<div class="bar-chart">${d.by_day
                  .map(
                    (x) => `<div class="bar-col">
                      <div class="val">${(x.revenue / 1000).toFixed(0)}k</div>
                      <div class="bar" style="height:${Math.max(3, (x.revenue / maxRevenue) * 100)}%"></div>
                      <div class="lbl">${x.day.slice(5)}</div>
                    </div>`
                  )
                  .join('')}</div>`
              : `<div class="empty">Chưa có dữ liệu trong khoảng này</div>`
          }
        </div>
        <div class="card">
          <h3>Hình thức thanh toán</h3>
          ${
            d.by_method.length
              ? `<div class="table-wrap"><table>
                   <thead><tr><th>Hình thức</th><th class="right">Số hóa đơn</th><th class="right">Doanh thu</th></tr></thead>
                   <tbody>${d.by_method
                     .map(
                       (x) => `<tr>
                         <td>${esc(PAY_METHODS[x.method] || x.method)}</td>
                         <td class="right">${x.bills}</td>
                         <td class="right"><b>${money(x.revenue)}</b></td>
                       </tr>`
                     )
                     .join('')}</tbody></table></div>`
              : `<div class="empty">Chưa có dữ liệu</div>`
          }
        </div>
      </div>

      <div class="card">
        <h3>Top món bán chạy</h3>
        ${
          d.top_dishes.length
            ? `<div class="table-wrap"><table>
                 <thead><tr><th>#</th><th>Món</th><th class="right">Số lượng</th><th class="right">Doanh thu</th></tr></thead>
                 <tbody>${d.top_dishes
                   .map(
                     (x, i) => `<tr>
                       <td>${i + 1}</td>
                       <td><b>${esc(x.dish_name)}</b></td>
                       <td class="right">${x.qty}</td>
                       <td class="right">${money(x.revenue)}</td>
                     </tr>`
                   )
                   .join('')}</tbody></table></div>`
            : `<div class="empty">Chưa có dữ liệu</div>`
        }
      </div>`;
  };

  view.querySelector('#rp-run').addEventListener('click', load);
  view.querySelector('#rp-today').addEventListener('click', () => {
    view.querySelector('#rp-from').value = today;
    view.querySelector('#rp-to').value = today;
    load();
  });
  view.querySelector('#rp-month').addEventListener('click', () => {
    view.querySelector('#rp-from').value = firstDay;
    view.querySelector('#rp-to').value = today;
    load();
  });
  await load();
}

/* ------------------------------ 12. Cài đặt ------------------------------ */

async function viewSettings(view) {
  const { settings } = await api('/reports/settings');
  view.innerHTML = `
    <div class="card" style="max-width:560px">
      <h3>Thông tin nhà hàng</h3>
      <div class="field"><label>Tên nhà hàng</label>
        <input id="st-name" value="${esc(settings.restaurant_name || '')}" ${isManager() ? '' : 'disabled'} /></div>
      <div class="field"><label>Đơn vị tiền tệ</label>
        <input id="st-currency" value="${esc(settings.currency || 'VNĐ')}" ${isManager() ? '' : 'disabled'} /></div>
      <div class="field"><label>Thuế VAT (%)</label>
        <input id="st-tax" type="number" value="${esc(settings.tax_rate || '0')}" ${isManager() ? '' : 'disabled'} /></div>
      ${isManager() ? '<button class="btn primary" id="st-save">Lưu cài đặt</button>' : '<p class="muted small">Chỉ quản lý mới sửa được cài đặt.</p>'}
    </div>

    <div class="card" style="max-width:560px">
      <h3>Tài khoản đang đăng nhập</h3>
      <div class="grid cols-2">
        <div><div class="small muted">Họ tên</div><b>${esc(state.user.full_name)}</b></div>
        <div><div class="small muted">Tên đăng nhập</div><b>${esc(state.user.username)}</b></div>
        <div><div class="small muted">Vai trò</div><b>${esc(ROLE_LABEL[state.user.role] || state.user.role)}</b></div>
        <div><div class="small muted">Liên hệ</div><b>${esc(state.user.phone || '—')}</b></div>
      </div>
      <button class="btn mt" id="st-change-pass">🔑 Đổi mật khẩu</button>
    </div>

    <div class="card" style="max-width:560px">
      <h3>Giới thiệu hệ thống</h3>
      <p class="small muted">
        Ứng dụng quản lý nhà hàng gồm: sơ đồ bàn, gọi món (POS), màn hình bếp, đặt bàn,
        khách hàng thân thiết, thực đơn, nhân viên và báo cáo doanh thu.
        Backend Node.js + Express, cơ sở dữ liệu SQLite, xác thực bằng JWT.
      </p>
    </div>`;

  const saveBtn = view.querySelector('#st-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      try {
        await api('/reports/settings', {
          method: 'PUT',
          body: {
            restaurant_name: view.querySelector('#st-name').value.trim(),
            currency: view.querySelector('#st-currency').value.trim(),
            tax_rate: view.querySelector('#st-tax').value,
          },
        });
        toast('Đã lưu cài đặt');
        document.getElementById('brand-name').textContent =
          view.querySelector('#st-name').value.trim() || 'Nhà hàng';
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }
  view.querySelector('#st-change-pass').addEventListener('click', openChangePassword);
  const brand = document.getElementById('brand-name');
  if (brand && settings.restaurant_name) brand.textContent = settings.restaurant_name;
}

/* ------------------------------- Khởi động ------------------------------ */

function stopPolling() {
  clearInterval(state.timer);
  clearInterval(window.__kTimer);
  state.timer = null;
}

(async function boot() {
  if (!state.token) return renderLogin();
  try {
    const { user } = await api('/auth/me');
    state.user = user;
    localStorage.setItem('rm_user', JSON.stringify(user));
    renderApp();
  } catch {
    logout();
  }
})();
