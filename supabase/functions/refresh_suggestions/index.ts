// Edge function: refresh the "Happening in the world" suggestions from Polymarket's
// top events. High-precision transform — rejects anything that won't clean up into a
// grammatical question, so the feed never fills with junk. Replaces only source='polymarket'
// rows (curated 'seed' + original suggestions are untouched).
//
// Gated by an x-refresh-secret header (verify_jwt is off; the public anon key must NOT be
// able to trigger it). Scheduled by pg_cron via pg_net. Writes with the service-role key.

const PM = 'https://gamma-api.polymarket.com/events?limit=60&active=true&closed=false&archived=false&order=volume24hr&ascending=false';
const SB = Deno.env.get('SUPABASE_URL')!;
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SECRET = Deno.env.get('REFRESH_SECRET') || '';

const REJECT = /___|#|:|\(|\)|\/|\bvs\.?\b| - |\bbo[35]\b|more markets|exact score|player props|golden boot|full lid|\d\s*-\s*\d/i;

function categorize(t: string): string {
  const s = t.toLowerCase();
  if (/bitcoin|ethereum|\bbtc\b|\beth\b|crypto|solana|dogecoin|memecoin/.test(s)) return '💰 Crypto';
  if (/president|election|nominee|congress|senate|governor|\bleader\b|prime minister|mayor/.test(s)) return '🇺🇸 Politics';
  if (/\bfed\b|rate|recession|s&p|inflation|gdp|jobs report|\bcpi\b/.test(s)) return '🏛️ Markets';
  if (/\bnba\b|lebron/.test(s)) return '🏀 NBA';
  if (/\bnfl\b|super bowl/.test(s)) return '🏈 NFL';
  if (/world cup|premier league|champions league|la liga|ballon/.test(s)) return '⚽ Soccer';
  if (/wimbledon|tennis|\bopen\b/.test(s)) return '🎾 Tennis';
  if (/\bf1\b|grand prix|formula 1/.test(s)) return '🏎️ F1';
  if (/oscar|grammy|emmy|box office|billboard|\bmovie\b/.test(s)) return '🎬 Culture';
  return '🔥 Trending';
}

function clean(raw: string): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (REJECT.test(t) || t.length < 6 || t.length > 110) return null;
  let m = t.match(/^(.*?)\s+Winner(?:\s+(\d{4}))?$/i);
  if (m) return `Who will win the ${m[2] ? m[2] + ' ' : ''}${m[1]}?`;
  m = t.match(/^(.*?)\s+Champion(?:\s+(\d{4}))?$/i);
  if (m) return `Who will win the ${m[2] ? m[2] + ' ' : ''}${m[1]} championship?`;
  m = t.match(/^(.*?)\s+Nominee(?:\s+(\d{4}))?$/i);
  if (m) return `Who will be the ${m[2] ? m[2] + ' ' : ''}${m[1]} nominee?`;
  if (t.endsWith('?')) return t;
  return null;
}

Deno.serve(async (req) => {
  if (SECRET && req.headers.get('x-refresh-secret') !== SECRET) {
    return new Response('forbidden', { status: 403 });
  }
  let events: unknown;
  try {
    const r = await fetch(PM, { headers: { 'User-Agent': 'hunch-refresh/1.0' } });
    if (!r.ok) return new Response(JSON.stringify({ error: `polymarket ${r.status}` }), { status: 502 });
    events = await r.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 502 });
  }
  const list: any[] = Array.isArray(events) ? events : ((events as any)?.data || (events as any)?.events || []);

  const seen = new Set<string>();
  const rows: any[] = [];
  for (const e of list) {
    const q = clean(e?.title || '');
    if (!q) continue;
    const k = q.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push({ category: categorize(e.title), question: q, details: 'Trending on Polymarket right now.', source: 'polymarket', kind: 'binary' });
    if (rows.length >= 10) break;
  }

  const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
  await fetch(`${SB}/rest/v1/suggestions?source=eq.polymarket`, { method: 'DELETE', headers: h });
  if (rows.length) {
    const ins = await fetch(`${SB}/rest/v1/suggestions`, { method: 'POST', headers: h, body: JSON.stringify(rows) });
    if (!ins.ok) return new Response(JSON.stringify({ error: `insert ${ins.status}`, detail: await ins.text() }), { status: 500 });
  }
  return new Response(JSON.stringify({ inserted: rows.length, questions: rows.map((r) => r.question) }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
