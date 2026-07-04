# Resume here — Hunch

Cross-machine handoff snapshot. Last updated 2026-07-03. Read this first, then `HANDOFF.md`.

## Where things stand right now

**Virality betting (numeric closest-guess markets + social-post attachment) is BUILT, deployed, and verified.**

- **Backend:** migration `virality_numeric_markets` is **already applied** to the live Supabase
  project (`esjantuavbshexzaoact`). **Do NOT re-run it.** SQL is committed at
  `supabase/migrations/20260703_virality_numeric_markets.sql`.
  - Adds `markets.kind` (`binary` | `numeric`), `post_url`, `metric`, `target_value`,
    `resolved_value`; `bets.guess` (+ `side` nullable, XOR check).
  - New RPCs: `place_guess`, `resolve_numeric`. `place_bet` / `resolve_market` guard the wrong kind.
  - Payout: winner-take-all closest guess, ties split pro-rata, **cent-exact** (ledger nets to $0).
  - Verified via REST e2e (real signed-in users): closest wins exact pot; 3-way tie → 134/133/133;
    ledger nets to zero; subject blocked from guessing; guards fire; void refunds. Test data cleaned
    up — DB is at 0 rows.
- **Frontend:** changes are in `app.js` (committed). Composer has a YES/NO ↔ Closest-number toggle
  + "attach a social post" (URL + metric); numeric markets get a guess slip, live pot/range, and a
  winner board with Δ-to-truth on resolve. Also pushed byte-perfect to the Supabase
  `site_assets.app.js` row (but see the blocker — that URL doesn't render in browsers anyway).
- **Docs:** design spec + phased roadmap in `docs/superpowers/specs/2026-07-03-*.md`.

## ⛔ Blocker — do this first (it's the only thing between us and a live site)

The Supabase edge function serves the entry **HTML as `text/plain` on GET** (platform anti-phishing
downgrade on `*.supabase.co`), so the app shows raw source and never boots in a browser. Backend is
100% fine. Proof: `HEAD`→`text/html`, `GET`→`text/plain`; `app.js` GET is fine.

**Fix = host the static frontend on Vercel** (repo root is already a working static site:
`index.html` + `styles.css` + `app.js` + `config.js`; Supabase stays the backend):

1. vercel.com → **Add New → Project** → import `wasumayan/hunch` → **Deploy** (no build step).
2. Supabase → **Auth → URL Configuration** → set **Site URL** to the new `*.vercel.app` URL and add
   it to the redirect allowlist. (This also fixes the old `localhost:3000` email-link issue.)
3. Verify: open the Vercel URL → create a circle → **+ Market → Closest number** → place a guess →
   resolve. Confirm it renders and pays out.

## Next up (roadmap, once hosting is live)

- **Phase 2 — KBC trivia** (ante → pot → ledger; no new money primitive).
- **Phase 3 — card games** (poker / blackjack / uno; need Supabase Realtime).
- See `docs/superpowers/specs/2026-07-03-hunch-roadmap.md`.

## Gotchas for whoever resumes

- Migration is applied — any further schema change must be a **new** migration.
- Browser-testing without polluting prod: create pre-confirmed users via SQL
  (`auth.users` + `auth.identities`, `extensions.crypt`/`gen_salt`), drive via REST or the Vercel
  URL, then `delete from auth.users where email like '%@hunchtest.dev'`. Pattern in `HANDOFF.md` §5.
- Redeploying the frontend to `site_assets` is moot for browser rendering (text/plain) — Vercel is
  the real host now.
