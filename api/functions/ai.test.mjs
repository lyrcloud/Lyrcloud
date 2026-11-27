// Lyrcloud AI Gateway: env.AI in the runtime -> platform function -> Bedrock (faked), with plan limits,
// caching and usage records in DynamoDB (faked).
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { BedrockRuntimeClient, ConverseCommand, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

Object.assign(process.env, { DATA_TABLE_NAME: 'data', USERS_TABLE_NAME: 'users', PLATFORM_SECRET: 'test-secret' });
const { handler: platform } = await import('./platform.mjs');
const { signToken, cleanBindings } = await import('./storage.mjs');
const { makeEnv } = await import('./runtime.mjs');
const { chatInput, AI_LIMITS } = await import('./ai.mjs');

let items;
let users;
let calls;

DynamoDBDocumentClient.prototype.send = async function send(command) {
  const { input } = command;
  const name = command.constructor.name;
  if (input.TableName === 'users') return { Item: structuredClone(users.get(input.Key.userId)) };
  const k = (key) => `${key.pk}|${key.sk}`;
  if (name === 'GetCommand') return { Item: structuredClone(items.get(k(input.Key))) };
  if (name === 'PutCommand') { items.set(k(input.Item), structuredClone(input.Item)); return {}; }
  if (name === 'UpdateCommand') {
    const item = items.get(k(input.Key)) || { ...input.Key };
    // "ADD a :x, b :y SET c = :z" as used by ai.mjs
    const [addPart, setPart] = input.UpdateExpression.replace(/^ADD /, '').split(' SET ');
    for (const clause of addPart.split(',')) {
      const [field, value] = clause.trim().split(/\s+/);
      const real = input.ExpressionAttributeNames?.[field] || field;
      item[real] = (item[real] || 0) + input.ExpressionAttributeValues[value];
    }
    if (setPart) {
      const [field, value] = setPart.split('=').map((x) => x.trim());
      item[field] = input.ExpressionAttributeValues[value];
    }
    items.set(k(input.Key), item);
    return { Attributes: structuredClone(item) };
  }
  if (name === 'QueryCommand') {
    const pk = input.ExpressionAttributeValues[':pk'];
    const prefix = input.ExpressionAttributeValues[':m'] || '';
    return { Items: [...items.values()].filter((item) => item.pk === pk && item.sk.startsWith(prefix)) };
  }
  throw new Error(`unexpected ${name}`);
};

let blockClaude = false;
BedrockRuntimeClient.prototype.send = async function send(command) {
  calls.push(command.input);
  if (command instanceof ConverseCommand && blockClaude && command.input.modelId.includes('anthropic')) {
    throw Object.assign(new Error('Model use case details have not been submitted for this account.'), { name: 'ResourceNotFoundException' });
  }
  if (command instanceof ConverseCommand) {
    return { output: { message: { content: [{ text: `echo: ${command.input.messages.at(-1).content[0].text}` }] } }, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } };
  }
  if (command instanceof InvokeModelCommand) {
    const body = JSON.parse(command.input.body);
    return { body: Buffer.from(JSON.stringify({ embedding: Array(body.dimensions).fill(0.1), inputTextTokenCount: 3 })) };
  }
  throw new Error('unexpected bedrock call');
};

beforeEach(() => {
  items = new Map();
  users = new Map([['u1', { userId: 'u1', plan: 'launch' }], ['u2', { userId: 'u2', plan: 'scale' }]]);
  calls = [];
  blockClaude = false;
});

const envFor = (owner) => makeEnv({}, [{ binding: 'AI', type: 'ai', name: 'ai' }], async (request) => {
  const out = await platform({ ...request, token: signToken('test-secret', { fn: 'fn', owner }) });
  if (!out.ok) throw Object.assign(new Error(out.error), { status: out.status });
  return out.result;
});

test('"ai" in lyrcloud.json becomes an AI binding', () => {
  assert.deepEqual(cleanBindings({ ai: 'AI', kv: { CACHE: 'c' } })[0].map((b) => b.type), ['ai', 'kv']);
  assert.match(cleanBindings({ ai: 'not valid' })[1], /binding name/);
});

test('chat: env.AI.run calls Bedrock with an explicit max token count and records usage', async () => {
  const env = envFor('u1');
  const out = await env.AI.run('claude-haiku-4.5', { prompt: 'hello', system: 'be brief' });
  assert.equal(out.response, 'echo: hello');
  assert.deepEqual(out.usage, { input_tokens: 10, output_tokens: 5 });
  assert.equal(calls[0].modelId, 'us.anthropic.claude-haiku-4-5-20251001-v1:0');
  assert.equal(calls[0].inferenceConfig.maxTokens, 1024);
  assert.deepEqual(calls[0].system, [{ text: 'be brief' }]);
  const usage = [...items.values()].find((item) => item.pk === 'usage#u1');
  assert.equal(usage.requests, 1);
  assert.equal(usage.inputTokens, 10);
  // The default model, and a messages conversation
  const second = await env.AI.run({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] });
  assert.equal(second.model, 'claude-haiku-4.5');
  assert.equal(calls[1].messages.length, 3);
});

test('caching answers identical requests without calling the model again', async () => {
  const env = envFor('u1');
  const first = await env.AI.run('claude-sonnet-4.6', { prompt: 'same' }, { cache: 600 });
  const second = await env.AI.run('claude-sonnet-4.6', { prompt: 'same' }, { cache: 600 });
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.response, first.response);
  assert.equal(calls.length, 1);
  // Another account never gets this account's cached answer.
  await envFor('u2').AI.run('claude-sonnet-4.6', { prompt: 'same' }, { cache: 600 });
  assert.equal(calls.length, 2);
});

test('plans: Opus needs Scale, and the monthly budget stops requests', async () => {
  await assert.rejects(envFor('u1').AI.run('claude-opus-4.6', { prompt: 'x' }), /Scale or Enterprise/);
  assert.equal((await envFor('u2').AI.run('claude-opus-4.6', { prompt: 'x' })).response, 'echo: x');
  const month = new Date().toISOString().slice(0, 7);
  items.set(`usage#u1|${month}#claude-haiku-4.5`, { pk: 'usage#u1', sk: `${month}#claude-haiku-4.5`, inputTokens: AI_LIMITS.launch.monthlyTokens, outputTokens: 0 });
  await assert.rejects(envFor('u1').AI.run('claude-haiku-4.5', { prompt: 'x' }), /budget/);
});

test('the per-minute rate limit applies per account', async () => {
  const env = envFor('u1');
  const minute = String(Math.floor(Date.now() / 60_000));
  items.set(`airate#u1|${minute}`, { pk: 'airate#u1', sk: minute, count: AI_LIMITS.launch.perMinute });
  await assert.rejects(env.AI.run('claude-haiku-4.5', { prompt: 'x' }), /a minute/);
  assert.equal((await envFor('u2').AI.run('claude-haiku-4.5', { prompt: 'x' })).response, 'echo: x');
});

test('embeddings and the model list', async () => {
  const env = envFor('u1');
  const out = await env.AI.embed('titan-embed-v2', ['one', 'two'], { dimensions: 256 });
  assert.equal(out.data.length, 2);
  assert.equal(out.data[0].length, 256);
  assert.equal(out.usage.input_tokens, 6);
  const models = await env.AI.models();
  assert.equal(models.find((m) => m.name === 'claude-opus-4.6').available, false);
  assert.equal(models.find((m) => m.name === 'claude-haiku-4.5').available, true);
});

test('bad requests are refused before reaching the model', () => {
  assert.throws(() => chatInput('gpt-9', { prompt: 'x' }), /Unknown chat model/);
  assert.throws(() => chatInput('claude-haiku-4.5', {}), /prompt/);
  assert.throws(() => chatInput('claude-haiku-4.5', { prompt: 'x', max_tokens: 99999 }), /max_tokens/);
  assert.throws(() => chatInput('claude-haiku-4.5', { messages: [{ role: 'assistant', content: 'x' }] }), /first message/);
  assert.throws(() => chatInput('claude-haiku-4.5', { prompt: 'x', temperature: 3 }), /temperature/);
  assert.equal(calls.length, 0);
});

test('a model that isn’t switched on gives a clear error, and fallback models are tried in order', async () => {
  blockClaude = true;
  const env = envFor('u1');
  await assert.rejects(env.AI.run('claude-haiku-4.5', { prompt: 'x' }), /isn’t switched on for Lyrcloud yet/);
  const out = await env.AI.run('claude-haiku-4.5', { prompt: 'x' }, { fallback: ['claude-sonnet-4.6', 'nova-lite'] });
  assert.equal(out.model, 'nova-lite');
  assert.deepEqual(out.fallback_from, ['claude-haiku-4.5', 'claude-sonnet-4.6']);
  await assert.rejects(env.AI.run('claude-haiku-4.5', { prompt: 'x' }, { fallback: 'gpt-9' }), /Unknown chat model/);
});
