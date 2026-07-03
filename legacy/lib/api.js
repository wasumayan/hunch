import crypto from 'node:crypto';
import { db, tx, balance, pools } from './db.js';

const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new ApiError(400, msg);

// ---------- auth helpers ----------

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, Date.now() + SESSION_MS);
  return token;
}

function userFromRequest(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.username, u.display_name, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(token);
  if (!row || row.expires_at < Date.now()) return null;
  return { id: row.id, username: row.username, displayName: row.display_name };
}

function requireUser(req) {
  const user = userFromRequest(req);
  if (!user) throw new ApiError(401, 'Not signed in');
  return user;
}

function requireMember(groupId, userId) {
  const m = db.prepare('SELECT role FROM members WHERE group_id = ? AND user_id = ?').get(groupId, userId);
  if (!m) throw new ApiError(403, 'Not a member of this group');
  return m.role;
}

// ---------- misc helpers ----------

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function inviteCode() {
  const bytes = crypto.randomBytes(6);
  let code = '';
  for (const b of bytes) code += CODE_CHARS[b % CODE_CHARS.length];
  return code;
}

function seedMember(groupId, userId, amount) {
  db.prepare('INSERT INTO transactions (group_id, user_id, amount, kind, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(groupId, userId, amount, 'seed', Date.now());
}

function cleanStr(v, name, min, max) {
  if (typeof v !== 'string') throw bad(`${name} is required`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw bad(`${name} must be ${min}–${max} characters`);
  return s;
}

function cleanInt(v, name, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} must be a whole number between ${min} and ${max}`);
  return n;
}

function marketSummary(m) {
  const p = pools(m.id);
  const total = p.yes + p.no;
  return {
    id: m.id,
    groupId: m.group_id,
    creatorId: m.creator_id,
    creatorName: m.creator_name,
    question: m.question,
    details: m.details,
    closesAt: m.closes_at,
    createdAt: m.created_at,
    status: m.status,
    resolution: m.resolution,
    resolvedAt: m.resolved_at,
    resolvedByName: m.resolved_by_name || null,
    yesPool: p.yes,
    noPool: p.no,
    volume: total,
    priceYes: total > 0 ? p.yes / total : 0.5,
    bettingOpen: m.status === 'open' && m.closes_at > Date.now(),
    bettors: db.prepare('SELECT COUNT(DISTINCT user_id) AS c FROM bets WHERE market_id = ?').get(m.id).c,
  };
}

const MARKET_SELECT = `
  SELECT m.*, cu.display_name AS creator_name, ru.display_name AS resolved_by_name
  FROM markets m
  JOIN users cu ON cu.id = m.creator_id
  LEFT JOIN users ru ON ru.id = m.resolved_by
`;

function getMarket(id) {
  const m = db.prepare(`${MARKET_SELECT} WHERE m.id = ?`).get(id);
  if (!m) throw new ApiError(404, 'Market not found');
  return m;
}

/** Per-member stats for a group: balance, seeded, P&L, record. */
function memberStats(groupId) {
  const members = db.prepare(`
    SELECT u.id, u.display_name, mem.role, mem.joined_at,
      COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.group_id = mem.group_id AND t.user_id = u.id), 0) AS bal,
      COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.group_id = mem.group_id AND t.user_id = u.id AND t.kind IN ('seed','bonus')), 0) AS seeded,
      COALESCE((SELECT SUM(b.amount) FROM bets b JOIN markets mk ON mk.id = b.market_id
                WHERE b.user_id = u.id AND mk.group_id = mem.group_id AND mk.status IN ('open','locked')), 0) AS in_play
    FROM members mem JOIN users u ON u.id = mem.user_id
    WHERE mem.group_id = ?
  `).all(groupId);

  // W/L record: for each resolved market a user bet on, a win means they took more out than they put in.
  const records = db.prepare(`
    SELECT b.user_id,
      SUM(CASE WHEN COALESCE(payout.total, 0) > staked.total THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN COALESCE(payout.total, 0) < staked.total THEN 1 ELSE 0 END) AS losses
    FROM (SELECT DISTINCT market_id, user_id FROM bets) b
    JOIN markets m ON m.id = b.market_id AND m.status = 'resolved'
    JOIN (SELECT market_id, user_id, SUM(amount) AS total FROM bets GROUP BY market_id, user_id) staked
      ON staked.market_id = b.market_id AND staked.user_id = b.user_id
    LEFT JOIN (SELECT market_id, user_id, SUM(amount) AS total FROM transactions
               WHERE kind IN ('payout','refund') GROUP BY market_id, user_id) payout
      ON payout.market_id = b.market_id AND payout.user_id = b.user_id
    WHERE m.group_id = ?
    GROUP BY b.user_id
  `).all(groupId);
  const recordByUser = new Map(records.map((r) => [r.user_id, r]));

  return members.map((m) => {
    const rec = recordByUser.get(m.id) || { wins: 0, losses: 0 };
    return {
      id: m.id,
      displayName: m.display_name,
      role: m.role,
      joinedAt: m.joined_at,
      balance: m.bal,
      inPlay: m.in_play,
      // Open stakes count at face value so live bets don't read as losses.
      pnl: m.bal + m.in_play - m.seeded,
      wins: rec.wins ?? 0,
      losses: rec.losses ?? 0,
    };
  }).sort((a, b) => (b.balance + b.inPlay) - (a.balance + a.inPlay));
}

// ---------- route handlers ----------

const routes = [];
function route(method, pattern, handler) {
  const names = [];
  const regex = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '(\\d+)'; }) + '$');
  routes.push({ method, regex, names, handler });
}

// --- auth ---

route('POST', '/api/register', ({ body }) => {
  const username = cleanStr(body.username, 'Username', 3, 20);
  if (!/^[a-zA-Z0-9_]+$/.test(username)) throw bad('Username can only contain letters, numbers, and underscores');
  const displayName = cleanStr(body.displayName, 'Display name', 1, 30);
  const password = cleanStr(body.password, 'Password', 4, 100);
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) throw bad('That username is taken');
  const salt = crypto.randomBytes(16).toString('hex');
  const info = db.prepare('INSERT INTO users (username, display_name, pass_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(username, displayName, hashPassword(password, salt), salt, Date.now());
  const id = Number(info.lastInsertRowid);
  return { token: createSession(id), user: { id, username, displayName } };
});

route('POST', '/api/login', ({ body }) => {
  const username = cleanStr(body.username, 'Username', 1, 40);
  const password = cleanStr(body.password, 'Password', 1, 100);
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const fail = new ApiError(401, 'Wrong username or password');
  if (!u) throw fail;
  const expected = Buffer.from(u.pass_hash, 'hex');
  const actual = Buffer.from(hashPassword(password, u.salt), 'hex');
  if (!crypto.timingSafeEqual(expected, actual)) throw fail;
  return { token: createSession(u.id), user: { id: u.id, username: u.username, displayName: u.display_name } };
});

route('POST', '/api/logout', ({ req }) => {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) db.prepare('DELETE FROM sessions WHERE token = ?').run(header.slice(7));
  return { ok: true };
});

route('GET', '/api/me', ({ req }) => ({ user: requireUser(req) }));

// --- groups ---

route('POST', '/api/groups', ({ req, body }) => {
  const user = requireUser(req);
  const name = cleanStr(body.name, 'Group name', 1, 40);
  const emoji = typeof body.emoji === 'string' && body.emoji.trim() ? body.emoji.trim().slice(0, 8) : '🎲';
  const currencyName = typeof body.currencyName === 'string' && body.currencyName.trim()
    ? cleanStr(body.currencyName, 'Currency name', 1, 20) : 'coins';
  const startingBalance = body.startingBalance === undefined || body.startingBalance === ''
    ? 1000 : cleanInt(body.startingBalance, 'Starting balance', 1, 1000000);
  let coinValueCents = null;
  if (body.coinValueCents !== undefined && body.coinValueCents !== null && body.coinValueCents !== '') {
    const v = Number(body.coinValueCents);
    if (!Number.isFinite(v) || v <= 0 || v > 10000) throw bad('Coin value must be a positive number of cents');
    coinValueCents = v;
  }
  return tx(() => {
    let code = inviteCode();
    while (db.prepare('SELECT id FROM groups WHERE invite_code = ?').get(code)) code = inviteCode();
    const info = db.prepare(`
      INSERT INTO groups (name, emoji, invite_code, currency_name, starting_balance, coin_value_cents, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, emoji, code, currencyName, startingBalance, coinValueCents, user.id, Date.now());
    const groupId = Number(info.lastInsertRowid);
    db.prepare('INSERT INTO members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
      .run(groupId, user.id, 'admin', Date.now());
    seedMember(groupId, user.id, startingBalance);
    return { id: groupId, inviteCode: code };
  });
});

route('POST', '/api/groups/join', ({ req, body }) => {
  const user = requireUser(req);
  const code = cleanStr(body.inviteCode, 'Invite code', 1, 20).toUpperCase();
  const group = db.prepare('SELECT * FROM groups WHERE invite_code = ?').get(code);
  if (!group) throw bad('No group with that invite code');
  const existing = db.prepare('SELECT 1 FROM members WHERE group_id = ? AND user_id = ?').get(group.id, user.id);
  if (existing) return { id: group.id, alreadyMember: true };
  return tx(() => {
    db.prepare('INSERT INTO members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
      .run(group.id, user.id, 'member', Date.now());
    seedMember(group.id, user.id, group.starting_balance);
    return { id: group.id };
  });
});

route('GET', '/api/groups', ({ req }) => {
  const user = requireUser(req);
  const groups = db.prepare(`
    SELECT g.*,
      (SELECT COUNT(*) FROM members WHERE group_id = g.id) AS member_count,
      (SELECT COUNT(*) FROM markets WHERE group_id = g.id AND status = 'open' AND closes_at > ?) AS open_markets
    FROM groups g JOIN members mem ON mem.group_id = g.id
    WHERE mem.user_id = ?
    ORDER BY g.created_at DESC
  `).all(Date.now(), user.id);
  return {
    groups: groups.map((g) => ({
      id: g.id, name: g.name, emoji: g.emoji, currencyName: g.currency_name,
      memberCount: g.member_count, openMarkets: g.open_markets,
      balance: balance(g.id, user.id),
    })),
  };
});

route('GET', '/api/groups/:id', ({ req, params }) => {
  const user = requireUser(req);
  const groupId = Number(params.id);
  const role = requireMember(groupId, user.id);
  const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  const markets = db.prepare(`${MARKET_SELECT} WHERE m.group_id = ? ORDER BY m.created_at DESC`).all(groupId);
  return {
    group: {
      id: g.id, name: g.name, emoji: g.emoji, inviteCode: g.invite_code,
      currencyName: g.currency_name, startingBalance: g.starting_balance,
      coinValueCents: g.coin_value_cents, createdBy: g.created_by,
    },
    myRole: role,
    myBalance: balance(groupId, user.id),
    members: memberStats(groupId),
    markets: markets.map(marketSummary),
  };
});

route('GET', '/api/groups/:id/activity', ({ req, params }) => {
  const user = requireUser(req);
  const groupId = Number(params.id);
  requireMember(groupId, user.id);
  const events = [];
  for (const r of db.prepare(`
    SELECT mem.joined_at AS at, u.display_name AS who FROM members mem
    JOIN users u ON u.id = mem.user_id WHERE mem.group_id = ?`).all(groupId)) {
    events.push({ at: r.at, text: `${r.who} joined the group`, icon: '👋' });
  }
  for (const r of db.prepare(`
    SELECT m.created_at AS at, m.id, m.question, u.display_name AS who FROM markets m
    JOIN users u ON u.id = m.creator_id WHERE m.group_id = ?`).all(groupId)) {
    events.push({ at: r.at, marketId: r.id, text: `${r.who} opened “${r.question}”`, icon: '🆕' });
  }
  for (const r of db.prepare(`
    SELECT b.created_at AS at, b.side, b.amount, m.id, m.question, u.display_name AS who
    FROM bets b JOIN markets m ON m.id = b.market_id JOIN users u ON u.id = b.user_id
    WHERE m.group_id = ?`).all(groupId)) {
    events.push({
      at: r.at, marketId: r.id, icon: r.side === 'yes' ? '🟢' : '🔴',
      text: `${r.who} bet ${r.amount} on ${r.side.toUpperCase()} — “${r.question}”`,
    });
  }
  for (const r of db.prepare(`
    SELECT m.resolved_at AS at, m.id, m.question, m.status, m.resolution, u.display_name AS who
    FROM markets m JOIN users u ON u.id = m.resolved_by
    WHERE m.group_id = ? AND m.resolved_at IS NOT NULL`).all(groupId)) {
    const outcome = r.status === 'void' ? 'VOID (all bets refunded)' : r.resolution.toUpperCase();
    events.push({ at: r.at, marketId: r.id, icon: '⚖️', text: `${r.who} resolved “${r.question}” → ${outcome}` });
  }
  for (const r of db.prepare(`
    SELECT t.created_at AS at, t.amount, u.display_name AS who FROM transactions t
    JOIN users u ON u.id = t.user_id WHERE t.group_id = ? AND t.kind = 'bonus'`).all(groupId)) {
    events.push({ at: r.at, text: `${r.who} received a ${r.amount} top-up`, icon: '💰' });
  }
  events.sort((a, b) => b.at - a.at);
  return { events: events.slice(0, 60) };
});

route('GET', '/api/groups/:id/settle', ({ req, params }) => {
  const user = requireUser(req);
  const groupId = Number(params.id);
  requireMember(groupId, user.id);
  const g = db.prepare('SELECT coin_value_cents, currency_name FROM groups WHERE id = ?').get(groupId);
  const stats = memberStats(groupId);
  // Greedy debt simplification (Splitwise-style): losers pay winners, biggest first.
  const creditors = stats.filter((s) => s.pnl > 0).map((s) => ({ name: s.displayName, left: s.pnl }))
    .sort((a, b) => b.left - a.left);
  const debtors = stats.filter((s) => s.pnl < 0).map((s) => ({ name: s.displayName, left: -s.pnl }))
    .sort((a, b) => b.left - a.left);
  const transfers = [];
  let ci = 0, di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const pay = Math.min(creditors[ci].left, debtors[di].left);
    if (pay > 0) transfers.push({ from: debtors[di].name, to: creditors[ci].name, coins: pay });
    creditors[ci].left -= pay;
    debtors[di].left -= pay;
    if (creditors[ci].left === 0) ci++;
    if (debtors[di].left === 0) di++;
  }
  return {
    coinValueCents: g.coin_value_cents,
    currencyName: g.currency_name,
    pnl: stats.map((s) => ({ name: s.displayName, pnl: s.pnl })),
    transfers,
  };
});

route('POST', '/api/groups/:id/bonus', ({ req, params, body }) => {
  const user = requireUser(req);
  const groupId = Number(params.id);
  if (requireMember(groupId, user.id) !== 'admin') throw new ApiError(403, 'Only admins can grant top-ups');
  const targetId = cleanInt(body.userId, 'User', 1, Number.MAX_SAFE_INTEGER);
  requireMember(groupId, targetId);
  const amount = cleanInt(body.amount, 'Amount', 1, 1000000);
  db.prepare('INSERT INTO transactions (group_id, user_id, amount, kind, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(groupId, targetId, amount, 'bonus', Date.now());
  return { ok: true };
});

// --- markets ---

route('POST', '/api/groups/:id/markets', ({ req, params, body }) => {
  const user = requireUser(req);
  const groupId = Number(params.id);
  requireMember(groupId, user.id);
  const question = cleanStr(body.question, 'Question', 3, 140);
  const details = typeof body.details === 'string' ? body.details.trim().slice(0, 1000) : '';
  const closesAt = Number(body.closesAt);
  if (!Number.isFinite(closesAt) || closesAt <= Date.now()) throw bad('Close time must be in the future');
  if (closesAt > Date.now() + 366 * 24 * 3600 * 1000) throw bad('Close time must be within a year');
  const info = db.prepare(`
    INSERT INTO markets (group_id, creator_id, question, details, closes_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(groupId, user.id, question, details, Math.round(closesAt), Date.now());
  return { id: Number(info.lastInsertRowid) };
});

route('GET', '/api/markets/:id', ({ req, params }) => {
  const user = requireUser(req);
  const m = getMarket(Number(params.id));
  requireMember(m.group_id, user.id);
  const g = db.prepare('SELECT currency_name FROM groups WHERE id = ?').get(m.group_id);
  const positions = db.prepare(`
    SELECT b.user_id, u.display_name, b.side, SUM(b.amount) AS total
    FROM bets b JOIN users u ON u.id = b.user_id
    WHERE b.market_id = ? GROUP BY b.user_id, b.side ORDER BY total DESC
  `).all(m.id).map((r) => ({ userId: r.user_id, name: r.display_name, side: r.side, amount: r.total }));
  const payouts = db.prepare(`
    SELECT t.user_id, u.display_name, t.amount, t.kind FROM transactions t
    JOIN users u ON u.id = t.user_id
    WHERE t.market_id = ? AND t.kind IN ('payout','refund') ORDER BY t.amount DESC
  `).all(m.id).map((r) => ({ userId: r.user_id, name: r.display_name, amount: r.amount, kind: r.kind }));
  const comments = db.prepare(`
    SELECT c.id, c.body, c.created_at, u.display_name FROM comments c
    JOIN users u ON u.id = c.user_id WHERE c.market_id = ? ORDER BY c.created_at ASC
  `).all(m.id).map((r) => ({ id: r.id, body: r.body, at: r.created_at, name: r.display_name }));
  const role = db.prepare('SELECT role FROM members WHERE group_id = ? AND user_id = ?').get(m.group_id, user.id).role;
  return {
    market: marketSummary(m),
    currencyName: g.currency_name,
    myBalance: balance(m.group_id, user.id),
    canResolve: m.creator_id === user.id || role === 'admin',
    positions,
    payouts,
    comments,
  };
});

route('POST', '/api/markets/:id/bets', ({ req, params, body }) => {
  const user = requireUser(req);
  const side = body.side;
  if (side !== 'yes' && side !== 'no') throw bad('Side must be yes or no');
  return tx(() => {
    const m = getMarket(Number(params.id));
    requireMember(m.group_id, user.id);
    if (m.status !== 'open') throw bad('Betting is closed on this market');
    if (m.closes_at <= Date.now()) throw bad('This market has closed');
    const amount = cleanInt(body.amount, 'Amount', 1, 100000000);
    const bal = balance(m.group_id, user.id);
    if (bal < amount) throw bad(`Not enough funds — you have ${bal}`);
    const now = Date.now();
    db.prepare('INSERT INTO bets (market_id, user_id, side, amount, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(m.id, user.id, side, amount, now);
    db.prepare('INSERT INTO transactions (group_id, user_id, amount, kind, market_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(m.group_id, user.id, -amount, 'bet', m.id, now);
    return { ok: true, newBalance: bal - amount };
  });
});

route('POST', '/api/markets/:id/lock', ({ req, params }) => {
  const user = requireUser(req);
  return tx(() => {
    const m = getMarket(Number(params.id));
    const role = requireMember(m.group_id, user.id);
    if (m.creator_id !== user.id && role !== 'admin') throw new ApiError(403, 'Only the creator or an admin can lock');
    if (m.status !== 'open') throw bad('Market is not open');
    db.prepare('UPDATE markets SET status = ? WHERE id = ?').run('locked', m.id);
    return { ok: true };
  });
});

route('POST', '/api/markets/:id/resolve', ({ req, params, body }) => {
  const user = requireUser(req);
  const resolution = body.resolution;
  if (!['yes', 'no', 'void'].includes(resolution)) throw bad('Resolution must be yes, no, or void');
  return tx(() => {
    const m = getMarket(Number(params.id));
    const role = requireMember(m.group_id, user.id);
    if (m.creator_id !== user.id && role !== 'admin') throw new ApiError(403, 'Only the creator or an admin can resolve');
    if (m.status === 'resolved' || m.status === 'void') throw bad('Market is already resolved');

    const now = Date.now();
    const stakes = db.prepare('SELECT user_id, side, SUM(amount) AS total FROM bets WHERE market_id = ? GROUP BY user_id, side').all(m.id);
    const insertTx = db.prepare('INSERT INTO transactions (group_id, user_id, amount, kind, market_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');

    const refundAll = () => {
      const byUser = new Map();
      for (const s of stakes) byUser.set(s.user_id, (byUser.get(s.user_id) || 0) + s.total);
      for (const [userId, total] of byUser) insertTx.run(m.group_id, userId, total, 'refund', m.id, now);
    };

    if (resolution === 'void') {
      refundAll();
      db.prepare('UPDATE markets SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ?')
        .run('void', user.id, now, m.id);
      return { ok: true, outcome: 'void' };
    }

    const p = pools(m.id);
    const pot = p.yes + p.no;
    const winPool = p[resolution];
    if (winPool === 0) {
      // Nobody backed the winning side — refund everyone rather than vaporize the losers.
      refundAll();
    } else {
      for (const s of stakes.filter((s) => s.side === resolution)) {
        const payout = Math.floor((s.total * pot) / winPool);
        if (payout > 0) insertTx.run(m.group_id, s.user_id, payout, 'payout', m.id, now);
      }
    }
    db.prepare('UPDATE markets SET status = ?, resolution = ?, resolved_by = ?, resolved_at = ? WHERE id = ?')
      .run('resolved', resolution, user.id, now, m.id);
    return { ok: true, outcome: resolution };
  });
});

route('POST', '/api/markets/:id/comments', ({ req, params, body }) => {
  const user = requireUser(req);
  const m = getMarket(Number(params.id));
  requireMember(m.group_id, user.id);
  const text = cleanStr(body.body, 'Comment', 1, 500);
  db.prepare('INSERT INTO comments (market_id, user_id, body, created_at) VALUES (?, ?, ?, ?)')
    .run(m.id, user.id, text, Date.now());
  return { ok: true };
});

// ---------- dispatcher ----------

export async function handleApi(req, res, pathname) {
  let body = {};
  if (req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
      if (chunks.reduce((n, c) => n + c.length, 0) > 1e6) { res.writeHead(413); res.end(); return; }
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw) {
      try { body = JSON.parse(raw); } catch { body = null; }
      if (body === null || typeof body !== 'object') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }
    }
  }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const match = pathname.match(r.regex);
    if (!match) continue;
    const params = {};
    r.names.forEach((n, i) => { params[n] = match[i + 1]; });
    try {
      const result = r.handler({ req, res, params, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 500;
      if (status === 500) console.error(err);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: status === 500 ? 'Something went wrong' : err.message }));
    }
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}
