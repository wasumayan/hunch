import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.join(root, 'data');
mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, 'goon.db'));

db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL,
    pass_hash     TEXT NOT NULL,
    salt          TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    expires_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS groups (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL,
    emoji             TEXT NOT NULL DEFAULT '🎲',
    invite_code       TEXT NOT NULL UNIQUE,
    currency_name     TEXT NOT NULL DEFAULT 'coins',
    starting_balance  INTEGER NOT NULL DEFAULT 1000,
    coin_value_cents  REAL,
    created_by        INTEGER NOT NULL REFERENCES users(id),
    created_at        INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS members (
    group_id   INTEGER NOT NULL REFERENCES groups(id),
    user_id    INTEGER NOT NULL REFERENCES users(id),
    role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
    joined_at  INTEGER NOT NULL,
    PRIMARY KEY (group_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS markets (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id     INTEGER NOT NULL REFERENCES groups(id),
    creator_id   INTEGER NOT NULL REFERENCES users(id),
    question     TEXT NOT NULL,
    details      TEXT NOT NULL DEFAULT '',
    closes_at    INTEGER NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','locked','resolved','void')),
    resolution   TEXT CHECK (resolution IN ('yes','no')),
    resolved_by  INTEGER REFERENCES users(id),
    resolved_at  INTEGER,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_markets_group ON markets(group_id, created_at);

  CREATE TABLE IF NOT EXISTS bets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    market_id   INTEGER NOT NULL REFERENCES markets(id),
    user_id     INTEGER NOT NULL REFERENCES users(id),
    side        TEXT NOT NULL CHECK (side IN ('yes','no')),
    amount      INTEGER NOT NULL CHECK (amount > 0),
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bets_market ON bets(market_id);
  CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_id);

  CREATE TABLE IF NOT EXISTS transactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id    INTEGER NOT NULL REFERENCES groups(id),
    user_id     INTEGER NOT NULL REFERENCES users(id),
    amount      INTEGER NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('seed','bet','payout','refund','bonus')),
    market_id   INTEGER REFERENCES markets(id),
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tx_member ON transactions(group_id, user_id);

  CREATE TABLE IF NOT EXISTS comments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    market_id   INTEGER NOT NULL REFERENCES markets(id),
    user_id     INTEGER NOT NULL REFERENCES users(id),
    body        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_comments_market ON comments(market_id);
`);

/** Run fn inside a SQLite transaction; rolls back on throw. */
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function balance(groupId, userId) {
  const row = db
    .prepare('SELECT COALESCE(SUM(amount), 0) AS bal FROM transactions WHERE group_id = ? AND user_id = ?')
    .get(groupId, userId);
  return row.bal;
}

/** YES/NO pool totals for a market. */
export function pools(marketId) {
  const rows = db
    .prepare('SELECT side, COALESCE(SUM(amount), 0) AS total FROM bets WHERE market_id = ? GROUP BY side')
    .all(marketId);
  const out = { yes: 0, no: 0 };
  for (const r of rows) out[r.side] = r.total;
  return out;
}
