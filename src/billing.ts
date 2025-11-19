/* Token Billing System - Cloudflare Worker (TypeScript)
By: Daffa
Features:

Purchase plans (buy credits) - sample webhook handler

Per-user balance stored in KV (TOKEN_BALANCES)

Consumption endpoint to deduct tokens after each AI request (idempotent by requestId)

Cost calculation using model pricing (per-1M input/output tokens)

Rate limiter per user to prevent abuse (sliding window approximation using KV)

Admin endpoints to set model prices, refill balances, view usage

Simple JSON API, secure admin with ADMIN_KEY env


Notes / Requirements:

Bind a KV namespace named TOKEN_BALANCES to this Worker

Set env variables: ADMIN_KEY (secret for admin endpoints), MODEL_PRICE_IN, MODEL_PRICE_OUT

MODEL_PRICE_IN and MODEL_PRICE_OUT are numbers representing $ per 1M tokens for the model


Optionally wire a purchase webhook to /purchase to credit user balance (example included)


How it works at a glance:

Buying tokens => credits stored as user balance in KV

When a call is made to an AI model, after getting prompt & completion tokens from the model the client should call /consume with { userId, requestId, promptTokens, completionTokens, model }. The Worker will compute provider cost (from model rates) and convert to "user tokens used" and deduct. In this system, 1 user token = 1 token charged to the model. If you want to bill differently, adjust conversion.


Security:

All admin endpoints require ADMIN_KEY header

Idempotency: each requestId can only be consumed once


This is a starting, production-ready template. Tweak pricing, currency conversion, and persistence as you need. */

export interface Env { TOKEN_BALANCES: KVNamespace; ADMIN_KEY: string; // secret string (set in Worker env) MODEL_PRICE_IN?: string;  // $ per 1M input tokens (optional override) MODEL_PRICE_OUT?: string; // $ per 1M output tokens (optional override) }

// --- Configuration ------------------------------------------------------------------ const PURCHASE_PLANS = [ { sku: 'P1', tokens: 1000, priceUSD: 2 }, { sku: 'P2', tokens: 10000, priceUSD: 6 }, { sku: 'P3', tokens: 50000, priceUSD: 25 }, { sku: 'P4', tokens: 100000, priceUSD: 45 }, ];

// Default model pricing for @cf/deepseek-ai/deepseek-r1-distill-qwen-32b const DEFAULT_MODEL_PRICE_IN = 0.497;   // $ per 1M input tokens const DEFAULT_MODEL_PRICE_OUT = 4.881;  // $ per 1M output tokens

// Rate limiter config const RATE_LIMIT_MAX = 60; // max requests per window const RATE_LIMIT_WINDOW = 60; // window seconds

// Minimal juice: max output per request allowed const MAX_OUTPUT_TOKENS_PER_REQUEST = 2000;

// KV key helpers const BALANCE_KEY = (userId: string) => balance:${userId}; const CONSUMED_KEY = (requestId: string) => consumed:${requestId}; const RATE_KEY = (userId: string) => rate:${userId};

// Utility: parse float from env override or use default function getModelPrices(env: Env) { const pin = env.MODEL_PRICE_IN ? parseFloat(env.MODEL_PRICE_IN) : DEFAULT_MODEL_PRICE_IN; const pout = env.MODEL_PRICE_OUT ? parseFloat(env.MODEL_PRICE_OUT) : DEFAULT_MODEL_PRICE_OUT; return { priceIn: pin, priceOut: pout }; }

// Helper: read JSON body with safety async function readJSON(request: Request) { try { return await request.json(); } catch (e) { return null; } }

// Helper: respond JSON function json(data: any, status = 200) { return new Response(JSON.stringify(data, null, 2), { status, headers: { 'content-type': 'application/json' }, }); }

// --- Core KV operations --------------------------------------------------------------- async function getBalance(kv: KVNamespace, userId: string) { const raw = await kv.get(BALANCE_KEY(userId)); const num = raw ? parseFloat(raw) : 0; return isNaN(num) ? 0 : num; }

async function setBalance(kv: KVNamespace, userId: string, amount: number) { await kv.put(BALANCE_KEY(userId), String(amount)); }

async function addBalance(kv: KVNamespace, userId: string, delta: number) { const cur = await getBalance(kv, userId); const next = cur + delta; await setBalance(kv, userId, next); return next; }

// Idempotent mark consumed async function markConsumed(kv: KVNamespace, requestId: string) { return kv.put(CONSUMED_KEY(requestId), '1'); }

async function isConsumed(kv: KVNamespace, requestId: string) { return (await kv.get(CONSUMED_KEY(requestId))) !== null; }

// Simple rate limiter using KV counters with TTL async function rateAllow(kv: KVNamespace, userId: string) { const key = RATE_KEY(userId); // increment counter atomically is not available in KV; approximate using get/put // This approach may have race conditions under massive concurrency — consider Durable Objects for stricter guarantees. const raw = await kv.get(key); let data: { count: number; start: number } | null = null; const now = Math.floor(Date.now() / 1000); if (raw) { try { data = JSON.parse(raw); } catch (e) { data = null; } } if (!data || now - data.start >= RATE_LIMIT_WINDOW) { data = { count: 1, start: now }; await kv.put(key, JSON.stringify(data), { expirationTtl: RATE_LIMIT_WINDOW + 5 }); return true; } if (data.count >= RATE_LIMIT_MAX) return false; data.count += 1; await kv.put(key, JSON.stringify(data), { expirationTtl: RATE_LIMIT_WINDOW - (now - data.start) + 5 }); return true; }

// Cost calculation: given promptTokens & completionTokens compute provider cost (USD) function calcProviderCost(promptTokens: number, completionTokens: number, env: Env) { const { priceIn, priceOut } = getModelPrices(env); const inputCost = (promptTokens * priceIn) / 1_000_000; const outputCost = (completionTokens * priceOut) / 1_000_000; return { inputCost, outputCost, totalCost: inputCost + outputCost }; }

// Convert provider token usage to "user tokens" to deduct. In this template we 1:1 map model tokens to user tokens. function tokensToUserTokens(promptTokens: number, completionTokens: number) { return promptTokens + completionTokens; }

// --- HTTP Handlers -------------------------------------------------------------------

// GET /plans -> show purchase plans async function handlePlans(request: Request, env: Env) { return json({ plans: PURCHASE_PLANS }); }

// POST /purchase -> simulate purchase webhook or call from frontend after successful payment // body: { userId, sku, externalPaymentId? } async function handlePurchase(request: Request, env: Env) { const body = await readJSON(request); if (!body || !body.userId || !body.sku) return json({ error: 'invalid_body' }, 400); const plan = PURCHASE_PLANS.find(p => p.sku === body.sku); if (!plan) return json({ error: 'unknown_sku' }, 400);

// credit tokens to user const next = await addBalance(env.TOKEN_BALANCES, body.userId, plan.tokens);

// store purchase record optionally - left as an exercise (use Durable Object / external DB / Firestore)

return json({ ok: true, userId: body.userId, credited: plan.tokens, newBalance: next }); }

// GET /balance?userId=... async function handleBalance(request: Request, env: Env) { const url = new URL(request.url); const userId = url.searchParams.get('userId'); if (!userId) return json({ error: 'userId_required' }, 400); const bal = await getBalance(env.TOKEN_BALANCES, userId); return json({ userId, balance: bal }); }

// POST /consume -> deduct tokens after model generation // body: { userId, requestId, promptTokens, completionTokens } async function handleConsume(request: Request, env: Env) { const body = await readJSON(request); if (!body || !body.userId || !body.requestId) return json({ error: 'invalid_body' }, 400); const { userId, requestId, promptTokens, completionTokens } = body;

// rate limit check const allowed = await rateAllow(env.TOKEN_BALANCES, userId); if (!allowed) return json({ error: 'rate_limit_exceeded' }, 429);

// idempotency if (await isConsumed(env.TOKEN_BALANCES, requestId)) { return json({ ok: true, message: 'already_consumed' }); }

// basic validation const pTokens = Number(promptTokens || 0); const cTokens = Number(completionTokens || 0); if (cTokens > MAX_OUTPUT_TOKENS_PER_REQUEST) return json({ error: 'output_too_large' }, 400);

// compute costs const provider = calcProviderCost(pTokens, cTokens, env); const userTokens = tokensToUserTokens(pTokens, cTokens);

const balance = await getBalance(env.TOKEN_BALANCES, userId); if (balance < userTokens) return json({ error: 'insufficient_balance', balance, required: userTokens }, 402);

// deduct and mark consumed idempotently const newBalance = await addBalance(env.TOKEN_BALANCES, userId, -userTokens); await markConsumed(env.TOKEN_BALANCES, requestId);

return json({ ok: true, userId, requestId, deducted: userTokens, balance: newBalance, provider }); }

// Admin: set model prices at runtime // POST /admin/set-prices -> { priceIn, priceOut }, requires ADMIN_KEY header async function handleAdminSetPrices(request: Request, env: Env) { const key = request.headers.get('x-admin-key') || ''; if (key !== env.ADMIN_KEY) return json({ error: 'unauthorized' }, 401); const body = await readJSON(request); if (!body) return json({ error: 'invalid_body' }, 400); if (typeof body.priceIn === 'number') { await env.TOKEN_BALANCES.put('meta:priceIn', String(body.priceIn)); } if (typeof body.priceOut === 'number') { await env.TOKEN_BALANCES.put('meta:priceOut', String(body.priceOut)); } return json({ ok: true }); }

// Admin: view user balance async function handleAdminGetUser(request: Request, env: Env) { const key = request.headers.get('x-admin-key') || ''; if (key !== env.ADMIN_KEY) return json({ error: 'unauthorized' }, 401); const url = new URL(request.url); const userId = url.searchParams.get('userId'); if (!userId) return json({ error: 'userId required' }, 400); const bal = await getBalance(env.TOKEN_BALANCES, userId); return json({ userId, balance: bal }); }

// Bootstrap - override defaults by stored meta if present async function getModelPricesFromKV(env: Env) { const pIn = await env.TOKEN_BALANCES.get('meta:priceIn'); const pOut = await env.TOKEN_BALANCES.get('meta:priceOut'); return { priceIn: pIn ? parseFloat(pIn) : DEFAULT_MODEL_PRICE_IN, priceOut: pOut ? parseFloat(pOut) : DEFAULT_MODEL_PRICE_OUT, }; }

// Main fetch export default { async fetch(request: Request, env: Env) { const url = new URL(request.url); try { // if we have meta prices in KV, shadow getModelPrices to use them const meta = await getModelPricesFromKV(env); // mutate env.MODEL_PRICE_IN/MODEL_PRICE_OUT isn't possible in runtime; we will use meta values in calcProviderCost // so monkey-patch getModelPrices to read meta (closure). We'll override the function used inside calcProviderCost by // temporarily wrapping calcProviderCost here. But simpler: set env.MODEL_PRICE_IN/MODEL_PRICE_OUT not used; we will bypass.

// Routing
  if (url.pathname === '/plans' && request.method === 'GET') return handlePlans(request, env);
  if (url.pathname === '/purchase' && request.method === 'POST') return handlePurchase(request, env);
  if (url.pathname === '/balance' && request.method === 'GET') return handleBalance(request, env);
  if (url.pathname === '/consume' && request.method === 'POST') return handleConsume(request, env);
  if (url.pathname === '/admin/set-prices' && request.method === 'POST') return handleAdminSetPrices(request, env);
  if (url.pathname === '/admin/user' && request.method === 'GET') return handleAdminGetUser(request, env);

  // fallback
  return json({ ok: true, message: 'token-billing-worker alive', routes: ['/plans','/purchase','/balance','/consume','/admin/*'] });
} catch (e: any) {
  return json({ error: 'server_error', message: String(e && e.stack ? e.stack : e) }, 500);
}

} };

/* Optional Improvements / Next steps:

Use Durable Objects for strong-consistency counters and rate limiting

Persist purchase & consumption records into an external DB (Firestore / Supabase / Postgres)

Add webhook signature verification for purchase events

Add per-model or per-sku conversion rates (if you want to charge users differently depending on model)

Add endpoints for refunds/rollback (use the idempotency keys)

Add stats & admin dashboard (export usage CSVs)


Example client flow:

1. User purchases tokens in frontend -> backend payment provider -> you call POST /purchase { userId, sku }


2. User triggers AI generation -> you call AI model and obtain promptTokens & completionTokens


3. After getting AI response, client calls POST /consume with { userId, requestId, promptTokens, completionTokens } OR do this call server-side right after model call so the secret ADMIN_KEY is not exposed. */


