# Virality Betting — Design Spec

Date: 2026-07-03
Status: design approved in brainstorming; ready for implementation planning.
Roadmap context: Phase 1 of `2026-07-03-hunch-roadmap.md`.

## 1. Goal

Let a circle bet on whether a social-media post goes viral — e.g. "Will @priya's reel
clear 50k views by Sunday?" or "How many views will it have by Sunday? Closest guess wins."
Do this by riding Hunch's existing market / parimutuel / settle-up engine, adding the
smallest possible new surface.

## 2. Core model: two orthogonal primitives

Virality is **not** a new entity. It is the combination of two independently-useful pieces:

1. **A new market `kind = 'numeric'`** — closest-guess markets. Generally useful beyond
   social ("how many people show up to the party?").
2. **An optional social-post attachment** (URL + metric) on *any* market.

Combinations:
- **Threshold virality** = `binary` market + post + optional target ("Will it reach 50k views?").
  Reuses the existing YES/NO engine unchanged.
- **Closest-guess virality** = `numeric` market + post. New engine (this spec's main work).

Building the two primitives separately keeps each reusable and testable in isolation.

## 3. Decisions (locked in brainstorming)

| Decision | Choice |
|---|---|
| Mechanics supported | Both: YES/NO threshold **and** numeric closest-guess |
| Numeric payout | **Winner-take-all**: closest guess takes the pot; ties split pro-rata by stake |
| Money precision | Numeric engine **conserves to the cent** (flooring remainder distributed deterministically across the winning guesses — see §7) |
| Guess visibility | **Open** — guesses visible live, like the existing positions list |
| Resolution | **Manual** — resolver enters the final number. No API auto-resolve in this phase |
| Post preview | Link + platform icon derived from URL host. No oEmbed/rich embeds |

## 4. Non-goals (YAGNI)

- No automated metric feeds / social-API auto-resolution (paywalled, brittle) — later,
  optional layer only.
- No rich post embeds — a clean link with a derived platform icon is enough.
- No generic "game-session framework" — extracted later when card games make it a 3rd consumer.
- No change to the binary engine's existing behavior.

## 5. Schema changes (additive migration `virality_numeric_markets`)

Current tables are hard-wired to YES/NO: `bets.side` is `NOT NULL` check `yes|no`;
`markets.resolution` is `yes|no`; `ledger.kind` is `bet|payout|refund`. The `ledger` is
**not** touched structurally.

**`markets`** — add:
- `kind text NOT NULL DEFAULT 'binary'` CHECK (`kind IN ('binary','numeric')`)
- `post_url text` (nullable) CHECK (`post_url IS NULL OR length(post_url) <= 500`)
- `metric text` (nullable) CHECK (`metric IS NULL OR length(metric) <= 24`) — label, e.g. "views"
- `target_value bigint` (nullable) CHECK (`target_value IS NULL OR target_value >= 0`) — threshold sugar
- `resolved_value bigint` (nullable) — the "truth" number for a resolved numeric market

**`bets`** — add:
- `guess bigint` (nullable) CHECK (`guess IS NULL OR guess >= 0`)
- Make `side` nullable.
- Table CHECK: `(side IS NOT NULL AND guess IS NULL) OR (side IS NULL AND guess IS NOT NULL)`
  — a bet is exactly one of side-bet (binary) or guess-bet (numeric).

Notes:
- `markets.resolution` (yes/no) stays **NULL** for numeric markets; `resolved_value` +
  `status='resolved'` marks a numeric resolution.
- Existing rows default to `kind='binary'`, so all current data and the 64 e2e checks are
  unaffected.
- A bet's `kind` must match its market's `kind`; enforced in the `place_bet` RPC (cross-table,
  so not a table constraint).

## 6. RPC changes (extend, never replace)

### `create_market` — add params
- `p_kind text default 'binary'`, `p_post_url text default null`, `p_metric text default null`,
  `p_target bigint default null`.
- Validation: `p_kind` in (binary, numeric); numeric markets ignore `p_target` semantics for
  payout (kept only for display parity); `subject_user_id` still allowed (own-post case).
- All existing validation (access, closes_at, visibility, gates) unchanged.

### `place_bet` — branch by market kind
- Binary: unchanged (`p_side`, `p_amount_cents`).
- Numeric: new `p_guess bigint`; store `guess` + `amount_cents`, `side = NULL`. Reuse every
  existing guard: betting open, not the subject, member/guest access, `max_bet_cents` cap,
  `FOR UPDATE` lock. Reject `p_side` on numeric markets and `p_guess` on binary markets.
- Writes `ledger (kind='bet', amount_cents = -stake)` exactly as today.

### `resolve_market` — branch by market kind
- Binary: unchanged (`p_outcome in yes|no|void`).
- Numeric: new `p_final_value bigint` (and still supports void → refund all).
  Resolution rights unchanged (creator, subject, or group admin). Algorithm in §7.

## 7. Numeric resolution algorithm (winner-take-all, cent-exact)

Inside a single transaction with `SELECT ... FOR UPDATE` on the market's bets:

```
truth  := p_final_value
bets   := all bets for this market            -- each has (id, user_id, guess, amount_cents)
pot    := sum(bets.amount_cents)              -- always > 0 if any bets exist
if bets is empty: mark resolved, set resolved_value, return   -- nothing to pay

for each b in bets: dist_b := abs(b.guess - truth)
min_dist      := min(dist_b)
winners       := bets where dist_b = min_dist     -- ties allowed
winning_stake := sum(winners.amount_cents)

-- pro-rata split of the whole pot, floored
for each w in winners (ordered by bet id):
    payout_w := floor(pot * w.amount_cents / winning_stake)

-- conserve to the cent: hand the flooring remainder out 1c at a time, lowest bet id first
remainder := pot - sum(payout_w)              -- 0 .. (#winners - 1)
distribute remainder as +1c to the first `remainder` winners ordered by bet id

for each w in winners:
    insert ledger (market_id, w.user_id, kind='payout', amount_cents = +payout_w)

set markets.status='resolved', resolved_value=truth, resolved_by=caller, resolved_at=now()
```

Properties:
- `sum(payouts) == pot` exactly → the market's ledger nets to zero → Settle Up stays correct.
- Single guesser: winners = {them}, payout = pot → stake refunded, net zero.
- Void path reuses the existing refund logic (`kind='refund', +stake` for every bet).

(The existing **binary** engine floors pro-rata and may drop a cent or two; aligning it to
cent-exact is out of scope here and noted for a later cleanup.)

## 8. Read-RPC additions

`get_market_detail`, `get_group_detail`, `get_home`, `get_community_feed` return the new
fields where relevant:
- `kind`, `post_url`, `metric`, `target_value`, `resolved_value`.
- For numeric markets, each position/bet includes its `guess` (open visibility).
- Numeric markets expose `pot_cents`, `guess_count`, and `guess_min`/`guess_max` (spread) in
  place of YES/NO pools/prices.

## 9. Frontend (`app.js` / `index.html` / `styles.css`)

Vanilla, zero-build, same `rpc()` + render pattern.

**Composer (`marketComposer`)**
- Market-type segment: `YES / NO` ┃ `Closest number` → sets `p_kind`.
- Optional "📈 Attach a social post": URL input; `metric` label input (e.g. "views", "likes").
- YES/NO + post: optional `target` renders a chip / crisper question.
- Numeric: the `metric` label becomes the unit shown next to guesses.

**Market view (`marketView`) — numeric branch**
- Replace the price bar / cents with: pot size, guess count, guess spread (min–max), and a
  post link with platform icon.
- Bet slip: a number input ("Your guess — views") + amount input. Preview shows the current
  pot and "closest guess takes it" (no YES/NO odds).
- Positions list shows everyone's `guess` + stake (open).
- Referee controls: a number field to enter the final value + Resolve; Void unchanged.
- Resolved state: truth banner, a sorted Δ ladder with the winner highlighted, and the
  existing payouts section.

**Tiles (home / group / community)**
- Numeric markets show a `🔢 closest guess` chip, pot, and guess count instead of YES/NO cents.

**Reuse (no changes needed):** the `subject_user_id` rule (if it's *your* post, you're the
subject — you resolve but can't bet, killing the conflict of interest), community gating,
invites, comments, and settle-up all work as-is.

## 10. Edge cases

- Numeric market with zero bets → resolvable to record the truth; no payouts.
- All guesses equidistant from truth → all are winners, split pro-rata (conserves).
- Subject (own-post) is blocked from betting, same as binary.
- Guess bounds: `guess >= 0`, `<= 1e15` (bigint-safe); reject non-integers client-side.
- Betting closed / locked / already resolved → same guards as binary.
- A binary market may still carry a post + target and behaves exactly like today.

## 11. Testing (extend the e2e pattern from HANDOFF §5)

Add checks alongside the existing 64:
- Create a numeric market; place several guesses from pre-confirmed users.
- Resolve with a truth value; assert the closest guesser receives the **exact** pot.
- Tie case: two equidistant guesses split pro-rata; assert cent-exact conservation
  (market ledger sums to 0).
- Single-guesser refund-to-self nets zero.
- Subject blocked from placing a guess.
- Void refunds every guess.
- Regression: a binary market with a post + target still resolves YES/NO as before, and all
  prior e2e checks stay green.
- Security walls: outsiders get errors from the numeric RPCs and empty reads from tables.

## 12. Deploy

- Apply migration `virality_numeric_markets` (Supabase dashboard SQL editor or MCP
  `apply_migration`) — additive, safe on live data.
- Ship frontend via the `site_assets` dance (HANDOFF §4): update the `index` and `app.js`
  rows; edge function refreshes within its cache TTL.
- Keep the repo the source of truth; update `HANDOFF.md` roadmap + migration list.

## 13. Open questions

None blocking. Deferred by decision: automated metric resolution, rich embeds, and hiding
guesses until close (chose open).
