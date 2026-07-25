/**
 * Universal AI Token Billing System - Cloudflare Worker
 * Supports multi-model pricing, rate limiting, idempotency, and admin controls.
 */

export interface Env {
  TOKEN_BALANCES: KVNamespace;
  ADMIN_KEY: string;
  CORS_ORIGIN?: string;
}

interface PurchasePlan {
  sku: string;
  tokens: number;
  priceUSD: number;
}

interface ModelPrice {
  priceIn: number;   // USD per 1M input tokens
  priceOut: number;  // USD per 1M output tokens
}

// --- Default Pricing Configuration ---------------------------------------------------
const DEFAULT_PURCHASE_PLANS: PurchasePlan[] = [
  { sku: 'STARTER', tokens: 50_000, priceUSD: 1 },
  { sku: 'PRO', tokens: 300_000, priceUSD: 5 },
  { sku: 'BUSINESS', tokens: 1_500_000, priceUSD: 20 },
  { sku: 'ENTERPRISE', tokens: 10_000_000, priceUSD: 100 },
];

// Fallback pricing per 1M tokens ($)
const DEFAULT_MODEL_PRICING: Record<string, ModelPrice> = {
  '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b': { priceIn: 0.497, priceOut: 4.881 },
  '@cf/deepseek-ai/deepseek-math-7b-instruct': { priceIn: 0.20, priceOut: 0.20 },
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { priceIn: 0.59, priceOut: 0.79 },
  '@cf/meta/llama-3.1-8b-instruct': { priceIn: 0.05, priceOut: 0.08 },
  '@cf/qwen/qwen1.5-14b-chat': { priceIn: 0.15, priceOut: 0.15 },

  // --- MODEL GOOGLE GEMMA ---
  '@cf/google/gemma-7b-it': { priceIn: 0.08, priceOut: 0.10 },
  '@cf/google/gemma-2b-it': { priceIn: 0.03, priceOut: 0.05 },
  '@cf/google/gemma-2-9b-it': { priceIn: 0.10, priceOut: 0.20 },

  'default': { priceIn: 0.50, priceOut: 1.00 }, // Fallback for unlisted models
};


// Rate limiter settings
const RATE_LIMIT_MAX = 100; // max requests
const RATE_LIMIT_WINDOW = 60; // window in seconds
const IDEMPOTENCY_TTL_DAYS = 7; // days to keep requestId history

// Key Generators
const BALANCE_KEY = (userId: string) => `balance:${userId}`;
const CONSUMED_KEY = (requestId: string) => `consumed:${requestId}`;
const RATE_KEY = (userId: string) => `rate:${userId}`;
const MODEL_PRICING_KEY = (model: string) => `model:${model}`;

// --- Utility Helpers -----------------------------------------------------------------

function getCorsHeaders(env: Env): HeadersInit {
  return {
    'Access-Control-Allow-Origin': env.CORS_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-key',
  };
}

function jsonResponse(data: any, status = 200, env?: Env): Response {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(env ? getCorsHeaders(env) : { 'Access-Control-Allow-Origin': '*' }),
  };
  return new Response(JSON.stringify(data), { status, headers });
}

async function parseJSON<T>(request: Request): Promise<T | null> {
  try {
    return await request.json<T>();
  } catch {
    return null;
  }
}

function verifyAdmin(request: Request, env: Env): boolean {
  const key = request.headers.get('x-admin-key');
  return !!key && key === env.ADMIN_KEY;
}

// --- KV Core Helpers -----------------------------------------------------------------

async function getBalance(kv: KVNamespace, userId: string): Promise<number> {
  const raw = await kv.get(BALANCE_KEY(userId));
  if (!raw) return 0;
  const val = parseFloat(raw);
  return isNaN(val) ? 0 : val;
}

async function updateBalance(kv: KVNamespace, userId: string, delta: number): Promise<number> {
  const current = await getBalance(kv, userId);
  const next = Math.max(0, current + delta);
  await kv.put(BALANCE_KEY(userId), next.toString());
  return next;
}

async function isRequestProcessed(kv: KVNamespace, requestId: string): Promise<boolean> {
  return (await kv.get(CONSUMED_KEY(requestId))) !== null;
}

async function markRequestProcessed(kv: KVNamespace, requestId: string): Promise<void> {
  await kv.put(CONSUMED_KEY(requestId), '1', {
    expirationTtl: IDEMPOTENCY_TTL_DAYS * 24 * 60 * 60,
  });
}

async function checkRateLimit(kv: KVNamespace, userId: string): Promise<boolean> {
  const key = RATE_KEY(userId);
  const raw = await kv.get(key);
  const now = Math.floor(Date.now() / 1000);

  let data: { count: number; start: number } = raw ? JSON.parse(raw) : { count: 0, start: now };

  if (now - data.start >= RATE_LIMIT_WINDOW) {
    data = { count: 1, start: now };
  } else {
    data.count += 1;
  }

  if (data.count > RATE_LIMIT_MAX) {
    return false;
  }

  const ttl = Math.max(5, RATE_LIMIT_WINDOW - (now - data.start));
  await kv.put(key, JSON.stringify(data), { expirationTtl: ttl });
  return true;
}

async function getModelPrices(kv: KVNamespace, modelName: string): Promise<ModelPrice> {
  // Check KV override first
  const cached = await kv.get(MODEL_PRICING_KEY(modelName));
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch {
      // fallback if JSON parse fails
    }
  }

  // Fallback to static mapping
  return DEFAULT_MODEL_PRICING[modelName] || DEFAULT_MODEL_PRICING['default'];
}

// --- Route Handlers ------------------------------------------------------------------

// GET /plans
async function handlePlans(env: Env): Promise<Response> {
  return jsonResponse({ ok: true, plans: DEFAULT_PURCHASE_PLANS }, 200, env);
}

// GET /balance?userId=...
async function handleGetBalance(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');

  if (!userId) {
    return jsonResponse({ ok: false, error: 'missing_userId' }, 400, env);
  }

  const balance = await getBalance(env.TOKEN_BALANCES, userId);
  return jsonResponse({ ok: true, userId, balance }, 200, env);
}

// POST /purchase
async function handlePurchase(request: Request, env: Env): Promise<Response> {
  const body = await parseJSON<{ userId: string; sku: string; referenceId?: string }>(request);

  if (!body || !body.userId || !body.sku) {
    return jsonResponse({ ok: false, error: 'invalid_body' }, 400, env);
  }

  const plan = DEFAULT_PURCHASE_PLANS.find((p) => p.sku === body.sku);
  if (!plan) {
    return jsonResponse({ ok: false, error: 'unknown_sku' }, 400, env);
  }

  const newBalance = await updateBalance(env.TOKEN_BALANCES, body.userId, plan.tokens);

  return jsonResponse({
    ok: true,
    userId: body.userId,
    credited: plan.tokens,
    newBalance,
    referenceId: body.referenceId || null,
  }, 200, env);
}

// POST /consume
async function handleConsume(request: Request, env: Env): Promise<Response> {
  const body = await parseJSON<{
    userId: string;
    requestId: string;
    promptTokens: number;
    completionTokens: number;
    model?: string;
  }>(request);

  if (!body || !body.userId || !body.requestId) {
    return jsonResponse({ ok: false, error: 'invalid_body' }, 400, env);
  }

  const { userId, requestId, promptTokens = 0, completionTokens = 0, model = 'default' } = body;

  // Rate Limiting
  const allowed = await checkRateLimit(env.TOKEN_BALANCES, userId);
  if (!allowed) {
    return jsonResponse({ ok: false, error: 'rate_limit_exceeded' }, 429, env);
  }

  // Idempotency
  const processed = await isRequestProcessed(env.TOKEN_BALANCES, requestId);
  if (processed) {
    const currentBalance = await getBalance(env.TOKEN_BALANCES, userId);
    return jsonResponse({ ok: true, message: 'already_consumed', balance: currentBalance }, 200, env);
  }

  // Calculate user tokens deduction (1 model token = 1 user token, adjustable)
  const totalModelTokens = Number(promptTokens) + Number(completionTokens);
  
  // Cost breakdown estimation (USD)
  const prices = await getModelPrices(env.TOKEN_BALANCES, model);
  const costUSD = (promptTokens * prices.priceIn + completionTokens * prices.priceOut) / 1_000_000;

  // Check balance
  const currentBalance = await getBalance(env.TOKEN_BALANCES, userId);
  if (currentBalance < totalModelTokens) {
    return jsonResponse({
      ok: false,
      error: 'insufficient_balance',
      required: totalModelTokens,
      balance: currentBalance,
    }, 402, env);
  }

  // Deduct Balance and Mark Idempotent
  const newBalance = await updateBalance(env.TOKEN_BALANCES, userId, -totalModelTokens);
  await markRequestProcessed(env.TOKEN_BALANCES, requestId);

  return jsonResponse({
    ok: true,
    userId,
    requestId,
    deducted: totalModelTokens,
    newBalance,
    estimatedCostUSD: costUSD,
  }, 200, env);
}

// --- Admin Handlers ------------------------------------------------------------------

// POST /admin/balance/topup
async function handleAdminTopUp(request: Request, env: Env): Promise<Response> {
  if (!verifyAdmin(request, env)) return jsonResponse({ ok: false, error: 'unauthorized' }, 401, env);

  const body = await parseJSON<{ userId: string; amount: number }>(request);
  if (!body || !body.userId || typeof body.amount !== 'number') {
    return jsonResponse({ ok: false, error: 'invalid_body' }, 400, env);
  }

  const newBalance = await updateBalance(env.TOKEN_BALANCES, body.userId, body.amount);
  return jsonResponse({ ok: true, userId: body.userId, newBalance }, 200, env);
}

// POST /admin/models
async function handleAdminSetModelPrice(request: Request, env: Env): Promise<Response> {
  if (!verifyAdmin(request, env)) return jsonResponse({ ok: false, error: 'unauthorized' }, 401, env);

  const body = await parseJSON<{ model: string; priceIn: number; priceOut: number }>(request);
  if (!body || !body.model || typeof body.priceIn !== 'number' || typeof body.priceOut !== 'number') {
    return jsonResponse({ ok: false, error: 'invalid_body' }, 400, env);
  }

  const modelData: ModelPrice = { priceIn: body.priceIn, priceOut: body.priceOut };
  await env.TOKEN_BALANCES.put(MODEL_PRICING_KEY(body.model), JSON.stringify(modelData));

  return jsonResponse({ ok: true, model: body.model, pricing: modelData }, 200, env);
}

// --- Main Fetch Event Handler --------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: getCorsHeaders(env) });
    }

    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    try {
      if (request.method === 'GET' && pathname === '/') {
        return jsonResponse({ ok: true, service: 'CF Workers AI Billing System', status: 'online' }, 200, env);
      }

      if (request.method === 'GET' && pathname === '/plans') {
        return handlePlans(env);
      }

      if (request.method === 'GET' && pathname === '/balance') {
        return handleGetBalance(request, env);
      }

      if (request.method === 'POST' && pathname === '/purchase') {
        return handlePurchase(request, env);
      }

      if (request.method === 'POST' && pathname === '/consume') {
        return handleConsume(request, env);
      }

      // Admin Routes
      if (request.method === 'POST' && pathname === '/admin/balance/topup') {
        return handleAdminTopUp(request, env);
      }

      if (request.method === 'POST' && pathname === '/admin/models') {
        return handleAdminSetModelPrice(request, env);
      }

      return jsonResponse({ ok: false, error: 'not_found' }, 404, env);
    } catch (err: any) {
      return jsonResponse({ ok: false, error: 'internal_error', message: err.message }, 500, env);
    }
  },
};