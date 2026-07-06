-- Migration: circle_visibility
-- Circles get a visibility: 'private' (default — invisible, invite-only) or
-- 'discoverable' (shows in Discover; people can request to join, admins approve).

alter table public.groups add column if not exists visibility text not null default 'private';
alter table public.groups add constraint groups_visibility_check check (visibility in ('private','discoverable'));

create table if not exists public.circle_join_requests (
  id bigint generated always as identity primary key,
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','approved','declined')),
  created_at timestamptz not null default now(),
  unique (group_id, user_id)
);
alter table public.circle_join_requests enable row level security;
-- deny-by-default; all access via the RPCs below.

-- A signed-in user requests to join a discoverable circle.
create or replace function public.request_join_circle(p_group uuid)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not exists (select 1 from groups where id = p_group and visibility = 'discoverable') then
    raise exception 'That circle is not open to requests';
  end if;
  if is_member(p_group) then raise exception 'You are already in this circle'; end if;
  insert into circle_join_requests (group_id, user_id, status)
  values (p_group, auth.uid(), 'pending')
  on conflict (group_id, user_id) do update set status = 'pending', created_at = now();
  return jsonb_build_object('ok', true);
end $function$;

-- A circle admin approves or declines a pending request.
create or replace function public.resolve_join_request(p_group uuid, p_user uuid, p_approve boolean)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
begin
  if not is_admin(p_group) then raise exception 'Only circle admins can review requests'; end if;
  if p_approve then
    insert into members (group_id, user_id, role) values (p_group, p_user, 'member') on conflict do nothing;
    update circle_join_requests set status = 'approved' where group_id = p_group and user_id = p_user;
  else
    update circle_join_requests set status = 'declined' where group_id = p_group and user_id = p_user;
  end if;
  return jsonb_build_object('ok', true);
end $function$;

-- create_group gains a visibility param
drop function if exists public.create_group(text, text, text, bigint);
create or replace function public.create_group(p_name text, p_emoji text, p_currency text,
  p_max_bet_cents bigint default null, p_visibility text default 'private')
 returns uuid language plpgsql security definer set search_path to 'public'
as $function$
declare gid uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if coalesce(p_visibility,'private') not in ('private','discoverable') then raise exception 'Invalid visibility'; end if;
  insert into groups (name, emoji, currency, max_bet_cents, created_by, visibility)
  values (trim(p_name), coalesce(nullif(trim(p_emoji), ''), '✦'),
          upper(coalesce(nullif(trim(p_currency), ''), 'USD')), p_max_bet_cents, auth.uid(),
          coalesce(p_visibility,'private'))
  returning id into gid;
  insert into members (group_id, user_id, role) values (gid, auth.uid(), 'admin');
  return gid;
end $function$;

-- get_home gains 'discoverable' (real discoverable circles the user is not in yet)
create or replace function public.get_home()
 returns jsonb language sql stable security definer set search_path to 'public'
as $function$
select jsonb_build_object(
  'profile', (select to_jsonb(p) from profiles p where p.id = auth.uid()),
  'handles', (select to_jsonb(h) - 'user_id' from payment_handles h where h.user_id = auth.uid()),
  'groups', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', g.id, 'name', g.name, 'emoji', g.emoji, 'currency', g.currency,
      'member_count', (select count(*) from members where group_id = g.id),
      'open_markets', (select count(*) from markets mk where mk.group_id = g.id and mk.status = 'open' and mk.closes_at > now()),
      'net_cents', coalesce((select sum(l.amount_cents) from ledger l join markets mk on mk.id = l.market_id
                             where mk.group_id = g.id and l.user_id = auth.uid() and mk.status in ('resolved','void')), 0),
      'in_play_cents', coalesce((select sum(b.amount_cents) from bets b join markets mk on mk.id = b.market_id
                                 where mk.group_id = g.id and b.user_id = auth.uid() and mk.status in ('open','locked')), 0)
    ) order by g.created_at desc)
    from groups g join members m on m.group_id = g.id where m.user_id = auth.uid()), '[]'::jsonb),
  'guest_markets', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', mk.id, 'question', mk.question, 'status', mk.status, 'closes_at', mk.closes_at,
      'group_name', (select name from groups where id = mk.group_id),
      'currency', (select currency from groups where id = mk.group_id)
    ) order by mk.created_at desc)
    from market_guests mg join markets mk on mk.id = mg.market_id
    where mg.user_id = auth.uid() and not is_member(mk.group_id)), '[]'::jsonb),
  'discoverable', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', g.id, 'name', g.name, 'emoji', g.emoji,
      'member_count', (select count(*) from members where group_id = g.id),
      'requested', exists(select 1 from circle_join_requests r where r.group_id = g.id and r.user_id = auth.uid() and r.status = 'pending')
    ) order by (select count(*) from members where group_id = g.id) desc)
    from groups g where g.visibility = 'discoverable' and not is_member(g.id)), '[]'::jsonb),
  'featured', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', f.id, 'name', f.name, 'emoji', f.emoji, 'blurb', f.blurb, 'member_count', f.member_count,
      'requested', exists(select 1 from featured_group_requests r where r.featured_group_id = f.id and r.user_id = auth.uid())
    ) order by f.sort_order, f.created_at)
    from featured_groups f), '[]'::jsonb)
)
$function$;

-- get_group_detail gains 'join_requests' (pending, admins only) + group.visibility
create or replace function public.get_group_detail(p_group uuid)
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  if not is_member(p_group) then raise exception 'Not a member of this group'; end if;
  return jsonb_build_object(
    'group', (select jsonb_build_object('id', g.id, 'name', g.name, 'emoji', g.emoji,
              'currency', g.currency, 'max_bet_cents', g.max_bet_cents, 'created_by', g.created_by,
              'visibility', g.visibility)
              from groups g where g.id = p_group),
    'my_role', (select role from members where group_id = p_group and user_id = auth.uid()),
    'join_requests', case when is_admin(p_group) then coalesce((
      select jsonb_agg(jsonb_build_object('user_id', u.id, 'username', u.username,
             'display_name', u.display_name, 'created_at', r.created_at) order by r.created_at)
      from circle_join_requests r join profiles u on u.id = r.user_id
      where r.group_id = p_group and r.status = 'pending'), '[]'::jsonb) else '[]'::jsonb end,
    'members', coalesce((
      select jsonb_agg(row order by (row->>'settled_net_cents')::bigint + (row->>'in_play_cents')::bigint desc)
      from (
        select jsonb_build_object(
          'id', u.id, 'username', u.username, 'display_name', u.display_name, 'role', mem.role,
          'settled_net_cents', coalesce((select sum(l.amount_cents) from ledger l join markets mk on mk.id = l.market_id
            where mk.group_id = p_group and l.user_id = u.id and mk.status in ('resolved','void')), 0),
          'in_play_cents', coalesce((select sum(b.amount_cents) from bets b join markets mk on mk.id = b.market_id
            where mk.group_id = p_group and b.user_id = u.id and mk.status in ('open','locked')), 0),
          'wins', coalesce((select count(*) from (
            select b.market_id from bets b join markets mk on mk.id = b.market_id
            where b.user_id = u.id and mk.group_id = p_group and mk.status = 'resolved'
            group by b.market_id
            having coalesce((select sum(l2.amount_cents) from ledger l2 where l2.market_id = b.market_id and l2.user_id = u.id and l2.kind in ('payout','refund')), 0)
                 > sum(b.amount_cents)) w), 0),
          'losses', coalesce((select count(*) from (
            select b.market_id from bets b join markets mk on mk.id = b.market_id
            where b.user_id = u.id and mk.group_id = p_group and mk.status = 'resolved'
            group by b.market_id
            having coalesce((select sum(l2.amount_cents) from ledger l2 where l2.market_id = b.market_id and l2.user_id = u.id and l2.kind in ('payout','refund')), 0)
                 < sum(b.amount_cents)) w), 0)
        ) as row
        from members mem join profiles u on u.id = mem.user_id
        where mem.group_id = p_group
      ) rows), '[]'::jsonb),
    'markets', coalesce((
      select jsonb_agg(market_summary(m) order by m.created_at desc)
      from markets m where m.group_id = p_group), '[]'::jsonb)
  );
end $function$;