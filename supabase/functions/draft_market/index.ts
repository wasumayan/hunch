// Edge function: turn a plain-English sentence into a drafted Hunch market.
// Calls Anthropic (Claude) with the caller's words, returns structured JSON the
// composer prefills. verify_jwt is ON, so only signed-in users can spend the key.
// Set the ANTHROPIC_API_KEY function secret to activate; until then it returns 503.

const KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';
const MODEL = Deno.env.get('DRAFT_MODEL') || 'claude-haiku-4-5-20251001';

function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
}

Deno.serve(async (req) => {
  // Require a real signed-in user (the public anon key must NOT be able to spend the LLM key).
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const who = await fetch((Deno.env.get('SUPABASE_URL') || '') + '/auth/v1/user', {
    headers: { apikey: Deno.env.get('SUPABASE_ANON_KEY') || '', Authorization: 'Bearer ' + token },
  }).catch(() => null);
  if (!who || !who.ok) return json({ error: 'Sign in to use AI drafting.' }, 401);

  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* ignore */ }
  const text = String(body.text || '').trim().slice(0, 500);
  if (text.length < 3) return json({ error: 'Describe your bet in a sentence.' }, 400);
  if (!KEY) return json({ error: 'AI drafting is not configured yet — add an Anthropic API key.' }, 503);

  const today = new Date().toISOString().slice(0, 10);
  const system = [
    'You turn a casual sentence into a prediction market for the betting app "Hunch".',
    'Reply with ONLY a compact JSON object, no prose, no markdown. Keys:',
    'question (a crisp question, max 140 chars);',
    'kind ("binary" for a YES/NO question, or "numeric" for a guess-the-number market);',
    'metric (a short unit like "views" or "points" when numeric, otherwise null);',
    'details (one sentence on exactly how it resolves, max 200 chars);',
    'closes_at (ISO-8601 UTC betting deadline; infer it from the sentence, else 7 days after ' + today + ');',
    'post_url (a URL if the sentence contains one, otherwise null).',
  ].join(' ');

  let r: Response;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 400, system, messages: [{ role: 'user', content: text }] }),
    });
  } catch (e) {
    return json({ error: 'Could not reach the AI service', detail: String(e) }, 502);
  }
  if (!r.ok) return json({ error: 'AI draft failed', detail: (await r.text()).slice(0, 300) }, 502);

  const data = await r.json();
  const raw = (data && data.content && data.content[0] && data.content[0].text ? data.content[0].text : '').trim();
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  let parsed: any = null;
  if (s >= 0 && e > s) { try { parsed = JSON.parse(raw.slice(s, e + 1)); } catch (_e) { /* fallthrough */ } }
  if (!parsed) return json({ error: 'Could not parse the AI draft', raw: raw.slice(0, 300) }, 502);

  return json({
    question: String(parsed.question || '').slice(0, 160),
    kind: parsed.kind === 'numeric' ? 'numeric' : 'binary',
    metric: parsed.metric ? String(parsed.metric).slice(0, 24) : null,
    details: parsed.details ? String(parsed.details).slice(0, 2000) : '',
    closes_at: parsed.closes_at || null,
    post_url: parsed.post_url || null,
  });
});
