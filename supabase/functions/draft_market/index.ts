// Edge function: plain-English -> drafted Hunch market via any OpenAI-compatible LLM.
// Provider-agnostic — set LLM_API_KEY, and optionally LLM_BASE_URL + LLM_MODEL. Works with
// Groq (free), Google Gemini (free, via its OpenAI-compatible endpoint), OpenRouter free
// models, DeepSeek, or a self-hosted endpoint. Defaults to Groq's free Llama.
// verify_jwt + a signed-in-user check keep the public key from spending the LLM budget.

const API_KEY = Deno.env.get('LLM_API_KEY') || '';
const BASE = Deno.env.get('LLM_BASE_URL') || 'https://api.groq.com/openai/v1';
const MODEL = Deno.env.get('LLM_MODEL') || 'llama-3.3-70b-versatile';

function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
}

Deno.serve(async (req) => {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const who = await fetch((Deno.env.get('SUPABASE_URL') || '') + '/auth/v1/user', {
    headers: { apikey: Deno.env.get('SUPABASE_ANON_KEY') || '', Authorization: 'Bearer ' + token },
  }).catch(() => null);
  if (!who || !who.ok) return json({ error: 'Sign in to use AI drafting.' }, 401);

  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* ignore */ }
  const text = String(body.text || '').trim().slice(0, 500);
  if (text.length < 3) return json({ error: 'Describe your bet in a sentence.' }, 400);
  if (!API_KEY) return json({ error: 'AI drafting is not configured yet — add a free LLM key.' }, 503);

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
    r = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, temperature: 0.2, max_tokens: 400,
        messages: [{ role: 'system', content: system }, { role: 'user', content: text }],
      }),
    });
  } catch (e) {
    return json({ error: 'Could not reach the AI service', detail: String(e) }, 502);
  }
  if (!r.ok) return json({ error: 'AI draft failed', detail: (await r.text()).slice(0, 300) }, 502);

  const data = await r.json();
  const rawText = (data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '') || '';
  const raw = String(rawText).trim();
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
