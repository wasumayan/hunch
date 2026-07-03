// GoonMarket — private prediction markets for the group chat.

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');

// ---------- state ----------
let token = localStorage.getItem('gm_token') || null;
let me = JSON.parse(localStorage.getItem('gm_user') || 'null');
let pollTimer = null;

// ---------- api client ----------
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token) { signOut(false); }
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}
const get = (p) => api('GET', p);
const post = (p, b) => api('POST', p, b || {});

function signOut(callApi = true) {
  if (callApi) post('/api/logout').catch(() => {});
  token = null; me = null;
  localStorage.removeItem('gm_token');
  localStorage.removeItem('gm_user');
  location.hash = '#/';
  render();
}

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n).toLocaleString('en-US');

function cents(priceYes) { return Math.min(99, Math.max(1, Math.round(priceYes * 100))); }

function timeAgo(ts) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function timeUntil(ts) {
  const s = Math.floor((ts - Date.now()) / 1000);
  if (s <= 0) return 'closed';
  if (s < 60) return `${s}s left`;
  if (s < 3600) return `closes in ${Math.floor(s / 60)}m`;
  if (s < 86400) return `closes in ${Math.floor(s / 3600)}h`;
  return `closes in ${Math.floor(s / 86400)}d`;
}

const AVATAR_COLORS = ['#5b8cff', '#21c07a', '#f4536e', '#f5b942', '#a06bff', '#2ec5d3', '#ff8a5c', '#e35bd8'];
function avatar(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const color = AVATAR_COLORS[h % AVATAR_COLORS.length];
  return `<span class="avatar" style="background:${color}">${esc(String(name).trim()[0]?.toUpperCase() || '?')}</span>`;
}

let toastTimer = null;
function toast(msg, isErr = false) {
  toastEl.textContent = msg;
  toastEl.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = ''; }, 2600);
}

function statusTag(m) {
  if (m.status === 'void') return '<span class="status-tag st-void">Voided</span>';
  if (m.status === 'resolved') {
    return m.resolution === 'yes'
      ? '<span class="status-tag st-resolved-yes">✓ Yes</span>'
      : '<span class="status-tag st-resolved-no">✗ No</span>';
  }
  if (m.bettingOpen) return '<span class="status-tag st-open">Open</span>';
  return '<span class="status-tag st-closed">Awaiting result</span>';
}

// Modal helper: opens HTML, returns the modal element; closes on backdrop click.
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

function topbar() {
  return `
    <div class="topbar">
      <a class="brand" href="#/">Goon<span>Market</span> 🎲</a>
      <div class="who">
        ${me ? `${avatar(me.displayName)} <span>${esc(me.displayName)}</span>
          <button class="linkbtn" id="logoutBtn">Sign out</button>` : ''}
      </div>
    </div>`;
}
function wireTopbar() {
  document.getElementById('logoutBtn')?.addEventListener('click', () => signOut());
}

// Bind a form-like container: calls fn on button click, shows errors as toast.
function onClick(id, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', async () => {
    el.disabled = true;
    try { await fn(); } catch (err) { toast(err.message, true); }
    el.disabled = false;
  });
}

// ---------- views ----------

function authView() {
  let mode = 'login';
  const draw = () => {
    app.innerHTML = `
      <div class="auth-wrap">
        <div class="auth-hero">
          <div class="dice">🎲</div>
          <h1>Goon<span style="color:var(--green)">Market</span></h1>
          <p>Private prediction markets for the group chat.<br>Bet your friends. Settle up later.</p>
        </div>
        <div class="auth-toggle">
          <button id="tabLogin" class="${mode === 'login' ? 'on' : ''}">Sign in</button>
          <button id="tabRegister" class="${mode === 'register' ? 'on' : ''}">Create account</button>
        </div>
        <div class="card">
          <label>Username</label>
          <input id="username" autocomplete="username" placeholder="mayan">
          ${mode === 'register' ? `
            <label>Display name</label>
            <input id="displayName" placeholder="Mayan W">` : ''}
          <label>Password</label>
          <input id="password" type="password" autocomplete="${mode === 'register' ? 'new-password' : 'current-password'}" placeholder="••••••••">
          <div style="margin-top:18px">
            <button class="btn-primary btn-wide" id="go">${mode === 'login' ? 'Sign in' : 'Create account'}</button>
          </div>
        </div>
      </div>`;
    document.getElementById('tabLogin').onclick = () => { mode = 'login'; draw(); };
    document.getElementById('tabRegister').onclick = () => { mode = 'register'; draw(); };
    const submit = async () => {
      const body = {
        username: document.getElementById('username').value,
        password: document.getElementById('password').value,
      };
      if (mode === 'register') body.displayName = document.getElementById('displayName').value;
      const data = await post(mode === 'login' ? '/api/login' : '/api/register', body);
      token = data.token; me = data.user;
      localStorage.setItem('gm_token', token);
      localStorage.setItem('gm_user', JSON.stringify(me));
      render();
    };
    onClick('go', submit);
    app.querySelectorAll('input').forEach((i) => i.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('go').click();
    }));
  };
  draw();
}

async function homeView() {
  const { groups } = await get('/api/groups');
  app.innerHTML = `
    ${topbar()}
    <div class="spread" style="margin: 6px 0 16px">
      <h1 style="font-size:21px; font-weight:800">Your circles</h1>
      <div class="row">
        <button class="btn-ghost" id="joinBtn">Join</button>
        <button class="btn-primary" id="createBtn">+ New circle</button>
      </div>
    </div>
    <div class="stack">
      ${groups.length === 0 ? `
        <div class="empty">
          <div class="big">🃏</div>
          No circles yet. Create one and send your friends the invite code.
        </div>` : groups.map((g) => `
        <a class="group-card" href="#/g/${g.id}">
          <div class="card spread">
            <div class="row">
              <span class="group-emoji">${esc(g.emoji)}</span>
              <div>
                <div style="font-weight:700">${esc(g.name)}</div>
                <div class="faint">${g.memberCount} member${g.memberCount === 1 ? '' : 's'} · ${g.openMarkets} open market${g.openMarkets === 1 ? '' : 's'}</div>
              </div>
            </div>
            <span class="balance-chip">${fmt(g.balance)} ${esc(g.currencyName)}</span>
          </div>
        </a>`).join('')}
    </div>`;
  wireTopbar();

  onClick('createBtn', () => {
    openModal(`
      <h2>New circle</h2>
      <label>Name</label>
      <input id="gName" placeholder="The Goons" maxlength="40">
      <label>Emoji</label>
      <input id="gEmoji" placeholder="🎲" maxlength="8" value="🎲">
      <label>Currency name</label>
      <input id="gCurrency" placeholder="coins" value="coins" maxlength="20">
      <label>Starting stack per member</label>
      <input id="gStart" type="number" value="1000" min="1">
      <label>Real value per coin, in cents (optional)</label>
      <input id="gCents" type="number" placeholder="e.g. 1 → 100 coins = $1" min="0" step="0.1">
      <div class="faint" style="margin-top:6px">If set, the Settle Up tab shows who owes whom in real dollars. Leave blank for pure bragging rights.</div>
      <div style="margin-top:18px"><button class="btn-primary btn-wide" id="gGo">Create circle</button></div>
    `);
    onClick('gGo', async () => {
      const data = await post('/api/groups', {
        name: document.getElementById('gName').value,
        emoji: document.getElementById('gEmoji').value,
        currencyName: document.getElementById('gCurrency').value,
        startingBalance: document.getElementById('gStart').value === '' ? undefined : Number(document.getElementById('gStart').value),
        coinValueCents: document.getElementById('gCents').value === '' ? undefined : Number(document.getElementById('gCents').value),
      });
      closeModal();
      location.hash = `#/g/${data.id}`;
    });
  });

  onClick('joinBtn', () => {
    openModal(`
      <h2>Join a circle</h2>
      <label>Invite code</label>
      <input id="jCode" placeholder="K7XQ2M" style="text-transform:uppercase" maxlength="10">
      <div style="margin-top:18px"><button class="btn-primary btn-wide" id="jGo">Join</button></div>
    `);
    onClick('jGo', async () => {
      const data = await post('/api/groups/join', { inviteCode: document.getElementById('jCode').value });
      closeModal();
      toast(data.alreadyMember ? 'You are already in this circle' : 'Welcome in! You have been staked.');
      location.hash = `#/g/${data.id}`;
    });
  });
}

async function groupView(groupId, tab = 'markets') {
  const data = await get(`/api/groups/${groupId}`);
  const { group, markets, members, myBalance, myRole } = data;
  const open = markets.filter((m) => m.bettingOpen);
  const pending = markets.filter((m) => !m.bettingOpen && m.status !== 'resolved' && m.status !== 'void');
  const done = markets.filter((m) => m.status === 'resolved' || m.status === 'void');

  const marketCard = (m) => `
    <a class="market-card" href="#/m/${m.id}">
      <div class="card">
        <div class="spread" style="align-items:flex-start">
          <div class="mc-q">${esc(m.question)}</div>
          ${statusTag(m)}
        </div>
        <div class="price-pair">
          <div class="price-box price-yes"><small>YES</small>${cents(m.priceYes)}¢</div>
          <div class="price-box price-no"><small>NO</small>${100 - cents(m.priceYes)}¢</div>
        </div>
        <div class="mc-meta faint">
          <span>💰 ${fmt(m.volume)} ${esc(group.currencyName)}</span>
          <span>👥 ${m.bettors}</span>
          <span>${m.bettingOpen ? '⏳ ' + timeUntil(m.closesAt) : ''}</span>
        </div>
      </div>
    </a>`;

  const tabContent = {
    markets: () => `
      ${open.length + pending.length + done.length === 0 ? `
        <div class="empty"><div class="big">🔮</div>No markets yet. Ask a question your friends will fight about.</div>` : ''}
      ${open.length ? `<div class="section-title">Open</div><div class="stack">${open.map(marketCard).join('')}</div>` : ''}
      ${pending.length ? `<div class="section-title">Awaiting resolution</div><div class="stack">${pending.map(marketCard).join('')}</div>` : ''}
      ${done.length ? `<div class="section-title">Settled</div><div class="stack">${done.map(marketCard).join('')}</div>` : ''}`,

    leaderboard: () => `
      <div class="card">
        ${members.map((mem, i) => {
          const pnlCls = mem.pnl > 0 ? 'pnl-up' : mem.pnl < 0 ? 'pnl-down' : 'pnl-flat';
          const medal = ['🥇', '🥈', '🥉'][i];
          return `
          <div class="lb-row">
            <div class="lb-rank ${medal ? 'top' : ''}">${medal || i + 1}</div>
            ${avatar(mem.displayName)}
            <div style="flex:1">
              <div style="font-weight:700">${esc(mem.displayName)} ${mem.role === 'admin' ? '<span class="faint">· admin</span>' : ''}</div>
              <div class="faint">${mem.wins}W – ${mem.losses}L${mem.inPlay ? ` · 🔒 ${fmt(mem.inPlay)} in play` : ''}</div>
            </div>
            <div style="text-align:right">
              <div style="font-weight:800">${fmt(mem.balance)}</div>
              <div class="${pnlCls}" style="font-size:12.5px">${mem.pnl > 0 ? '+' : ''}${fmt(mem.pnl)}</div>
            </div>
            ${myRole === 'admin' ? `<button class="linkbtn topup" data-uid="${mem.id}" data-name="${esc(mem.displayName)}" title="Grant top-up">💰</button>` : ''}
          </div>`;
        }).join('')}
      </div>`,

    activity: () => `<div class="card" id="activityBox"><div class="muted">Loading…</div></div>`,

    settle: () => `<div id="settleBox"><div class="muted">Loading…</div></div>`,
  };

  app.innerHTML = `
    ${topbar()}
    <div class="group-head">
      <div class="spread">
        <div class="row">
          <span class="group-emoji">${esc(group.emoji)}</span>
          <h1>${esc(group.name)}</h1>
        </div>
        <span class="balance-chip">You: ${fmt(myBalance)} ${esc(group.currencyName)}</span>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="invite-pill" id="invitePill">Invite code: <b>${esc(group.inviteCode)}</b> 📋</button>
        <button class="btn-primary" id="newMarketBtn" style="margin-left:auto">+ New market</button>
      </div>
    </div>
    <div class="tabs">
      ${['markets', 'leaderboard', 'activity', 'settle'].map((t) => `
        <button data-tab="${t}" class="${tab === t ? 'on' : ''}">
          ${{ markets: 'Markets', leaderboard: 'Leaderboard', activity: 'Activity', settle: 'Settle Up' }[t]}
        </button>`).join('')}
    </div>
    <div id="tabBody">${tabContent[tab]()}</div>`;

  wireTopbar();
  app.querySelectorAll('.tabs button').forEach((b) => {
    b.onclick = () => groupView(groupId, b.dataset.tab);
  });

  document.getElementById('invitePill').onclick = async () => {
    try {
      await navigator.clipboard.writeText(group.inviteCode);
      toast('Invite code copied — send it to your friends');
    } catch {
      toast(`Invite code: ${group.inviteCode}`);
    }
  };

  onClick('newMarketBtn', () => {
    const dflt = new Date(Date.now() + 24 * 3600 * 1000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    openModal(`
      <h2>New market</h2>
      <label>Question (must resolve YES or NO)</label>
      <input id="mQ" placeholder="Will Dev be late to dinner on Friday?" maxlength="140">
      <label>Resolution criteria (optional, settle arguments now)</label>
      <textarea id="mD" rows="3" placeholder="Late = arrives after 8:15pm by Aryan's phone clock."></textarea>
      <label>Betting closes</label>
      <input id="mC" type="datetime-local" value="${dflt}">
      <div style="margin-top:18px"><button class="btn-primary btn-wide" id="mGo">Open market</button></div>
    `);
    onClick('mGo', async () => {
      const closesAt = new Date(document.getElementById('mC').value).getTime();
      const data = await post(`/api/groups/${groupId}/markets`, {
        question: document.getElementById('mQ').value,
        details: document.getElementById('mD').value,
        closesAt,
      });
      closeModal();
      location.hash = `#/m/${data.id}`;
    });
  });

  app.querySelectorAll('.topup').forEach((b) => {
    b.onclick = () => {
      openModal(`
        <h2>Top up ${esc(b.dataset.name)}</h2>
        <label>Amount (${esc(group.currencyName)})</label>
        <input id="tAmt" type="number" value="500" min="1">
        <div style="margin-top:18px"><button class="btn-primary btn-wide" id="tGo">Grant</button></div>
      `);
      onClick('tGo', async () => {
        await post(`/api/groups/${groupId}/bonus`, { userId: Number(b.dataset.uid), amount: Number(document.getElementById('tAmt').value) });
        closeModal();
        toast('Top-up granted');
        groupView(groupId, 'leaderboard');
      });
    };
  });

  if (tab === 'activity') {
    const { events } = await get(`/api/groups/${groupId}/activity`);
    document.getElementById('activityBox').innerHTML = events.length === 0
      ? '<div class="empty">Nothing yet.</div>'
      : events.map((e) => `
        <div class="act-row">
          <span>${e.icon}</span>
          <span>${e.marketId ? `<a href="#/m/${e.marketId}" style="color:inherit">${esc(e.text)}</a>` : esc(e.text)}</span>
          <span class="act-time">${timeAgo(e.at)}</span>
        </div>`).join('');
  }

  if (tab === 'settle') {
    const s = await get(`/api/groups/${groupId}/settle`);
    const money = (coins) => {
      if (!s.coinValueCents) return `${fmt(coins)} ${esc(s.currencyName)}`;
      const v = (coins * s.coinValueCents) / 100;
      return `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`;
    };
    document.getElementById('settleBox').innerHTML = `
      <div class="card">
        <div class="section-title" style="margin-top:0">Net winnings</div>
        ${s.pnl.map((p) => `
          <div class="pos-row">
            <div class="row">${avatar(p.name)} <b>${esc(p.name)}</b></div>
            <span class="${p.pnl > 0 ? 'pnl-up' : p.pnl < 0 ? 'pnl-down' : 'pnl-flat'}">${p.pnl > 0 ? '+' : ''}${money(p.pnl)}</span>
          </div>`).join('')}
      </div>
      <div class="section-title">Simplest way to settle ${s.coinValueCents ? '(real money)' : ''}</div>
      <div class="card">
        ${s.transfers.length === 0 ? '<div class="empty">All square. Nobody owes anybody. 🤝</div>'
          : s.transfers.map((t) => `
          <div class="pos-row">
            <div class="row">${avatar(t.from)} <span><b>${esc(t.from)}</b> pays <b>${esc(t.to)}</b></span></div>
            <b>${money(t.coins)}</b>
          </div>`).join('')}
        ${s.coinValueCents ? '<div class="faint" style="margin-top:10px">GoonMarket only keeps score — settle in cash, Venmo, or dignity.</div>' : ''}
      </div>`;
  }
}

async function marketView(marketId) {
  const data = await get(`/api/markets/${marketId}`);
  const { market: m, positions, payouts, comments, canResolve, myBalance, currencyName } = data;
  const pYes = cents(m.priceYes);
  const myPos = positions.filter((p) => p.userId === me.id);

  // preserve bet-slip state across polling re-renders
  const prevSide = app.querySelector('.side-toggle .on')?.dataset.side || 'yes';
  const prevAmt = document.getElementById('betAmt')?.value || '';

  const banner = m.status === 'resolved'
    ? `<div class="banner ${m.resolution}">Resolved ${m.resolution.toUpperCase()} by ${esc(m.resolvedByName)} · pot was ${fmt(m.volume)} ${esc(currencyName)}</div>`
    : m.status === 'void'
      ? `<div class="banner void">Voided by ${esc(m.resolvedByName)} — all bets refunded</div>`
      : '';

  app.innerHTML = `
    ${topbar()}
    <a href="#/g/${m.groupId}" class="muted">← Back to circle</a>
    <div style="margin-top:14px" class="spread">
      <h1 style="font-size:21px; font-weight:800; line-height:1.3">${esc(m.question)}</h1>
      ${statusTag(m)}
    </div>
    ${m.details ? `<p class="muted" style="margin-top:8px">${esc(m.details)}</p>` : ''}
    <div class="faint" style="margin-top:8px">
      by ${esc(m.creatorName)} · ${m.bettingOpen ? timeUntil(m.closesAt) : m.status === 'open' || m.status === 'locked' ? 'betting closed' : ''}
      · volume ${fmt(m.volume)} ${esc(currencyName)}
    </div>

    <div class="big-price-bar"><div class="fill" style="width:${m.volume ? m.priceYes * 100 : 50}%"></div></div>
    <div class="spread" style="font-size:13px; font-weight:700">
      <span style="color:var(--green)">YES ${pYes}¢ · pool ${fmt(m.yesPool)}</span>
      <span style="color:var(--red)">pool ${fmt(m.noPool)} · NO ${100 - pYes}¢</span>
    </div>

    ${banner ? `<div style="margin-top:16px">${banner}</div>` : ''}

    ${m.bettingOpen ? `
      <div class="section-title">Place a bet</div>
      <div class="card">
        <div class="side-toggle">
          <button class="yes" data-side="yes"><small>YES</small>${pYes}¢</button>
          <button class="no" data-side="no"><small>NO</small>${100 - pYes}¢</button>
        </div>
        <label>Amount <span style="float:right; text-transform:none; letter-spacing:0">balance: ${fmt(myBalance)}</span></label>
        <input id="betAmt" type="number" min="1" placeholder="100">
        <div class="chips">
          ${[25, 100, 250].map((v) => `<button data-amt="${v}">${v}</button>`).join('')}
          <button data-amt="${myBalance}">All in 🫡</button>
        </div>
        <div class="payout-preview" id="preview"></div>
        <div style="margin-top:14px"><button class="btn-primary btn-wide" id="betGo">Place bet</button></div>
      </div>` : ''}

    ${m.status === 'open' && !m.bettingOpen || m.status === 'locked' ? `
      <div class="empty" style="padding:18px">Betting is closed — waiting on ${esc(m.creatorName)} to resolve.</div>` : ''}

    ${canResolve && m.status !== 'resolved' && m.status !== 'void' ? `
      <div class="section-title">Referee controls</div>
      <div class="resolve-box">
        <div class="muted">You created this market${canResolve ? '' : ''} — call the result. Winners split the whole pot.</div>
        <div class="resolve-btns">
          <button class="rb-yes" id="resYes">Resolve YES</button>
          <button class="rb-no" id="resNo">Resolve NO</button>
          <button class="rb-void" id="resVoid">Void</button>
          ${m.status === 'open' && m.bettingOpen ? '<button class="rb-void" id="lockBtn">Lock betting</button>' : ''}
        </div>
      </div>` : ''}

    ${myPos.length ? `
      <div class="section-title">Your position</div>
      <div class="card">
        ${myPos.map((p) => `
          <div class="pos-row">
            <span class="side-pill ${p.side}">${p.side.toUpperCase()}</span>
            <b>${fmt(p.amount)} ${esc(currencyName)}</b>
          </div>`).join('')}
      </div>` : ''}

    ${m.status === 'resolved' || m.status === 'void' ? `
      <div class="section-title">Payouts</div>
      <div class="card">
        ${payouts.length === 0 ? '<div class="empty">No winners this time.</div>' : payouts.map((p) => `
          <div class="pos-row">
            <div class="row">${avatar(p.name)} <b>${esc(p.name)}</b> ${p.kind === 'refund' ? '<span class="faint">refund</span>' : ''}</div>
            <span class="pnl-up">+${fmt(p.amount)}</span>
          </div>`).join('')}
      </div>` : ''}

    <div class="section-title">Positions</div>
    <div class="card">
      ${positions.length === 0 ? '<div class="empty">No bets yet — be the first degenerate.</div>' : positions.map((p) => `
        <div class="pos-row">
          <div class="row">${avatar(p.name)} <b>${esc(p.name)}</b></div>
          <div class="row"><span class="side-pill ${p.side}">${p.side.toUpperCase()}</span> <b>${fmt(p.amount)}</b></div>
        </div>`).join('')}
    </div>

    <div class="section-title">Trash talk</div>
    <div class="card">
      ${comments.map((c) => `
        <div class="comment">
          <div class="comment-head">${avatar(c.name)} <b>${esc(c.name)}</b> <span class="faint">${timeAgo(c.at)}</span></div>
          <div style="margin-top:4px; margin-left:38px">${esc(c.body)}</div>
        </div>`).join('')}
      <div class="row" style="margin-top:${comments.length ? '12px' : '0'}">
        <input id="commentBody" placeholder="Talk your talk…" maxlength="500">
        <button class="btn-ghost" id="commentGo">Send</button>
      </div>
    </div>`;

  wireTopbar();

  // --- bet slip ---
  if (m.bettingOpen) {
    let side = prevSide;
    const amtInput = document.getElementById('betAmt');
    amtInput.value = prevAmt;
    const preview = document.getElementById('preview');
    const drawSlip = () => {
      app.querySelectorAll('.side-toggle button').forEach((b) => b.classList.toggle('on', b.dataset.side === side));
      const a = Math.floor(Number(amtInput.value));
      if (!a || a <= 0) {
        preview.innerHTML = `<span class="muted">Enter an amount to see your potential payout.</span>`;
        return;
      }
      const pool = side === 'yes' ? m.yesPool : m.noPool;
      const pot = m.yesPool + m.noPool + a;
      const win = Math.floor((a * pot) / (pool + a));
      preview.innerHTML = `
        <div class="spread">
          <span class="muted">If ${side.toUpperCase()} → you get</span>
          <b style="color:${side === 'yes' ? 'var(--green)' : 'var(--red)'}">${fmt(win)} ${esc(currencyName)}</b>
        </div>
        <div class="spread" style="margin-top:2px">
          <span class="faint">profit +${fmt(win - a)}</span>
          <span class="faint">${(win / a).toFixed(2)}× payout</span>
        </div>`;
    };
    app.querySelectorAll('.side-toggle button').forEach((b) => {
      b.onclick = () => { side = b.dataset.side; drawSlip(); };
    });
    app.querySelectorAll('.chips button').forEach((b) => {
      b.onclick = () => { amtInput.value = b.dataset.amt; drawSlip(); };
    });
    amtInput.addEventListener('input', drawSlip);
    drawSlip();
    onClick('betGo', async () => {
      const amount = Math.floor(Number(amtInput.value));
      const res = await post(`/api/markets/${marketId}/bets`, { side, amount });
      toast(`Bet placed! ${side.toUpperCase()} for ${fmt(amount)} · balance ${fmt(res.newBalance)}`);
      marketView(marketId);
    });
  }

  // --- referee controls ---
  const resolveWith = (resolution) => async () => {
    const label = resolution === 'void' ? 'VOID this market and refund all bets' : `resolve this market ${resolution.toUpperCase()}`;
    if (!confirm(`Are you sure you want to ${label}? This pays everyone out and can't be undone.`)) return;
    await post(`/api/markets/${marketId}/resolve`, { resolution });
    toast(resolution === 'void' ? 'Market voided, bets refunded' : `Resolved ${resolution.toUpperCase()} — winners paid`);
    marketView(marketId);
  };
  onClick('resYes', resolveWith('yes'));
  onClick('resNo', resolveWith('no'));
  onClick('resVoid', resolveWith('void'));
  onClick('lockBtn', async () => {
    await post(`/api/markets/${marketId}/lock`);
    toast('Betting locked');
    marketView(marketId);
  });

  // --- comments ---
  const sendComment = async () => {
    const input = document.getElementById('commentBody');
    if (!input.value.trim()) return;
    await post(`/api/markets/${marketId}/comments`, { body: input.value });
    marketView(marketId);
  };
  onClick('commentGo', sendComment);
  document.getElementById('commentBody').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendComment().catch((err) => toast(err.message, true));
  });
}

// ---------- router ----------
async function render() {
  clearInterval(pollTimer);
  if (!token) { authView(); return; }
  const hash = location.hash || '#/';
  try {
    let match;
    if ((match = hash.match(/^#\/g\/(\d+)$/))) {
      await groupView(Number(match[1]));
      pollTimer = setInterval(() => { if (safeToRefresh()) groupView(Number(match[1]), currentTab()); }, 8000);
    } else if ((match = hash.match(/^#\/m\/(\d+)$/))) {
      await marketView(Number(match[1]));
      pollTimer = setInterval(() => { if (safeToRefresh()) marketView(Number(match[1])); }, 6000);
    } else {
      await homeView();
    }
  } catch (err) {
    if (!token) { authView(); return; }
    app.innerHTML = `${topbar()}<div class="empty"><div class="big">😵</div>${esc(err.message)}<div style="margin-top:14px"><a href="#/">← Home</a></div></div>`;
    wireTopbar();
  }
}

function currentTab() {
  return document.querySelector('.tabs button.on')?.dataset.tab || 'markets';
}

// Don't clobber the page while the user is typing or has a modal open.
function safeToRefresh() {
  if (document.querySelector('.modal-back')) return false;
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return false;
  const amt = document.getElementById('betAmt');
  if (amt && amt.value) return false;
  return true;
}

window.addEventListener('hashchange', render);
render();
