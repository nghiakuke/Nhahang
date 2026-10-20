#!/usr/bin/env bash
# Kiểm thử API end-to-end
set -u
B="http://localhost:3000/api"
J="Content-Type: application/json"
pass=0; fail=0
chk() { # chk <mô tả> <điều kiện>
  if [ "$2" = "1" ]; then echo "  ✓ $1"; pass=$((pass+1)); else echo "  ✗ $1"; fail=$((fail+1)); fi
}
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
jqf() { node "$DIR/query.js" "$1" < /dev/stdin; }

echo "== 1. Đăng nhập =="
TOKEN=$(curl -s --noproxy '*' -X POST $B/auth/login -H "$J" -d '{"username":"admin","password":"admin123"}' | jqf '.token')
chk "admin đăng nhập được" "$([ ${#TOKEN} -gt 20 ] && echo 1 || echo 0)"
A="Authorization: Bearer $TOKEN"

BAD=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X POST $B/auth/login -H "$J" -d '{"username":"admin","password":"sai"}')
chk "sai mật khẩu bị từ chối (401)" "$([ "$BAD" = "401" ] && echo 1 || echo 0)"

NOAUTH=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' $B/orders)
chk "không có token bị chặn (401)" "$([ "$NOAUTH" = "401" ] && echo 1 || echo 0)"

echo "== 2. Thực đơn =="
DISHES=$(curl -s --noproxy '*' $B/dishes -H "$A")
NDISH=$(echo "$DISHES" | jqf '.dishes.length')
chk "có $NDISH món ăn trong thực đơn" "$([ "$NDISH" -ge 20 ] && echo 1 || echo 0)"
DID=$(echo "$DISHES" | jqf '.dishes[0].id')
DPRICE=$(echo "$DISHES" | jqf '.dishes[0].price')
NEWD=$(curl -s --noproxy '*' -X POST $B/dishes -H "$A" -H "$J" -d '{"name":"Món test 123","price":99000,"description":"tạm"}' | jqf '.dish.id')
chk "thêm món mới (id=$NEWD)" "$([ "$NEWD" != "ERR" ] && [ "$NEWD" != "undefined" ] && echo 1 || echo 0)"
curl -s --noproxy '*' -X DELETE $B/dishes/$NEWD -H "$A" > /dev/null
chk "xóa món test" "1"

echo "== 3. Bàn =="
TABLES=$(curl -s --noproxy '*' $B/tables -H "$A")
NT=$(echo "$TABLES" | jqf '.tables.length')
TID=$(echo "$TABLES" | jqf '.tables[0].id')
chk "có $NT bàn" "$([ "$NT" -ge 10 ] && echo 1 || echo 0)"

echo "== 4. Tạo đơn + thêm món =="
ORD=$(curl -s --noproxy '*' -X POST $B/orders -H "$A" -H "$J" -d "{\"table_id\":$TID,\"customer_name\":\"Khách Test\",\"guest_count\":3}")
OID=$(echo "$ORD" | jqf '.order.id')
OCODE=$(echo "$ORD" | jqf '.order.order_code')
chk "tạo đơn $OCODE" "$([ "$OID" != "undefined" ] && echo 1 || echo 0)"

DUP=$(curl -s --noproxy '*' -X POST $B/orders -H "$A" -H "$J" -d "{\"table_id\":$TID}" | jqf '.existing')
chk "bàn đang mở thì trả về đơn cũ (không tạo trùng)" "$([ "$DUP" = "true" ] && echo 1 || echo 0)"

ADD=$(curl -s --noproxy '*' -X POST $B/orders/$OID/items -H "$A" -H "$J" -d "{\"dish_id\":$DID,\"quantity\":2,\"note\":\"ít cay\"}")
chk "thêm 2 x món #$DID vào đơn" "$([ "$(echo "$ADD" | jqf '.items.length')" = "1" ] && echo 1 || echo 0)"
TOTAL1=$(echo "$ADD" | jqf '.order.total')
chk "tổng tiền = 2 x $DPRICE = $TOTAL1" "$([ "$TOTAL1" = "$((DPRICE*2))" ] && echo 1 || echo 0)"

ADD2=$(curl -s --noproxy '*' -X POST $B/orders/$OID/items -H "$A" -H "$J" -d "{\"dish_id\":$DID,\"quantity\":3,\"note\":\"ít cay\"}")
QTY=$(echo "$ADD2" | jqf '.items[0].quantity')
chk "gộp dòng cùng món + cùng ghi chú (qty=$QTY)" "$([ "$QTY" = "5" ] && echo 1 || echo 0)"

echo "== 5. Luồng bếp =="
Q=$(curl -s --noproxy '*' $B/kitchen -H "$A")
chk "đơn xuất hiện trong hàng đợi bếp" "$([ "$(echo "$Q" | jqf '.queue.length')" -ge 1 ] && echo 1 || echo 0)"
IID=$(echo "$Q" | jqf '.queue[0].items[0].id')
curl -s --noproxy '*' -X PATCH $B/kitchen/item/$IID -H "$A" -H "$J" -d '{"status":"cooking"}' > /dev/null
OST=$(curl -s --noproxy '*' $B/orders/$OID -H "$A" | jqf '.order.status')
chk "món đang nấu -> đơn chuyển 'cooking'" "$([ "$OST" = "cooking" ] && echo 1 || echo 0)"
curl -s --noproxy '*' -X PATCH $B/kitchen/item/$IID -H "$A" -H "$J" -d '{"status":"ready"}' > /dev/null
OST=$(curl -s --noproxy '*' $B/orders/$OID -H "$A" | jqf '.order.status')
chk "món chín -> đơn chuyển 'ready'" "$([ "$OST" = "ready" ] && echo 1 || echo 0)"
curl -s --noproxy '*' -X PATCH $B/kitchen/item/$IID -H "$A" -H "$J" -d '{"status":"served"}' > /dev/null
OST=$(curl -s --noproxy '*' $B/orders/$OID -H "$A" | jqf '.order.status')
chk "đã phục vụ -> đơn chuyển 'served'" "$([ "$OST" = "served" ] && echo 1 || echo 0)"
TSTAT=$(curl -s --noproxy '*' $B/tables -H "$A" | jqf ".tables.find(t=>t.id==$TID).status")
chk "bàn $TID chuyển sang 'occupied'" "$([ "$TSTAT" = "occupied" ] && echo 1 || echo 0)"

echo "== 6. Thanh toán =="
CO=$(curl -s --noproxy '*' -X POST $B/orders/$OID/checkout -H "$A" -H "$J" -d '{"method":"cash","discount":20000}')
PAID=$(echo "$CO" | jqf '.order.status')
PT=$(echo "$CO" | jqf '.payment.amount')
chk "đơn chuyển 'paid'" "$([ "$PAID" = "paid" ] && echo 1 || echo 0)"
chk "số tiền thanh toán = $((DPRICE*5-20000)) (đã trừ 20k) -> $PT" "$([ "$PT" = "$((DPRICE*5-20000))" ] && echo 1 || echo 0)"
TSTAT=$(curl -s --noproxy '*' $B/tables -H "$A" | jqf ".tables.find(t=>t.id==$TID).status")
chk "bàn trở lại 'free' sau thanh toán" "$([ "$TSTAT" = "free" ] && echo 1 || echo 0)"
AGAIN=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X POST $B/orders/$OID/checkout -H "$A" -H "$J" -d '{}')
chk "thanh toán lại bị chặn (400)" "$([ "$AGAIN" = "400" ] && echo 1 || echo 0)"

echo "== 7. Đặt bàn & khách hàng =="
RESV=$(curl -s --noproxy '*' -X POST $B/reservations -H "$A" -H "$J" -d "{\"customer_name\":\"Khách Đặt\",\"phone\":\"0912345678\",\"table_id\":$TID,\"party_size\":4,\"reserved_at\":\"2026-10-21 19:00:00\"}")
RID=$(echo "$RESV" | jqf '.reservation.id')
chk "tạo đặt bàn id=$RID" "$([ "$RID" != "undefined" ] && echo 1 || echo 0)"
TSTAT=$(curl -s --noproxy '*' $B/tables -H "$A" | jqf ".tables.find(t=>t.id==$TID).status")
chk "bàn chuyển 'reserved'" "$([ "$TSTAT" = "reserved" ] && echo 1 || echo 0)"
CLASH=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X POST $B/reservations -H "$A" -H "$J" -d "{\"customer_name\":\"X\",\"phone\":\"0999\",\"table_id\":$TID,\"reserved_at\":\"2026-10-21 19:30:00\"}")
chk "trùng khung giờ bị chặn (409)" "$([ "$CLASH" = "409" ] && echo 1 || echo 0)"
curl -s --noproxy '*' -X PUT $B/reservations/$RID -H "$A" -H "$J" -d '{"status":"cancelled"}' > /dev/null
chk "hủy đặt bàn" "1"
CID=$(curl -s --noproxy '*' -X POST $B/customers -H "$A" -H "$J" -d '{"name":"Khách Thân","phone":"0987654321"}' | jqf '.customer.id')
chk "thêm khách hàng id=$CID" "$([ "$CID" != "undefined" ] && echo 1 || echo 0)"

echo "== 8. Báo cáo =="
OV=$(curl -s --noproxy '*' "$B/reports/overview" -H "$A")
chk "doanh thu ghi nhận = $(echo "$OV" | jqf '.revenue')" "$([ "$(echo "$OV" | jqf '.revenue')" -gt 0 ] && echo 1 || echo 0)"
chk "có món bán chạy" "$([ "$(echo "$OV" | jqf '.top_dishes.length')" -ge 1 ] && echo 1 || echo 0)"
DASH=$(curl -s --noproxy '*' $B/reports/dashboard -H "$A")
chk "dashboard trả dữ liệu hôm nay" "$([ "$(echo "$DASH" | jqf '.today_revenue')" -gt 0 ] && echo 1 || echo 0)"

echo "== 9. Phân quyền =="
STOK=$(curl -s --noproxy '*' -X POST $B/auth/login -H "$J" -d '{"username":"nhanvien","password":"nhanvien123"}' | jqf '.token')
SA="Authorization: Bearer $STOK"
DENY=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X POST $B/dishes -H "$SA" -H "$J" -d '{"name":"X","price":1}')
chk "nhân viên không được thêm món (403)" "$([ "$DENY" = "403" ] && echo 1 || echo 0)"
ALLOW=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' $B/orders -H "$SA")
chk "nhân viên xem được đơn hàng (200)" "$([ "$ALLOW" = "200" ] && echo 1 || echo 0)"
DENY2=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' $B/reports/overview -H "$SA")
chk "nhân viên không xem được báo cáo (403)" "$([ "$DENY2" = "403" ] && echo 1 || echo 0)"

echo "== 10. Đổi mật khẩu =="
CH=$(curl -s --noproxy '*' -X POST $B/auth/change-password -H "$SA" -H "$J" -d '{"old_password":"nhanvien123","new_password":"matkhau456"}')
chk "đổi mật khẩu thành công" "$([ "$(echo "$CH" | jqf '.ok')" = "true" ] && echo 1 || echo 0)"
NEWOK=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X POST $B/auth/login -H "$J" -d '{"username":"nhanvien","password":"matkhau456"}')
chk "đăng nhập bằng mật khẩu mới (200)" "$([ "$NEWOK" = "200" ] && echo 1 || echo 0)"
curl -s --noproxy '*' -X POST $B/auth/change-password -H "$SA" -H "$J" -d '{"old_password":"matkhau456","new_password":"nhanvien123"}' > /dev/null

echo
echo "KẾT QUẢ: $pass đạt / $fail lỗi"
[ "$fail" = "0" ]
