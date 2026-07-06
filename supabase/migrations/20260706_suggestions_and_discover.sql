-- Migration: suggestions_source_and_discover
-- (A) suggestions: source/kind/metric so we can auto-refresh from Polymarket + carry numeric suggestions
-- (B) featured "Discover" groups: cosmetic hype circles + a real "request to join" interest capture

-- ============================================================
-- A. suggestions columns
-- ============================================================
alter table public.suggestions
  add column if not exists source text,                         -- null=original curated, 'seed'=this batch, 'polymarket'=cron
  add column if not exists kind text not null default 'binary',
  add column if not exists metric text;
alter table public.suggestions
  add constraint suggestions_kind_check check (kind in ('binary','numeric')),
  add constraint suggestions_metric_check check (metric is null or length(metric) <= 24);

create or replace function public.get_suggestions(p_group uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if not is_member(p_group) then raise exception 'Not a member of this group'; end if;
  return jsonb_build_object(
    'global', coalesce((select jsonb_agg(jsonb_build_object(
        'category', s.category, 'question', s.question, 'details', s.details,
        'kind', s.kind, 'metric', s.metric) order by s.id desc)
      from suggestions s where not s.is_template and s.tag is null), '[]'::jsonb),
    'templates', coalesce((select jsonb_agg(jsonb_build_object(
        'category', s.category, 'question', s.question, 'details', s.details,
        'kind', s.kind, 'metric', s.metric))
      from suggestions s where s.is_template), '[]'::jsonb),
    'tag_matched', coalesce((select jsonb_agg(jsonb_build_object(
        'category', s.category, 'question', s.question, 'details', s.details, 'tag', s.tag,
        'kind', s.kind, 'metric', s.metric))
      from suggestions s where s.tag is not null and lower(s.tag) in (
        select distinct lower(t) from members mem join profiles p on p.id = mem.user_id, unnest(p.tags) t
        where mem.group_id = p_group)), '[]'::jsonb),
    'member_names', coalesce((select jsonb_agg(u.display_name) from members mem join profiles u on u.id = mem.user_id
      where mem.group_id = p_group), '[]'::jsonb)
  );
end $function$;

-- ============================================================
-- B. featured "Discover" groups + interest capture
-- ============================================================
create table if not exists public.featured_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  emoji text not null default '✦',
  blurb text not null default '',
  member_count int not null default 0,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
alter table public.featured_groups enable row level security;
drop policy if exists featured_groups_read on public.featured_groups;
create policy featured_groups_read on public.featured_groups for select to authenticated using (true);

create table if not exists public.featured_group_requests (
  id bigint generated always as identity primary key,
  featured_group_id uuid not null references public.featured_groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (featured_group_id, user_id)
);
alter table public.featured_group_requests enable row level security;
-- deny-by-default: no policies. Writes go through request_featured_group(); owner reads via dashboard.

create or replace function public.request_featured_group(p_featured uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not exists (select 1 from featured_groups where id = p_featured) then
    raise exception 'That circle is not available';
  end if;
  insert into featured_group_requests (featured_group_id, user_id)
  values (p_featured, auth.uid())
  on conflict (featured_group_id, user_id) do nothing;
  return jsonb_build_object('ok', true);
end $function$;

-- get_home gains a 'featured' array (with a per-user requested flag)
create or replace function public.get_home()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
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
  'featured', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', f.id, 'name', f.name, 'emoji', f.emoji, 'blurb', f.blurb, 'member_count', f.member_count,
      'requested', exists(select 1 from featured_group_requests r where r.featured_group_id = f.id and r.user_id = auth.uid())
    ) order by f.sort_order, f.created_at)
    from featured_groups f), '[]'::jsonb)
)
$function$;
