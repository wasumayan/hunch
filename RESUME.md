# Resume here — Hunch

Cross-machine handoff snapshot. Last updated 2026-07-05. Read this first, then `HANDOFF.md`.

## ✅ LIVE — deployed to Vercel, virality betting verified end-to-end

**Live URL: https://hunch-zeta.vercel.app** — renders correctly (Vercel serves real `text/html`;
the Supabase edge URL served HTML as `text/plain`, so it's abandoned as the frontend host).
Verified in a real browser on the live site: sign in → create circle → create a numeric market
(with social-post link) → place a guess → resolve → correct winner, Δ-to-truth, and payout; zero
console errors. Backend numeric-market migration applied + REST-verified (ledger nets to $0).

- **Redeploy after frontend edits:** from repo root, `npx vercel@latest deploy --prod --yes`
  (authed as `wasumayan`, project `hunch`). Not git-connected, so a GitHub push does NOT auto-deploy
  — either run that command or connect the repo in the Vercel dashboard for push-to-deploy.
### Onboarding — email verification required (by design)

Auth config (set 2026-07-05 via Management API): **Site URL** = `https://hunch-zeta.vercel.app`
(+ redirect allow-list), and **email confirmation ON** (`mailer_autoconfirm: false`) — new users must
click a verification link in their email before they can get in. The app already handles this (shows
"Check your inbox" + a Resend button), and the Site URL fix means the link now lands on the live app
(it previously pointed at `localhost:3000`, which is why onboarding was broken).

⚠️ **Reliability caveat — set up custom SMTP.** Supabase's built-in mailer is rate-limited to ~2–4
emails/hr and is meant for testing only; with verification required, that throttles real signups. Add
custom SMTP (e.g. Resend — free ~100/day) under Auth → SMTP Settings, or ask Claude to configure it via
the Management API given a Resend API key + a verified sender address.

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

## Why Vercel (resolved context)

The Supabase edge function serves the entry **HTML as `text/plain` on GET** (platform anti-phishing
downgrade on `*.supabase.co`) — proof: `HEAD`→`text/html`, `GET`→`text/plain`, while `app.js` GET is
fine. So the app never booted in a browser from the edge URL. The repo root is a plain static site
(`index.html` + `styles.css` + `app.js` + `config.js`), so hosting it on Vercel (which serves real
`text/html`) fixed it. Supabase remains the backend, unchanged.

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
