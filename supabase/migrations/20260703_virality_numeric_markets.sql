-- Migration: virality_numeric_markets
-- Additive. Adds a numeric "closest-guess" market kind + optional social-post metadata.
-- Safe on live data (all binary defaults; existing rows unaffected).

-- ============================================================
-- 1. Schema
-- ============================================================
alter table public.markets
  add column if not exists kind text not null default 'binary',
  add column if not exists post_url text,
  add column if not exists metric text,
  add column if not exists target_value bigint,
  add column if not exists resolved_value bigint;

alter table public.markets
  add constraint markets_kind_check check (kind in ('binary','numeric')),
  add constraint markets_post_url_check check (post_url is null or length(post_url) <= 500),
  add constraint markets_metric_check check (metric is null or length(metric) <= 24),
  add constraint markets_target_check check (target_value is null or target_value >= 0),
  add constraint markets_resolved_value_check check (resolved_value is null or resolved_value >= 0);

alter table public.bets
  add column if not exists guess bigint;

-- side was NOT NULL yes/no; numeric bets carry a guess instead of a side.
alter table public.bets alter column side drop not null;
alter table public.bets
  add constraint bets_guess_check check (guess is null or guess >= 0),
  add constraint bets_side_xor_guess check (
    (side is not null and guess is null) or (side is null and guess is not null)
  );

-- ============================================================
-- 2. market_summary — expose kind, post, target, resolved_value + numeric pools
-- ============================================================
create or replace function public.market_summary(m markets)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
select jsonb_build_object(
  'id', m.id, 'group_id', m.group_id, 'question', m.question, 'details', m.details,
  'closes_at', m.closes_at, 'created_at', m.created_at, 'status', m.status,
  'resolution', m.resolution, 'resolved_at', m.resolved_at, 'visibility', m.visibility,
  'gate_domain', m.gate_domain, 'gate_tag', m.gate_tag,
  'kind', m.kind, 'post_url', m.post_url, 'metric', m.metric,
  'target_value', m.target_value, 'resolved_value', m.resolved_value,
  'creator_id', m.creator_id,
  'creator_name', (select display_name from profiles where id = m.creator_id),
  'subject_id', m.subject_user_id,
  'subject_name', (select display_name from profiles where id = m.subject_user_id),
  'resolved_by_name', (select display_name from profiles where id = m.resolved_by),
  'yes_pool', coalesce((select sum(amount_cents) from bets where market_id = m.id and side = 'yes'), 0),
  'no_pool', coalesce((select sum(amount_cents) from bets where market_id = m.id and side = 'no'), 0),
  'pot_cents', coalesce((select sum(amount_cents) from bets where market_id = m.id), 0),
  'guess_count', (select count(*) from bets where market_id = m.id and guess is not null),
  'guess_min', (select min(guess) from bets where market_id = m.id),
  'guess_max', (select max(guess) from bets where market_id = m.id),
  'bettors', (select count(distinct user_id) from bets where market_id = m.id),
  'betting_open', (m.status = 'open' and m.closes_at > now())
)
$function$;

-- ============================================================
-- 3. create_market — add p_kind / p_post_url / p_metric / p_target
-- ============================================================
drop function if exists public.create_market(uuid, text, text, timestamptz, text, text, text, uuid);
create or replace function public.create_market(
  p_group uuid, p_question text, p_details text, p_closes_at timestamptz,
  p_visibility text default 'group', p_gate_domain text default null,
  p_gate_tag text default null, p_subject uuid default null,
  p_kind text default 'binary', p_post_url text default null,
  p_metric text default null, p_target bigint default null)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare mid uuid;
begin
  if not is_member(p_group) then raise exception 'Not a member of this group'; end if;
  if p_closes_at <= now() then raise exception 'Close time must be in the future'; end if;
  if p_closes_at > now() + interval '366 days' then raise exception 'Close time must be within a year'; end if;
  if p_subject is not null and not exists (select 1 from members where group_id = p_group and user_id = p_subject) then
    raise exception 'The subject must be a member of the group';
  end if;
  if p_visibility not in ('group', 'community') then raise exception 'Invalid visibility'; end if;
  if coalesce(p_kind, 'binary') not in ('binary', 'numeric') then raise exception 'Invalid market kind'; end if;
  insert into markets (group_id, creator_id, subject_user_id, question, details, closes_at, visibility,
                       gate_domain, gate_tag, kind, post_url, metric, target_value)
  values (p_group, auth.uid(), p_subject, trim(p_question), coalesce(trim(p_details), ''), p_closes_at,
          p_visibility,
          case when p_visibility = 'community' then lower(nullif(trim(p_gate_domain), '')) end,
          case when p_visibility = 'community' then nullif(trim(p_gate_tag), '') end,
          coalesce(p_kind, 'binary'),
          nullif(trim(p_post_url), ''),
          nullif(trim(p_metric), ''),
          case when coalesce(p_kind,'binary') = 'binary' then p_target end)
  returning id into mid;
  return mid;
end $function$;

-- ============================================================
-- 4. place_bet — reject numeric markets (binary only)
-- ============================================================
create or replace function public.place_bet(p_market uuid, p_side text, p_amount_cents bigint)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  m markets%rowtype;
  v_max bigint;
  v_yes bigint;
  v_no bigint;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if p_side not in ('yes', 'no') then raise exception 'Side must be yes or no'; end if;
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'Amount must be positive'; end if;
  select * into m from markets where id = p_market for update;
  if not found then raise exception 'Market not found'; end if;
  if m.kind <> 'binary' then raise exception 'This is a closest-guess market — submit a number instead'; end if;
  if not can_view_market(p_market) then raise exception 'You do not have access to this market'; end if;
  if m.status <> 'open' then raise exception 'Betting is closed on this market'; end if;
  if m.closes_at <= now() then raise exception 'This market has closed'; end if;
  if m.subject_user_id = auth.uid() then
    raise exception 'You are the subject of this market — you can resolve it, but not bet on it';
  end if;
  select max_bet_cents into v_max from groups where id = m.group_id;
  if v_max is not null and p_amount_cents > v_max then
    raise exception 'This group caps bets at % per wager', (v_max / 100.0)::text;
  end if;
  insert into bets (market_id, user_id, side, amount_cents) values (p_market, auth.uid(), p_side, p_amount_cents);
  insert into ledger (market_id, user_id, amount_cents, kind) values (p_market, auth.uid(), -p_amount_cents, 'bet');
  select coalesce(sum(amount_cents) filter (where side = 'yes'), 0),
         coalesce(sum(amount_cents) filter (where side = 'no'), 0)
    into v_yes, v_no from bets where market_id = p_market;
  return jsonb_build_object('yes_pool', v_yes, 'no_pool', v_no);
end $function$;

-- ============================================================
-- 5. place_guess — numeric bet placement (guess + stake)
-- ============================================================
create or replace function public.place_guess(p_market uuid, p_guess bigint, p_amount_cents bigint)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  m markets%rowtype;
  v_max bigint;
  v_pot bigint;
  v_count int;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if p_guess is null or p_guess < 0 then raise exception 'Enter a valid guess (a non-negative whole number)'; end if;
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'Amount must be positive'; end if;
  select * into m from markets where id = p_market for update;
  if not found then raise exception 'Market not found'; end if;
  if m.kind <> 'numeric' then raise exception 'This market takes YES/NO bets, not a number'; end if;
  if not can_view_market(p_market) then raise exception 'You do not have access to this market'; end if;
  if m.status <> 'open' then raise exception 'Betting is closed on this market'; end if;
  if m.closes_at <= now() then raise exception 'This market has closed'; end if;
  if m.subject_user_id = auth.uid() then
    raise exception 'You are the subject of this market — you can resolve it, but not bet on it';
  end if;
  select max_bet_cents into v_max from groups where id = m.group_id;
  if v_max is not null and p_amount_cents > v_max then
    raise exception 'This group caps bets at % per wager', (v_max / 100.0)::text;
  end if;
  insert into bets (market_id, user_id, guess, amount_cents) values (p_market, auth.uid(), p_guess, p_amount_cents);
  insert into ledger (market_id, user_id, amount_cents, kind) values (p_market, auth.uid(), -p_amount_cents, 'bet');
  select coalesce(sum(amount_cents), 0), count(*) into v_pot, v_count from bets where market_id = p_market;
  return jsonb_build_object('pot_cents', v_pot, 'guess_count', v_count);
end $function$;

-- ============================================================
-- 6. resolve_market — allow void on numeric; block yes/no on numeric
-- ============================================================
create or replace function public.resolve_market(p_market uuid, p_outcome text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  m markets%rowtype;
  v_pot bigint;
  v_win_pool bigint;
begin
  if p_outcome not in ('yes', 'no', 'void') then raise exception 'Outcome must be yes, no, or void'; end if;
  select * into m from markets where id = p_market for update;
  if not found then raise exception 'Market not found'; end if;
  if not can_resolve_market(p_market) then
    raise exception 'Only the creator, the subject, or a group admin can resolve this market';
  end if;
  if m.status in ('resolved', 'void') then raise exception 'Market is already resolved'; end if;
  if m.kind = 'numeric' and p_outcome in ('yes','no') then
    raise exception 'This is a closest-guess market — resolve it with the final number';
  end if;

  select coalesce(sum(amount_cents), 0) into v_pot from bets where market_id = p_market;
  select coalesce(sum(amount_cents), 0) into v_win_pool from bets where market_id = p_market and side = p_outcome;

  if p_outcome = 'void' or v_win_pool = 0 then
    insert into ledger (market_id, user_id, amount_cents, kind)
    select p_market, user_id, sum(amount_cents), 'refund'
    from bets where market_id = p_market group by user_id;
  else
    insert into ledger (market_id, user_id, amount_cents, kind)
    select p_market, user_id, floor(sum(amount_cents)::numeric * v_pot / v_win_pool)::bigint, 'payout'
    from bets where market_id = p_market and side = p_outcome group by user_id;
  end if;

  update markets set
    status = case when p_outcome = 'void' then 'void' else 'resolved' end,
    resolution = case when p_outcome = 'void' then null else p_outcome end,
    resolved_by = auth.uid(), resolved_at = now()
  where id = p_market;

  return jsonb_build_object('outcome', p_outcome, 'pot_cents', v_pot);
end $function$;

-- ============================================================
-- 7. resolve_numeric — closest-guess winner-take-all, cent-exact
-- ============================================================
create or replace function public.resolve_numeric(p_market uuid, p_final_value bigint)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  m markets%rowtype;
  v_pot bigint;
begin
  if p_final_value is null or p_final_value < 0 then raise exception 'Final value must be a non-negative whole number'; end if;
  select * into m from markets where id = p_market for update;
  if not found then raise exception 'Market not found'; end if;
  if m.kind <> 'numeric' then raise exception 'This is a YES/NO market — use the normal resolve'; end if;
  if not can_resolve_market(p_market) then
    raise exception 'Only the creator, the subject, or a group admin can resolve this market';
  end if;
  if m.status in ('resolved', 'void') then raise exception 'Market is already resolved'; end if;

  select coalesce(sum(amount_cents), 0) into v_pot from bets where market_id = p_market;

  if v_pot > 0 then
    -- Closest guess(es) split the whole pot pro-rata to stake, floored, with the
    -- flooring remainder handed out 1c at a time (earliest bet first) so the pot
    -- is conserved exactly and the market's ledger nets to zero.
    with dist as (
      select user_id, amount_cents, id, abs(guess - p_final_value) as d
      from bets where market_id = p_market
    ),
    mind as (select min(d) as md from dist),
    winners as (
      select d.user_id, sum(d.amount_cents) as stake, min(d.id) as first_bet_id
      from dist d, mind where d.d = mind.md group by d.user_id
    ),
    tot as (select coalesce(sum(stake), 0) as win_stake from winners),
    paid as (
      select w.user_id, w.first_bet_id,
             floor(w.stake::numeric * v_pot / t.win_stake)::bigint as base
      from winners w, tot t
    ),
    ranked as (
      select user_id, base, row_number() over (order by first_bet_id) as rn
      from paid
    ),
    final as (
      select user_id,
             base + case when rn <= (v_pot - (select coalesce(sum(base),0) from paid)) then 1 else 0 end as amt
      from ranked
    )
    insert into ledger (market_id, user_id, amount_cents, kind)
    select p_market, user_id, amt, 'payout' from final where amt > 0;
  end if;

  update markets set status = 'resolved', resolved_value = p_final_value,
    resolved_by = auth.uid(), resolved_at = now()
  where id = p_market;

  return jsonb_build_object('final_value', p_final_value, 'pot_cents', v_pot);
end $function$;

-- ============================================================
-- 8. get_market_detail — positions carry guess (for numeric)
-- ============================================================
create or replace function public.get_market_detail(p_market uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare m markets%rowtype;
begin
  if not can_view_market(p_market) then raise exception 'You do not have access to this market'; end if;
  select * into m from markets where id = p_market;
  return jsonb_build_object(
    'market', market_summary(m),
    'group_name', (select name from groups where id = m.group_id),
    'currency', (select currency from groups where id = m.group_id),
    'max_bet_cents', (select max_bet_cents from groups where id = m.group_id),
    'am_member', is_member(m.group_id),
    'can_resolve', can_resolve_market(p_market),
    'is_subject', (m.subject_user_id = auth.uid()),
    'positions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', b.user_id, 'username', u.username, 'display_name', u.display_name,
        'side', b.side, 'guess', b.guess, 'amount_cents', b.sum_amount) order by b.sum_amount desc)
      from (select market_id, user_id, side, guess, sum(amount_cents) as sum_amount
            from bets where market_id = p_market group by 1,2,3,4) b
      join profiles u on u.id = b.user_id), '[]'::jsonb),
    'payouts', coalesce((
      select jsonb_agg(jsonb_build_object('display_name', u.display_name, 'amount_cents', l.amount_cents, 'kind', l.kind)
             order by l.amount_cents desc)
      from ledger l join profiles u on u.id = l.user_id
      where l.market_id = p_market and l.kind in ('payout','refund')), '[]'::jsonb),
    'comments', coalesce((
      select jsonb_agg(jsonb_build_object('display_name', u.display_name, 'username', u.username,
             'body', c.body, 'created_at', c.created_at) order by c.created_at asc)
      from comments c join profiles u on u.id = c.user_id where c.market_id = p_market), '[]'::jsonb)
  );
end $function$;

-- ============================================================
-- 9. get_activity — handle numeric bets/resolutions (avoid NULL text)
-- ============================================================
create or replace function public.get_activity(p_group uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if not is_member(p_group) then raise exception 'Not a member of this group'; end if;
  return coalesce((
    select jsonb_agg(e order by (e->>'at') desc)
    from (
      select jsonb_build_object('at', mem.joined_at, 'icon', '👋',
        'text', u.display_name || ' joined the group') as e
      from members mem join profiles u on u.id = mem.user_id where mem.group_id = p_group
      union all
      select jsonb_build_object('at', m.created_at, 'icon', '✨', 'market_id', m.id,
        'text', u.display_name || ' opened “' || m.question || '”')
      from markets m join profiles u on u.id = m.creator_id where m.group_id = p_group
      union all
      select jsonb_build_object('at', b.created_at,
        'icon', case when b.guess is not null then '🎯' when b.side = 'yes' then '🟢' else '🔴' end,
        'market_id', m.id,
        'text', u.display_name || ' bet ' || (b.amount_cents / 100.0)::text ||
                case when b.guess is not null then ' — guessed ' || b.guess::text
                     else ' on ' || upper(b.side) end
                || ' — “' || m.question || '”')
      from bets b join markets m on m.id = b.market_id join profiles u on u.id = b.user_id
      where m.group_id = p_group
      union all
      select jsonb_build_object('at', m.resolved_at, 'icon', '⚖️', 'market_id', m.id,
        'text', u.display_name || ' resolved “' || m.question || '” → ' ||
                case when m.status = 'void' then 'VOID (refunded)'
                     when m.kind = 'numeric' then coalesce(m.resolved_value::text, '?') || coalesce(' ' || m.metric, '')
                     else upper(m.resolution) end)
      from markets m join profiles u on u.id = m.resolved_by
      where m.group_id = p_group and m.resolved_at is not null
    ) events(e) ), '[]'::jsonb);
end $function$;
