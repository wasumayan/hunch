// Hunch — private prediction markets for your friend group.
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
// Works at any mount path (Vercel root, edge function subpath, …)
const BASE_URL = location.origin + location.pathname;
const app = document.getElementById('app');
const toastEl = document.getElementById('toast');

let session = null;
let myProfile = null;
let pollTimer = null;

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SYM = { USD: '$', SGD: 'S$', HKD: 'HK$', EUR: '€', GBP: '£', INR: '₹', AUD: 'A$', CAD: 'C$', JPY: '¥', CNY: '¥' };
function money(cents, cur = 'USD', signed = false) {
  const sym = SYM[cur] || cur + ' ';
  const v = Math.abs(cents) / 100;
  const str = sym + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (cents < 0) return '-' + str;
  return (signed && cents > 0 ? '+' : '') + str;
}
const parseMoney = (v) => Math.round(parseFloat(v) * 100);
const fmtNum = (n) => Number(n ?? 0).toLocaleString('en-US');
const parseCount = (v) => { const n = Math.round(parseFloat(String(v).replace(/[, ]/g, ''))); return Number.isFinite(n) ? n : NaN; };

// Social-post link: derive a platform glyph + clean host from a URL.
function postMeta(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const map = { 'x.com': '𝕏', 'twitter.com': '𝕏', 'instagram.com': '📸', 'tiktok.com': '🎵', 'youtube.com': '▶️', 'youtu.be': '▶️', 'reddit.com': '👽', 'facebook.com': '📘', 'threads.net': '@', 'linkedin.com': 'in', 'twitch.tv': '🎮' };
    for (const k in map) { if (host === k || host.endsWith('.' + k)) return { icon: map[k], host }; }
    return { icon: '🔗', host };
  } catch { return { icon: '🔗', host: url }; }
}
function postLink(m) {
  if (!m.post_url) return '';
  const { icon, host } = postMeta(m.post_url);
  return `<a class="post-link" href="${esc(m.post_url)}" target="_blank" rel="noopener">${icon} ${esc(host)} ↗</a>`;
}

// Numeric-market styles, injected once (keeps the deployed index/CSS row untouched).
function injectNumStyles() {
  if (document.getElementById('hunch-num')) return;
  const s = document.createElement('style');
  s.id = 'hunch-num';
  s.textContent = `
    .num-grid{display:flex;gap:9px;margin-top:13px}
    .num-box{flex:1;text-align:center;border-radius:11px;padding:10px 6px;background:var(--panel)}
    .num-box .v{font-weight:700;font-size:17px;letter-spacing:-0.01em}
    .num-box small{display:block;font-size:10.5px;font-weight:700;letter-spacing:.08em;opacity:.65;text-transform:uppercase;margin-bottom:2px}
    .guess-pill{display:inline-flex;align-items:center;background:var(--coral-dim);color:var(--coral-dark);font-weight:700;border-radius:999px;padding:3px 11px;font-size:13px}
    .post-link{display:inline-flex;align-items:center;gap:6px;background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:5px 12px;font-size:12.5px;color:var(--ink)!important;text-decoration:none!important;margin-top:10px}
    .post-link:hover{border-color:var(--coral)}
    .ladder-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid var(--line-soft)}
    .ladder-row:last-child{border-bottom:none}
    .ladder-row.win{background:var(--yes-dim);margin:0 -14px;padding:10px 14px;border-radius:10px;border-bottom:none}
    .delta{font-size:12px;color:var(--faint);font-weight:600}`;
  document.head.appendChild(s);
}
injectNumStyles();

function cents100(priceYes) { return Math.min(99, Math.max(1, Math.round(priceYes * 100))); }

function timeAgo(ts) {
  const s = Math.max(1, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function timeUntil(ts) {
  const s = Math.floor((new Date(ts).getTime() - Date.now()) / 1000);
  if (s <= 0) return 'closed';
  if (s < 3600) return `closes in ${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `closes in ${Math.floor(s / 3600)}h`;
  return `closes in ${Math.floor(s / 86400)}d`;
}

const AVA = ['#d97757', '#3e7a54', '#5b7fa6', '#b98a2f', '#8a5ba6', '#4a9a9e', '#bc4749', '#7a8a3e'];
function avatar(name, sm = false) {
  let h = 0;
  for (const ch of String(name || '?')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return `<span class="avatar ${sm ? 'sm' : ''}" style="background:${AVA[h % AVA.length]}">${esc(String(name).trim()[0]?.toUpperCase() || '?')}</span>`;
}

let toastTimer = null;
function toast(msg, isErr = false) {
  toastEl.textContent = msg;
  toastEl.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = ''; }, 3000);
}

async function rpc(name, args = {}) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw new Error(error.message.replace(/^[A-Z0-9]+: /, ''));
  return data;
}

function openModal(html) {
  closeModal();
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal">${html}</div>`;
  back.addEventListener('click', (e) => { if (e.target === back) closeModal(); });
  document.body.appendChild(back);
  return back;
}
function closeModal() { document.querySelector('.modal-back')?.remove(); }

function onClick(id, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', async () => {
    el.disabled = true;
    try { await fn(); } catch (err) { toast(err.message, true); }
    el.disabled = false;
  });
}

function statusTag(m) {
  if (m.status === 'void') return '<span class="chip">Voided</span>';
  if (m.status === 'resolved') {
    if (m.kind === 'numeric') return `<span class="chip gold">🎯 ${esc(fmtNum(m.resolved_value))}${m.metric ? ' ' + esc(m.metric) : ''}</span>`;
    return m.resolution === 'yes' ? '<span class="chip yes">✓ YES</span>' : '<span class="chip no">✗ NO</span>';
  }
  if (m.betting_open) return '<span class="chip yes">● Open</span>';
  return '<span class="chip gold">Awaiting result</span>';
}

function topbar(active = '') {
  return `
    <div class="topbar">
      <a class="brand" href="#/">hunch<em>.</em></a>
      <div class="nav">
        <a href="#/" class="${active === 'home' ? 'on' : ''}">Circles</a>
        <a href="#/community" class="${active === 'community' ? 'on' : ''}">Community</a>
        ${myProfile ? `<a href="#/u/${myProfile.id}" class="${active === 'me' ? 'on' : ''}" title="Your profile" style="padding:4px 6px">${avatar(myProfile.display_name, true)}</a>` : ''}
        <button class="navlink" id="signOutBtn">Sign out</button>
      </div>
    </div>`;
}
function wireTopbar() {
  document.getElementById('signOutBtn')?.addEventListener('click', async () => {
    await sb.auth.signOut();
    location.hash = '#/';
  });
}

// ---------- invite plumbing ----------
const PENDING_INVITE = 'hunch_pending_invite';

async function redeemPending() {
  const code = localStorage.getItem(PENDING_INVITE);
  if (!code) return null;
  localStorage.removeItem(PENDING_INVITE);
  try {
    const r = await rpc('redeem_invite', { p_code: code });
    if (r.kind === 'group') { toast('Welcome to the circle!'); return `#/g/${r.group_id}`; }
    if (r.kind === 'market') { toast('You are in — place your bet.'); return `#/m/${r.market_id}`; }
    toast('Welcome to Hunch!');
  } catch (err) {
    toast(err.message, true);
  }
  return null;
}

function inviteLink(code) { return `${BASE_URL}#/i/${code}`; }

async function copyInvite(kind, opts = {}) {
  const code = await rpc('create_invite', { p_kind: kind, p_group: opts.group ?? null, p_market: opts.market ?? null });
  const link = inviteLink(code);
  try { await navigator.clipboard.writeText(link); toast('Invite link copied — send it to your friends'); }
  catch { openModal(`<h2>Invite link</h2><p class="muted" style="margin-top:10px; word-break:break-all">${esc(link)}</p>`); }
}

// ---------- views ----------

function authView(mode = 'signin') {
  clearInterval(pollTimer);
  const pending = localStorage.getItem(PENDING_INVITE);
  const draw = () => {
    app.innerHTML = `
      <div class="auth-wrap">
        <div class="hero">
          <div class="mark">hunch<em>.</em></div>
          <p>Got a feeling? Put a little money on it.<br>Private prediction markets for your friend group.</p>
        </div>
        ${pending ? `<div class="notice" style="margin-bottom:16px">🎟️ You have a pending invite — sign in or create an account to use it.</div>` : ''}
        <div class="seg">
          <button id="tabIn" class="${mode === 'signin' ? 'on' : ''}">Sign in</button>
          <button id="tabUp" class="${mode === 'signup' ? 'on' : ''}">Create account</button>
        </div>
        <div class="card">
          <label>Email</label>
          <input id="email" type="email" autocomplete="email" placeholder="you@example.com">
          ${mode === 'signup' ? `
            <label>Display name</label>
            <input id="displayName" placeholder="How friends see you" maxlength="40">
            <label>Username</label>
            <input id="username" placeholder="lowercase, letters & numbers" maxlength="20">` : ''}
          <label>Password</label>
          <input id="password" type="password" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}" placeholder="••••••••">
          <div style="margin-top:20px">
            <button class="btn-coral btn-wide" id="go">${mode === 'signin' ? 'Sign in' : 'Create account'}</button>
          </div>
          ${mode === 'signup' ? '<div class="faint" style="margin-top:12px">We’ll email you a verification link. Your email is never shown to other users — only its domain can be used for community gates you opt into.</div>' : ''}
        </div>
      </div>`;
    document.getElementById('tabIn').onclick = () => authView('signin');
    document.getElementById('tabUp').onclick = () => authView('signup');
    onClick('go', async () => {
      const email = document.getElementById('email').value.trim();
      const password = document.getElementById('password').value;
      if (!email || !password) throw new Error('Email and password are required');
      if (mode === 'signup') {
        const { data, error } = await sb.auth.signUp({
          email, password,
          options: {
            data: {
              username: document.getElementById('username').value.trim(),
              display_name: document.getElementById('displayName').value.trim(),
            },
            emailRedirectTo: BASE_URL,
          },
        });
        if (error) throw new Error(error.message);
        if (!data.session) { verifyNoticeView(email); return; }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) {
          if (/confirm/i.test(error.message)) { verifyNoticeView(email); return; }
          throw new Error(error.message);
        }
      }
    });
    app.querySelectorAll('input').forEach((i) => i.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('go').click();
    }));
  };
  draw();
}

function verifyNoticeView(email) {
  app.innerHTML = `
    <div class="auth-wrap">
      <div class="hero">
        <div class="mark">hunch<em>.</em></div>
      </div>
      <div class="card" style="text-align:center">
        <div style="font-size:36px">📬</div>
        <h2 style="margin-top:10px">Check your inbox</h2>
        <p class="muted" style="margin-top:8px">We sent a verification link to<br><b>${esc(email)}</b></p>
        <p class="faint" style="margin-top:10px">Click it, then come back here and sign in.</p>
        <div style="margin-top:18px" class="row">
          <button class="btn-ghost" id="resend" style="flex:1">Resend email</button>
          <button class="btn-primary" id="backIn" style="flex:1">Sign in</button>
        </div>
      </div>
    </div>`;
  onClick('resend', async () => {
    const { error } = await sb.auth.resend({ type: 'signup', email });
    if (error) throw new Error(error.message);
    toast('Verification email resent');
  });
  onClick('backIn', () => authView('signin'));
}

async function inviteLandingView(code) {
  clearInterval(pollTimer);
  const p = await rpc('invite_preview', { p_code: code });
  if (!p.valid) {
    app.innerHTML = `${session ? topbar() : ''}<div class="empty"><div class="big">🎟️</div>This invite link is invalid or expired.<div style="margin-top:14px"><a href="#/">← Home</a></div></div>`;
    wireTopbar();
    return;
  }
  if (session) {
    localStorage.setItem(PENDING_INVITE, code);
    const dest = await redeemPending();
    location.hash = dest || '#/';
    return;
  }
  localStorage.setItem(PENDING_INVITE, code);
  const what = p.kind === 'group'
    ? `join <b>${esc(p.group_emoji || '')} ${esc(p.group_name)}</b> (${p.member_count} member${p.member_count === 1 ? '' : 's'})`
    : p.kind === 'market'
      ? `bet on <b>“${esc(p.question)}”</b>`
      : `join <b>Hunch</b>`;
  app.innerHTML = `
    <div class="auth-wrap">
      <div class="hero">
        <div class="mark">hunch<em>.</em></div>
        <p>Got a feeling? Put a little money on it.</p>
      </div>
      <div class="card" style="text-align:center">
        <div style="font-size:36px">🎟️</div>
        <p style="margin-top:12px; font-size:16px">${esc(p.inviter || 'A friend')} invited you to ${what}</p>
        <div style="margin-top:18px">
          <button class="btn-coral btn-wide" id="accept">Create an account</button>
          <button class="linkbtn" id="haveOne" style="margin-top:10px">I already have an account</button>
        </div>
      </div>
    </div>`;
  onClick('accept', () => authView('signup'));
  onClick('haveOne', () => authView('signin'));
}

async function homeView() {
  const d = await rpc('get_home');
  myProfile = d.profile;
  const groups = d.groups || [];
  const guests = d.guest_markets || [];
  app.innerHTML = `
    ${topbar('home')}
    <div class="spread" style="margin: 4px 0 16px">
      <h1 style="font-size:22px">Your circles</h1>
      <div class="row">
        <button class="btn-ghost" id="inviteAppBtn" title="General invite to Hunch">Share app</button>
        <button class="btn-coral" id="createBtn">+ New circle</button>
      </div>
    </div>
    <div class="stack">
      ${groups.length === 0 ? `
        <div class="empty">
          <div class="big">🔮</div>
          No circles yet. Create one and invite your friends —<br>every argument is a market waiting to happen.
        </div>` : groups.map((g) => {
          const net = g.net_cents;
          const cls = net > 0 ? '' : net < 0 ? 'neg' : 'zero';
          return `
        <a class="tile" href="#/g/${g.id}">
          <div class="card spread">
            <div class="row">
              <span class="tile-emoji">${esc(g.emoji)}</span>
              <div>
                <div style="font-weight:600; font-size:15.5px">${esc(g.name)}</div>
                <div class="faint">${g.member_count} member${g.member_count === 1 ? '' : 's'} · ${g.open_markets} open · ${esc(g.currency)}</div>
              </div>
            </div>
            <div style="text-align:right">
              <span class="money-chip ${cls}">${money(net, g.currency, true)}</span>
              ${g.in_play_cents > 0 ? `<div class="faint" style="margin-top:4px">🔒 ${money(g.in_play_cents, g.currency)} in play</div>` : ''}
            </div>
          </div>
        </a>`;
        }).join('')}
    </div>
    ${guests.length ? `
      <div class="section-title">Events you're invited to</div>
      <div class="stack">
        ${guests.map((m) => `
          <a class="tile" href="#/m/${m.id}">
            <div class="card spread">
              <div>
                <div class="mc-q">${esc(m.question)}</div>
                <div class="faint" style="margin-top:4px">hosted by ${esc(m.group_name)}</div>
              </div>
              <span class="chip">${m.status === 'open' ? timeUntil(m.closes_at) : m.status}</span>
            </div>
          </a>`).join('')}
      </div>` : ''}
    <div class="section-title">Join with an invite</div>
    <div class="card row">
      <input id="joinCode" placeholder="Paste an invite code or link" style="flex:1">
      <button class="btn-primary" id="joinGo">Join</button>
    </div>`;
  wireTopbar();

  onClick('inviteAppBtn', () => copyInvite('app'));
  onClick('joinGo', async () => {
    let v = document.getElementById('joinCode').value.trim();
    const m = v.match(/#\/i\/([A-Za-z0-9]+)/);
    if (m) v = m[1];
    if (!v) throw new Error('Paste an invite code or link');
    const r = await rpc('redeem_invite', { p_code: v });
    location.hash = r.kind === 'market' ? `#/m/${r.market_id}` : r.kind === 'group' ? `#/g/${r.group_id}` : '#/';
    if (r.kind !== 'app') toast('You are in!');
  });

  onClick('createBtn', () => {
    openModal(`
      <h2>New circle</h2>
      <label>Name</label>
      <input id="gName" placeholder="The group chat, but with stakes" maxlength="40">
      <label>Emoji</label>
      <input id="gEmoji" value="🔮" maxlength="8">
      <label>Currency</label>
      <select id="gCur">
        ${['USD', 'SGD', 'HKD', 'EUR', 'GBP', 'INR', 'AUD', 'CAD', 'JPY'].map((c) => `<option ${c === 'USD' ? 'selected' : ''}>${c}</option>`).join('')}
      </select>
      <label>Max bet per wager (optional)</label>
      <input id="gMax" type="number" min="0.01" step="0.01" placeholder="e.g. 20.00 — leave blank for no cap">
      <div class="faint" style="margin-top:8px">Bets are tracked in real money. Nobody deposits anything — Hunch keeps score and Settle Up tells everyone who owes whom.</div>
      <div style="margin-top:20px"><button class="btn-coral btn-wide" id="gGo">Create circle</button></div>
    `);
    onClick('gGo', async () => {
      const maxRaw = document.getElementById('gMax').value;
      const gid = await rpc('create_group', {
        p_name: document.getElementById('gName').value,
        p_emoji: document.getElementById('gEmoji').value,
        p_currency: document.getElementById('gCur').value,
        p_max_bet_cents: maxRaw ? parseMoney(maxRaw) : null,
      });
      closeModal();
      location.hash = `#/g/${gid}`;
    });
  });
}

// ---------- group ----------

async function groupView(groupId, tab = 'markets') {
  const d = await rpc('get_group_detail', { p_group: groupId });
  const { group, members, markets } = d;
  const cur = group.currency;
  const open = markets.filter((m) => m.betting_open);
  const pending = markets.filter((m) => !m.betting_open && !['resolved', 'void'].includes(m.status));
  const done = markets.filter((m) => ['resolved', 'void'].includes(m.status));

  const marketCard = (m) => {
    const total = m.yes_pool + m.no_pool;
    const pY = total > 0 ? cents100(m.yes_pool / total) : 50;
    const body = m.kind === 'numeric'
      ? `<div class="num-grid">
          <div class="num-box"><small>Pot</small><span class="v">${money(m.pot_cents, cur)}</span></div>
          <div class="num-box"><small>Guesses</small><span class="v">${m.guess_count || 0}</span></div>
          <div class="num-box"><small>${m.guess_count ? 'Range' : 'Unit'}</small><span class="v">${m.guess_count ? esc(fmtNum(m.guess_min)) + '–' + esc(fmtNum(m.guess_max)) : esc(m.metric || '#')}</span></div>
        </div>`
      : `<div class="price-pair">
          <div class="price-box price-yes"><small>YES</small>${pY}¢</div>
          <div class="price-box price-no"><small>NO</small>${100 - pY}¢</div>
        </div>`;
    return `
    <a class="tile" href="#/m/${m.id}">
      <div class="card" style="padding:16px 18px">
        <div class="spread" style="align-items:flex-start">
          <div class="mc-q">${esc(m.question)}</div>
          ${statusTag(m)}
        </div>
        ${m.subject_name ? `<div class="faint" style="margin-top:4px">about ${esc(m.subject_name)} · they judge, they can't bet</div>` : ''}
        ${body}
        <div class="mc-meta faint">
          ${m.kind === 'numeric'
            ? `<span>🎯 closest guess${m.metric ? ' · ' + esc(m.metric) : ''}</span>`
            : `<span>${money(total, cur)} vol</span><span>👥 ${m.bettors}</span>`}
          ${m.post_url ? `<span>${postMeta(m.post_url).icon} post</span>` : ''}
          ${m.visibility === 'community' ? '<span class="chip coral" style="font-size:10.5px">community</span>' : ''}
          <span>${m.betting_open ? '⏳ ' + timeUntil(m.closes_at) : ''}</span>
        </div>
      </div>
    </a>`;
  };

  const lb = () => `
    <div class="card">
      ${members.map((mem, i) => {
        const pnl = mem.settled_net_cents + mem.in_play_cents;
        const cls = pnl > 0 ? 'pnl-up' : pnl < 0 ? 'pnl-down' : 'pnl-flat';
        const medal = ['🥇', '🥈', '🥉'][i];
        return `
        <div class="lb-row">
          <div class="lb-rank ${medal ? 'top' : ''}">${medal || i + 1}</div>
          <a href="#/u/${mem.id}" style="display:contents">${avatar(mem.display_name)}</a>
          <div style="flex:1">
            <a href="#/u/${mem.id}" style="font-weight:600; color:inherit">${esc(mem.display_name)}</a>
            ${mem.role === 'admin' ? '<span class="faint"> · admin</span>' : ''}
            <div class="faint">${mem.wins}W–${mem.losses}L${mem.in_play_cents ? ` · 🔒 ${money(mem.in_play_cents, cur)} in play` : ''}</div>
          </div>
          <span class="${cls}">${money(mem.settled_net_cents, cur, true)}</span>
        </div>`;
      }).join('')}
    </div>`;

  app.innerHTML = `
    ${topbar()}
    <div class="spread" style="margin-top:4px">
      <div class="row">
        <span class="tile-emoji">${esc(group.emoji)}</span>
        <div>
          <h1 style="font-size:21px">${esc(group.name)}</h1>
          <div class="faint">${members.length} members · ${esc(cur)}${group.max_bet_cents ? ` · max bet ${money(group.max_bet_cents, cur)}` : ''}</div>
        </div>
      </div>
      <div class="row">
        <button class="btn-ghost" id="inviteBtn">Invite</button>
        <button class="btn-coral" id="newMarketBtn">+ Market</button>
      </div>
    </div>
    <div class="tabs">
      ${[['markets', 'Markets'], ['leaderboard', 'Leaderboard'], ['suggested', 'Suggested'], ['activity', 'Activity'], ['settle', 'Settle Up']].map(([t, name]) => `
        <button data-tab="${t}" class="${tab === t ? 'on' : ''}">${name}</button>`).join('')}
    </div>
    <div id="tabBody">
      ${tab === 'markets' ? `
        ${markets.length === 0 ? '<div class="empty"><div class="big">💭</div>No markets yet — check the Suggested tab for inspiration.</div>' : ''}
        ${open.length ? `<div class="section-title" style="margin-top:6px">Open</div><div class="stack">${open.map(marketCard).join('')}</div>` : ''}
        ${pending.length ? `<div class="section-title">Awaiting resolution</div><div class="stack">${pending.map(marketCard).join('')}</div>` : ''}
        ${done.length ? `<div class="section-title">Settled</div><div class="stack">${done.map(marketCard).join('')}</div>` : ''}
      ` : tab === 'leaderboard' ? lb()
        : '<div class="empty">Loading…</div>'}
    </div>`;
  wireTopbar();

  app.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => groupView(groupId, b.dataset.tab); });

  onClick('inviteBtn', () => copyInvite('group', { group: groupId }));
  onClick('newMarketBtn', () => marketComposer(groupId, members));

  if (tab === 'suggested') renderSuggested(groupId, members);
  if (tab === 'activity') renderActivity(groupId);
  if (tab === 'settle') renderSettle(groupId);
}

async function renderActivity(groupId) {
  const events = await rpc('get_activity', { p_group: groupId });
  document.getElementById('tabBody').innerHTML = `
    <div class="card">
      ${(events || []).length === 0 ? '<div class="empty">Nothing yet.</div>' : events.slice(0, 60).map((e) => `
        <div class="act-row">
          <span>${e.icon}</span>
          <span>${e.market_id ? `<a href="#/m/${e.market_id}" style="color:inherit">${esc(e.text)}</a>` : esc(e.text)}</span>
          <span class="act-time">${timeAgo(e.at)}</span>
        </div>`).join('')}
    </div>`;
}

async function renderSettle(groupId) {
  const s = await rpc('get_settle', { p_group: groupId });
  const cur = s.currency;
  const rows = s.rows || [];
  // Splitwise-style greedy simplification: biggest debtor pays biggest creditor.
  const creditors = rows.filter((r) => r.net_cents > 0).map((r) => ({ ...r, left: r.net_cents })).sort((a, b) => b.left - a.left);
  const debtors = rows.filter((r) => r.net_cents < 0).map((r) => ({ ...r, left: -r.net_cents })).sort((a, b) => b.left - a.left);
  const transfers = [];
  let ci = 0, di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const amt = Math.min(creditors[ci].left, debtors[di].left);
    if (amt > 0) transfers.push({ from: debtors[di], to: creditors[ci], cents: amt });
    creditors[ci].left -= amt; debtors[di].left -= amt;
    if (creditors[ci].left === 0) ci++;
    if (debtors[di].left === 0) di++;
  }
  const payBtns = (t) => {
    const h = t.to.handles || {};
    const amt = (t.cents / 100).toFixed(2);
    const note = encodeURIComponent('Hunch settle-up');
    const btns = [];
    if (h.venmo) btns.push(`<a class="pay-btn" target="_blank" rel="noopener" href="https://venmo.com/${encodeURIComponent(h.venmo.replace(/^@/, ''))}?txn=pay&amount=${amt}&note=${note}">Venmo</a>`);
    if (h.cashapp) btns.push(`<a class="pay-btn" target="_blank" rel="noopener" href="https://cash.app/$${encodeURIComponent(h.cashapp.replace(/^\$/, ''))}/${amt}">Cash App</a>`);
    if (h.paypal) btns.push(`<a class="pay-btn" target="_blank" rel="noopener" href="https://paypal.me/${encodeURIComponent(h.paypal)}/${amt}">PayPal</a>`);
    if (h.zelle) btns.push(`<button class="pay-btn zelle-copy" data-z="${esc(h.zelle)}">Zelle ⧉</button>`);
    return btns.length ? btns.join('') : `<span class="faint">${esc(t.to.display_name)} hasn't added payment handles</span>`;
  };
  document.getElementById('tabBody').innerHTML = `
    <div class="card">
      <div class="section-title" style="margin-top:0">Net results (settled markets only)</div>
      ${rows.length === 0 ? '<div class="empty">Nothing settled yet.</div>' : rows.map((r) => `
        <div class="pos-row">
          <div class="row">${avatar(r.display_name)} <b>${esc(r.display_name)}</b></div>
          <span class="${r.net_cents > 0 ? 'pnl-up' : 'pnl-down'}">${money(r.net_cents, cur, true)}</span>
        </div>`).join('')}
    </div>
    <div class="section-title">Simplest way to settle</div>
    <div class="card">
      ${transfers.length === 0 ? '<div class="empty">All square. Nobody owes anybody. 🤝</div>' : transfers.map((t) => `
        <div class="pos-row" style="flex-wrap:wrap">
          <div class="row">${avatar(t.from.display_name)} <span><b>${esc(t.from.display_name)}</b> pays <b>${esc(t.to.display_name)}</b></span></div>
          <div class="row"><b>${money(t.cents, cur)}</b></div>
          <div class="pay-btns" style="width:100%; margin-top:6px; padding-left:42px">${payBtns(t)}</div>
        </div>`).join('')}
      ${transfers.length ? '<div class="faint" style="margin-top:12px">Hunch only keeps score — money moves on Venmo, Cash App, PayPal, or Zelle. Add your handles on your profile so friends can pay you in one tap.</div>' : ''}
    </div>`;
  document.querySelectorAll('.zelle-copy').forEach((b) => {
    b.onclick = async () => { await navigator.clipboard.writeText(b.dataset.z); toast(`Zelle: ${b.dataset.z} copied`); };
  });
}

async function renderSuggested(groupId, members) {
  const s = await rpc('get_suggestions', { p_group: groupId });
  const names = (s.member_names || []).filter((n) => n !== myProfile?.display_name);
  const pick = () => names.length ? names[Math.floor(Math.random() * names.length)] : 'someone';
  const fill = (q) => {
    const name = pick();
    return { q: q.replaceAll('{name}', name), name: q.includes('{name}') ? name : null };
  };
  const card = (item, filled) => `
    <div class="sug-card" data-q="${esc(filled?.q || item.question)}" data-d="${esc(item.details || '')}" data-subject="${esc(filled?.name || '')}">
      <div class="sug-cat">${esc(item.category)}${item.tag ? ` · matched your circle's “${esc(item.tag)}” tag` : ''}</div>
      <div class="sug-q">${esc(filled?.q || item.question)}</div>
    </div>`;
  document.getElementById('tabBody').innerHTML = `
    ${(s.tag_matched || []).length ? `<div class="section-title" style="margin-top:6px">Because of what you share</div>
      <div class="stack">${s.tag_matched.map((i) => card(i)).join('')}</div>` : ''}
    <div class="section-title" style="margin-top:${(s.tag_matched || []).length ? '26px' : '6px'}">About your friends <button class="linkbtn" id="reroll">↻ shuffle names</button></div>
    <div class="stack">${(s.templates || []).map((i) => card(i, fill(i.question))).join('')}</div>
    <div class="section-title">Happening in the world</div>
    <div class="stack">${(s.global || []).map((i) => card(i)).join('')}</div>
    <div class="faint" style="margin-top:18px">Tap any suggestion to open it in the market composer. Add tags to your profile (school, city, interests) and Hunch will surface events your circle shares. Live news feeds can be plugged in later via an edge function.</div>`;
  document.getElementById('reroll')?.addEventListener('click', () => renderSuggested(groupId, members));
  document.querySelectorAll('.sug-card').forEach((c) => {
    c.onclick = () => marketComposer(groupId, members, {
      question: c.dataset.q, details: c.dataset.d,
      subjectName: c.dataset.subject || null,
    });
  });
}

function marketComposer(groupId, members, prefill = {}) {
  const dflt = new Date(Date.now() + 24 * 3600 * 1000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const subjectId = prefill.subjectName ? (members.find((m) => m.display_name === prefill.subjectName)?.id || '') : '';
  let kind = prefill.kind === 'numeric' ? 'numeric' : 'binary';
  openModal(`
    <h2>New market</h2>
    <label>Market type</label>
    <div class="seg" id="mType">
      <button type="button" data-k="binary" class="${kind === 'binary' ? 'on' : ''}">YES / NO</button>
      <button type="button" data-k="numeric" class="${kind === 'numeric' ? 'on' : ''}">Closest number 🎯</button>
    </div>
    <label id="mQLabel"></label>
    <input id="mQ" maxlength="160" value="${esc(prefill.question || '')}">
    <label>Resolution criteria (optional — settle the argument now)</label>
    <textarea id="mD" rows="2" placeholder="What counts, who verifies, what's the deadline.">${esc(prefill.details || '')}</textarea>
    <label>📈 Attach a social post (optional)</label>
    <input id="mPost" maxlength="500" placeholder="https://x.com/… — link the post everyone's watching" value="${esc(prefill.postUrl || '')}">
    <label id="mMetricLabel"></label>
    <input id="mMetric" maxlength="24" placeholder="views" value="${esc(prefill.metric || '')}">
    <div id="mTargetBox">
      <label>Target number (optional) — reaching it resolves YES</label>
      <input id="mTarget" type="text" inputmode="numeric" placeholder="e.g. 50000">
    </div>
    <label>Betting closes</label>
    <input id="mC" type="datetime-local" value="${dflt}">
    <label>Who is this about? (optional)</label>
    <select id="mSubject">
      <option value="">Nobody in particular</option>
      ${members.map((m) => `<option value="${m.id}" ${m.id === subjectId ? 'selected' : ''}>${esc(m.display_name)}</option>`).join('')}
    </select>
    <div class="faint" style="margin-top:4px">The subject resolves the market but can't bet on it — perfect if it's their own post.</div>
    <label>Audience</label>
    <select id="mVis">
      <option value="group">This circle only</option>
      <option value="community">Open to the community</option>
    </select>
    <div id="gateBox" style="display:none">
      <label>Restrict to email domain (optional)</label>
      <input id="mDomain" placeholder="e.g. princeton.edu">
      <label>Restrict to profile tag (optional)</label>
      <input id="mTag" placeholder="e.g. princeton — matches user profile tags">
    </div>
    <div style="margin-top:20px"><button class="btn-coral btn-wide" id="mGo">Open market</button></div>
  `);
  const updateKindUI = () => {
    const numeric = kind === 'numeric';
    document.getElementById('mQLabel').textContent = numeric ? 'Question (players guess a number)' : 'Question (resolves YES or NO)';
    document.getElementById('mQ').placeholder = numeric ? 'How many views will Priya’s reel get by Sunday?' : 'Will Priya actually run the half marathon?';
    document.getElementById('mMetricLabel').textContent = numeric ? 'Unit — what are we counting? (e.g. views, likes)' : 'Unit / metric (optional)';
    document.getElementById('mTargetBox').style.display = numeric ? 'none' : 'block';
    document.querySelectorAll('#mType button').forEach((b) => b.classList.toggle('on', b.dataset.k === kind));
  };
  document.querySelectorAll('#mType button').forEach((b) => { b.onclick = () => { kind = b.dataset.k; updateKindUI(); }; });
  updateKindUI();
  document.getElementById('mVis').onchange = (e) => {
    document.getElementById('gateBox').style.display = e.target.value === 'community' ? 'block' : 'none';
  };
  onClick('mGo', async () => {
    const closesAt = new Date(document.getElementById('mC').value);
    if (isNaN(closesAt)) throw new Error('Pick a close time');
    const vis = document.getElementById('mVis').value;
    let target = null;
    if (kind === 'binary') {
      const t = document.getElementById('mTarget').value.trim();
      if (t) { target = parseCount(t); if (!Number.isFinite(target) || target < 0) throw new Error('Target must be a whole number'); }
    }
    const mid = await rpc('create_market', {
      p_group: groupId,
      p_question: document.getElementById('mQ').value,
      p_details: document.getElementById('mD').value,
      p_closes_at: closesAt.toISOString(),
      p_visibility: vis,
      p_gate_domain: vis === 'community' ? document.getElementById('mDomain').value.trim() || null : null,
      p_gate_tag: vis === 'community' ? document.getElementById('mTag').value.trim() || null : null,
      p_subject: document.getElementById('mSubject').value || null,
      p_kind: kind,
      p_post_url: document.getElementById('mPost').value.trim() || null,
      p_metric: document.getElementById('mMetric').value.trim() || null,
      p_target: target,
    });
    closeModal();
    location.hash = `#/m/${mid}`;
  });
}

// ---------- market ----------

async function marketView(marketId) {
  const d = await rpc('get_market_detail', { p_market: marketId });
  const m = d.market;
  if (m.kind === 'numeric') { numericMarketView(marketId, d); return; }
  const cur = d.currency;
  const total = m.yes_pool + m.no_pool;
  const pY = total > 0 ? cents100(m.yes_pool / total) : 50;
  const myPos = (d.positions || []).filter((p) => p.user_id === myProfile?.id);

  const prevSide = app.querySelector('.side-toggle .on')?.dataset.side || 'yes';
  const prevAmt = document.getElementById('betAmt')?.value || '';

  const banner = m.status === 'resolved'
    ? `<div class="banner ${m.resolution}">Resolved ${m.resolution.toUpperCase()} by ${esc(m.resolved_by_name)} — pot was ${money(total, cur)}</div>`
    : m.status === 'void'
      ? `<div class="banner void">Voided by ${esc(m.resolved_by_name)} — all bets refunded</div>`
      : d.is_subject
        ? `<div class="banner info">This market is about you. You settle the truth — but your money stays in your pocket.</div>`
        : '';

  app.innerHTML = `
    ${topbar()}
    ${d.am_member ? `<a href="#/g/${m.group_id}" class="muted">← ${esc(d.group_name)}</a>` : `<span class="muted">hosted by ${esc(d.group_name)}</span>`}
    <div style="margin-top:14px" class="spread">
      <h1 style="font-size:21px; line-height:1.35">${esc(m.question)}</h1>
      ${statusTag(m)}
    </div>
    ${m.details ? `<p class="muted" style="margin-top:8px">${esc(m.details)}</p>` : ''}
    <div class="row faint" style="margin-top:8px; flex-wrap:wrap">
      <span>by ${esc(m.creator_name)}</span>
      ${m.subject_name ? `<span class="chip coral">about ${esc(m.subject_name)}</span>` : ''}
      ${m.visibility === 'community' ? `<span class="chip">community${m.gate_domain ? ` · @${esc(m.gate_domain)}` : ''}${m.gate_tag ? ` · #${esc(m.gate_tag)}` : ''}</span>` : ''}
      <span>· ${m.betting_open ? timeUntil(m.closes_at) : ['resolved', 'void'].includes(m.status) ? '' : 'betting closed'}</span>
      <span>· ${money(total, cur)} vol</span>
    </div>

    <div class="price-bar"><div class="fill" style="width:${total ? (m.yes_pool / total) * 100 : 50}%"></div></div>
    <div class="spread" style="font-size:13px; font-weight:700">
      <span style="color:var(--yes)">YES ${pY}¢ · ${money(m.yes_pool, cur)}</span>
      <span style="color:var(--no)">${money(m.no_pool, cur)} · NO ${100 - pY}¢</span>
    </div>

    ${banner ? `<div style="margin-top:16px">${banner}</div>` : ''}

    ${m.betting_open && !d.is_subject ? `
      <div class="section-title">Place a bet</div>
      <div class="card">
        <div class="side-toggle">
          <button class="yes" data-side="yes"><small>YES</small>${pY}¢</button>
          <button class="no" data-side="no"><small>NO</small>${100 - pY}¢</button>
        </div>
        <label>Amount (${esc(cur)})${d.max_bet_cents ? `<span style="float:right; text-transform:none">max ${money(d.max_bet_cents, cur)}</span>` : ''}</label>
        <input id="betAmt" type="number" min="0.01" step="0.01" placeholder="10.00">
        <div class="chips-row">
          ${[5, 10, 25, 50].map((v) => `<button data-amt="${v}">${SYM[cur] || ''}${v}</button>`).join('')}
        </div>
        <div class="payout-preview" id="preview"></div>
        <div style="margin-top:14px"><button class="btn-coral btn-wide" id="betGo">Place bet</button></div>
      </div>` : ''}

    ${!m.betting_open && ['open', 'locked'].includes(m.status) ? `
      <div class="empty" style="padding:18px">Betting is closed — waiting on the result.</div>` : ''}

    ${d.can_resolve && !['resolved', 'void'].includes(m.status) ? `
      <div class="section-title">Referee controls</div>
      <div class="resolve-box">
        <div class="muted">${d.is_subject ? 'This one is about you — call it honestly.' : 'You can call the result.'} Winners split the whole pot.</div>
        <div class="resolve-btns">
          <button class="rb-yes" id="resYes">Resolve YES</button>
          <button class="rb-no" id="resNo">Resolve NO</button>
          <button class="rb-void" id="resVoid">Void</button>
          ${m.betting_open ? '<button class="rb-void" id="lockBtn">Lock betting</button>' : ''}
        </div>
      </div>` : ''}

    ${myPos.length ? `
      <div class="section-title">Your position</div>
      <div class="card">
        ${myPos.map((p) => `
          <div class="pos-row">
            <span class="chip ${p.side}">${p.side.toUpperCase()}</span>
            <b>${money(p.amount_cents, cur)}</b>
          </div>`).join('')}
      </div>` : ''}

    ${['resolved', 'void'].includes(m.status) && (d.payouts || []).length ? `
      <div class="section-title">Payouts</div>
      <div class="card">
        ${d.payouts.map((p) => `
          <div class="pos-row">
            <div class="row">${avatar(p.display_name)} <b>${esc(p.display_name)}</b> ${p.kind === 'refund' ? '<span class="faint">refund</span>' : ''}</div>
            <span class="pnl-up">+${money(p.amount_cents, cur)}</span>
          </div>`).join('')}
      </div>` : ''}

    <div class="section-title spread">Positions
      ${d.am_member || d.can_resolve ? `<button class="linkbtn" id="shareMarket">Share this event ↗</button>` : ''}
    </div>
    <div class="card">
      ${(d.positions || []).length === 0 ? '<div class="empty">No bets yet — someone has to have the first hunch.</div>' : d.positions.map((p) => `
        <div class="pos-row">
          <div class="row">${avatar(p.display_name)} <a href="#/u/${p.user_id}" style="font-weight:600; color:inherit">${esc(p.display_name)}</a></div>
          <div class="row"><span class="chip ${p.side}">${p.side.toUpperCase()}</span> <b>${money(p.amount_cents, cur)}</b></div>
        </div>`).join('')}
    </div>

    <div class="section-title">Trash talk</div>
    <div class="card">
      ${(d.comments || []).map((c) => `
        <div class="comment">
          <div class="row" style="align-items:baseline; gap:8px">${avatar(c.display_name, true)} <b style="font-size:13.5px">${esc(c.display_name)}</b> <span class="faint">${timeAgo(c.created_at)}</span></div>
          <div style="margin-top:4px; margin-left:34px">${esc(c.body)}</div>
        </div>`).join('')}
      <div class="row" style="margin-top:${(d.comments || []).length ? '12px' : '0'}">
        <input id="commentBody" placeholder="Talk your talk…" maxlength="500">
        <button class="btn-ghost" id="commentGo">Send</button>
      </div>
    </div>`;

  wireTopbar();

  onClick('shareMarket', () => copyInvite('market', { market: marketId }));

  if (m.betting_open && !d.is_subject) {
    let side = prevSide;
    const amtInput = document.getElementById('betAmt');
    amtInput.value = prevAmt;
    const preview = document.getElementById('preview');
    const drawSlip = () => {
      app.querySelectorAll('.side-toggle button').forEach((b) => b.classList.toggle('on', b.dataset.side === side));
      const c = parseMoney(amtInput.value);
      if (!c || c <= 0 || isNaN(c)) {
        preview.innerHTML = '<span class="muted">Enter an amount to see your potential payout.</span>';
        return;
      }
      const pool = side === 'yes' ? m.yes_pool : m.no_pool;
      const pot = total + c;
      const win = Math.floor((c * pot) / (pool + c));
      preview.innerHTML = `
        <div class="spread">
          <span class="muted">If ${side.toUpperCase()} → you receive</span>
          <b style="color:${side === 'yes' ? 'var(--yes)' : 'var(--no)'}">${money(win, cur)}</b>
        </div>
        <div class="spread" style="margin-top:2px">
          <span class="faint">profit ${money(win - c, cur, true)}</span>
          <span class="faint">${(win / c).toFixed(2)}× payout</span>
        </div>`;
    };
    app.querySelectorAll('.side-toggle button').forEach((b) => { b.onclick = () => { side = b.dataset.side; drawSlip(); }; });
    app.querySelectorAll('.chips-row button').forEach((b) => { b.onclick = () => { amtInput.value = b.dataset.amt; drawSlip(); }; });
    amtInput.addEventListener('input', drawSlip);
    drawSlip();
    onClick('betGo', async () => {
      const c = parseMoney(amtInput.value);
      if (!c || c <= 0) throw new Error('Enter a positive amount');
      await rpc('place_bet', { p_market: marketId, p_side: side, p_amount_cents: c });
      toast(`Bet placed — ${side.toUpperCase()} for ${money(c, cur)}`);
      marketView(marketId);
    });
  }

  const resolveWith = (outcome) => async () => {
    const label = outcome === 'void' ? 'VOID this market and refund every bet' : `resolve this market ${outcome.toUpperCase()}`;
    if (!confirm(`Are you sure you want to ${label}? This pays everyone out and can't be undone.`)) return;
    await rpc('resolve_market', { p_market: marketId, p_outcome: outcome });
    toast(outcome === 'void' ? 'Market voided, bets refunded' : `Resolved ${outcome.toUpperCase()} — winners paid`);
    marketView(marketId);
  };
  onClick('resYes', resolveWith('yes'));
  onClick('resNo', resolveWith('no'));
  onClick('resVoid', resolveWith('void'));
  onClick('lockBtn', async () => { await rpc('lock_market', { p_market: marketId }); toast('Betting locked'); marketView(marketId); });

  const sendComment = async () => {
    const input = document.getElementById('commentBody');
    if (!input.value.trim()) return;
    await rpc('post_comment', { p_market: marketId, p_body: input.value });
    marketView(marketId);
  };
  onClick('commentGo', sendComment);
  document.getElementById('commentBody').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendComment().catch((err) => toast(err.message, true));
  });
}

// ---------- numeric (closest-guess / virality) market ----------

function numericMarketView(marketId, d) {
  const m = d.market;
  const cur = d.currency;
  const metric = m.metric || '';
  const unit = metric ? ' ' + esc(metric) : '';
  const positions = (d.positions || []).slice();
  const myPos = positions.filter((p) => p.user_id === myProfile?.id);
  const resolved = m.status === 'resolved';
  const truth = m.resolved_value;

  const prevGuess = document.getElementById('guessVal')?.value || '';
  const prevStake = document.getElementById('guessStake')?.value || '';

  const board = positions.map((p) => ({ ...p, delta: resolved ? Math.abs(Number(p.guess) - Number(truth)) : null }));
  const minDelta = resolved && board.length ? Math.min(...board.map((p) => p.delta)) : null;
  if (resolved) board.sort((a, b) => a.delta - b.delta || b.amount_cents - a.amount_cents);
  else board.sort((a, b) => b.amount_cents - a.amount_cents);

  const banner = resolved
    ? `<div class="banner yes">Final: <b>${esc(fmtNum(truth))}${unit}</b> — closest guess took the ${money(m.pot_cents, cur)} pot · called by ${esc(m.resolved_by_name)}</div>`
    : m.status === 'void'
      ? `<div class="banner void">Voided by ${esc(m.resolved_by_name)} — all stakes refunded</div>`
      : d.is_subject
        ? `<div class="banner info">This market is about you. You call the final number — but your money stays in your pocket.</div>`
        : '';

  app.innerHTML = `
    ${topbar()}
    ${d.am_member ? `<a href="#/g/${m.group_id}" class="muted">← ${esc(d.group_name)}</a>` : `<span class="muted">hosted by ${esc(d.group_name)}</span>`}
    <div style="margin-top:14px" class="spread">
      <h1 style="font-size:21px; line-height:1.35">${esc(m.question)}</h1>
      ${statusTag(m)}
    </div>
    ${m.details ? `<p class="muted" style="margin-top:8px">${esc(m.details)}</p>` : ''}
    <div class="row faint" style="margin-top:8px; flex-wrap:wrap">
      <span>by ${esc(m.creator_name)}</span>
      <span class="chip coral">🎯 closest guess</span>
      ${m.subject_name ? `<span class="chip coral">about ${esc(m.subject_name)}</span>` : ''}
      ${m.visibility === 'community' ? `<span class="chip">community${m.gate_domain ? ` · @${esc(m.gate_domain)}` : ''}${m.gate_tag ? ` · #${esc(m.gate_tag)}` : ''}</span>` : ''}
      <span>· ${m.betting_open ? timeUntil(m.closes_at) : ['resolved', 'void'].includes(m.status) ? '' : 'betting closed'}</span>
    </div>
    ${postLink(m)}

    <div class="num-grid">
      <div class="num-box"><small>Pot</small><span class="v">${money(m.pot_cents, cur)}</span></div>
      <div class="num-box"><small>Guesses</small><span class="v">${m.guess_count || 0}</span></div>
      <div class="num-box"><small>${m.guess_count ? 'Range' : (metric ? 'Unit' : 'Guess')}</small><span class="v">${m.guess_count ? esc(fmtNum(m.guess_min)) + '–' + esc(fmtNum(m.guess_max)) : (metric ? esc(metric) : '—')}</span></div>
    </div>

    ${banner ? `<div style="margin-top:16px">${banner}</div>` : ''}

    ${m.betting_open && !d.is_subject ? `
      <div class="section-title">Make your guess</div>
      <div class="card">
        <label>Your guess${metric ? ` (${esc(metric)})` : ''}</label>
        <input id="guessVal" type="text" inputmode="numeric" placeholder="e.g. 42000">
        <label>Stake (${esc(cur)})${d.max_bet_cents ? `<span style="float:right; text-transform:none">max ${money(d.max_bet_cents, cur)}</span>` : ''}</label>
        <input id="guessStake" type="number" min="0.01" step="0.01" placeholder="10.00">
        <div class="chips-row">
          ${[5, 10, 25, 50].map((v) => `<button data-amt="${v}">${SYM[cur] || ''}${v}</button>`).join('')}
        </div>
        <div class="payout-preview" id="gpreview"></div>
        <div style="margin-top:14px"><button class="btn-coral btn-wide" id="guessGo">Lock in guess</button></div>
      </div>` : ''}

    ${!m.betting_open && ['open', 'locked'].includes(m.status) ? `
      <div class="empty" style="padding:18px">Betting is closed — waiting on the final number.</div>` : ''}

    ${d.can_resolve && !['resolved', 'void'].includes(m.status) ? `
      <div class="section-title">Referee controls</div>
      <div class="resolve-box">
        <div class="muted">${d.is_subject ? 'This one is about you — enter the honest final number.' : 'Enter the final number. Closest guess takes the whole pot.'}</div>
        <label>Final ${metric ? esc(metric) : 'value'}</label>
        <input id="finalVal" type="text" inputmode="numeric" placeholder="e.g. 47300">
        <div class="resolve-btns">
          <button class="rb-yes" id="resNum">Resolve with this number</button>
          <button class="rb-void" id="resVoid">Void</button>
          ${m.betting_open ? '<button class="rb-void" id="lockBtn">Lock betting</button>' : ''}
        </div>
      </div>` : ''}

    ${myPos.length ? `
      <div class="section-title">Your guess${myPos.length > 1 ? 'es' : ''}</div>
      <div class="card">
        ${myPos.map((p) => `
          <div class="pos-row">
            <span class="guess-pill">${esc(fmtNum(p.guess))}${unit}</span>
            <b>${money(p.amount_cents, cur)}</b>
          </div>`).join('')}
      </div>` : ''}

    ${['resolved', 'void'].includes(m.status) && (d.payouts || []).length ? `
      <div class="section-title">Payouts</div>
      <div class="card">
        ${d.payouts.map((p) => `
          <div class="pos-row">
            <div class="row">${avatar(p.display_name)} <b>${esc(p.display_name)}</b> ${p.kind === 'refund' ? '<span class="faint">refund</span>' : ''}</div>
            <span class="pnl-up">+${money(p.amount_cents, cur)}</span>
          </div>`).join('')}
      </div>` : ''}

    <div class="section-title spread">${resolved ? 'The board' : 'Guesses'}
      ${d.am_member || d.can_resolve ? `<button class="linkbtn" id="shareMarket">Share this event ↗</button>` : ''}
    </div>
    <div class="card">
      ${board.length === 0 ? '<div class="empty">No guesses yet — someone has to go first.</div>' : board.map((p) => `
        <div class="ladder-row ${resolved && p.delta === minDelta ? 'win' : ''}">
          <div class="row">${avatar(p.display_name, true)} <a href="#/u/${p.user_id}" style="font-weight:600; color:inherit">${esc(p.display_name)}</a>${resolved && p.delta === minDelta ? ' <span class="chip yes" style="font-size:10.5px">🎯 winner</span>' : ''}</div>
          <div class="row">
            ${resolved ? `<span class="delta">Δ ${esc(fmtNum(p.delta))}</span>` : ''}
            <span class="guess-pill">${esc(fmtNum(p.guess))}${unit}</span>
            <b>${money(p.amount_cents, cur)}</b>
          </div>
        </div>`).join('')}
    </div>

    <div class="section-title">Trash talk</div>
    <div class="card">
      ${(d.comments || []).map((c) => `
        <div class="comment">
          <div class="row" style="align-items:baseline; gap:8px">${avatar(c.display_name, true)} <b style="font-size:13.5px">${esc(c.display_name)}</b> <span class="faint">${timeAgo(c.created_at)}</span></div>
          <div style="margin-top:4px; margin-left:34px">${esc(c.body)}</div>
        </div>`).join('')}
      <div class="row" style="margin-top:${(d.comments || []).length ? '12px' : '0'}">
        <input id="commentBody" placeholder="Talk your talk…" maxlength="500">
        <button class="btn-ghost" id="commentGo">Send</button>
      </div>
    </div>`;

  wireTopbar();
  onClick('shareMarket', () => copyInvite('market', { market: marketId }));

  if (m.betting_open && !d.is_subject) {
    const gv = document.getElementById('guessVal');
    const gs = document.getElementById('guessStake');
    gv.value = prevGuess; gs.value = prevStake;
    const preview = document.getElementById('gpreview');
    const drawSlip = () => {
      const guess = parseCount(gv.value);
      const c = parseMoney(gs.value);
      if (!Number.isFinite(guess)) { preview.innerHTML = '<span class="muted">Enter your number to lock it in.</span>'; return; }
      const potAfter = m.pot_cents + (c > 0 ? c : 0);
      preview.innerHTML = `
        <div class="spread">
          <span class="muted">If you're closest to the final ${esc(metric || 'number')}</span>
          <b style="color:var(--yes)">you take ${money(potAfter, cur)}</b>
        </div>
        <div class="faint" style="margin-top:2px">Your guess: <b>${esc(fmtNum(guess))}${unit}</b>${c > 0 ? ` · stake ${money(c, cur)}` : ''} · winner takes the whole pot</div>`;
    };
    app.querySelectorAll('.chips-row button').forEach((b) => { b.onclick = () => { gs.value = b.dataset.amt; drawSlip(); }; });
    gv.addEventListener('input', drawSlip);
    gs.addEventListener('input', drawSlip);
    drawSlip();
    onClick('guessGo', async () => {
      const guess = parseCount(gv.value);
      const c = parseMoney(gs.value);
      if (!Number.isFinite(guess) || guess < 0) throw new Error('Enter a whole-number guess (0 or more)');
      if (!c || c <= 0) throw new Error('Enter a positive stake');
      await rpc('place_guess', { p_market: marketId, p_guess: guess, p_amount_cents: c });
      toast(`Guess locked — ${fmtNum(guess)}${unit} for ${money(c, cur)}`);
      marketView(marketId);
    });
  }

  const resolveNum = async () => {
    const fv = parseCount(document.getElementById('finalVal').value);
    if (!Number.isFinite(fv) || fv < 0) throw new Error('Enter the final number (0 or more)');
    if (!confirm(`Resolve with ${fmtNum(fv)}${unit}? Closest guess takes the whole pot — this can't be undone.`)) return;
    await rpc('resolve_numeric', { p_market: marketId, p_final_value: fv });
    toast(`Resolved at ${fmtNum(fv)}${unit} — closest guess paid`);
    marketView(marketId);
  };
  onClick('resNum', resolveNum);
  onClick('resVoid', async () => {
    if (!confirm('Void this market and refund every stake? This can\'t be undone.')) return;
    await rpc('resolve_market', { p_market: marketId, p_outcome: 'void' });
    toast('Market voided, stakes refunded');
    marketView(marketId);
  });
  onClick('lockBtn', async () => { await rpc('lock_market', { p_market: marketId }); toast('Betting locked'); marketView(marketId); });

  const sendComment = async () => {
    const input = document.getElementById('commentBody');
    if (!input.value.trim()) return;
    await rpc('post_comment', { p_market: marketId, p_body: input.value });
    marketView(marketId);
  };
  onClick('commentGo', sendComment);
  document.getElementById('commentBody').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendComment().catch((err) => toast(err.message, true));
  });
}

// ---------- community ----------

async function communityView() {
  const feed = await rpc('get_community_feed');
  app.innerHTML = `
    ${topbar('community')}
    <h1 style="font-size:22px; margin: 4px 0 6px">Community markets</h1>
    <p class="muted" style="margin-bottom:16px">Open events you qualify for — by invitation, email domain, or the tags on your profile.</p>
    <div class="stack">
      ${(feed || []).length === 0 ? `
        <div class="empty"><div class="big">🌏</div>Nothing you qualify for right now.<br>Add tags to <a href="#/u/${myProfile?.id}">your profile</a> — school, city, interests — to unlock gated events.</div>`
        : feed.map((m) => {
          const total = m.yes_pool + m.no_pool;
          const pY = total > 0 ? cents100(m.yes_pool / total) : 50;
          const body = m.kind === 'numeric'
            ? `<div class="num-grid">
                <div class="num-box"><small>Pot</small><span class="v">${money(m.pot_cents, m.currency)}</span></div>
                <div class="num-box"><small>Guesses</small><span class="v">${m.guess_count || 0}</span></div>
                <div class="num-box"><small>${m.guess_count ? 'Range' : 'Unit'}</small><span class="v">${m.guess_count ? esc(fmtNum(m.guess_min)) + '–' + esc(fmtNum(m.guess_max)) : esc(m.metric || '#')}</span></div>
              </div>`
            : `<div class="price-pair">
                <div class="price-box price-yes"><small>YES</small>${pY}¢</div>
                <div class="price-box price-no"><small>NO</small>${100 - pY}¢</div>
              </div>`;
          return `
          <a class="tile" href="#/m/${m.id}">
            <div class="card" style="padding:16px 18px">
              <div class="spread" style="align-items:flex-start">
                <div class="mc-q">${esc(m.question)}</div>
                <span class="chip yes">● Open</span>
              </div>
              ${body}
              <div class="mc-meta faint">
                <span>${esc(m.group_name)}</span>
                ${m.kind === 'numeric' ? `<span>🎯 closest guess${m.metric ? ' · ' + esc(m.metric) : ''}</span>` : `<span>${money(total, m.currency)} vol</span>`}
                ${m.post_url ? `<span>${postMeta(m.post_url).icon} post</span>` : ''}
                ${m.gate_domain ? `<span class="chip" style="font-size:10.5px">@${esc(m.gate_domain)}</span>` : ''}
                ${m.gate_tag ? `<span class="chip" style="font-size:10.5px">#${esc(m.gate_tag)}</span>` : ''}
                <span>⏳ ${timeUntil(m.closes_at)}</span>
              </div>
            </div>
          </a>`;
        }).join('')}
    </div>`;
  wireTopbar();
}

// ---------- profile ----------

async function profileView(userId) {
  const d = await rpc('get_user_stats', { p_user: userId });
  if (!d.profile) { app.innerHTML = `${topbar()}<div class="empty">Profile not found.</div>`; wireTopbar(); return; }
  const p = d.profile;
  const own = p.id === myProfile?.id;
  const s = d.per_market || { wins: 0, losses: 0, pushes: 0, biggest_win_cents: 0 };
  const played = s.wins + s.losses;
  const winRate = played ? Math.round((s.wins / played) * 100) : null;
  const streak = d.streak?.count ? `${d.streak.count}${d.streak.kind}` : '—';

  let handles = {};
  if (own) {
    const { data } = await sb.from('payment_handles').select('*').eq('user_id', p.id).maybeSingle();
    handles = data || {};
  }

  app.innerHTML = `
    ${topbar(own ? 'me' : '')}
    <div class="row" style="margin-top:6px">
      ${avatar(p.display_name)}
      <div>
        <h1 style="font-size:21px">${esc(p.display_name)}</h1>
        <div class="faint">@${esc(p.username)} · joined ${timeAgo(p.created_at).replace(' ago', '')} ago</div>
      </div>
    </div>
    ${p.bio ? `<p class="muted" style="margin-top:10px">${esc(p.bio)}</p>` : ''}
    ${(p.tags || []).length ? `<div class="row" style="margin-top:10px; flex-wrap:wrap">${p.tags.map((t) => `<span class="chip">#${esc(t)}</span>`).join('')}</div>` : ''}

    <div class="section-title">Track record</div>
    <div class="stat-grid">
      <div class="stat-box"><div class="v">${s.wins}–${s.losses}</div><div class="k">Record</div></div>
      <div class="stat-box"><div class="v">${winRate === null ? '—' : winRate + '%'}</div><div class="k">Win rate</div></div>
      <div class="stat-box"><div class="v">${streak}</div><div class="k">Streak</div></div>
      <div class="stat-box"><div class="v">${d.total_bets}</div><div class="k">Bets placed</div></div>
    </div>
    ${(d.by_currency || []).length ? `
      <div class="section-title">Net results</div>
      <div class="card">
        ${d.by_currency.map((c) => `
          <div class="pos-row">
            <span class="muted">${esc(c.currency)} · ${money(c.volume_cents || 0, c.currency)} wagered lifetime</span>
            <span class="${(c.net_cents || 0) >= 0 ? 'pnl-up' : 'pnl-down'}">${money(c.net_cents || 0, c.currency, true)}</span>
          </div>`).join('')}
        ${s.biggest_win_cents > 0 ? `<div class="faint" style="margin-top:8px">Biggest single win: ${money(s.biggest_win_cents, (d.by_currency[0] || {}).currency || 'USD')} 🏆</div>` : ''}
      </div>` : ''}

    ${own ? `
      <div class="section-title">Edit profile</div>
      <div class="card">
        <label>Display name</label>
        <input id="pName" value="${esc(p.display_name)}" maxlength="40">
        <label>Bio</label>
        <input id="pBio" value="${esc(p.bio || '')}" maxlength="300" placeholder="One-liner for your rivals">
        <label>Tags — school, city, interests (comma-separated)</label>
        <input id="pTags" value="${esc((p.tags || []).join(', '))}" placeholder="princeton, nyc, crypto, running">
        <div class="faint" style="margin-top:6px">Tags unlock community markets gated to people like you, and tune your circle's suggested events.</div>
        <div style="margin-top:16px"><button class="btn-primary btn-wide" id="pSave">Save profile</button></div>
      </div>
      <div class="section-title">Payment handles — get paid in one tap</div>
      <div class="card">
        <label>Venmo username</label>
        <input id="hVenmo" value="${esc(handles.venmo || '')}" placeholder="your-venmo">
        <label>Cash App cashtag</label>
        <input id="hCash" value="${esc(handles.cashapp || '')}" placeholder="$yourtag">
        <label>PayPal.me name</label>
        <input id="hPaypal" value="${esc(handles.paypal || '')}" placeholder="yourname">
        <label>Zelle (phone or email)</label>
        <input id="hZelle" value="${esc(handles.zelle || '')}" placeholder="+1 555 000 1234">
        <div class="faint" style="margin-top:6px">Shown only to people who settle up with you, only when you're owed money.</div>
        <div style="margin-top:16px"><button class="btn-primary btn-wide" id="hSave">Save payment handles</button></div>
      </div>` : ''}`;
  wireTopbar();

  if (own) {
    onClick('pSave', async () => {
      const tags = document.getElementById('pTags').value.split(',').map((t) => t.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')).filter(Boolean).slice(0, 12);
      const { error } = await sb.from('profiles').update({
        display_name: document.getElementById('pName').value.trim(),
        bio: document.getElementById('pBio').value.trim(),
        tags,
      }).eq('id', p.id);
      if (error) throw new Error(error.message);
      toast('Profile saved');
      profileView(userId);
    });
    onClick('hSave', async () => {
      const clean = (id) => document.getElementById(id).value.trim() || null;
      const { error } = await sb.from('payment_handles').upsert({
        user_id: p.id, venmo: clean('hVenmo'), cashapp: clean('hCash'), paypal: clean('hPaypal'), zelle: clean('hZelle'),
      });
      if (error) throw new Error(error.message);
      toast('Payment handles saved');
    });
  }
}

// ---------- router ----------

function safeToRefresh() {
  if (document.querySelector('.modal-back')) return false;
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return false;
  for (const id of ['betAmt', 'guessVal', 'guessStake', 'finalVal']) {
    const el = document.getElementById(id);
    if (el && el.value) return false;
  }
  return true;
}

async function render() {
  clearInterval(pollTimer);
  const hash = location.hash || '#/';
  const inviteMatch = hash.match(/^#\/i\/([A-Za-z0-9]+)$/);

  try {
    if (inviteMatch) { await inviteLandingView(inviteMatch[1].toUpperCase()); return; }
    if (!session) { authView('signin'); return; }
    if (!myProfile) {
      const home = await rpc('get_home');
      myProfile = home.profile;
    }
    // redeem any invite accepted before signing in
    const dest = await redeemPending();
    if (dest) { location.hash = dest; return; }

    let m;
    if ((m = hash.match(/^#\/g\/([0-9a-f-]{36})(?:\/(\w+))?$/))) {
      await groupView(m[1], m[2] || 'markets');
      pollTimer = setInterval(() => {
        if (safeToRefresh() && document.querySelector('.tabs button.on')?.dataset.tab === 'markets') groupView(m[1], 'markets');
      }, 12000);
    } else if ((m = hash.match(/^#\/m\/([0-9a-f-]{36})$/))) {
      await marketView(m[1]);
      pollTimer = setInterval(() => { if (safeToRefresh()) marketView(m[1]); }, 8000);
    } else if ((m = hash.match(/^#\/u\/([0-9a-f-]{36})$/))) {
      await profileView(m[1]);
    } else if (hash === '#/community') {
      await communityView();
    } else {
      await homeView();
    }
  } catch (err) {
    app.innerHTML = `${session ? topbar() : ''}<div class="empty"><div class="big">🫠</div>${esc(err.message)}<div style="margin-top:14px"><a href="#/">← Home</a></div></div>`;
    wireTopbar();
  }
}

window.addEventListener('hashchange', render);

sb.auth.onAuthStateChange((_event, s) => {
  const wasSignedIn = !!session;
  session = s;
  if (!s) myProfile = null;
  if (!!s !== wasSignedIn) render();
});

const { data: { session: s0 } } = await sb.auth.getSession();
session = s0;
render();
