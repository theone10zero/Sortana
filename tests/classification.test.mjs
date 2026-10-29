import test from 'node:test';
import assert from 'node:assert/strict';
import * as chat from '../modules/backends/chatCompletions.js';
import * as decision from '../modules/backends/systemOne.js';
import { CONFIG_DEFAULTS, migratedInputLimit, validateSettings } from '../modules/classificationConfig.js';

const data = { aiCache: { legacy: { matched: true, reason: 'old' } }, aiReasonCache: { legacy: 'old' } };
globalThis.messenger = { storage: { local: {
  async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, data[key]])); },
  async set(values) { Object.assign(data, structuredClone(values)); },
  async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }
} }, messages: { async get(id) { return { headerMessageId: `message-${id}` }; } } };
const classifier = await import('../modules/AiClassifier.js');
const transfer = await import('../options/dataTransfer.js');
const answer = probability => ({ model: 'served-model', answers: { match: { type: 'noul', noul: probability } } });
let calls = [];
function serve(body, status = 200) {
  globalThis.fetch = async (url, request) => { calls.push({ url, ...request }); return { ok: status === 200, status, json: async () => body }; };
}

test('adapters preserve chat prompts and isolate SystemOne payloads', () => {
  const config = { ...CONFIG_DEFAULTS, model: 'chosen', customSystemPrompt: 'Custom guidance' };
  const payload = chat.buildRequest('email', 'invoice', config);
  assert.match(payload.messages[0].content, /Custom guidance/);
  assert.match(payload.messages[0].content, /Classification Criteria:\n1\. invoice/);
  assert.equal(payload.messages[1].content, '**Email Summary**\n```\nemail\n```');
  assert.equal(payload.max_tokens, 4096);
  assert.deepEqual(decision.buildRequest('email', 'invoice', config), {
    state: 'email', model: 'chosen',
    questions: { match: { type: 'noul', instructions: 'Does this email satisfy the following criterion: invoice. The email is provided as a summary: metadata, attachment file names and three excerpts of the body.' } }
  });
  assert.equal('model' in decision.buildRequest('email', 'invoice', CONFIG_DEFAULTS), false);
  assert.equal('model' in chat.buildRequest('email', 'invoice', CONFIG_DEFAULTS), false);
});

test('parsers validate evidence including zero, one, and malformed answers', () => {
  for (const probability of [0, 0.5, 1]) assert.equal(decision.parseResponse(answer(probability)).probability, probability);
  for (const probability of [null, '0.5', -0.1, 1.1, Infinity, NaN]) assert.throws(() => decision.parseResponse(answer(probability)));
  for (const raw of [null, {}, { answers: { other: { type: 'noul', noul: 0.5 } } }, { answers: { match: { type: 'choice', noul: 0.5 } } }]) assert.throws(() => decision.parseResponse(raw));
  // Chat Completions now returns an array
  assert.deepEqual(chat.parseResponse({ choices: [{ message: { content: '[{"index":1,"matched":true,"reason":"brace } inside"}]' } }] }), [{ matched: true, reason: 'brace } inside', probability: null }]);
  for (const content of ['', '{broken}', '{"match":"true"}']) assert.throws(() => chat.parseResponse({ choices: [{ message: { content } }] }));
  // A malformed element leaves the criterion unanswered rather than failing.
  assert.deepEqual(chat.parseResponse({ choices: [{ message: { content: '[{"match":"true"}]' } }] }), [null]);
  assert.throws(() => chat.parseResponse(null));
});

test('URLs preserve proxy prefixes and normalize API suffixes', () => {
  for (const suffix of ['', '/', '/v1', '/v1/', '/v1/models', '/v1/chat/completions/', '/v1/systemone']) {
    assert.equal(classifier.buildEndpointUrl(`http://localhost:8080/proxy${suffix}`, 'systemone'), 'http://localhost:8080/proxy/v1/systemone');
    assert.equal(classifier.buildModelsUrl(`http://localhost:8080/proxy${suffix}`), 'http://localhost:8080/proxy/v1/models');
  }
  assert.equal(classifier.buildEndpointUrl('example.com'), 'https://example.com/v1/chat/completions');
  assert.equal(classifier.buildEndpointUrl(''), '');
});

test('settings validation and independent character-limit migration', () => {
  assert.equal(migratedInputLimit({}), 3686);
  assert.equal(migratedInputLimit({ aiParams: { max_tokens: 1000 } }), 900);
  assert.equal(migratedInputLimit({ inputCharacterLimit: 500, aiParams: { max_tokens: 1000 } }), 500);
  validateSettings({ decisionThreshold: 0, aiRules: [{ decisionThreshold: 1 }] });
  for (const value of [-1, 2, null, '0.5']) assert.throws(() => validateSettings({ aiRules: [{ decisionThreshold: value }] }));
  for (const value of [0, 1.2, NaN]) assert.throws(() => validateSettings({ inputCharacterLimit: value }));
});

test('cache migration, inference reuse, fingerprints, clearing and import', async () => {
  await classifier.init();
  assert.equal(await classifier.getCacheSize(), 0);
  assert.equal(data.aiReasonCache, undefined);
  assert.deepEqual(data.aiCache, {});
  classifier.setConfig({ ...CONFIG_DEFAULTS, apiType: 'systemone', endpoint: 'http://localhost:8080', apiKey: 'secret', openaiOrganization: 'org', openaiProject: 'project' });
  const snapshot = classifier.getConfig();
  const key = await classifier.buildCacheKey(1, 'invoice', snapshot);
  serve(answer(0.75)); calls = [];
  const first = await classifier.classify('email', 'invoice', { snapshot, cacheKey: key, threshold: 0.75 });
  assert.equal(first.matched, true);
  assert.equal(first.model, 'served-model');
  assert.deepEqual(calls[0].headers, { 'Content-Type': 'application/json', Authorization: 'Bearer secret' });
  const second = await classifier.classify('email', 'invoice', { snapshot, cacheKey: key, threshold: 0.8 });
  assert.equal(second.matched, false);
  assert.equal(second.probability, 0.75);
  assert.equal(calls.length, 1);
  classifier.replaceCache(data.aiCache);
  assert.equal(classifier.getCachedDetails(key, 0.75).matched, true);
  assert.equal(await classifier.buildCacheKey(1, 'invoice', { ...snapshot, decisionThreshold: 0.9, apiKey: 'new secret' }), key);
  for (const change of [{ apiType: 'chat-completions' }, { endpoint: 'http://other' }, { model: 'other' }, { tokenReduction: true }, { inputCharacterLimit: 500 }]) {
    assert.notEqual(await classifier.buildCacheKey(1, 'invoice', { ...snapshot, ...change }), key);
  }
  const chatSnapshot = { ...snapshot, apiType: 'chat-completions' };
  const chatKey = await classifier.buildCacheKey(1, 'invoice', chatSnapshot);
  assert.notEqual(await classifier.buildCacheKey(1, 'invoice', { ...chatSnapshot, customSystemPrompt: 'other' }), chatKey);
  assert.notEqual(await classifier.buildCacheKey(1, 'invoice', { ...chatSnapshot, aiParams: { ...snapshot.aiParams, temperature: 1 } }), chatKey);
  serve({ choices: [{ message: { content: '[{"index":1,"match":false,"reason":"not invoice"}]' } }] });
  await classifier.classify('email', 'invoice', { cacheKey: chatKey, snapshot: chatSnapshot });
  assert.equal(calls.at(-1).headers['OpenAI-Organization'], 'org');
  assert.equal(await classifier.getCacheSize(), 2);
  const exported = structuredClone(data.aiCache);
  await classifier.clearCacheForMessage(1);
  assert.equal(await classifier.getCacheSize(), 0);
  await transfer.importData({ text: async () => JSON.stringify({ aiCache: { ...exported, legacy: true } }) }, ['cache']);
  classifier.replaceCache(data.aiCache); // background storage listener consumes imported replacement
  assert.equal(await classifier.getCacheSize(), 2);
  await assert.rejects(transfer.importData({ text: async () => JSON.stringify({ decisionThreshold: 2 }) }, ['settings']));
  await assert.rejects(transfer.importData({ text: async () => JSON.stringify({ aiRules: [{ decisionThreshold: -1 }] }) }, ['rules']));
  await classifier.clearCache();
});

test('a message that vanished still yields a usable cache key', async () => {
  const snapshot = classifier.getConfig();
  const live = globalThis.messenger.messages.get;
  globalThis.messenger.messages.get = async (id) => { throw new Error(`Message not found: ${id}.`); };
  try {
    const key = await classifier.buildCacheKey(9, 'invoice', snapshot);
    assert.match(key, /^v4:[a-f0-9]{64}:[a-f0-9]{64}$/);
    assert.equal(await classifier.buildCacheKey(9, 'invoice', snapshot), key);
  } finally {
    globalThis.messenger.messages.get = live;
  }
  globalThis.messenger.messages.get = async () => { throw new Error('the header is unavailable'); };
  await assert.rejects(classifier.buildCacheKey(9, 'invoice', snapshot), /the header is unavailable/);
  globalThis.messenger.messages.get = live;
});

test('failures remain uncached and snapshots survive configuration changes', async () => {
  classifier.setConfig({ ...CONFIG_DEFAULTS, apiType: 'systemone' });
  const snapshot = classifier.getConfig();
  const key = await classifier.buildCacheKey(2, 'invoice', snapshot);
  for (const raw of [null, answer('0.9'), {}]) {
    serve(raw);
    await assert.rejects(classifier.classify('email', 'invoice', { cacheKey: key, snapshot }));
    assert.equal(classifier.getCachedDetails(key), null);
  }
  serve({}, 503);
  await assert.rejects(classifier.classify('email', 'invoice', { cacheKey: key, snapshot }), /503/);
  globalThis.fetch = async () => { throw new Error('network'); };
  await assert.rejects(classifier.classify('email', 'invoice', { cacheKey: key, snapshot }), /network/);
  globalThis.fetch = async () => ({ ok: true, json: async () => { throw new SyntaxError('bad JSON'); } });
  await assert.rejects(classifier.classify('email', 'invoice', { cacheKey: key, snapshot }), /bad JSON/);
  classifier.setConfig({ apiType: 'chat-completions', endpoint: 'http://changed' });
  serve(answer(1)); calls = [];
  const result = await classifier.classify('email', 'invoice', { cacheKey: key, snapshot });
  assert.equal(result.backend, 'systemone');
  assert.equal(calls[0].url, 'http://127.0.0.1:5000/v1/systemone');
  assert.equal('Authorization' in calls[0].headers, false);
  await classifier.clearCache();
});

test('clearing or replacing cache during inference prevents stale repopulation', async () => {
  classifier.setConfig({ ...CONFIG_DEFAULTS, apiType: 'systemone' });
  const snapshot = classifier.getConfig();
  const key = await classifier.buildCacheKey(3, 'invoice', snapshot);
  for (const replace of [() => classifier.clearCache(), () => classifier.replaceCache({})]) {
    let release, started;
    const ready = new Promise(resolve => { started = resolve; });
    globalThis.fetch = async () => {
      started();
      await new Promise(resolve => { release = resolve; });
      return { ok: true, json: async () => answer(0.9) };
    };
    const pending = classifier.classify('email', 'invoice', { cacheKey: key, snapshot });
    await ready;
    await replace();
    release();
    assert.equal((await pending).matched, true);
    assert.equal(classifier.getCachedDetails(key), null);
  }
});

test('settings and rule imports retain thresholds and reject invalid caches', async () => {
  const settings = { apiType: 'systemone', decisionThreshold: 0.75, inputCharacterLimit: 5000, tokenReduction: true };
  const rules = [{ criterion: 'invoice', decisionThreshold: 0, actions: [{ type: 'flag', flagged: true }] }, { criterion: 'urgent', actions: [] }];
  await transfer.importData({ text: async () => JSON.stringify({ ...settings, aiRules: rules }) }, ['settings', 'rules']);
  for (const [key, value] of Object.entries(settings)) assert.equal(data[key], value);
  assert.deepEqual(data.aiRules, rules);
  const key = await classifier.buildCacheKey(4, 'invoice');
  assert.equal(classifier.validCacheEntry(key, { version: 3, backend: 'systemone', probability: '0.8', reason: null, messageHash: key.split(':')[1], model: '' }), false);
});

test('SystemOne 404 reports endpoint, server message, and compatibility guidance', async () => {
  classifier.setConfig({ ...CONFIG_DEFAULTS, apiType: 'systemone', endpoint: 'http://seinei.wageshouse:5003' });
  serve({ error: { message: 'File Not Found' } }, 404);
  await assert.rejects(classifier.classify('synthetic email', 'invoice'), error => {
    assert.match(error.message, /HTTP 404 at http:\/\/seinei\.wageshouse:5003\/v1\/systemone/);
    assert.match(error.message, /Server response: File Not Found/);
    assert.match(error.message, /running server build supports/);
    return true;
  });
});
