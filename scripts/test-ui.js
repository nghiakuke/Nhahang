/**
 * Kiểm thử giao diện bằng jsdom: mô phỏng thao tác người dùng thật trên SPA
 * (đăng nhập, POS, bếp, đặt bàn, báo cáo…).
 *
 *   node scripts/test-ui.js
 */

'use strict';

const { JSDOM, VirtualConsole } = require('jsdom');

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
let pass = 0;
let fail = 0;
const failures = [];

function check(label, condition) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    pass++;
  } else {
    console.log(`  ✗ ${label}`);
    fail++;
    failures.push(label);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 6000, label = 'điều kiện' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (fn()) return true;
    } catch {
      /* thử lại */
    }
    await sleep(60);
  }
  throw new Error(`Hết thời gian chờ ${label}`);
}

async function main() {
  const consoleErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => consoleErrors.push(e.message));
  virtualConsole.on('error', (...a) => consoleErrors.push(a.join(' ')));
  virtualConsole.on('warn', () => {});
  virtualConsole.on('log', () => {});

  const html = await (await fetch(BASE + '/')).text();

  const dom = new JSDOM(html, {
    url: BASE + '/',
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
  });

  const { window } = dom;
  const doc = window.document;

  /**
   * jsdom không có fetch, còn fetch của Node chỉ nhận URL tuyệt đối.
   * Hàm api() của app luôn gọi dạng "/api/..." nên chỉ cần ghép tiền tố.
   */
  const realFetch = globalThis.fetch;
  window.fetch = (input, options) => {
    const raw = String(input);
    const url = raw.startsWith('http') ? raw : BASE + raw;
    return realFetch(url, options).then(async (res) => {
      const body = await res.text();
      return {
        ok: res.ok,
        status: res.status,
        text: async () => body,
        json: async () => JSON.parse(body),
      };
    });
  };

  const $ = (sel) => doc.querySelector(sel);
  const $$ = (sel) => [...doc.querySelectorAll(sel)];
  const bodyText = () => doc.body.textContent.replace(/\s+/g, ' ');
  const byText = (selector, label) => $$(selector).find((e) => e.textContent.includes(label));
  const allText = () => doc.body.textContent.replace(/\s+/g, ' ');

  /** Gõ vào ô nhập (đủ sự kiện để app xử lý) */
  const type = (el, value) => {
    el.value = value;
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
  };

  /** Bấm chuột thật sự vào phần tử */
  const click = (el) => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  };

  const clickText = (selector, label) => {
    const el = byText(selector, label);
    if (!el) throw new Error(`Không tìm thấy "${label}" trong ${selector}`);
    click(el);
    return el;
  };

  /**
   * Gửi form đăng nhập. Lưu ý: trong jsdom, bấm nút submit hoặc requestSubmit()
   * không kích hoạt sự kiện submit như trình duyệt (chỉ dispatchEvent mới chạy),
   * nên dùng dispatchEvent để kiểm thử logic xử lý.
   */
  const submitForm = () => {
    const form = $('#login-form');
    if (!form.__listening) {
      form.addEventListener('submit', (event) => {
        form.__submitted = event.defaultPrevented;
      });
      form.__listening = true;
    }
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    form.__submitted = true; // dispatchEvent không trả về trạng thái preventDefault
  };

  // Chờ app.js tải xong
  await waitFor(() => $('#login-form'), { label: 'màn hình đăng nhập' });

  console.log('== 1. Màn hình đăng nhập ==');
  check('hiển thị form đăng nhập', !!$('#login-form'));
  check('có 4 liên kết tài khoản demo', $$('.demo-accounts code').length === 4);

  click($$('.demo-accounts code')[0]);
  const filled = $('#lg-user').value === 'admin' && $('#lg-pass').value === 'admin123';
  check('bấm tài khoản demo tự điền', filled);
  if (!filled) {
    type($('#lg-user'), 'admin');
    type($('#lg-pass'), 'admin123');
  }

  // Sai mật khẩu -> phải hiện thông báo lỗi
  type($('#lg-pass'), 'sai-mat-khau');
  submitForm();
  await sleep(1500);
  const errText = $('#lg-error').textContent;
  check(`mật khẩu sai hiện thông báo lỗi ("${errText}")`, /không đúng|Thiếu/.test(errText));

  console.log('== 2. Đăng nhập thành công ==');
  type($('#lg-pass'), 'admin123');
  submitForm();
  await waitFor(() => $('.sidebar') && $('#view'), { label: 'bảng điều khiển', timeout: 12000 });
  await waitFor(() => !$('#view').textContent.includes('Đang tải'), { label: 'tải tổng quan' });
  check('vào được bảng điều khiển', !!$('.sidebar'));
  check('hiện tên người dùng', bodyText().includes('Nguyễn Văn Admin'));
  check('menu có 12 mục cho quản trị viên', $$('.nav button').length === 12);

  console.log('== 3. Tổng quan ==');
  check('có thẻ doanh thu hôm nay', bodyText().includes('Doanh thu hôm nay'));
  check('có khu vực bàn trống', bodyText().includes('Bàn trống nhanh'));

  console.log('== 4. Mở đơn từ sơ đồ bàn ==');
  clickText('.nav button', 'Sơ đồ bàn');
  await waitFor(() => $('.tables-grid .table-card'), { label: 'sơ đồ bàn' });
  const tableCount = $$('.tables-grid .table-card').length;
  check(`sơ đồ bàn hiển thị ${tableCount} bàn`, tableCount >= 11);
  click($$('.tables-grid .table-card')[0]);
  await waitFor(() => $('.pos-layout'), { label: 'màn hình POS' });
  await waitFor(() => $('.menu-grid .dish-card'), { label: 'danh sách món' });
  check('chuyển sang màn hình bán hàng', !!$('.pos-layout'));
  check('menu món ăn được tải', $$('.menu-grid .dish-card').length >= 15);

  console.log('== 5. Gọi món ==');
  click($$('.menu-grid .dish-card')[0]);
  await waitFor(() => $('.cart-item'), { label: 'món trong giỏ' });
  check('thêm món vào đơn', $$('.cart-item').length === 1);
  const firstQty = $('.cart-item .qty span').textContent;
  click($('.cart-item .qty button:last-child'));
  await waitFor(() => $('.cart-item .qty span').textContent !== firstQty, { label: 'tăng số lượng' });
  check('nút + tăng số lượng', $('.cart-item .qty span').textContent === '2');

  click($$('.menu-grid .dish-card')[1]);
  await waitFor(() => $$('.cart-item').length === 2, { label: 'món thứ hai' });
  check('thêm món thứ hai', $$('.cart-item').length === 2);
  const grand = $('.grand').textContent;
  check(`tổng tiền được tính (${grand})`, /[1-9]/.test(grand));

  console.log('== 6. Gửi bếp ==');
  click($('#cart-send'));
  await waitFor(() => bodyText().includes('Đang nấu'), { label: 'món chuyển sang đang nấu' });
  check('gửi bếp đổi trạng thái món', bodyText().includes('Đang nấu'));

  console.log('== 7. Màn hình bếp ==');
  clickText('.nav button', 'Màn hình bếp');
  await waitFor(() => $('.ticket'), { label: 'phiếu bếp' });
  check('bếp nhận được phiếu', $$('.ticket').length >= 1);
  const kitchenItems = $$('.ticket li').length;
  check(`phiếu có ${kitchenItems} món`, kitchenItems >= 2);
  clickText('.ticket li button', 'Đã chín');
  await waitFor(() => bodyText().includes('Đã chín'), { label: 'món chín' });
  check('bấm "Đã chín" cập nhật trạng thái', true);

  console.log('== 8. Thanh toán ==');
  clickText('.nav button', 'Sơ đồ bàn');
  await waitFor(() => $('.tables-grid .table-card.occupied'), { label: 'bàn có khách' });
  check('bàn đang phục vụ được đánh dấu', $$('.tables-grid .table-card.occupied').length >= 1);
  click($('.tables-grid .table-card.occupied'));
  await waitFor(() => $('#cart-pay'), { label: 'nút thanh toán' });
  click($('#cart-pay'));
  await waitFor(() => $('#co-confirm'), { label: 'hộp thoại thanh toán' });
  check('mở hộp thoại thanh toán', !!$('#co-method'));
  type($('#co-discount'), '10000');
  await sleep(150);
  check('giảm giá cập nhật thành tiền', $('#co-final').textContent.includes('₫'));
  click($('#co-confirm'));
  await waitFor(() => $('.tables-grid'), { label: 'quay lại sơ đồ bàn' });
  await sleep(600);
  check('bàn trở về trạng thái trống', $$('.tables-grid .table-card.free').length >= 11);

  console.log('== 9. Đơn hàng ==');
  clickText('.nav button', 'Đơn hàng');
  await waitFor(() => $('table tbody tr'), { label: 'danh sách đơn' });
  check('có đơn hàng vừa thanh toán', bodyText().includes('Đã thanh toán'));
  clickText('tbody button', 'Chi tiết');
  await waitFor(() => $('.modal'), { label: 'chi tiết đơn' });
  check('mở được chi tiết đơn hàng', bodyText().includes('Tạm tính'));
  click($('.modal [data-close]'));
  await sleep(200);
  check('đóng được hộp thoại', !$('.modal'));

  console.log('== 10. Đặt bàn ==');
  clickText('.nav button', 'Đặt bàn');
  await waitFor(() => $('#r-new'), { label: 'trang đặt bàn' });
  click($('#r-new'));
  await waitFor(() => $('#rv-save'), { label: 'form đặt bàn' });
  type($('#rv-name'), 'Trần Thị Khách');
  type($('#rv-phone'), '0905556667');
  type($('#rv-party'), '4');
  click($('#rv-save'));
  await waitFor(() => bodyText().includes('Trần Thị Khách'), { label: 'lượt đặt bàn mới' });
  check('thêm được lượt đặt bàn', bodyText().includes('0905556667'));

  console.log('== 11. Khách hàng ==');
  clickText('.nav button', 'Khách hàng');
  await waitFor(() => $('#c-new'), { label: 'trang khách hàng' });
  click($('#c-new'));
  await waitFor(() => $('#cf-save'), { label: 'form khách hàng' });
  type($('#cf-name'), 'Lê Văn Thân');
  type($('#cf-phone'), '0911222333');
  click($('#cf-save'));
  await waitFor(() => bodyText().includes('Lê Văn Thân'), { label: 'khách hàng mới' });
  check('thêm được khách hàng', bodyText().includes('0911222333'));

  console.log('== 12. Thực đơn ==');
  clickText('.nav button', 'Thực đơn');
  await waitFor(() => $('#m-new-dish'), { label: 'trang thực đơn' });
  await waitFor(() => $$('tbody tr').length >= 20, { label: 'danh sách món' });
  check(`hiển thị ${$$('tbody tr').length} món`, $$('tbody tr').length >= 20);
  click($('#m-new-dish'));
  await waitFor(() => $('#df-save'), { label: 'form món ăn' });
  type($('#df-name'), 'Phở bò đặc biệt');
  type($('#df-price'), '95000');
  click($('#df-save'));
  await waitFor(() => bodyText().includes('Phở bò đặc biệt'), { label: 'món mới trong thực đơn' });
  check('thêm được món mới', bodyText().includes('Phở bò đặc biệt'));

  console.log('== 13. Nhân viên ==');
  clickText('.nav button', 'Nhân viên');
  await waitFor(() => $('#s-new'), { label: 'trang nhân viên' });
  await waitFor(() => $$('tbody tr').length >= 4, { label: 'danh sách nhân viên' });
  check(`liệt kê ${$$('tbody tr').length} tài khoản`, $$('tbody tr').length >= 4);
  click($('#s-new'));
  await waitFor(() => $('#sf-save'), { label: 'form nhân viên' });
  type($('#sf-name'), 'Nguyễn Tân Binh');
  type($('#sf-user'), 'tanbinh');
  type($('#sf-pass'), 'matkhau123');
  click($('#sf-save'));
  await waitFor(() => bodyText().includes('tanbinh'), { label: 'nhân viên mới' });
  check('thêm được nhân viên mới', bodyText().includes('tanbinh'));

  console.log('== 14. Báo cáo ==');
  clickText('.nav button', 'Báo cáo');
  await waitFor(() => $('#rp-run'), { label: 'trang báo cáo' });
  await waitFor(() => bodyText().includes('Tổng doanh thu'), { label: 'số liệu báo cáo' });
  check('hiện tổng doanh thu', bodyText().includes('Tổng doanh thu'));
  check('có biểu đồ doanh thu theo ngày', bodyText().includes('Doanh thu theo ngày'));
  check('có top món bán chạy', bodyText().includes('Top món bán chạy'));
  const revText = $('.stat .value').textContent;
  check(`doanh thu hiển thị đúng định dạng (${revText})`, revText.includes('₫'));

  console.log('== 15. Cài đặt ==');
  clickText('.nav button', 'Cài đặt');
  await waitFor(() => $('#st-name'), { label: 'trang cài đặt' });
  check('hiện tên nhà hàng', $('#st-name').value.length > 0);
  type($('#st-name'), 'Nhà hàng Hương Việt 2');
  click($('#st-save'));
  await sleep(800);
  check('lưu cài đặt cập nhật tên thương hiệu', $('#brand-name').textContent.includes('Hương Việt 2'));

  console.log('== 16. Đăng xuất & phân quyền theo vai trò ==');
  click($('#btn-logout'));
  await waitFor(() => $('#m-yes'), { label: 'hộp thoại đăng xuất' });
  click($('#m-yes'));
  await waitFor(() => $('#login-form'), { label: 'quay lại đăng nhập' });
  check('đăng xuất quay về màn hình đăng nhập', !!$('#login-form'));

  type($('#lg-user'), 'nhanvien');
  type($('#lg-pass'), 'nhanvien123');
  submitForm();
  await waitFor(() => $('.sidebar'), { label: 'đăng nhập nhân viên', timeout: 10000 });
  await sleep(500);
  check(`nhân viên chỉ thấy ${$$('.nav button').length} mục menu`, $$('.nav button').length === 9);
  check('nhân viên không thấy mục Báo cáo', !byText('.nav button', 'Báo cáo'));
  check('nhân viên không thấy mục Nhân viên', !byText('.nav button', 'Nhân viên'));

  console.log('== 17. Lỗi JavaScript ==');
  const realErrors = consoleErrors.filter((m) => !/Not implemented/i.test(m));
  check(`không có lỗi JS khi chạy (${realErrors.length})`, realErrors.length === 0);
  if (realErrors.length) console.log('    ' + realErrors.slice(0, 4).join('\n    '));

  dom.window.close();

  console.log(`\nKẾT QUẢ GIAO DIỆN: ${pass} đạt / ${fail} lỗi`);
  if (fail) {
    console.log('Các mục lỗi:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n❌ Lỗi khi chạy kiểm thử giao diện:', err.message);
  process.exit(1);
});
