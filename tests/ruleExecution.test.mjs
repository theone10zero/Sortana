import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// Run the actual background rule/queue functions with Thunderbird services mocked.
const source = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('async function processMessage('), source.indexOf('async function clearCacheForMessages('));
function runner({ fail = false, changeSettings = false } = {}) {
  const actions = [], evaluated = [], errors = [];
  const rules = [
    { criterion: 'first', decisionThreshold: 0.8, actions: [{ type: 'flag', flagged: true }], stopProcessing: true },
    { criterion: 'second', actions: [{ type: 'read', read: true }] }
  ];
  let currentConfig = { apiType: 'systemone', inputCharacterLimit: 5, decisionThreshold: 0.5 };
  const context = vm.createContext({
    structuredClone, Date, Error,
    aiRules: rules, queue: Promise.resolve(), queuedCount: 0, processing: false,
    currentStart: 0, tokenReduction: true, showDebugTab: false, timingStats: {},
    updateActionIcon() {}, updateTimingStats() {}, showTransientIcon() {},
    buildEmailText() { return 'email contents'; }, ICONS: { circle: 'circle' },
    logger: { aiLog() {} }, recordError(...args) { errors.push(args); },
    ERROR_NOTIFICATION_ID: 'error',
    storage: { local: { async set() {} } },
    messenger: {
      messages: {
        async getFull() { return {}; },
        async get() {
          if (changeSettings) {
            rules[0].decisionThreshold = 0.1;
            currentConfig = { apiType: 'chat-completions', decisionThreshold: 0.1 };
          }
          return { tags: [], folder: { accountId: 'account' } };
        },
        async update(id, action) { actions.push({ id, ...action }); }
      }, identities: { async list() { return []; } }
    },
    browser: { runtime: { getURL: x => x }, notifications: { async create() {} } },
    AiClassifier: {
      getConfig() { return structuredClone(currentConfig); },
      async buildCacheKey(id, criterion) { return `${id}:${criterion}`; },
      async *classifyRules(text, candidates, snapshot) {
        for (const { rule, cacheKey } of candidates) {
          evaluated.push({ text, criterion: rule.criterion, cacheKey, snapshot,
            threshold: rule.decisionThreshold ?? snapshot.decisionThreshold });
          if (fail && cacheKey.startsWith('1:')) throw new Error('inference failed');
          yield { rule, result: { matched: true } };
        }
      }
    }
  });
  vm.runInContext(functions, context);
  return { context, actions, evaluated, errors };
}

test('failure stops remaining rules for one email, next queued email still acts', async () => {
  const { context, actions, evaluated, errors } = runner({ fail: true });
  await vm.runInContext('applyAiRules([1, 2])', context);
  assert.deepEqual(evaluated.map(x => x.cacheKey), ['1:first', '2:first']);
  assert.deepEqual(actions, [{ id: 2, flagged: true }]);
  assert.equal(errors.length, 1);
  assert.equal(context.processing, false);
  assert.equal(context.queuedCount, 0);
});

test('settings and rules remain fixed during an email; reduction uses characters', async () => {
  const { context, evaluated, actions } = runner({ changeSettings: true });
  await vm.runInContext('applyAiRules([1])', context);
  assert.equal(evaluated[0].text, 'email');
  assert.equal(evaluated[0].threshold, 0.8);
  assert.equal(evaluated[0].snapshot.apiType, 'systemone');
  assert.equal(evaluated.length, 1); // stop after first match
  assert.equal(actions.length, 1);
});

test('inherited thresholds and eligibility preserve ordered rule processing', async () => {
  const { context, evaluated, actions } = runner();
  context.aiRules[0].enabled = false;
  await vm.runInContext('applyAiRules([1])', context);
  assert.equal(evaluated[0].criterion, 'second');
  assert.equal(evaluated[0].threshold, 0.5);
  assert.deepEqual(actions, [{ id: 1, read: true }]);
});
