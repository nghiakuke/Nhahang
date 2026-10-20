'use strict';

/**
 * Bộ parse lệnh tiếng Việt cho Trợ lý AI (chế độ không cần LLM).
 *
 * Nhận diện ý định từ câu thoại viết thường, có dấu hoặc không dấu, rồi
 * trích xuất đối tượng (bàn, món, số lượng, mã đơn…) thành tham số hành động.
 *
 * Trả về:
 *   { reply }                 — lời chào / trợ giúp, không cần dữ liệu
 *   { action, args }          — một hành động cần thực thi
 *   null                      — không nhận ra, nên hỏi lại người dùng
 */

const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .toLowerCase()
    .trim();

/**
 * Cắt chuỗi GỐC (giữ dấu tiếng Việt) theo nhóm bắt của regex chạy trên
 * chuỗi đã chuẩn hóa. Chuẩn hóa Bỏ-Dấu-Phân-Diệu giữ nguyên độ dài ký tự
 * với văn bản NFC, nên chỉ số khớp 1-1 giữa hai chuỗi.
 */
function grab(raw, re) {
  const flat = String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .toLowerCase();
  // Tự thêm cờ d để có chỉ số nhóm bắt
  const src = re.source;
  const flags = re.flags.replace(/[dg]/g, '') + 'dg';
  const m = new RegExp(src, flags).exec(flat);
  const orig = String(raw).normalize('NFC');
  if (!m) return null;
  const gi = 1;
  if (m.indices && m.indices[gi]) {
    return orig.slice(m.indices[gi][0], m.indices[gi][1]).trim() || null;
  }
  return null;
}

/** "190.000" / "190k" / "1tr" → 190000 / 1900000 */
function parseMoney(raw) {
  if (!raw) return null;
  let s = norm(raw).replace(/[.,\s]/g, '');
  let mult = 1;
  if (/tr(?:ieu)?$/.test(s)) {
    mult = 1e6;
    s = s.replace(/tr(?:ieu)?$/, '');
  } else if (/k$/.test(s)) {
    mult = 1e3;
    s = s.replace(/k$/, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n * mult : null;
}

/** Các từ hay đứng sau "bàn" nhưng KHÔNG phải tên bàn. */
const TABLE_STOP = new Set([
  'anh', 'chi', 'co', 'ong', 'ba', 'em', 'be', 'nay', 'kia', 'nao', 'khac', 'moi',
  'tron', 'trong', 'co', 'dang', 'da', 'se', 'sẽ', 'sau', 'truoc', 'nay', 'gia',
  'nha', 'hang', 'khach', 'trong', 'ngoai', 'vip', 'so',
]);

/**
 * Trích tên bàn ("ban 3", "ban B2", "ban VIP-1") — quét mọi ứng viên và
 * bỏ qua từ khóa chung, để "đặt bàn anh Hùng" không bắt nhầm "anh".
 */
function pickTable(t) {
  const re = /\bban\s+(?:so\s+)?([\w-]+)/g;
  let m;
  while ((m = re.exec(t))) {
    const cand = m[1];
    if (!cand) continue;
    // Bỏ qua nếu ứng viên là từ khóa chung, nhưng vẫn giữ "vip"
    if (TABLE_STOP.has(cand) && cand !== 'vip') continue;
    return cand;
  }
  return null;
}

/** Trích mã đơn "HD-261020-0001" hoặc "don DH001" (loại trừ "bàn"). */
function pickOrder(t) {
  const code = t.match(/\b(dh|hd)[\s-]?\d{2,8}(?:-\d{1,4})?/);
  if (code) return code[0].trim();
  const byDon = t.match(/\b(?:don|ma don)\s+#?(?!ban\b|moi\b|nao\b)([\w-]+)/);
  return byDon ? byDon[1] : null;
}

/** Trích phần tử còn lại sau khi bỏ mục tiêu "cho/tai ban X" và số lượng. */
function stripTarget(text, { dropQty = false } = {}) {
  let s = text;
  const qtyMatch = dropQty ? s.match(/^(\d+)\s*(?:phan|suat|ly|cai|mon|to)?\s+/) : null;
  let qty = 1;
  if (qtyMatch) {
    qty = Number(qtyMatch[1]);
    s = s.slice(qtyMatch[0].length);
  }
  s = s.replace(/\s*(?:cho|tai|o|cua)\s*(?:ban|don|dh|hd)\b.*$/i, '');
  s = s.replace(/\s+(?:nhe|nha|di|dum|dum voi)\.?$/i, '');
  s = s.replace(/^(?:mon|mon an|mon la|la)\s+/i, '');
  return { name: s.trim(), qty };
}

/** "19h", "19h30", "19:30" → "19:30:00" */
function pickTimeOfDay(t) {
  const m = t.match(/\b(\d{1,2})\s*(?:h|gi|\:)\s*(\d{2})?\b/);
  if (!m) return null;
  const h = String(Math.min(23, Number(m[1]))).padStart(2, '0');
  const mi = m[2] || '00';
  return `${h}:${mi}:00`;
}

/** Ghép ngày (hôm nay / ngày mai / yyyy-mm-dd) + giờ thành chuỗi DB. */
function buildDateTime(t, now = new Date()) {
  const time = pickTimeOfDay(t) || '19:00:00';
  let day;
  const iso = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/) || t.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
  if (iso && iso[1].length === 4) day = `${iso[1]}-${iso[2]}-${iso[3]}`;
  else if (iso) day = `${iso[3]}-${iso[2]}-${iso[1]}`;
  else {
    const d = new Date(now);
    if (/ngay mai|maiy? qua|hom sau/.test(t)) d.setDate(d.getDate() + 1);
    day = d.toISOString().slice(0, 10);
  }
  return `${day} ${time}`;
}

function pickPhone(t) {
  const m = t.match(/\b0\d{8,10}\b/);
  return m ? m[0] : null;
}

function pickPartySize(t) {
  const m = t.match(/\b(\d{1,2})\s*(?:khach|nguoi|than vien|duong)\b/);
  return m ? Number(m[1]) : null;
}

function pickRole(t) {
  if (/quan tri|admin/.test(t)) return 'admin';
  if (/quan ly|truong phong/.test(t)) return 'manager';
  if (/\bbep|dau bep|chef/.test(t)) return 'chef';
  return 'staff';
}

function pickMethod(t) {
  if (/tien mat/.test(t)) return 'cash';
  if (/\bthe\b/.test(t)) return 'card';
  if (/momo/.test(t)) return 'momo';
  if (/zalo/.test(t)) return 'zalo';
  if (/chuyen khoan/.test(t)) return 'bank';
  return null;
}

function pickDiscount(t) {
  const m = t.match(/giam\s*(?:gia)?\s*([\d.,]+)\s*(%|phan tram|nghin|tru|k|000|dong|d)?/);
  if (!m) return null;
  const n = parseMoney(m[1]);
  if (n == null) return null;
  return /%|phan tram/.test(m[2] || '') ? n : n;
}

const STATUS_WORDS = [
  [/da thanh toan|da tra tien|het don.*thanh toan/, 'paid'],
  [/da huy|huy don|dong don/, 'cancelled'],
  [/dang nau|dang che bien|nau/, 'cooking'],
  [/da chin|san sang|chin roi/, 'ready'],
  [/da phuc vu|phuc vu xong/, 'served'],
  [/dang mo|moi mo|chua thanh toan|dang cho/, 'draft'],
];

/* ================================ PARSE ================================ */

function parse(message, now = new Date()) {
  const raw = String(message || '').trim();
  const t = norm(raw);
  if (!t) return null;

  /* -------------- Lời chào / hỏi chung -------------- */
  if (/^(xin chao|chao|hello|hi|hey)\b/.test(t) && t.length < 25) {
    return { reply: 'Xin chào! Mình là trợ lý AI toàn quyền của nhà hàng. Cần mình làm gì ạ?' };
  }
  if (/^(cam on|cam on ban|thanks|thank)/.test(t)) {
    return { reply: 'Dạ không có gì ạ! Cần gì mình hỗ trợ tiếp nhé!' };
  }
  if (/ban la ai|ban la gi|gioi thieu|huong dan|ban co the gi|giup gi duoc|cach su dung/.test(t)) {
    return { reply: require('./actions').HELP_TEXT };
  }

  /* ------------------------- Báo cáo ------------------------- */
  if (/doanh thu\s*(tu|cua|ngay|hom)/.test(t) || /doanh thu/.test(t)) {
    const from = t.match(/\btu\s+(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})/);
    const to = t.match(/\b(den|toi|qua)\s+(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})/);
    if (from || to) {
      const f = from ? buildDateTime(from[1].replace(/\//g, '-'), now).slice(0, 10) : undefined;
      const l = to ? buildDateTime(to[2].replace(/\//g, '-'), now).slice(0, 10) : undefined;
      return { action: 'revenue_report', args: { from: f, to: l } };
    }
    if (/hom nay|hom nay|ngay hom nay/.test(t)) {
      return { action: 'revenue_report', args: { from: now.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) } };
    }
    if (/thang|tuan/.test(t)) return { action: 'revenue_report', args: {} };
  }
  if (/^(xem |hien thi |tra cuu )?(tong quan|so lieu|thong ke|so do)/.test(t) || /doanh thu hom nay|bao cao hom nay/.test(t)) {
    return { action: 'dashboard', args: {} };
  }

  /* ------------------------ Thanh toán ----------------------- */
  if (/thanh toan|trang tri|tinh tien|ra hoa don|nhan tien/.test(t)) {
    const args = {};
    const table = pickTable(t);
    const order = pickOrder(t);
    if (table) args.table = table;
    if (order) args.order = order;
    const method = pickMethod(t);
    if (method) args.method = method;
    const disc = pickDiscount(t);
    if (disc != null) args.discount = disc;
    return { action: 'checkout_order', args };
  }

  /* --------------------- Hủy / đóng đơn -------------------- */
  if (/(huy|dong)\s*don/.test(t) && !/huy dat ban/.test(t)) {
    const args = {};
    const table = pickTable(t);
    const order = pickOrder(t);
    if (table) args.table = table;
    if (order) args.order = order;
    return { action: 'cancel_order', args };
  }

  /* --------------------- Xóa / sửa món trong đơn ------------ */
  // "xóa món phở cho bàn 3" / "bỏ món phở khỏi bàn 3" → xóa khỏi đơn
  if (/(xoa|huy|bo|huy bo)\s+mon/.test(t) && (pickTable(t) || pickOrder(t) || /khoi don|trong don|khoi ban/.test(t))) {
    const before = t.split(/\b(?:cho|tai|o|cua|khoi)\s*(?:ban|don)\b/)[0];
    const { name } = stripTarget(before.replace(/^(xoa|huy|bo|huy bo)\s+mon\s*/, ''));
    const args = { dish: name };
    const table = pickTable(t);
    const order = pickOrder(t);
    if (table) args.table = table;
    if (order) args.order = order;
    return { action: 'remove_item', args };
  }
  if (/(sua|doi|thay doi|dat)\s+so luong/.test(t)) {
    const m = t.match(/so luong\s+(.+?)\s+(?:thanh|la|con)\s+(\d+)/);
    if (m) {
      const { name } = stripTarget(m[1]);
      const args = { dish: name, quantity: Number(m[2]) };
      const table = pickTable(t);
      const order = pickOrder(t);
      if (table) args.table = table;
      if (order) args.order = order;
      return { action: 'change_item_quantity', args };
    }
  }

  /* ---------------------- Thêm món / mở đơn ----------------- */
  if (/(?:^|\s)(?:them|goi|order)\s/.test(t) && !/them ban|them mon|them khach|them nhan vien|them vao danh sach/.test(t)) {
    const m = t.match(/(?:^|\s)(?:them|goi|order)\s+(.+)/);
    if (m) {
      const { name, qty } = stripTarget(m[1], { dropQty: true });
      if (name) {
        const args = { dish: name, quantity: qty };
        const table = pickTable(t);
        const order = pickOrder(t);
        if (table) args.table = table;
        if (order) args.order = order;
        return { action: 'add_item', args };
      }
    }
  }
  if (/mo don|mo ban|tao don/.test(t)) {
    const table = pickTable(t) || (t.match(/\bmo ban\s+(?:so\s+)?(\d+)/) || [])[1];
    const args = {};
    if (table) args.table = table;
    const guest = pickPartySize(t);
    if (guest) args.guests = guest;
    return { action: 'create_order', args };
  }

  /* --------------------------- Bếp -------------------------- */
  // "món bún chả đã chín" / "bún chả xong rồi" → chuyển món sang đã chín
  const mChin = t.match(/^(?:mon\s+)?(.+?)\s+(?:da\s+)?(?:chin|xong)(?:\s+roi)?$/);
  if (mChin && !/huy|xoa|het|thanh toan/.test(mChin[1])) {
    const name = mChin[1].replace(/^(mon|mon an|ca|mon nay|mon kia)\s+/, '').trim();
    if (name && !/^nao\b/.test(name)) return { action: 'kitchen_mark', args: { dish: name, status: 'ready' } };
  }
  // "món phở đang nấu" / "chuyển phở sang đang nấu"
  const mNau = t.match(/^(?:mon\s+)?(.+?)\s+dang nau$/) || t.match(/^chuyen\s+(?:mon\s+)?(.+?)\s+sang\s+dang\s+nau$/);
  if (mNau) {
    const name = mNau[1].replace(/^(mon|mon an|ca)\s+/, '').trim();
    if (name && !/^nao\b/.test(name)) return { action: 'kitchen_mark', args: { dish: name, status: 'cooking' } };
  }
  if (/xem bep|hang cho bep|trang thai bep|mon nao.*nau|kitchen/.test(t)) {
    return { action: 'kitchen_queue', args: {} };
  }

  /* -------------------------- Đặt bàn ----------------------- */
  if (/huy dat ban|xoa dat ban/.test(t)) {
    const m = t.match(/#?\s*(\d+)/);
    if (/xoa/.test(t)) return { action: 'delete_reservation', args: { id: Number(m?.[1]) } };
    return { action: 'set_reservation_status', args: { id: Number(m?.[1]), status: 'cancelled' } };
  }
  if (/xac nhan dat ban|nhan khach|cho khach vao|xep khach|xep ban/.test(t)) {
    const m = t.match(/#?\s*(\d+)/);
    const status = /nhan khach|cho khach vao|xep/.test(t) ? 'seated' : 'confirmed';
    return { action: 'set_reservation_status', args: { id: Number(m?.[1]), status } };
  }
  if (/dat ban|dat truoc|giu cho/.test(t)) {
    const args = { time: buildDateTime(t, now) };
    const phone = pickPhone(t);
    if (phone) args.phone = phone;
    const table = pickTable(t);
    if (table) args.table = table;
    const party = pickPartySize(t);
    if (party) args.party_size = party;
    const nameRe = /(?:dat ban|dat truoc|giu cho)\s+(?:cho\s+)?(?:anh|chi|co|ong|ba|em)?\s*([\p{L} ]+?)(?=\s+(?:luc|vao|ngay|sdt|so dien thoai|dien thoai|ban\b|cho\s+\d)|\s*$)/u;
    const nameAlt = /cho\s+(?:anh|chi|co|ong|ba|em)?\s*([\p{L} ]+?)(?=\s+(?:sdt|so dien thoai|dien thoai|luc|ban\b)|\s*$)/u;
    const nameCand =
      grab(raw, nameRe) || ((t.match(nameRe) || [])[1]?.trim()) || grab(raw, nameAlt) || ((t.match(nameAlt) || [])[1]?.trim());
    if (nameCand && !/^ban\b/.test(nameCand) && pickPhone(nameCand) == null) {
      args.customer_name = nameCand.trim();
    }
    return { action: 'create_reservation', args };
  }
  if (/xem dat ban|danh sach dat ban|lich dat|dat ban nao|lich su dat/.test(t)) {
    const status = /cho xac nhan|pending/.test(t)
      ? 'pending'
      : /da xac nhan|confirmed/.test(t)
        ? 'confirmed'
        : /da huy|cancelled/.test(t)
          ? 'cancelled'
          : /da xep|seated/.test(t)
            ? 'seated'
            : undefined;
    return { action: 'list_reservations', args: status ? { status } : {} };
  }

  /* ------------------------- Khách hàng -------------------- */
  if (/(xoa|huy)\s+khach/.test(t)) {
    const { name } = stripTarget(t.replace(/^(xoa|huy)\s+khach\s*/, ''));
    return { action: 'delete_customer', args: { customer: name || pickPhone(t) } };
  }
  if (/(them|dang ky|cap nhat|sua)\s+khach/.test(t)) {
    const phone = pickPhone(t);
    if (phone && /(them|dang ky)/.test(t)) {
      const re = /(?:them|dang ky)\s+khach\s+(.+?)(?:\s+(?:sdt|so dien thoai|voi sdt|dien thoai)|\s+0\d{8,10}|\s*$)/u;
      const name = grab(raw, re) || ((t.match(re) || [])[1]?.trim()) || raw;
      return { action: 'create_customer', args: { name, phone } };
    }
    if (/cap nhat|sua/.test(t)) {
      const m = t.match(/(?:cap nhat|sua)\s+khach\s+(.+)/);
      const { name } = stripTarget(m?.[1] || '');
      return { action: 'update_customer', args: { customer: name || phone } };
    }
  }
  if (/xem khach|danh sach khach|khach hang|khach quen/.test(t)) {
    return { action: 'list_customers', args: {} };
  }

  /* ------------------------- Nhân viên ---------------------- */
  if (/(xoa|huy)\s+(?:tai khoan|nhan vien)/.test(t)) {
    const { name } = stripTarget(t.replace(/^.*?(?:tai khoan|nhan vien)\s*/, ''));
    return { action: 'delete_user', args: { user: name } };
  }
  if (/(khoa|vo hieu hoa)\s+(?:tai khoan|nhan vien)/.test(t)) {
    const { name } = stripTarget(t.replace(/^.*?(?:tai khoan|nhan vien)\s*/, ''));
    return { action: 'update_user', args: { user: name, active: false } };
  }
  if (/(mo khoa|kich hoat|mo lai)\s+(?:tai khoan|nhan vien)/.test(t)) {
    const { name } = stripTarget(t.replace(/^.*?(?:tai khoan|nhan vien)\s*/, ''));
    return { action: 'update_user', args: { user: name, active: true } };
  }
  if (/(them|tao|lap)\s+(?:tai khoan|nhan vien)/.test(t)) {
    const user = (t.match(/(?:tai khoan|username|tk)\s+([\w.-]+)/) || [])[1];
    const pass = (t.match(/(?:mat khau|mk|password)\s+([\w.-]+)/) || [])[1];
    const fullRe = /(?:tai khoan|nhan vien)\s+(.+?)\s+(?:tai khoan|username|tk|voi tai khoan|mat khau|mk)/u;
    const full = grab(raw, fullRe) || ((t.match(fullRe) || [])[1]?.trim());
    return {
      action: 'create_user',
      args: {
        username: user,
        password: pass,
        full_name: full?.trim() || undefined,
        role: pickRole(t),
      },
    };
  }
  if (/danh sach nhan vien|xem nhan vien|danh sach tai khoan|nhan vien nao/.test(t)) {
    return { action: 'list_users', args: {} };
  }
  if (/(doi|thay doi|chuyen)\s+(?:vi tro|cap)/.test(t)) {
    const role = pickRole(t);
    const { name } = stripTarget(t.replace(/.*(?:vi tro|cap)\s+(?:thanh|la|la gi)?\s*/, ''));
    return { action: 'update_user', args: { user: name, role } };
  }

  /* ------------------------ Cài đặt ------------------------- */
  if (/(doi|dat|thay doi)\s+(?:ten nha hang|thuong hieu)\s*(?:thanh|la)?\s*(.+)/.test(t)) {
    const re = /(?:ten nha hang|thuong hieu)\s*(?:thanh|la)?\s*(.+)/;
    const name = grab(raw, re) || ((t.match(re) || [])[1]?.trim());
    return { action: 'update_settings', args: { restaurant_name: String(name || '').trim() } };
  }
  if (/xem cai dat|cai dat hien tai/.test(t)) return { action: 'get_settings', args: {} };

  /* ------------------------- Thực đơn ----------------------- */
  if (/(xoa|huy|loat bo)\s+mon/.test(t)) {
    const { name } = stripTarget(t.replace(/^(xoa|huy|loat bo)\s+mon\s*/, ''));
    return { action: 'delete_dish', args: { dish: name } };
  }
  if (/(het mon|ngung ban|het hang)\s+/.test(t) && !/het mon hang/.test(t)) {
    const { name } = stripTarget(t.replace(/^(het mon|ngung ban|het hang)\s*/, ''));
    return { action: 'update_dish', args: { dish: name, available: false } };
  }
  if (/(doi|thay doi|cap nhat|tang|giam)\s+gia/.test(t)) {
    const m = t.match(/gia\s+(.+?)\s+(?:thanh|la|con|còn)\s+([\d.,]+)\s*(k|nghin|000|tr|trieu)?/);
    if (m) {
      const { name } = stripTarget(m[1]);
      const price = parseMoney(m[2] + (m[3] || ''));
      return { action: 'update_dish', args: { dish: name, price } };
    }
  }
  if (/(them|tao|them moi)\s+(?:mon|mon an)/.test(t)) {
    const m = t.match(/(?:mon|mon an)\s+(.+?)\s+(?:gia|voi gia|la|co gia)\s+([\d.,]+)\s*(k|nghin|000|tr|trieu)?/);
    if (m) {
      const re = /(?:mon|mon an)\s+(.+?)\s+(?:gia|voi gia|la|co gia)\s+[\d.,]+\s*(?:k|nghin|000|tr|trieu)?/;
      const name = grab(raw, re) || stripTarget(m[1]).name;
      const price = parseMoney(m[2] + (m[3] || ''));
      const catRe = /(?:thuoc|o nhom|nhom|truoc)\s+(.+)/;
      const cat = grab(raw, catRe) || ((t.match(/(?:thuoc|o nhom|nhom|truoc)\s+(.+)/) || [])[1]);
      const args = { name, price };
      if (cat) args.category = String(cat).trim();
      return { action: 'create_dish', args };
    }
  }
  if (/danh sach mon|thuc don|menu|menu|cac mon|xem mon|mon gi co/.test(t)) {
    const q = (t.match(/(?:tim|tra cuu|kiem)\s+(?:mon)?\s*([\p{L}\d ]{2,})/u) || [])[1];
    return { action: 'list_dishes', args: q ? { q: q.trim() } : {} };
  }
  if (/them nhom|tao nhom|them danh muc/.test(t)) {
    const m = t.match(/(?:nhom|danh muc)\s+(.+)/);
    return { action: 'create_category', args: { name: m?.[1]?.trim() } };
  }
  if (/danh sach nhom|xem nhom|nhom mon nao|danh muc/.test(t)) {
    return { action: 'list_categories', args: {} };
  }

  /* --------------------------- Bàn -------------------------- */
  if (/(xoa|huy|loat bo)\s+ban/.test(t)) {
    const table = pickTable(t) || (t.match(/(?:xoa|huy|loat bo)\s+ban\s+(?:so\s+)?([\w-]+)/) || [])[1];
    return { action: 'delete_table', args: { table } };
  }
  if (/(them|tao|them moi|lap)\s+(?:ban|ban moi)/.test(t)) {
    const re = /^(?:them|tao|lap)\s+(?:ban moi\s+|ban\s+)(.+)/;
    let name = grab(raw, re) || raw.replace(/^(?:Thêm|Tạo|Lắp)\s+(?:bàn\s+)?/i, '').trim();
    const zone = (t.match(/\b(?:o|tai|thuoc|khu)\s+(ngoai troi|trong nha|phong vip|vip|san vuon)/) || [])[1];
    if (zone) {
      // Cắt chuỗi gốc theo vị trí cụm zone tìm thấy trên chuỗi chuẩn hóa
      const zoneRe = /\s+(?:o|tai|thuoc|khu)\s+.*$/;
      const flatName = String(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase();
      const zm = zoneRe.exec(flatName);
      if (zm) name = String(name).slice(0, zm.index).trim();
    }
    const args = { name: name || String(raw).trim() };
    if (zone) args.zone = zone;
    return { action: 'create_table', args };
  }
  if (/(doi|sua|cap nhat)\s+ban/.test(t)) {
    const table = pickTable(t);
    const zone = (t.match(/\b(?:o|tai|thuoc|khu)\s+(ngoai troi|trong nha|phong vip|vip|san vuon)/) || [])[1];
    const seats = pickPartySize(t) || (t.match(/(\d+)\s*(?:ghe|cho ngoi)/) || [])[1];
    const args = { table };
    if (zone) args.zone = zone;
    if (seats) args.seats = Number(seats);
    return { action: 'update_table', args };
  }
  if (/trang thai ban|danh sach ban|xem ban|ban nao trong|ban co khach|sơ đồ ban|so do ban/.test(t)) {
    return { action: 'list_tables', args: {} };
  }

  /* -------- Còn lại: nếu có từ khóa "đơn hàng" chung chung -------- */
  if (/don hang|don nao|xem don|danh sach don/.test(t)) {
    const found = STATUS_WORDS.find(([re]) => re.test(t));
    return { action: 'list_orders', args: found ? { status: found[1] } : {} };
  }

  return null;
}

module.exports = { parse, norm };
