# 🎲 GoonMarket

Private prediction markets for the group chat — **Kalshi × Splitwise for friends**.

Create a circle, invite friends with a code, post YES/NO markets about anything
("Will Dev be late to dinner?"), bet play-money coins, and let the winners split the pot.
A Splitwise-style **Settle Up** tab tells you who owes whom if your group gives coins
a real-dollar value.

## Run it

Double-click **`start.cmd`**, or:

```
node server.js
```

Then open **http://localhost:8000**.

- Friends on the same Wi-Fi can join at `http://<your-LAN-IP>:8000` (printed on startup).
- Remote friends: use [Tailscale](https://tailscale.com) or `ngrok http 8000`, or deploy —
  it's a single Node process with a single SQLite file, it runs anywhere Node 22.5+ runs.

No dependencies to install — the server uses only Node built-ins (including Node's
built-in SQLite). This machine uses a portable Node runtime at
`%LOCALAPPDATA%\node-portable` (no admin install needed).

## How the betting works

**Parimutuel pools** — the fairest system for a small friend group:

- Every market has a YES pool and a NO pool. The displayed price is the pool ratio
  (`YES 63¢` means 63% of the money is on YES).
- When the market resolves, **winners split the entire pot** proportionally to their stake.
  Bet 100 on YES against a pool of 400 YES / 500 NO → you get `100 × 900/500 = 180`... it's
  all shown live in the bet-slip payout preview.
- VOID refunds everyone. If nobody bet the winning side, everyone is refunded.
- The market **creator or a circle admin** resolves. Betting auto-closes at the close time,
  or the referee can lock it early.

## Features

- 🔐 Accounts with username/password (scrypt-hashed, session tokens)
- 👥 Circles with invite codes; every member is seeded a starting stack
- 📈 Live-moving Kalshi-style prices, payout preview, all-in button
- 🏆 Leaderboard with balance, net P&L, and W–L record
- 📜 Activity feed (joins, bets, resolutions)
- 🤝 Settle Up: Splitwise-style minimal-transfer settlement, in coins or real dollars
- 💰 Admin top-ups to bail out busted friends
- 🗑️ Trash-talk comment threads on every market

## Data

Everything lives in `data/goon.db` (SQLite). Back it up by copying the file.
Balances are never stored — they're derived from an append-only transaction ledger,
so the books always balance.
