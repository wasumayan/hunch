# Hunch — Developer Handoff

Everything you (or an AI assistant on a fresh laptop) need to keep building Hunch.
Last updated: 2026-07-02.

---

## 1. What this is

**Hunch** (https://esjantuavbshexzaoact.supabase.co/functions/v1/app) is a private
prediction-market app for friend groups — Kalshi-style YES/NO markets, parimutuel payouts,
Splitwise-style settle-up in real dollars, deployed and live.

- **Frontend**: zero-build static SPA — `index.html`, `app.js`, `styles.css`, `config.js`
  (vanilla ES modules + `supabase-js` from the jsDelivr CDN; no npm install, no bundler).
- **Backend**: Supabase project **`esjantuavbshexzaoact`** (org *WasuIndustries*, region
  `ap-southeast-1`). ALL logic lives in Postgres.
- **Hosting**: the `app` Supabase Edge Function serves the frontend out of the
  `public.site_assets` table (rows: `index`, `app.js`). The repo is *also* a
  Vercel-ready static site (see §6).
- `legacy/` is the original local-only prototype (Node + SQLite). Ignore it; kept for reference.

## 2. Setting up a new laptop

1. Install **Git** and clone this repo.
2. Install **Node 22.5+** (only needed to run test scripts / a local static server — the
   app itself has zero dependencies). No admin rights? Use the portable zip from
   nodejs.org/dist, like the original machine does at `%LOCALAPPDATA%\node-portable`.
3. Get access to the Supabase project: log into supabase.com with the owner account
   (wasumayan) — dashboard: https://supabase.com/dashboard/project/esjantuavbshexzaoact
4. Local dev: serve the repo root with any static server (`npx serve`, `python -m http.server`,
   or `node legacy/server.js`-style one-liner) and open localhost — the app talks to the
   **live** Supabase backend defined in `config.js`. There is no separate staging DB; be
   deliberate, or create a Supabase branch/second project for experiments.

Secrets: there are none in this repo. `config.js` holds the URL + *publishable* anon key,
which is safe to expose by design — every query is enforced server-side by RLS and
permission-checked RPCs. Service-role keys live only in the Supabase dashboard; never
commit or bake them into anything client-side.

## 3. Backend architecture (the important part)

**Deny-by-default security.** Every table has RLS enabled. Most tables have **no**
policies — direct reads/writes are rejected. The only direct access: `profiles`
(read for authed users, self-update), `payment_handles` (self only), `suggestions` (read),
`site_assets` (public read). Everything else flows through `SECURITY DEFINER` functions
that validate permissions internally.

**Tables**: `profiles`, `payment_handles`, `groups`, `members`, `markets`, `market_guests`,
`bets`, `ledger` (append-only; a user's money position is always `SUM(amount_cents)`),
`comments`, `invites`, `suggestions`, `site_assets`.

**Write RPCs**: `create_group`, `create_invite`, `invite_preview` (also callable by anon —
powers the invite landing page), `redeem_invite`, `create_market`, `place_bet`,
`lock_market`, `resolve_market`, `post_comment`.

**Read RPCs** (jsonb, one per page): `get_home`, `get_group_detail`, `get_market_detail`,
`get_settle`, `get_community_feed`, `get_user_stats`, `get_activity`, `get_suggestions`.

**Money rules** (all enforced in SQL, all integer cents):
- Parimutuel: price = pool ratio; on resolve, winners split the whole pot pro-rata (floored).
- `void` refunds everyone; an empty winning pool also refunds everyone.
- `subject_user_id` (the person a market is about) can resolve/lock but **cannot bet**.
- Resolution rights: creator, subject, or group admin. Row locks (`FOR UPDATE`) make
  bet placement and resolution race-safe.
- "Settled net" counts only resolved/void markets; open stakes are shown as "in play".
- Community markets: `visibility='community'` + optional `gate_domain` (matched against
  the JWT email domain — `profiles.email_domain` is trigger-protected, not user-editable)
  and/or `gate_tag` (matched against `profiles.tags`). Market invites add `market_guests`
  rows that bypass gates for that one market only.

**Migrations** (in Supabase, chronological): `core_schema`,
`access_helpers_and_write_rpcs`, `read_rpcs`, `seed_suggestions`,
`fix_invite_code_generation`, `harden_function_surface`, `site_assets_table`.
Make schema changes as *new* migrations (dashboard SQL editor or MCP `apply_migration`).

**Gotchas learned the hard way**:
- Functions pin `search_path = public`, so pgcrypto helpers like `gen_random_bytes`
  (which live in the `extensions` schema) are NOT visible — use `md5(gen_random_uuid()::text)`.
- In JS, never plain-`String.replace()` content containing app code — `$'` in the
  replacement string is a special pattern and silently corrupts. Use a function replacement.
- `post_comment`/`lock_market` return `void` → PostgREST answers **204**, not 200.

## 4. Shipping frontend changes

The live site reads from `site_assets`, so a "deploy" is a SQL update:

1. Edit `index.html` / `styles.css` / `app.js` in the repo (keep the repo the source of truth).
2. Update the table — `index` row = full HTML with CSS inlined in `<style>` and
   `<script type="module" src="/functions/v1/app/app.js">`; `app.js` row = `config.js`
   consts + `app.js` minus its import of `./config.js`:
   ```sql
   update public.site_assets set content = $x$...new content...$x$, updated_at = now()
   where name = 'app.js';   -- dollar-quote; the content needs no escaping
   ```
3. The edge function caches per-instance (~few min TTL via instance recycling +
   `Cache-Control: max-age=60/300`). To force-refresh instantly, redeploy the `app`
   function (unchanged) or just wait a minute.

The `app` edge function itself (tiny, ~40 lines) only needs redeploying if you change
how serving works. Its source is reproduced at the bottom of this file.

## 5. Testing

Pattern used for the 64-check e2e suite (worth recreating in `tests/`):
- Create **pre-confirmed** users via SQL (bypasses email rate limits):
  insert into `auth.users` (with `crypt('pw', gen_salt('bf'))`, `email_confirmed_at = now()`,
  empty-string token columns) + a matching `auth.identities` row. The `on_auth_user_created`
  trigger auto-creates the profile.
- Drive everything through REST: `POST /auth/v1/token?grant_type=password` to sign in,
  `POST /rest/v1/rpc/<fn>` with `apikey` + `Authorization: Bearer` headers.
- Assert the security walls, not just happy paths: outsiders must get errors from RPCs and
  empty arrays from direct table reads; subjects must be blocked from betting; wrong
  domains/tags must be blocked from gated markets; payout math to the cent.
- **Always clean up**: delete invites → groups → test auth.users (in that FK order).

## 6. Deployment status & pending one-time setup

| Item | Status |
|---|---|
| Live app (Supabase edge hosting) | ✅ https://esjantuavbshexzaoact.supabase.co/functions/v1/app |
| Database, RLS, RPCs, seeds | ✅ applied, tested (64/64 e2e checks) |
| Supabase **Auth Site URL** | ⚠️ still `localhost:3000` — set it to the live URL at [Auth → URL Configuration](https://supabase.com/dashboard/project/esjantuavbshexzaoact/auth/url-configuration) so email-verification links land on the app |
| Custom SMTP | ⚠️ optional — built-in sender is rate-limited (~2–4 emails/hr); add SMTP before onboarding many friends at once |
| Vercel | ⏳ repo root is deploy-ready (`vercel.json`, `.vercelignore`); run `vercel login && vercel --prod`, then add the new URL to Supabase's auth redirect allowlist |
| Google OAuth / phone OTP | not configured (needs Google Cloud creds / Twilio in dashboard) |

## 7. Roadmap ideas (discussed, not built)

- **Live news / X API suggestions**: an edge function on a cron that inserts rows into
  `suggestions` (schema already supports it: `category`, `question`, `details`, `tag`).
- **Games** (poker / blackjack / UNO): real-time multiplayer — consider Supabase Realtime
  channels; ledger already supports arbitrary market-less entries if you add a `kind`.
- Multi-outcome (non-binary) markets; push notifications; PWA manifest for
  add-to-home-screen; market edit/delete; admin transfer.

## 8. Appendix: `app` edge function source

```ts
const BASE = 'https://esjantuavbshexzaoact.supabase.co';
const KEY = '<publishable anon key from config.js>';
const cache = new Map<string, { content: string; content_type: string }>();
async function asset(name: string) {
  const hit = cache.get(name);
  if (hit) return hit;
  const r = await fetch(`${BASE}/rest/v1/site_assets?name=eq.${encodeURIComponent(name)}&select=content,content_type`, { headers: { apikey: KEY } });
  if (!r.ok) return null;
  const rows = await r.json();
  if (!rows[0]) return null;
  cache.set(name, rows[0]);
  return rows[0];
}
Deno.serve(async (req: Request) => {
  const path = new URL(req.url).pathname;
  const name = path.endsWith('/app.js') ? 'app.js' : 'index';
  const a = await asset(name);
  if (!a) return new Response('Not found', { status: 404 });
  return new Response(a.content, {
    headers: {
      'Content-Type': a.content_type,
      'Cache-Control': name === 'index' ? 'public, max-age=60' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
  });
});
```
