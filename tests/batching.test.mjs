import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { CONFIG_DEFAULTS, validateSettings } from '../modules/classificationConfig.js';
import * as systemone from '../modules/backends/systemOne.js';
import { loadMessages, translatorFor } from './support/i18n.js';

const data = {};
let cacheWrites = 0;
globalThis.messenger = { storage: { local: {
  async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, data[key]])); },
  async set(values) { Object.assign(data, structuredClone(values)); if ('aiCache' in values) cacheWrites++; },
  async remove() {}
} }, messages: { async get(id) { return { headerMessageId: `mail-${id}` }; } } };
const classifier = await import('../modules/AiClassifier.js');
const transfer = await import('../options/dataTransfer.js');
let requests = [];
async function setup(update = {}) {
  await classifier.clearCache();
  classifier.setConfig({ ...CONFIG_DEFAULTS, apiType: 'systemone', ...update });
  requests = []; cacheWrites = 0;
  globalThis.fetch = async (url, request) => {
    const body = JSON.parse(request.body);
    requests.push({ url, body, headers: request.headers });
    // Intentionally reverse response order and include an unsolicited answer.
    return { ok: true, json: async () => ({ model: 'served', answers: {
      unsolicited: { type: 'noul', noul: 1 },
      ...Object.fromEntries(Object.keys(body.questions).reverse().map(id => [id, { type: 'noul', noul: 0.75 }]))
    } }) };
  };
  return classifier.getConfig();
}
async function candidates(count, snapshot, criteria = []) {
  return Promise.all(Array.from({ length: count }, async (_, i) => {
    const criterion = criteria[i] ?? `criterion ${i}`;
    return { id: `rule_${i}`, rule: { criterion, actions: [] }, cacheKey: await classifier.buildCacheKey(1, criterion, snapshot) };
  }));
}
async function collect(items, snapshot) {
  const results = [];
  for await (const value of classifier.classifyRules('email state', items, snapshot)) results.push(value);
  return results;
}

test('Process all, explicit batch sizes, partial batches, empty input and cache reuse', async () => {
  for (const [settings, expected] of [
    [{}, [10]], [{ systemOneProcessAll: false, systemOneBatchSize: 8 }, [8, 2]],
    [{ systemOneProcessAll: false, systemOneBatchSize: 1 }, Array(10).fill(1)]
  ]) {
    const snapshot = await setup(settings);
    const items = await candidates(10, snapshot);
    const results = await collect(items, snapshot);
    assert.deepEqual(requests.map(r => Object.keys(r.body.questions).length), expected);
    assert.equal(cacheWrites, expected.length);
    assert.deepEqual(results.map(r => r.rule.criterion), items.map(r => r.rule.criterion));
    assert.ok(results.every(r => r.result.probability === 0.75));
    assert.ok(requests.every(r => r.body.state === 'email state' && !('messages' in r.body)));
    await collect(items, snapshot);
    assert.equal(requests.length, expected.length);
    await collect([], snapshot);
    assert.equal(requests.length, expected.length);
  }
});

test('cached rules consume no capacity and duplicate criteria use independent thresholds', async () => {
  const snapshot = await setup({ systemOneProcessAll: false, systemOneBatchSize: 2 });
  const items = await candidates(5, snapshot, ['cached', 'same', 'cached', 'other', 'same']);
  await collect([items[0]], snapshot);
  requests = []; cacheWrites = 0;
  items[1].rule.decisionThreshold = 0.8;
  items[4].rule.decisionThreshold = 0.7;
  const results = await collect(items, snapshot);
  assert.equal(requests.length, 1);
  assert.deepEqual(Object.keys(requests[0].body.questions), ['rule_1', 'rule_3']);
  assert.equal(results[1].result.matched, false);
  assert.equal(results[4].result.matched, true);
  assert.equal(cacheWrites, 1);
  assert.equal(await classifier.buildCacheKey(1, 'same', { ...snapshot, systemOneProcessAll: true, systemOneBatchSize: 100 }), items[1].cacheKey);
});

test('answer identity determines probability, not answer order', () => {
  const result = { answers: { rule_2: { type: 'noul', noul: 0 }, rule_1: { type: 'noul', noul: 1 } } };
  assert.deepEqual(systemone.parseBatchResponse(result, [{ id: 'rule_1' }, { id: 'rule_2' }]).map(r => r.probability), [1, 0]);
});

test('failed batches neither yield nor cache partial results and do not retry', async () => {
  for (const failure of ['missing', 'invalid', 'http']) {
    const snapshot = await setup();
    const items = await candidates(2, snapshot);
    let calls = 0, yielded = 0;
    globalThis.fetch = async () => {
      calls++;
      return { ok: failure !== 'http', status: 413, json: async () => ({ answers: {
        rule_0: { type: 'noul', noul: 0.9 },
        ...(failure === 'invalid' ? { rule_1: { type: 'noul', noul: '0.9' } } : {})
      } }) };
    };
    await assert.rejects(async () => {
      for await (const value of classifier.classifyRules('state', items, snapshot)) yielded++;
    });
    assert.equal(yielded, 0);
    assert.equal(calls, 1);
    assert.equal(cacheWrites, 0);
    assert.equal(await classifier.getCacheSize(), 0);
  }
});

test('clearing or importing during a batch prevents stale cache writes', async () => {
  for (const replace of [() => classifier.clearCache(), () => classifier.replaceCache({})]) {
    const snapshot = await setup();
    const items = await candidates(2, snapshot);
    const fetch = globalThis.fetch;
    globalThis.fetch = async (...args) => { await replace(); return fetch(...args); };
    const results = await collect(items, snapshot);
    assert.equal(results.length, 2);
    assert.equal(requests.length, 1);
    assert.equal(await classifier.getCacheSize(), 0);
  }
});

test('Chat Completions remains lazy and sequential', async () => {
  const snapshot = await setup({ apiType: 'chat-completions' });
  const items = await candidates(3, snapshot);
  globalThis.fetch = async (url, request) => {
    requests.push(JSON.parse(request.body));
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"match":true}' } }] }) };
  };
  for await (const value of classifier.classifyRules('state', items, snapshot)) break;
  assert.equal(requests.length, 1);
  assert.ok(Array.isArray(requests[0].messages));
});

test('batch settings validate and survive import', async () => {
  for (const value of [0, -1, 1.2, Infinity, '8', null]) assert.throws(() => validateSettings({ systemOneBatchSize: value }));
  assert.throws(() => validateSettings({ systemOneProcessAll: 'true' }));
  await transfer.importData({ text: async () => JSON.stringify({ systemOneProcessAll: false, systemOneBatchSize: 3 }) }, ['settings']);
  assert.equal(data.systemOneProcessAll, false);
  assert.equal(data.systemOneBatchSize, 3);
  await assert.rejects(transfer.importData({ text: async () => '{"systemOneBatchSize":0}' }, ['settings']));
});

// Exercise the action runner with the real lazy classifier and mocked mail APIs.
const source = await readFile(new URL('../background.js', import.meta.url), 'utf8');
// The message-id helpers live at module level; processMessage depends on them.
const helpers = source.slice(source.indexOf('const MESSAGE_GONE_PATTERN'), source.indexOf('function normalizeRules'));
const functions = source.slice(source.indexOf('async function processMessage('), source.indexOf('async function clearCacheForMessages('));
test('stop after match skips later actions and batches; all-mode retains later evidence', async () => {
  for (const processAll of [true, false]) {
    const snapshot = await setup({ systemOneProcessAll: processAll, systemOneBatchSize: 2 });
    const actions = [], errors = [];
    const rules = Array.from({ length: 5 }, (_, i) => ({ criterion: `rule ${i}`, actions: [{ type: 'flag', flagged: true }], stopProcessing: i === 1 }));
    const context = vm.createContext({
      structuredClone, Date, Error, aiRules: rules, AiClassifier: classifier,
      t: translatorFor(await loadMessages()),
      queue: Promise.resolve(), queuedCount: 0, processing: false, currentStart: 0,
      tokenReduction: false, showDebugTab: false, timingStats: {},
      updateActionIcon() {}, updateTimingStats() {}, showTransientIcon() {},
      buildEmailText() { return 'state'; }, ICONS: { circle: 'circle' },
      logger: { aiLog() {} }, recordError(...args) { errors.push(args); }, ERROR_NOTIFICATION_ID: 'error',
      storage: messenger.storage,
      messenger: { messages: {
        async getFull() { return {}; }, async get() { return { tags: [], folder: { accountId: 'account' }, headerMessageId: 'message-1@example.com' }; },
        async update(id, value) { actions.push({ id, value }); },
        async query() { return { messages: [] }; }
      }, identities: { async list() { return []; } }, folders: { async query() { return { folders: [] }; } } },
      browser: { runtime: { getURL: x => x }, notifications: { async create() {} } }
    });
    vm.runInContext(`${helpers}\n${functions}`, context);
    await vm.runInContext('applyAiRules([1])', context);
    assert.equal(errors.length, 0);
    assert.equal(actions.length, 2);
    assert.equal(requests.length, 1);
    assert.equal(Object.keys(requests[0].body.questions).length, processAll ? 5 : 2);
    assert.equal(await classifier.getCacheSize(), processAll ? 5 : 2);
  }
});

test('batch controls default to all and retain numeric input across toggles and API switches', async () => {
  const optionsSource = await readFile(new URL('../options/options.js', import.meta.url), 'utf8');
  const section = optionsSource.slice(optionsSource.indexOf('    const apiTypeInput ='), optionsSource.indexOf('    const endpointInput ='));
  const fields = new Map();
  const field = id => {
    if (!fields.has(id)) fields.set(id, {
      value: '', checked: false, disabled: false, listeners: {},
      addEventListener(event, fn) { this.listeners[event] = fn; },
      classList: { toggle() {} }, closest() { return this; }
    });
    return fields.get(id);
  };
  const context = vm.createContext({
    defaults: { apiType: 'systemone' }, DEFAULT_AI_PARAMS: {}, migratedInputLimit() { return 3686; },
    t: translatorFor(await loadMessages()),
    updateEndpointPreview() {}, document: { getElementById: field, querySelectorAll() { return []; } }
  });
  vm.runInContext(`${section}\nupdateApiControls();`, context);
  const all = field('systemone-process-all'), size = field('systemone-batch-size'), api = field('api-type');
  assert.equal(all.checked, true);
  assert.equal(size.value, 8);
  assert.equal(size.disabled, true);
  all.checked = false; all.listeners.change();
  assert.equal(size.disabled, false);
  size.value = '3';
  all.checked = true; all.listeners.change();
  assert.equal(size.disabled, true);
  all.checked = false; all.listeners.change();
  assert.equal(size.value, '3');
  api.value = 'chat-completions'; api.listeners.change();
  assert.equal(size.disabled, true);
  api.value = 'systemone'; api.listeners.change();
  assert.equal(size.disabled, false);
  assert.equal(size.value, '3');
});

test('batch settings remain fixed while a per-email snapshot is running', async () => {
  const snapshot = await setup({ systemOneProcessAll: false, systemOneBatchSize: 2 });
  const items = await candidates(5, snapshot);
  const fetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    classifier.setConfig({ systemOneProcessAll: true, systemOneBatchSize: 1 });
    return fetch(...args);
  };
  await collect(items, snapshot);
  assert.deepEqual(requests.map(r => Object.keys(r.body.questions).length), [2, 2, 1]);
});
