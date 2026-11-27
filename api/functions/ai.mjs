// Lyrcloud AI Gateway: chat models and embeddings on Amazon Bedrock for Edge Functions (env.AI) and the
// CLI (`lyrcloud ai`). It picks the model from a short catalog, enforces each plan's monthly token budget
// and per-minute request rate, can cache identical requests, and records usage per account and model.
//
// DynamoDB (the functions data table):
//   pk "usage#<owner>",      sk "<YYYY-MM>#<model>"   { requests, inputTokens, outputTokens }
//   pk "aicache#<owner>",    sk "<sha256 of request>" { result, expiresAt }
//   pk "airate#<owner>",     sk "<minute>"            { count, expiresAt }
import { createHash } from 'node:crypto';
import { BedrockRuntimeClient, ConverseCommand, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { StorageError } from './storage.mjs';

export const bedrock = new BedrockRuntimeClient({ region: process.env.AI_REGION || 'us-east-1', maxAttempts: 4, retryMode: 'adaptive' });
export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const DATA_TABLE = () => process.env.DATA_TABLE_NAME;
const USERS_TABLE = () => process.env.USERS_TABLE_NAME;

// The models this account can call (checked with real calls on 2026-11-26). `plans` limits who may use
// a model; `weight` is how much each token counts against the monthly budget (relative cost).
export const MODELS = {
  'claude-haiku-4.5': { id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', kind: 'chat', label: 'Claude Haiku 4.5', note: 'Fast and inexpensive', weight: 1, plans: ['launch', 'scale', 'enterprise'] },
  'claude-sonnet-4.6': { id: 'us.anthropic.claude-sonnet-4-6', kind: 'chat', label: 'Claude Sonnet 4.6', note: 'Best balance of quality and speed', weight: 3, plans: ['launch', 'scale', 'enterprise'] },
  'claude-opus-4.6': { id: 'us.anthropic.claude-opus-4-6-v1', kind: 'chat', label: 'Claude Opus 4.6', note: 'Most capable; Scale and Enterprise plans', weight: 5, plans: ['scale', 'enterprise'] },
  'nova-micro': { id: 'us.amazon.nova-micro-v1:0', kind: 'chat', label: 'Amazon Nova Micro', note: 'Cheapest text model', weight: 0.25, plans: ['launch', 'scale', 'enterprise'] },
  'nova-lite': { id: 'us.amazon.nova-2-lite-v1:0', kind: 'chat', label: 'Amazon Nova 2 Lite', note: 'Low-cost, understands images', weight: 0.5, plans: ['launch', 'scale', 'enterprise'] },
  'titan-embed-v2': { id: 'amazon.titan-embed-text-v2:0', kind: 'embedding', label: 'Amazon Titan Text Embeddings V2', note: '256, 512 or 1024 dimensions', weight: 0.1, plans: ['launch', 'scale', 'enterprise'] },
};
export const DEFAULT_CHAT_MODEL = 'claude-haiku-4.5';
export const DEFAULT_EMBED_MODEL = 'titan-embed-v2';

// Budgets are in weighted tokens per calendar month (UTC).
export const AI_LIMITS = {
  launch: { monthlyTokens: 500_000, perMinute: 30 },
  scale: { monthlyTokens: 10_000_000, perMinute: 300 },
  enterprise: { monthlyTokens: 100_000_000, perMinute: 1200 },
};
export const aiLimitsFor = (plan) => AI_LIMITS[plan] || AI_LIMITS.launch;
export const MAX_OUTPUT_TOKENS = 4096;
export const DEFAULT_OUTPUT_TOKENS = 1024;
const MAX_INPUT_CHARS = 200_000;
const MAX_EMBED_TEXTS = 32;
const CACHE_MAX_TTL = 7 * 86400;

export const listModels = (plan) => Object.entries(MODELS).map(([name, model]) => ({
  name, label: model.label, kind: model.kind, note: model.note, available: model.plans.includes(plan),
}));

// ---------------------------------------------------------------- request shape

// Accepts { prompt } or { messages: [{ role, content }] }, plus system, max_tokens, temperature, top_p,
// stop. Returns the Converse input, or throws StorageError(400).
export function chatInput(modelName, input) {
  const model = MODELS[modelName];
  if (!model || model.kind !== 'chat') throw new StorageError(400, `Unknown chat model “${modelName}”. Try ${Object.keys(MODELS).filter((name) => MODELS[name].kind === 'chat').join(', ')}.`);
  if (!input || typeof input !== 'object') throw new StorageError(400, 'Pass { prompt } or { messages }.');
  let messages;
  if (typeof input.prompt === 'string') {
    messages = [{ role: 'user', content: input.prompt }];
  } else if (Array.isArray(input.messages) && input.messages.length) {
    messages = input.messages;
  } else {
    throw new StorageError(400, 'Pass { prompt: "…" } or { messages: [{ role: "user", content: "…" }] }.');
  }
  let chars = 0;
  const converse = messages.map((message, i) => {
    if (!message || !['user', 'assistant'].includes(message.role)) throw new StorageError(400, `messages[${i}].role must be "user" or "assistant".`);
    if (typeof message.content !== 'string' || !message.content) throw new StorageError(400, `messages[${i}].content must be text.`);
    chars += message.content.length;
    return { role: message.role, content: [{ text: message.content }] };
  });
  if (converse[0].role !== 'user') throw new StorageError(400, 'The first message must come from the user.');
  if (input.system !== undefined && typeof input.system !== 'string') throw new StorageError(400, 'system must be text.');
  chars += (input.system || '').length;
  if (chars > MAX_INPUT_CHARS) throw new StorageError(413, `Requests can be at most ${MAX_INPUT_CHARS.toLocaleString('en-US')} characters.`);
  const maxTokens = input.max_tokens === undefined ? DEFAULT_OUTPUT_TOKENS : Math.floor(Number(input.max_tokens));
  if (!(maxTokens >= 1 && maxTokens <= MAX_OUTPUT_TOKENS)) throw new StorageError(400, `max_tokens must be between 1 and ${MAX_OUTPUT_TOKENS}.`);
  const inferenceConfig = { maxTokens };
  if (input.temperature !== undefined) {
    const t = Number(input.temperature);
    if (!(t >= 0 && t <= 1)) throw new StorageError(400, 'temperature must be between 0 and 1.');
    inferenceConfig.temperature = t;
  }
  if (input.top_p !== undefined) {
    const p = Number(input.top_p);
    if (!(p > 0 && p <= 1)) throw new StorageError(400, 'top_p must be between 0 and 1.');
    inferenceConfig.topP = p;
  }
  if (input.stop !== undefined) {
    const stops = Array.isArray(input.stop) ? input.stop : [input.stop];
    if (stops.length > 4 || stops.some((s) => typeof s !== 'string' || !s)) throw new StorageError(400, 'stop must be up to 4 strings.');
    inferenceConfig.stopSequences = stops;
  }
  return {
    modelId: model.id,
    messages: converse,
    ...(input.system ? { system: [{ text: input.system }] } : {}),
    inferenceConfig,
  };
}

// ---------------------------------------------------------------- limits and usage

const month = (date = new Date()) => date.toISOString().slice(0, 7);
const minute = () => Math.floor(Date.now() / 60_000);

export async function planOf(owner) {
  if (!USERS_TABLE()) return 'launch';
  const { Item } = await ddb.send(new GetCommand({ TableName: USERS_TABLE(), Key: { userId: owner }, ProjectionExpression: '#p, disabled', ExpressionAttributeNames: { '#p': 'plan' } }));
  if (Item?.disabled === true) throw new StorageError(403, 'This account has been disabled.');
  return ['launch', 'scale', 'enterprise'].includes(Item?.plan) ? Item.plan : 'launch';
}

export async function usageOf(owner, when = month()) {
  const { Items = [] } = await ddb.send(new QueryCommand({
    TableName: DATA_TABLE(),
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :m)',
    ExpressionAttributeValues: { ':pk': `usage#${owner}`, ':m': `${when}#` },
  }));
  const models = Items.map((item) => ({
    model: item.sk.slice(when.length + 1),
    requests: item.requests || 0,
    inputTokens: item.inputTokens || 0,
    outputTokens: item.outputTokens || 0,
    cachedRequests: item.cachedRequests || 0,
  }));
  const weighted = models.reduce((sum, m) => sum + (m.inputTokens + m.outputTokens) * (MODELS[m.model]?.weight ?? 1), 0);
  return { month: when, models, weightedTokens: Math.round(weighted) };
}

async function checkRate(owner, perMinute) {
  const now = minute();
  const { Attributes } = await ddb.send(new UpdateCommand({
    TableName: DATA_TABLE(),
    Key: { pk: `airate#${owner}`, sk: String(now) },
    UpdateExpression: 'ADD #c :one SET expiresAt = :exp',
    ExpressionAttributeNames: { '#c': 'count' },
    ExpressionAttributeValues: { ':one': 1, ':exp': Math.floor(Date.now() / 1000) + 180 },
    ReturnValues: 'UPDATED_NEW',
  }));
  if (Attributes.count > perMinute) throw new StorageError(429, `AI requests are limited to ${perMinute} a minute on your plan. Try again shortly.`);
}

async function recordUsage(owner, modelName, { inputTokens = 0, outputTokens = 0 }, cached = false) {
  await ddb.send(new UpdateCommand({
    TableName: DATA_TABLE(),
    Key: { pk: `usage#${owner}`, sk: `${month()}#${modelName}` },
    UpdateExpression: cached ? 'ADD cachedRequests :one' : 'ADD requests :one, inputTokens :i, outputTokens :o',
    ExpressionAttributeValues: cached ? { ':one': 1 } : { ':one': 1, ':i': inputTokens, ':o': outputTokens },
  }));
}

// Throws unless the owner's plan allows `modelName` and has budget and rate left this month.
async function admit(owner, modelName) {
  const plan = await planOf(owner);
  const model = MODELS[modelName];
  if (!model.plans.includes(plan)) throw new StorageError(403, `${model.label} needs the Scale or Enterprise plan. Try claude-sonnet-4.6.`);
  const limits = aiLimitsFor(plan);
  const usage = await usageOf(owner);
  if (usage.weightedTokens >= limits.monthlyTokens) {
    throw new StorageError(429, `Your plan’s AI budget for ${usage.month} (${limits.monthlyTokens.toLocaleString('en-US')} tokens) is used up. Upgrade, or wait for next month.`);
  }
  await checkRate(owner, limits.perMinute);
  return plan;
}

// ---------------------------------------------------------------- calls

const cacheKey = (payload) => createHash('sha256').update(JSON.stringify(payload)).digest('hex');

async function cached(owner, key) {
  const { Item } = await ddb.send(new GetCommand({ TableName: DATA_TABLE(), Key: { pk: `aicache#${owner}`, sk: key } }));
  return Item && Item.expiresAt > Math.floor(Date.now() / 1000) ? Item.result : null;
}

// A model that can't be used right now: busy, or not switched on for Lyrcloud's account yet. These are
// the errors a fallback model is tried for.
const UNAVAILABLE = new Set(['ThrottlingException', 'ServiceQuotaExceededException', 'ServiceUnavailableException', 'ModelNotReadyException', 'ResourceNotFoundException', 'AccessDeniedException']);

const bedrockError = (err, modelName) => {
  if ((err?.name === 'ResourceNotFoundException' || err?.name === 'AccessDeniedException') && /use case|not available|access/i.test(err.message || '')) {
    return new StorageError(503, `${MODELS[modelName]?.label || modelName} isn’t switched on for Lyrcloud yet. Use nova-lite or nova-micro for now, or pass { fallback: 'nova-lite' }.`);
  }
  if (err?.name === 'ThrottlingException' || err?.name === 'ServiceQuotaExceededException') return new StorageError(503, 'The AI service is busy. Try again in a moment.');
  if (err?.name === 'ValidationException') return new StorageError(400, `The model refused the request: ${err.message}`);
  if (err?.name === 'ModelTimeoutException') return new StorageError(504, 'The model took too long to answer.');
  return null;
};

// options.cache: seconds to keep this exact request's answer (0/undefined: don't cache).
// options.fallback: a model (or list) to try, in order, when the first is busy or unavailable.
export async function runChat(owner, modelName = DEFAULT_CHAT_MODEL, input = {}, options = {}) {
  const fallbacks = options.fallback === undefined ? [] : Array.isArray(options.fallback) ? options.fallback : [options.fallback];
  if (fallbacks.length > 3) throw new StorageError(400, 'Give at most 3 fallback models.');
  const chain = [modelName, ...fallbacks];
  for (const name of chain) chatInput(name, input); // check every model before calling any
  for (let i = 0; ; i += 1) {
    try {
      const result = await runChatOnce(owner, chain[i], input, options);
      return i ? { ...result, fallback_from: chain.slice(0, i) } : result;
    } catch (err) {
      if (i === chain.length - 1 || !(err instanceof StorageError) || err.status !== 503) throw err;
    }
  }
}

async function runChatOnce(owner, modelName, input, options) {
  const request = chatInput(modelName, input);
  const ttl = options.cache ? Math.min(CACHE_MAX_TTL, Math.max(60, Math.floor(Number(options.cache)))) : 0;
  const key = ttl ? cacheKey({ modelName, request }) : null;
  if (key) {
    const hit = await cached(owner, key);
    if (hit) {
      await recordUsage(owner, modelName, {}, true);
      return { ...hit, cached: true };
    }
  }
  await admit(owner, modelName);
  let res;
  try {
    res = await bedrock.send(new ConverseCommand(request));
  } catch (err) {
    const known = bedrockError(err, modelName);
    if (known) throw known;
    if (UNAVAILABLE.has(err?.name)) throw new StorageError(503, `${MODELS[modelName].label} is unavailable right now.`);
    throw err;
  }
  const usage = { inputTokens: res.usage?.inputTokens || 0, outputTokens: res.usage?.outputTokens || 0 };
  await recordUsage(owner, modelName, usage);
  const result = {
    model: modelName,
    response: (res.output?.message?.content || []).map((block) => block.text || '').join(''),
    stop_reason: res.stopReason,
    usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
    cached: false,
  };
  if (key) {
    await ddb.send(new PutCommand({ TableName: DATA_TABLE(), Item: { pk: `aicache#${owner}`, sk: key, result, expiresAt: Math.floor(Date.now() / 1000) + ttl } }));
  }
  return result;
}

// texts: a string or up to 32 strings. Returns { model, data: [[...numbers]], dimensions, usage }.
export async function runEmbed(owner, modelName = DEFAULT_EMBED_MODEL, texts, { dimensions = 1024 } = {}) {
  const model = MODELS[modelName];
  if (!model || model.kind !== 'embedding') throw new StorageError(400, `Unknown embedding model “${modelName}”. Use ${DEFAULT_EMBED_MODEL}.`);
  const list = Array.isArray(texts) ? texts : [texts];
  if (!list.length || list.length > MAX_EMBED_TEXTS || list.some((t) => typeof t !== 'string' || !t || t.length > 50_000)) {
    throw new StorageError(400, `Embed 1 to ${MAX_EMBED_TEXTS} non-empty texts of up to 50,000 characters.`);
  }
  if (![256, 512, 1024].includes(Number(dimensions))) throw new StorageError(400, 'dimensions must be 256, 512 or 1024.');
  await admit(owner, modelName);
  let inputTokens = 0;
  const data = [];
  try {
    for (const text of list) {
      const res = await bedrock.send(new InvokeModelCommand({
        modelId: model.id,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({ inputText: text, dimensions: Number(dimensions), normalize: true }),
      }));
      const out = JSON.parse(Buffer.from(res.body).toString('utf8'));
      data.push(out.embedding);
      inputTokens += out.inputTextTokenCount || 0;
    }
  } catch (err) {
    throw bedrockError(err, modelName) || err;
  }
  await recordUsage(owner, modelName, { inputTokens, outputTokens: 0 });
  return { model: modelName, data, dimensions: Number(dimensions), usage: { input_tokens: inputTokens } };
}
