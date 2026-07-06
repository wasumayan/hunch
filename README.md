# hunch.

**Private prediction markets for your friend group.** Got a feeling? Put a little money on it.

**Live at: https://hunch-zeta.vercel.app**

The frontend is a plain static site (`index.html` + `styles.css` + `app.js` + `config.js`) hosted
on **Vercel**; redeploy after edits with `npx vercel@latest deploy --prod --yes` from the repo root.
Supabase is the backend (Postgres + Auth + RPCs). *Note: the old Supabase edge-function URL
(`/functions/v1/app`) can't host the frontend — the platform serves its HTML as `text/plain` on GET
— so Vercel is the frontend host. See `HANDOFF.md` §6.*

> One-time setup: in [Supabase Auth → URL Configuration](https://supabase.com/dashboard/project/esjantuavbshexzaoact/auth/url-configuration),
> set the Site URL to the live URL above so email-verification links land back on the app.

Kalshi-style YES/NO markets × Splitwise-style settle-up, built for circles of friends.

## Stack

- **Frontend**: static single-page app (no build step) — `index.html`, `app.js`, `styles.css` — deployed on **Vercel**
- **Backend**: **Supabase** (project `esjantuavbshexzaoact`, ap-southeast-1)
  - Postgres with **deny-by-default row-level security** — tables have no client policies except self-service profile rows; every read/write goes through permission-checked `SECURITY DEFINER` RPCs
  - Supabase Auth with email verification
  - All betting logic is atomic SQL (row locks around bet placement and resolution)

## How money works

- No deposits, no balances — Hunch is a scorekeeper, like Splitwise.
- Bets are **parimutuel**: every market has a YES pool and a NO pool; the price is the pool
  ratio (YES 63¢ = 63% of money on YES). Winners split the entire pot pro-rata.
- Each circle picks its currency (USD default; SGD, HKD, EUR, …) and an optional max bet.
- **Settle Up** nets everything into the fewest transfers, with one-tap Venmo / Cash App /
  PayPal links (amount prefilled) and Zelle copy for whoever is owed money.

## Rules encoded in the database

- If a market is **about you** (`subject`), you can resolve it but never bet on it.
- Resolution rights: market creator, the subject, or a circle admin.
- VOID refunds everyone; a market where nobody backed the winning side refunds everyone.
- **Community markets** can be opened beyond the circle, gated by **email domain**
  (e.g. `princeton.edu`) and/or a **profile tag** (e.g. `crypto`).
- **Invites** come in three flavors: whole app, a circle, or a single event
  (`/#/i/CODE`). Event invites grant access to just that market — not the host circle.

## Operations

- Migrations live in Supabase (`core_schema`, `access_helpers_and_write_rpcs`, `read_rpcs`,
  `seed_suggestions`, `fix_invite_code_generation`, `harden_function_surface`).
- Suggested events are rows in `public.suggestions` — add more anytime
  (`is_template = true` rows use `{name}` placeholders filled with circle members;
  `tag = 'princeton'` rows appear for circles whose members share that tag).
  A live news/X feed can be added later as a Supabase Edge Function that inserts rows here.
- `legacy/` holds the original local-only prototype (Node + SQLite). Not deployed.

## Local dev

Serve the root folder with any static server and open `localhost` — the app talks to the
live Supabase project defined in `config.js`.
