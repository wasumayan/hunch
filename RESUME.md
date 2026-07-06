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

✅ **Custom SMTP configured (Gmail).** Verification emails send via `smtp.gmail.com` as
`Hunch <wasumayan@gmail.com>` (Gmail App Password stored in Supabase auth config; ~500/day, plenty for a
friend group), and the auth email rate limit was raised `2 → 30`/hr. Set 2026-07-05 via the Management
API; a test signup returned a queued confirmation email (HTTP 200). To rotate the password later: revoke
the app password at myaccount.google.com/apppasswords and re-run the SMTP PATCH with a new one.

**Branded confirmation email.** The signup confirmation email is customized with Hunch branding (subject
*"You're almost in — confirm your email 🔮"*). Source of truth: `supabase/email-templates/confirmation.html`.
To re-apply after a config reset, PATCH `mailer_subjects_confirmation` + `mailer_templates_confirmation_content`
on `/v1/projects/<ref>/config/auth` (keep the `{{ .ConfirmationURL }}` variable intact).

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

## Also live (2026-07-06)

- **Hot suggestions** — 18 curated current-events questions (crypto/politics/macro/sports/tech, 3
  numeric) + an **auto-refresh** edge function (`refresh_suggestions`) that pulls Polymarket's top
  events daily via pg_cron (high-precision transform; secret-gated). See `HANDOFF.md` §7b.
- **Discover circles** — a "Circles buzzing right now" strip on home (cosmetic hype circles in
  `featured_groups`); "Request to join" records real interest in `featured_group_requests`. Read the
  waitlist with the query in `HANDOFF.md` §7b.
- **Private vs discoverable circles** — `groups.visibility` ('private' default / 'discoverable'). Real
  discoverable circles show in Discover with a genuine request-to-join → admin approves (`request_join_circle`
  / `resolve_join_request`; pending requests show to admins in the group view).
- **Friends + 1:1 bets** — Friends tab (`#/friends`): search by username, friend requests
  (`send_friend_request`/`respond_friend_request`, reciprocal auto-accept), friend invite links
  (invites 'friend' kind), and "Bet <friend>" → `bet_friend` creates a private 2-person "duo" circle
  (`groups.is_duo`, excluded from the main circles list) that reuses the whole engine.
- **AI event creation** — composer "Describe it" input → `draft_market` edge function (Anthropic Claude,
  `claude-haiku-4-5`) drafts question/kind/metric/close/details. verify_jwt + a signed-in-user check so
  the public key can't spend the LLM budget. **NEEDS ACTIVATION:** set the `ANTHROPIC_API_KEY` function
  secret (Supabase → Edge Functions → draft_market → Secrets, or via the Management API). Returns a
  graceful 503 until then.

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
