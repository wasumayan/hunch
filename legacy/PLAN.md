# GoonMarket — private prediction markets for the group chat

Kalshi/Polymarket mechanics × Splitwise social accounting, for a private circle of friends.
You create a group, friends join with an invite code, anyone can post a market
("Will Dev show up to the wedding on time?"), everyone bets play-money coins on YES or NO,
the creator resolves it, winners split the pot, and a Splitwise-style "Settle Up" tab tells
you who owes whom if your group chooses to give coins a real-money value.

---

## 1. Product design

### Core loop
1. **Create a group** ("The Goons"). Every member is seeded with a starting stack of coins (default 1,000).
2. **Post a market** — a binary YES/NO question with a close time.
3. **Bet** — anyone in the group stakes coins on YES or NO while the market is open. Prices move with the money.
4. **Resolve** — after close, the market creator (or a group admin) marks it YES, NO, or VOID.
5. **Payout** — winners split the entire pot proportionally to their stake.
6. **Track** — leaderboard, activity feed, and a Splitwise-style settle-up view.

### Betting mechanics: parimutuel pools
Real exchanges (Kalshi) use order books; Polymarket uses AMMs. Both are overkill and
confusing for 6 friends. **Parimutuel pools** are the right fit:

- Each market has a YES pool and a NO pool.
- **Implied price** (displayed Kalshi-style in ¢): `P(YES) = yesPool / (yesPool + noPool)`.
  Prices move live as friends bet — big favorites get expensive, longshots pay big.
- **Payout**: if YES wins, each YES bettor receives `stake × pot / yesPool` (their stake back
  plus a pro-rata share of the losing pool). Integer coins, floored.
- **Edge cases**: VOID refunds all stakes; if the winning side had zero bets, everyone is refunded.
- You can bet multiple times, and even both sides (hedging).

Why parimutuel: zero-sum and fair by construction, no liquidity/market-maker needed, trivially
explainable ("winners split the pot"), and odds still move like a real market.

### The Splitwise half
- Coins are a per-group ledger; every seed/bet/payout is a transaction row. Balance = sum.
- **Leaderboard**: balance, net P&L vs. seeded amount, W/L record.
- **Settle Up**: net P&L is zero-sum within a group. A greedy debt-simplification algorithm
  (same idea as Splitwise's "simplify debts") converts everyone's P&L into a minimal list of
  transfers — "Aryan pays Mayan $12.40". If the group sets a coin value (e.g. 100 coins = $1)
  amounts show in dollars; otherwise in coins. Purely informational — the app never moves money.
- **Top-ups**: admins can grant bonus coins to bail out a busted friend (tracked in the ledger).

### Resolution & trust model
Friends, not strangers — so keep it social: the market **creator or a group admin** resolves.
Early lock ("close betting now") and early resolve are allowed for events that finish ahead of
schedule. VOID is the escape hatch for ambiguous questions. Every resolution is attributed and
visible in the activity feed, which is all the accountability a friend group needs.

### Fun extras
- Comments/trash-talk thread on every market.
- Live-updating prices (page polls every few seconds).
- Payout preview in the bet slip: "Bet 100 on YES → win 230 if YES".
- Emoji identity per group + per member avatar colors.

## 2. Architecture

**Constraint-driven choice**: this machine had no Node/Python and the project lives in OneDrive
(where a `node_modules` tree is sync poison). So:

- **Portable Node.js 24** (zipped runtime in `%LOCALAPPDATA%\node-portable`, no admin, no installer).
- **Zero npm dependencies.** Server = `node:http`; database = `node:sqlite` (built into Node 24);
  auth crypto = `node:crypto` (scrypt + random tokens). Nothing to install, ever.
- **Vanilla ES-module SPA** frontend (hash router, fetch, no build step).

```
goon_kalshi/
├── server.js          # http server: static files + /api router
├── lib/
│   ├── db.js          # schema, connection, migrations
│   └── api.js         # all API route handlers (auth, groups, markets, bets…)
├── public/
│   ├── index.html
│   ├── style.css      # dark Kalshi-esque theme
│   └── app.js         # SPA: state, hash router, views, api client
├── data/goon.db       # SQLite (created on first run)
├── start.cmd          # double-click to run
└── README.md
```

### Data model (SQLite)
- `users` (id, username UNIQUE, display_name, pass_hash, salt, created_at)
- `sessions` (token PK, user_id, expires_at)
- `groups` (id, name, emoji, invite_code UNIQUE, currency_name, starting_balance, coin_value_cents NULL, created_by)
- `members` (group_id, user_id, role admin|member, joined_at)
- `markets` (id, group_id, creator_id, question, details, closes_at, status open|locked|resolved|void, resolution, resolved_by, resolved_at)
- `bets` (id, market_id, user_id, side yes|no, amount, created_at)
- `transactions` (id, group_id, user_id, amount signed, kind seed|bet|payout|refund|bonus, market_id NULL, created_at) — **balances are always derived**, never stored
- `comments` (id, market_id, user_id, body, created_at)

### API surface (JSON, Bearer token)
Auth: `POST /api/register | /api/login | /api/logout`, `GET /api/me`
Groups: `POST /api/groups`, `POST /api/groups/join`, `GET /api/groups`, `GET /api/groups/:id`,
`GET /api/groups/:id/activity`, `GET /api/groups/:id/settle`, `POST /api/groups/:id/bonus`
Markets: `POST /api/groups/:id/markets`, `GET /api/markets/:id`,
`POST /api/markets/:id/bets | /lock | /resolve | /comments`

### Security posture (friends-tier, but not sloppy)
scrypt password hashing with per-user salt + timing-safe compare; 30-day random session tokens;
every group/market route checks membership; bets validated server-side (balance, market open,
positive integer amount); path-traversal-safe static serving; SQLite transactions around
bet placement and resolution so money can't be created or destroyed.

## 3. Running it
- `start.cmd` (or `node server.js`) → http://localhost:8000
- Binds `0.0.0.0`, so friends on the same Wi-Fi join via `http://<your-LAN-IP>:8000`.
- For remote friends: Tailscale/ngrok, or deploy later (the app is a single process + one file DB, so it ports anywhere Node runs).

## 4. Build order
1. Runtime setup (portable Node) ✅
2. DB schema + server skeleton + auth
3. Groups & membership
4. Markets, betting engine, resolution/payouts
5. Leaderboard, activity, settle-up
6. Frontend SPA (auth → home → group → market)
7. End-to-end verification with multiple simulated users
