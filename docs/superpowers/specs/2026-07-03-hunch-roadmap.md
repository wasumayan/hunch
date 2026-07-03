# Hunch — Feature Roadmap

Date: 2026-07-03
Status: agreed sequencing; only Phase 1 (virality) is specced in detail so far.

This roadmap captures "what to do next" for Hunch. Features are ordered by **how well
each maps onto Hunch's money model** — a parimutuel pool + append-only `ledger` +
Splitwise-style settle-up, with **no balances ever held**. That model is the tightest
constraint in the system, so features that ride it are cheap and safe; features that need
a new money primitive are heavier and come later.

---

## Phase 0 — Operational loose ends (hours, not days)

Clear the pending items from `HANDOFF.md` §6 before piling on features. Cheapest
high-value work; protects real onboarding.

- **Auth Site URL** — as of 2026-07-02 it was still `localhost:3000`, which means email
  verification links don't land on the live app and new friends can't finish signup.
  **Verify in the Supabase dashboard** (Auth → URL Configuration); if still wrong, fix
  first. This is a likely live bug.
- **Custom SMTP** — built-in sender is rate-limited (~2–4 emails/hr). Add SMTP before
  onboarding many friends at once.
- **Vercel deploy** — repo root is deploy-ready (`vercel.json`, `.vercelignore`); run
  `vercel login && vercel --prod`, then add the new URL to Supabase's auth redirect
  allowlist.

## Phase 1 — Virality betting ⭐ (specced)

Bet on whether a social post pops. Reuses the entire market / parimutuel / settle-up
engine. Adds two orthogonal, independently-useful primitives:

1. A new market `kind = 'numeric'` (closest-guess markets).
2. An optional social-post attachment (URL + metric) on any market.

Virality = the two combined. Resolution is **manual** (MVP); automated metric feeds are an
explicitly-optional later layer. See `2026-07-03-virality-betting-design.md`.

## Phase 2 — KBC / "Kaun Banega Crorepati" trivia night

A live multiple-choice ladder with lifelines, played inside a circle. Money fits cleanly:
everyone **antes into a pot, winner(s) take it, the result posts to the ledger** and flows
through Settle Up. Needs a question bank + a game-session state machine, but **no new money
primitive**. Proves the "game session on top of the ledger" pattern that card games reuse.

Open design questions (for its own spec): question sourcing (curated bank vs. member-authored
vs. AI-generated), single-winner vs. laddered payouts, lifelines, live vs. async play, and
whether `ledger.market_id` must become nullable for market-less game payouts (it is currently
`NOT NULL`).

## Phase 3 — Card games (one at a time, heaviest)

Poker, Blackjack, UNO. These **break the parimutuel model** — they need live, stateful
gameplay Hunch has never had, and **Supabase Realtime** (hidden cards must be dealt
server-side under deny-by-default RLS).

- **Poker** — per-player chip stacks, betting rounds (check/call/raise/fold), side pots,
  hand evaluation; settles to the ledger at session end.
- **Blackjack** — player-vs-dealer forces a design fork: *is the app the house, or a
  rotating human banker?* Must be decided before building.
- **UNO** — card-matching rules, turn order, special cards; no money primitive required
  (score-based) unless a buy-in is layered on.

**Gate before committing:** confirm Supabase Realtime is enabled and channel authorization
works under the current RLS. Extract a shared game-session abstraction only once a second
concrete game (after KBC) makes it a real third consumer — not before.

---

### Sequencing rationale

Virality and KBC ride the existing ledger, so they ship fast and can't destabilize
settle-up. Poker needs *live chip stacks* — a stateful thing the append-only ledger
deliberately doesn't do — which is why it's last. Build the cheap, high-reuse features
first; earn the Realtime + engine investment only when the game genuinely needs it.
