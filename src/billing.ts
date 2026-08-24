/**
 * Universal AI Token Billing System - Cloudflare Worker
 * Supports multi-model pricing, rate limiting, idempotency, and admin controls.
 * 
 * CATATAN PENTING UNTUK PRODUCTION:
 * Cloudflare KV tidak mendukung operasi atomik (transaksi). 
 * Untuk sistem billing/keuangan, sangat disarankan menggunakan Cloudflare D1 atau Durable Objects 
 * untuk mencegah race conditions pada update saldo.
 */

export interface Env {
  TOKEN_BALANCES: KVNamespace;
  ADMIN_KEY: string;
  CORS_ORIGIN?: string;
  // Tambahkan binding untuk Auth jika diperlukan (misal: AUTH_SECRET)
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

const DEFAULT_MODEL_PRICING: Record<string, ModelPrice> = {
  '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b': { priceIn: 0.497, priceOut: 4.881 },
  '@cf/moonshotai/kimi-k2.7-code': { priceIn: 0.95, priceOut: 0.95 },
  '@cf/openai/gpt-oss-120b': { priceIn: 0.59, priceOut: 0.79 },
  '@cf/qwen/qwen2.5-coder-32b-instruct': { priceIn: 0.05, priceOut: 0.08 },
  '@cf/qwen/qwen3-30b-a3b-fp8': { priceIn: 0.15, priceOut: 0.45 },
  '@cf/google/gemma-2b-it-lora': { priceIn: 0.03, priceOut: 0.05 },
  '@cf/google/gemma-3-12b-it': { priceIn: 0.25, priceOut: 0.55 },
  '@cf/google/gemma-4-26b-a4b-it': { priceIn: 0.15, priceOut: 0.35 },
  '@cf/google/gemma-7b-it': { priceIn: 0.08, priceOut: 0.10 },
  'default': { priceIn: 0.50, priceOut: 1.00 },
};

// --- Constants -----------------------------------------------------------------------
const RATE_LIMIT_MAX = 100; 
const RATE_LIMIT_WINDOW = 60; 
const IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

// --- Key Generators ------------------------------------------------------------------
const Keys = {
  balance: (userId: string) => `balance:${userId}`,
  consumed: (requestId: string) => `consumed:${requestId}`,
  purchase: (referenceId: string) => `purchase:${referenceId}`,
  rate: (userId: string) => `rate:${userId}`,
  modelPricing: (model: string) => `model:${model}`,
};

// --- Utility Helpers -----------------------------------------------------------------
function getCorsHeaders(env: Env, request?: Request): Record<string, string> {
  const origin = request?.headers.get('Origin') || '';
  const allowedOrigins = [
    'https://vibecode-82m.pages.dev',
    'https://vibecode.harisudahmalam.workers.dev',
    'http://localhost:4000',
    'http://127.0.0.1:4000',
    env.CORS_ORIGIN
  ].filter(Boolean) as string[];
  
  // Jika origin ada di allowedOrigins, gunakan origin tersebut
  // Jika CORS_ORIGIN di-set, gunakan itu
  // Jika tidak, gunakan * (tapi ini tidak aman untuk credentials)
  const corsOrigin = allowedOrigins.includes(origin) ? origin : 
                    (env.CORS_ORIGIN || '*');
  
  // Jika origin adalah * dan request memiliki credentials, jangan izinkan
  const allowCredentials = corsOrigin !== '*';
  
  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-key',
    'Access-Control-Allow-Credentials': allowCredentials ? 'true' : 'false',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data: unknown, status = 200, env?: Env, request?: Request): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(env ? getCorsHeaders(env, request) : { 'Access-Control-Allow-Origin': '*' }),
    },
  });
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
  if (!key || !env.ADMIN_KEY) return false;
  
  // Mencegah timing attack
  if (key.length !== env.ADMIN_KEY.length) return false;
  let result = 0;
  for (let i = 0; i < key.length; i++) {
    result |= key.charCodeAt(i) ^ env.ADMIN_KEY.charCodeAt(i);
  }
  return result === 0;
}

// Placeholder untuk autentikasi user. Ganti dengan logika JWT/API Key Anda.
function verifyUser(request: Request, userId: string): boolean {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  
  const token = authHeader.split(' ')[1];
  // CONTOH: Validasi token sederhana atau verifikasi JWT
  // Dalam production, decode & validasi payload JWT sub/userId === userId
  
  // Untuk demo, izinkan token apapun yang tidak kosong
  // Atau validasi token sederhana
  if (!token) return false;
  
  // Jika menggunakan demo-token, izinkan semua userId
  if (token === 'demo-token') return true;
  
  // Jika menggunakan JWT, validasi di sini
  // try {
  //   const payload = JSON.parse(atob(token.split('.')[1]));
  //   return payload.sub === userId;
  // } catch {
  //   return false;
  // }
  
  return Boolean(token); 
}

// --- KV Core Helpers -----------------------------------------------------------------
async function getBalance(kv: KVNamespace, userId: string): Promise<number> {
  const raw = await kv.get(Keys.balance(userId));
  if (!raw) return 0;
  const val = parseFloat(raw);
  return isNaN(val) ? 0 : val;
}

async function updateBalance(kv: KVNamespace, userId: string, delta: number): Promise<number> {
  const current = await getBalance(kv, userId);
  const next = Math.max(0, current + delta);
  await kv.put(Keys.balance(userId), next.toString());
  return next;
}

async function isRequestProcessed(kv: KVNamespace, requestId: string): Promise<boolean> {
  return (await kv.get(Keys.consumed(requestId))) !== null;
}

async function markRequestProcessed(kv: KVNamespace, requestId: string): Promise<void> {
  await kv.put(Keys.consumed(requestId), '1', { expirationTtl: IDEMPOTENCY_TTL_SECONDS });
}

async function checkRateLimit(kv: KVNamespace, userId: string): Promise<boolean> {
  const key = Keys.rate(userId);
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
  const cached = await kv.get(Keys.modelPricing(modelName));
  if (cached) {
    try {
      return JSON.parse(cached) as ModelPrice;
    } catch {
      // Fallback jika format JSON di KV rusak
    }
  }
  return DEFAULT_MODEL_PRICING[modelName] || DEFAULT_MODEL_PRICING['default'];
}

// --- Route Handlers ------------------------------------------------------------------
async function handlePlans(env: Env, request?: Request): Promise<Response> {
  return jsonResponse({ ok: true, plans: DEFAULT_PURCHASE_PLANS }, 200, env, request);
}

async function handleGetBalance(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');
  
  if (!userId) return jsonResponse({ ok: false, error: 'missing_userId' }, 400, env, request);
  if (!verifyUser(request, userId)) return jsonResponse({ ok: false, error: 'unauthorized' }, 401, env, request);

  const balance = await getBalance(env.TOKEN_BALANCES, userId);
  return jsonResponse({ ok: true, userId, balance }, 200, env, request);
}

async function handlePurchase(request: Request, env: Env): Promise<Response> {
  const body = await parseJSON<{ userId: string; sku: string; referenceId?: string }>(request);
  if (!body?.userId || !body.sku) {
    return jsonResponse({ ok: false, error: 'invalid_body' }, 400, env, request);
  }
  if (!verifyUser(request, body.userId)) return jsonResponse({ ok: false, error: 'unauthorized' }, 401, env, request);

  const plan = DEFAULT_PURCHASE_PLANS.find((p) => p.sku === body.sku);
  if (!plan) return jsonResponse({ ok: false, error: 'unknown_sku' }, 400, env, request);

  const referenceId = body.referenceId || `purchase:${body.userId}:${crypto.randomUUID()}`;
  const previousPurchase = await env.TOKEN_BALANCES.get(Keys.purchase(referenceId));
  if (previousPurchase) {
    return jsonResponse({ ...JSON.parse(previousPurchase), idempotent: true }, 200, env, request);
  }

  const newBalance = await updateBalance(env.TOKEN_BALANCES, body.userId, plan.tokens);

  const result = {
    ok: true,
    userId: body.userId,
    credited: plan.tokens,
    newBalance,
    referenceId,
  };
  await env.TOKEN_BALANCES.put(Keys.purchase(referenceId), JSON.stringify(result), {
    expirationTtl: IDEMPOTENCY_TTL_SECONDS,
  });
  return jsonResponse(result, 200, env, request);
}

async function handleConsume(request: Request, env: Env): Promise<Response> {
  const body = await parseJSON<{
    userId: string;
    requestId: string;
    promptTokens?: number;
    completionTokens?: number;
    model?: string;
  }>(request);

  if (!body?.userId || !body.requestId) {
    return jsonResponse({ ok: false, error: 'invalid_body' }, 400, env);
  }
  if (!verifyUser(request, body.userId)) return jsonResponse({ ok: false, error: 'unauthorized' }, 401, env);

  const { userId, requestId, model = 'default' } = body;
  
  // FIX: Pastikan konversi ke number aman dan fallback ke 0 jika undefined/NaN
  const promptTokens = Number(body.promptTokens) || 0;
  const completionTokens = Number(body.completionTokens) || 0;
  const totalModelTokens = promptTokens + completionTokens;

  if (totalModelTokens <= 0) {
    return jsonResponse({ ok: false, error: 'invalid_token_count' }, 400, env);
  }

  // Rate Limiting
  const allowed = await checkRateLimit(env.TOKEN_BALANCES, userId);
  if (!allowed) {
    return jsonResponse({ ok: false, error: 'rate_limit_exceeded' }, 429, env, request);
  }

  // Idempotency Check
  const processed = await isRequestProcessed(env.TOKEN_BALANCES, requestId);
  if (processed) {
    const currentBalance = await getBalance(env.TOKEN_BALANCES, userId);
    return jsonResponse({ ok: true, message: 'already_consumed', balance: currentBalance }, 200, env, request);
  }

  // Calculate Cost
  const prices = await getModelPrices(env.TOKEN_BALANCES, model);
  const costUSD = (promptTokens * prices.priceIn + completionTokens * prices.priceOut) / 1_000_000;

  // Check Balance
  const currentBalance = await getBalance(env.TOKEN_BALANCES, userId);
  if (currentBalance < totalModelTokens) {
    return jsonResponse({
      ok: false,
      error: 'insufficient_balance',
      required: totalModelTokens,
      balance: currentBalance,
    }, 402, env, request);
  }

  // Deduct & Mark Processed
  const newBalance = await updateBalance(env.TOKEN_BALANCES, userId, -totalModelTokens);
  await markRequestProcessed(env.TOKEN_BALANCES, requestId);

  return jsonResponse({
    ok: true,
    userId,
    requestId,
    deducted: totalModelTokens,
    newBalance,
    estimatedCostUSD: costUSD,
  }, 200, env, request);
}

// --- Admin Handlers ------------------------------------------------------------------
async function handleAdminTopUp(request: Request, env: Env): Promise<Response> {
  if (!verifyAdmin(request, env)) return jsonResponse({ ok: false, error: 'unauthorized' }, 401, env, request);
  
  const body = await parseJSON<{ userId: string; amount: number }>(request);
  if (!body?.userId || typeof body.amount !== 'number' || isNaN(body.amount)) {
    return jsonResponse({ ok: false, error: 'invalid_body' }, 400, env, request);
  }

  const newBalance = await updateBalance(env.TOKEN_BALANCES, body.userId, body.amount);
  return jsonResponse({ ok: true, userId: body.userId, newBalance }, 200, env, request);
}

async function handleAdminSetModelPrice(request: Request, env: Env): Promise<Response> {
  if (!verifyAdmin(request, env)) return jsonResponse({ ok: false, error: 'unauthorized' }, 401, env, request);
  
  const body = await parseJSON<{ model: string; priceIn: number; priceOut: number }>(request);
  if (!body?.model || typeof body.priceIn !== 'number' || typeof body.priceOut !== 'number') {
    return jsonResponse({ ok: false, error: 'invalid_body' }, 400, env, request);
  }

  const modelData: ModelPrice = { priceIn: body.priceIn, priceOut: body.priceOut };
  await env.TOKEN_BALANCES.put(Keys.modelPricing(body.model), JSON.stringify(modelData));
  
  return jsonResponse({ ok: true, model: body.model, pricing: modelData }, 200, env, request);
}

// --- Main Fetch Event Handler --------------------------------------------------------
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: getCorsHeaders(env, request) });
    }

    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;

    try {
      switch (route) {
        case 'GET /':
          return jsonResponse({ ok: true, service: 'CF Workers AI Billing System', status: 'online' }, 200, env, request);
        case 'GET /plans':
          return handlePlans(env, request);
        case 'GET /balance':
          return handleGetBalance(request, env);
        case 'POST /purchase':
          return handlePurchase(request, env);
        case 'POST /consume':
          return handleConsume(request, env);
        case 'POST /admin/balance/topup':
          return handleAdminTopUp(request, env);
        case 'POST /admin/models':
          return handleAdminSetModelPrice(request, env);
        default:
          return jsonResponse({ ok: false, error: 'not_found' }, 404, env, request);
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      console.error('Worker Error:', errorMessage);
      return jsonResponse({ ok: false, error: 'internal_error', message: errorMessage }, 500, env, request);
    }
  },
};