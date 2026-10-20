-- ============================================================================
--  Quản lý nhà hàng — Schema PostgreSQL cho Supabase
--
--  Cách dùng:
--    Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run
--
--  Ghi chú thiết kế:
--   * Khóa chính dùng bigint identity (tương đương AUTOINCREMENT của SQLite).
--   * Mốc thời gian dùng timestamptz, mặc định now() — luôn lưu theo UTC.
--   * RLS được BẬT nhưng KHÔNG tạo policy: chỉ service_role key mới truy cập được.
--     Backend dùng service key nên bỏ qua RLS; anon key bị chặn hoàn toàn.
-- ============================================================================

-- ------------------------------------------------------------------ users --
create table if not exists public.users (
  id          bigint generated always as identity primary key,
  username    text not null unique,
  password    text not null,
  full_name   text not null,
  role        text not null default 'staff'
              check (role in ('admin','manager','staff','chef')),
  phone       text,
  email       text,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ------------------------------------------------------------- categories --
create table if not exists public.categories (
  id          bigint generated always as identity primary key,
  name        text not null unique,
  sort_order  integer not null default 0
);

-- ------------------------------------------------------------------ dishes --
create table if not exists public.dishes (
  id           bigint generated always as identity primary key,
  category_id  bigint references public.categories(id) on delete set null,
  name         text not null,
  description  text default '',
  price        integer not null check (price >= 0),
  image        text default '',
  available    boolean not null default true,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------- dining_tables --
create table if not exists public.dining_tables (
  id          bigint generated always as identity primary key,
  name        text not null unique,
  zone        text not null default 'Trong nhà',
  seats       integer not null default 4,
  status      text not null default 'free'
              check (status in ('free','occupied','reserved')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- --------------------------------------------------------------- customers --
create table if not exists public.customers (
  id           bigint generated always as identity primary key,
  name         text not null,
  phone        text not null,
  email        text default '',
  points       integer not null default 0,
  total_spent  integer not null default 0,
  created_at   timestamptz not null default now()
);

-- ------------------------------------------------------------------ orders --
create table if not exists public.orders (
  id             bigint generated always as identity primary key,
  order_code     text not null unique,
  table_id       bigint references public.dining_tables(id) on delete set null,
  customer_name  text default '',
  customer_id    bigint references public.customers(id) on delete set null,
  guest_count    integer not null default 1,
  user_id        bigint references public.users(id) on delete set null,
  status         text not null default 'draft'
                 check (status in ('draft','cooking','ready','served','paid','cancelled')),
  note           text default '',
  subtotal       integer not null default 0,
  discount       integer not null default 0,
  total          integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ------------------------------------------------------------ order_items --
create table if not exists public.order_items (
  id          bigint generated always as identity primary key,
  order_id    bigint not null references public.orders(id) on delete cascade,
  dish_id     bigint references public.dishes(id) on delete set null,
  dish_name   text not null,
  price       integer not null,
  quantity    integer not null default 1,
  note        text default '',
  status      text not null default 'pending'
              check (status in ('pending','cooking','ready','served','cancelled')),
  created_at  timestamptz not null default now()
);

-- --------------------------------------------------------------- payments --
create table if not exists public.payments (
  id          bigint generated always as identity primary key,
  order_id    bigint not null references public.orders(id) on delete cascade,
  user_id     bigint references public.users(id) on delete set null,
  method      text not null default 'cash'
              check (method in ('cash','card','momo','zalo','bank')),
  amount      integer not null,
  discount    integer not null default 0,
  created_at  timestamptz not null default now()
);

-- ----------------------------------------------------------- reservations --
create table if not exists public.reservations (
  id             bigint generated always as identity primary key,
  customer_name  text not null,
  phone          text not null,
  table_id       bigint references public.dining_tables(id) on delete set null,
  party_size     integer not null default 2,
  reserved_at    timestamptz not null,
  note           text default '',
  status         text not null default 'pending'
                 check (status in ('pending','confirmed','seated','cancelled')),
  created_at     timestamptz not null default now()
);

-- --------------------------------------------------------------- settings --
create table if not exists public.settings (
  key    text primary key,
  value  text not null
);

-- ---------------------------------------------------------------- indexes --
create index if not exists idx_orders_status   on public.orders(status);
create index if not exists idx_orders_table    on public.orders(table_id);
create index if not exists idx_orders_created  on public.orders(created_at);
create index if not exists idx_items_order     on public.order_items(order_id);
create index if not exists idx_resv_status     on public.reservations(status);
create index if not exists idx_pay_created     on public.payments(created_at);

-- ------------------------------------------------------------------- RLS ----
-- Bật RLS và không tạo policy nào: anon/public key hoàn toàn không đọc/ghi được.
-- Backend dùng service_role key nên vẫn hoạt động bình thường.
alter table public.users         enable row level security;
alter table public.categories    enable row level security;
alter table public.dishes        enable row level security;
alter table public.dining_tables enable row level security;
alter table public.customers     enable row level security;
alter table public.orders        enable row level security;
alter table public.order_items   enable row level security;
alter table public.payments      enable row level security;
alter table public.reservations  enable row level security;
alter table public.settings      enable row level security;

-- ============================================================================
--  Hàm hỗ trợ (RPC) cho các truy vấn nhiều bảng / tính toán
-- ============================================================================

-- Tính lại subtotal/total của một đơn và trả về dòng orders sau khi cập nhật.
create or replace function public.recalc_order(p_order_id bigint)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_subtotal integer;
  v_discount integer;
  v_row      public.orders;
begin
  select coalesce(sum(price * quantity), 0) into v_subtotal
    from order_items
   where order_id = p_order_id and status <> 'cancelled';

  select discount into v_discount from orders where id = p_order_id;
  if not found then
    return null;
  end if;

  update orders
     set subtotal = v_subtotal,
         total = greatest(0, v_subtotal - coalesce(v_discount, 0)),
         updated_at = now()
   where id = p_order_id
  returning * into v_row;

  return v_row;
end;
$$;

-- Đồng bộ trạng thái đơn theo trạng thái từng món; trả về dòng orders.
create or replace function public.sync_order_status(p_order_id bigint)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order   public.orders;
  v_pending integer;
  v_cooking integer;
  v_ready   integer;
  v_total   integer;
  v_status  text;
begin
  select * into v_order from orders where id = p_order_id;
  if not found then
    return null;
  end if;
  if v_order.status in ('paid','cancelled') then
    return v_order;
  end if;

  select count(*) filter (where status = 'pending'),
         count(*) filter (where status = 'cooking'),
         count(*) filter (where status = 'ready'),
         count(*)
    into v_pending, v_cooking, v_ready, v_total
    from order_items
   where order_id = p_order_id and status <> 'cancelled';

  if v_total = 0 then
    return v_order;
  end if;

  if v_pending > 0 then v_status := 'draft';
  elsif v_cooking > 0 then v_status := 'cooking';
  elsif v_ready > 0 then v_status := 'ready';
  else v_status := 'served';
  end if;

  if v_status <> v_order.status then
    update orders set status = v_status, updated_at = now()
     where id = p_order_id
    returning * into v_order;
  end if;

  return v_order;
end;
$$;

-- Cập nhật trạng thái bàn theo đơn đang mở / đặt bàn còn hiệu lực.
create or replace function public.refresh_table(p_table_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_has_order boolean;
  v_has_resv  boolean;
begin
  if p_table_id is null then
    return;
  end if;

  select exists(
    select 1 from orders
     where table_id = p_table_id
       and status in ('draft','cooking','ready','served')
  ) into v_has_order;

  if v_has_order then
    update dining_tables set status = 'occupied' where id = p_table_id;
    return;
  end if;

  select exists(
    select 1 from reservations
     where table_id = p_table_id
       and status in ('pending','confirmed')
       and reserved_at >= now() - interval '3 hours'
  ) into v_has_resv;

  update dining_tables
     set status = case when v_has_resv then 'reserved' else 'free' end
   where id = p_table_id;
end;
$$;

-- Sinh mã đơn kế tiếp trong ngày: HD-YYMMDD-0001
create or replace function public.next_order_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_ymd   text;
begin
  select count(*) into v_count
    from orders
   where created_at::date = current_date;

  v_ymd := to_char(current_date, 'YYMMDD');
  return 'HD' || v_ymd || '-' || lpad((v_count + 1)::text, 4, '0');
end;
$$;

-- ---------------------------------------------------------------- reports ---

-- Tổng quan doanh thu trong khoảng ngày.
create or replace function public.report_overview(p_from date, p_to date)
returns json
language sql
security definer
set search_path = public
as $$
  select json_build_object(
    'revenue',          (select coalesce(sum(amount),0) from payments
                          where created_at::date between p_from and p_to),
    'payments',         (select count(*) from payments
                          where created_at::date between p_from and p_to),
    'orders',           (select count(*) from orders
                          where created_at::date between p_from and p_to),
    'paid_orders',      (select count(*) from orders
                          where status = 'paid'
                            and created_at::date between p_from and p_to),
    'cancelled_orders', (select count(*) from orders
                          where status = 'cancelled'
                            and created_at::date between p_from and p_to),
    'by_day', coalesce((
      select json_agg(row_to_json(t) order by t.day)
        from (select created_at::date as day,
                     sum(amount) as revenue,
                     count(*) as bills
                from payments
               where created_at::date between p_from and p_to
               group by 1) t
    ), '[]'::json),
    'by_method', coalesce((
      select json_agg(row_to_json(t) order by t.revenue desc)
        from (select method,
                     sum(amount) as revenue,
                     count(*) as bills
                from payments
               where created_at::date between p_from and p_to
               group by method) t
    ), '[]'::json),
    'top_dishes', coalesce((
      select json_agg(row_to_json(t) order by t.qty desc)
        from (select oi.dish_name,
                     sum(oi.quantity) as qty,
                     sum(oi.price * oi.quantity) as revenue
                from order_items oi
                join orders o on o.id = oi.order_id
               where o.status = 'paid'
                 and oi.status <> 'cancelled'
                 and o.created_at::date between p_from and p_to
               group by oi.dish_name
               order by sum(oi.quantity) desc
               limit 10) t
    ), '[]'::json)
  );
$$;

-- Số liệu cho trang tổng quan.
create or replace function public.report_dashboard()
returns json
language sql
security definer
set search_path = public
as $$
  select json_build_object(
    'today_revenue', (select coalesce(sum(amount),0) from payments
                       where created_at::date = current_date),
    'today_bills',   (select count(*) from payments
                       where created_at::date = current_date),
    'month_revenue', (select coalesce(sum(amount),0) from payments
                       where date_trunc('month', created_at) = date_trunc('month', now())),
    'tables', json_build_object(
      'total',    (select count(*) from dining_tables where active),
      'occupied', (select count(*) from dining_tables where active and status = 'occupied'),
      'reserved', (select count(*) from dining_tables where active and status = 'reserved')
    ),
    'active_orders',        (select count(*) from orders
                              where status in ('draft','cooking','ready','served')),
    'pending_reservations', (select count(*) from reservations
                              where status in ('pending','confirmed')
                                and reserved_at::date = current_date),
    'cooking_items',        (select count(*) from order_items
                              where status in ('pending','cooking'))
  );
$$;

-- Cho phép backend (service_role) gọi các hàm này.
grant execute on function public.recalc_order(bigint)        to service_role;
grant execute on function public.sync_order_status(bigint)   to service_role;
grant execute on function public.refresh_table(bigint)       to service_role;
grant execute on function public.next_order_code()           to service_role;
grant execute on function public.report_overview(date, date) to service_role;
grant execute on function public.report_dashboard()          to service_role;
