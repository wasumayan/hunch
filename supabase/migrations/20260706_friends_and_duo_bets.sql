-- Migration: friends_and_duo_bets
-- Friend graph (requests + accepted friendships), user search, friend invite links,
-- and 1:1 bets modeled as auto-created 2-person "duo" circles (reuse the whole engine).

create table if not exists public.friendships (
  user_lo uuid not null references public.profiles(id) on delete cascade,
  user_hi uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_lo, user_hi),
  check (user_lo < user_hi)
);
alter table public.friendships enable row level security;

create table if not exists public.friend_requests (
  id bigint generated always as identity primary key,
  from_user uuid not null references public.profiles(id) on delete cascade,
  to_user uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (from_user, to_user),
  check (from_user <> to_user)
);
alter table public.friend_requests enable row level security;

alter table public.groups add column if not exists is_duo boolean not null default false;
alter table public.groups add column if not exists duo_key text unique;

create or replace function public.are_friends(a uuid, b uuid) returns boolean
 language sql stable security definer set search_path to 'public' as $function$
  select exists(select 1 from friendships where user_lo = least(a,b) and user_hi = greatest(a,b));
$function$;

create or replace function public.search_users(p_q text) returns jsonb
 language plpgsql stable security definer set search_path to 'public' as $function$
declare me uuid := auth.uid(); q text := lower(trim(p_q));
begin
  if me is null then raise exception 'Not signed in'; end if;
  if length(q) < 2 then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', p.id, 'username', p.username, 'display_name', p.display_name,
      'status', case
        when are_friends(me, p.id) then 'friends'
        when exists(select 1 from friend_requests r where r.from_user=me and r.to_user=p.id) then 'requested'
        when exists(select 1 from friend_requests r where r.from_user=p.id and r.to_user=me) then 'incoming'
        else 'none' end) order by p.username)
    from profiles p
    where p.id <> me and (lower(p.username) like q || '%' or lower(p.display_name) like q || '%')
    limit 10), '[]'::jsonb);
end $function$;

create or replace function public.send_friend_request(p_to uuid) returns jsonb
 language plpgsql security definer set search_path to 'public' as $function$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'Not signed in'; end if;
  if p_to = me then raise exception 'You cannot add yourself'; end if;
  if not exists(select 1 from profiles where id = p_to) then raise exception 'User not found'; end if;
  if are_friends(me, p_to) then return jsonb_build_object('status','friends'); end if;
  if exists(select 1 from friend_requests where from_user = p_to and to_user = me) then
    insert into friendships (user_lo, user_hi) values (least(me,p_to), greatest(me,p_to)) on conflict do nothing;
    delete from friend_requests where (from_user=p_to and to_user=me) or (from_user=me and to_user=p_to);
    return jsonb_build_object('status','friends');
  end if;
  insert into friend_requests (from_user, to_user) values (me, p_to) on conflict do nothing;
  return jsonb_build_object('status','requested');
end $function$;

create or replace function public.respond_friend_request(p_from uuid, p_accept boolean) returns jsonb
 language plpgsql security definer set search_path to 'public' as $function$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'Not signed in'; end if;
  if not exists(select 1 from friend_requests where from_user=p_from and to_user=me) then raise exception 'No such request'; end if;
  if p_accept then
    insert into friendships (user_lo, user_hi) values (least(me,p_from), greatest(me,p_from)) on conflict do nothing;
  end if;
  delete from friend_requests where from_user=p_from and to_user=me;
  return jsonb_build_object('ok', true);
end $function$;

create or replace function public.get_friends() returns jsonb
 language plpgsql stable security definer set search_path to 'public' as $function$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'Not signed in'; end if;
  return jsonb_build_object(
    'friends', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'username', p.username, 'display_name', p.display_name) order by p.display_name)
      from friendships f join profiles p on p.id = case when f.user_lo = me then f.user_hi else f.user_lo end
      where f.user_lo = me or f.user_hi = me), '[]'::jsonb),
    'incoming', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'username', p.username, 'display_name', p.display_name) order by r.created_at desc)
      from friend_requests r join profiles p on p.id = r.from_user where r.to_user = me), '[]'::jsonb),
    'outgoing', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'username', p.username, 'display_name', p.display_name) order by p.display_name)
      from friend_requests r join profiles p on p.id = r.to_user where r.from_user = me), '[]'::jsonb)
  );
end $function$;

-- 1:1 bet: find-or-create the private duo circle for this friend pair, return its id
create or replace function public.bet_friend(p_friend uuid) returns uuid
 language plpgsql security definer set search_path to 'public' as $function$
declare me uuid := auth.uid(); k text; gid uuid; mename text; frname text;
begin
  if me is null then raise exception 'Not signed in'; end if;
  if not are_friends(me, p_friend) then raise exception 'You are not friends with this person'; end if;
  k := least(me,p_friend)::text || ':' || greatest(me,p_friend)::text;
  select id into gid from groups where duo_key = k;
  if gid is null then
    select display_name into mename from profiles where id = me;
    select display_name into frname from profiles where id = p_friend;
    insert into groups (name, emoji, currency, created_by, visibility, is_duo, duo_key)
    values (mename || ' & ' || frname, '🤝', 'USD', me, 'private', true, k)
    returning id into gid;
    insert into members (group_id, user_id, role) values (gid, me, 'admin'), (gid, p_friend, 'admin');
  end if;
  return gid;
end $function$;

-- Extend the invite system with a 'friend' kind (shareable friend link)
alter table public.invites drop constraint if exists invites_kind_check;
alter table public.invites add constraint invites_kind_check check (kind in ('app','group','market','friend'));

create or replace function public.create_invite(p_kind text, p_group uuid default null, p_market uuid default null)
 returns text language plpgsql security definer set search_path to 'public' as $function$
declare v_code text; v_group uuid := p_group;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if p_kind = 'group' then
    if not is_member(p_group) then raise exception 'Only members can create group invites'; end if;
  elsif p_kind = 'market' then
    if not can_view_market(p_market) then raise exception 'You cannot invite to this market'; end if;
    select group_id into v_group from markets where id = p_market;
  elsif p_kind not in ('app','friend') then
    raise exception 'Invalid invite kind';
  end if;
  loop
    v_code := upper(substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 8));
    exit when not exists (select 1 from invites where code = v_code);
  end loop;
  insert into invites (code, kind, group_id, market_id, created_by)
  values (v_code, p_kind,
          case when p_kind = 'group' then v_group when p_kind = 'market' then v_group else null end,
          case when p_kind = 'market' then p_market else null end, auth.uid());
  return v_code;
end $function$;

create or replace function public.redeem_invite(p_code text) returns jsonb
 language plpgsql security definer set search_path to 'public' as $function$
declare v invites%rowtype;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into v from invites where code = upper(trim(p_code)) for update;
  if not found then raise exception 'Invalid invite code'; end if;
  if v.expires_at is not null and v.expires_at < now() then raise exception 'This invite has expired'; end if;
  if v.max_uses is not null and v.uses >= v.max_uses then raise exception 'This invite has been fully used'; end if;
  if v.kind = 'group' then
    insert into members (group_id, user_id) values (v.group_id, auth.uid()) on conflict do nothing;
  elsif v.kind = 'market' then
    if not is_member(v.group_id) then
      insert into market_guests (market_id, user_id) values (v.market_id, auth.uid()) on conflict do nothing;
    end if;
  elsif v.kind = 'friend' then
    if v.created_by <> auth.uid() then
      insert into friendships (user_lo, user_hi) values (least(v.created_by, auth.uid()), greatest(v.created_by, auth.uid())) on conflict do nothing;
    end if;
  end if;
  update invites set uses = uses + 1 where code = v.code;
  return jsonb_build_object('kind', v.kind, 'group_id', v.group_id, 'market_id', v.market_id, 'friend_id', v.created_by);
end $function$;

create or replace function public.invite_preview(p_code text) returns jsonb
 language plpgsql stable security definer set search_path to 'public' as $function$
declare v invites%rowtype; result jsonb;
begin
  select * into v from invites where code = upper(trim(p_code));
  if not found or (v.expires_at is not null and v.expires_at < now()) or (v.max_uses is not null and v.uses >= v.max_uses) then
    return jsonb_build_object('valid', false);
  end if;
  result := jsonb_build_object('valid', true, 'kind', v.kind,
    'inviter', (select display_name from profiles where id = v.created_by));
  if v.kind = 'group' then
    result := result || (select jsonb_build_object('group_name', g.name, 'group_emoji', g.emoji,
      'member_count', (select count(*) from members where group_id = g.id)) from groups g where g.id = v.group_id);
  elsif v.kind = 'market' then
    result := result || (select jsonb_build_object('question', m.question, 'closes_at', m.closes_at,
      'group_name', (select name from groups where id = m.group_id)) from markets m where m.id = v.market_id);
  end if;
  return result;
end $function$;

-- get_home: keep duo circles out of the main circles list (they live in Friends)
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
    from groups g join members m on m.group_id = g.id where m.user_id = auth.uid() and not g.is_duo), '[]'::jsonb),
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
    from groups g where g.visibility = 'discoverable' and not g.is_duo and not is_member(g.id)), '[]'::jsonb),
  'featured', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', f.id, 'name', f.name, 'emoji', f.emoji, 'blurb', f.blurb, 'member_count', f.member_count,
      'requested', exists(select 1 from featured_group_requests r where r.featured_group_id = f.id and r.user_id = auth.uid())
    ) order by f.sort_order, f.created_at)
    from featured_groups f), '[]'::jsonb)
)
$function$;