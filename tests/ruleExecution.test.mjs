import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { loadMessages, translatorFor } from './support/i18n.js';

// Run the actual background rule/queue functions with Thunderbird services mocked.
const t = translatorFor(await loadMessages());
const source = await readFile(new URL('../background.js', import.meta.url), 'utf8');
// The message-id helpers live at module level; processMessage depends on them.
const helpers = source.slice(source.indexOf('const MESSAGE_GONE_PATTERN'), source.indexOf('function normalizeRules'));
const functions = source.slice(source.indexOf('async function processMessage('), source.indexOf('async function clearCacheForMessages('));

function runner({ fail = false, changeSettings = false, rules: customRules = null, store = null } = {}) {
  const actions = [], evaluated = [], errors = [];
  const rules = customRules || [
    { criterion: 'first', decisionThreshold: 0.8, actions: [{ type: 'flag', flagged: true }], stopProcessing: true },
    { criterion: 'second', actions: [{ type: 'read', read: true }] }
  ];
  // Models Thunderbird's message tracker: only the ids that are currently
  // valid resolve, and a move replaces the id the message is tracked under.
  const seed = store || {};
  const live = new Map();
  function entry(id) {
    if (!live.has(id)) {
      live.set(id, {
        id,
        headerMessageId: seed.headerMessageId || `message-${id}@example.com`,
        folder: seed.folder || 'Inbox',
        gone: seed.gone === true
      });
    }
    return live.get(id);
  }
  let currentConfig = { apiType: 'systemone', inputCharacterLimit: 5, decisionThreshold: 0.5 };
  const gone = id => new Error(`Message not found: ${id}.`);
  const context = vm.createContext({
    structuredClone, Date, Error,
    t,
    aiRules: rules, queue: Promise.resolve(), queuedCount: 0, processing: false,
    currentStart: 0, tokenReduction: true, showDebugTab: false, timingStats: {},
    updateActionIcon() {}, updateTimingStats() {}, showTransientIcon() {},
    buildEmailSummary() { return 'email contents'; }, ICONS: { circle: 'circle' },
    logger: { aiLog() {} }, recordError(...args) { errors.push(args); },
    ERROR_NOTIFICATION_ID: 'error',
    storage: { local: { async set() {} } },
    messenger: {
      messages: {
        async getFull(id) {
          if (seed.goneOnGetFull) throw gone(id);
          return {};
        },
        async get(id) {
          if (changeSettings) {
            rules[0].decisionThreshold = 0.1;
            currentConfig = { apiType: 'chat-completions', decisionThreshold: 0.1 };
          }
          const message = entry(id);
          if (message.gone) throw gone(id);
          if (seed.headerError) throw new Error(seed.headerError);
          return { tags: [], folder: { accountId: 'account' }, headerMessageId: message.headerMessageId, read: false, date: Date.now() };
        },
        async update(id, action) {
          const message = live.get(id);
          if (!message || message.gone) throw new Error(`Error updating message: Message not found: ${id}.`);
          actions.push({ id, ...action });
        },
        async move([id], folder) {
          const message = live.get(id);
          if (!message || message.gone) throw gone(id);
          live.delete(id);
          message.id = 900 + id;
          message.folder = folder;
          live.set(message.id, message);
        },
        async copy([id], target) {
          const message = live.get(id);
          if (!message || message.gone) throw gone(id);
          actions.push({ id, copiedTo: target });
        },
        async delete([id]) {
          const message = live.get(id);
          if (!message || message.gone) throw gone(id);
          live.delete(id);
          message.gone = true;
        },
        async archive([id]) {
          const message = live.get(id);
          if (!message || message.gone) throw gone(id);
          live.delete(id);
          message.id = 900 + id;
          message.folder = 'Archives';
          live.set(message.id, message);
        },
        async query(criteria) {
          const found = [...live.values()].filter(message =>
            !message.gone &&
            (!criteria.headerMessageId || criteria.headerMessageId === message.headerMessageId) &&
            (!criteria.folder || criteria.folder === message.folder));
          return { messages: found.map(message => ({ id: message.id })) };
        }
      },
      identities: { async list() { return []; } },
      folders: { async query() { return { folders: [{ id: 'archives-folder' }] }; } }
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
  vm.runInContext(`${helpers}\n${functions}`, context);
  return { context, actions, evaluated, errors, live };
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

test('an update configured after a move still applies to the message', async () => {
  // The move invalidates the tracker id, so the update must either run first
  // or follow the message to its new folder.
  const { context, actions, errors } = runner({
    rules: [{ criterion: 'first', actions: [{ type: 'move', folder: 'Archive' }, { type: 'read', read: true }] }]
  });
  await vm.runInContext('applyAiRules([1])', context);
  assert.deepEqual(errors, []);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].read, true);
});

test('a later rule acts on the new id of a message an earlier rule moved', async () => {
  const { context, actions, errors } = runner({
    rules: [
      { criterion: 'first', actions: [{ type: 'move', folder: 'Archive' }] },
      { criterion: 'second', actions: [{ type: 'read', read: true }] }
    ]
  });
  await vm.runInContext('applyAiRules([1])', context);
  assert.deepEqual(errors, []);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].read, true);
  assert.equal(actions[0].id, 901, 'the action must use the id of the moved message');
});

test('a message that disappeared is skipped instead of failing the email', async () => {
  const { context, actions, evaluated, errors } = runner({
    rules: [
      { criterion: 'first', actions: [{ type: 'read', read: true }] },
      { criterion: 'second', actions: [{ type: 'flag', flagged: true }] }
    ],
    store: { id: 1, headerMessageId: 'message-1@example.com', folder: 'Inbox', gone: true }
  });
  await vm.runInContext('applyAiRules([1])', context);
  assert.deepEqual(actions, []);
  assert.deepEqual(evaluated, [], 'a vanished message must not be classified at all');
  assert.deepEqual(errors, [], 'a vanished message must not raise a user facing error');
  assert.equal(context.processing, false);
});

test('a message that vanished before it could be read is skipped', async () => {
  const { context, actions, evaluated, errors } = runner({
    rules: [{ criterion: 'first', actions: [{ type: 'read', read: true }] }],
    store: { goneOnGetFull: true }
  });
  await vm.runInContext('applyAiRules([1])', context);
  assert.deepEqual(actions, []);
  assert.deepEqual(evaluated, [], 'a vanished message must not be classified at all');
  assert.deepEqual(errors, [], 'a vanished message must not raise a user facing error');
  assert.equal(context.processing, false);
});

test('the same message queued twice is processed once', async () => {
  const { context, evaluated } = runner({
    rules: [{ criterion: 'first', actions: [{ type: 'flag', flagged: true }] }]
  });
  await vm.runInContext('applyAiRules([1, 1])', context);
  assert.equal(evaluated.length, 1, 'a duplicate id must not be classified twice');
});

test('a message can be applied again once it has been processed', async () => {
  const { context, evaluated } = runner({
    rules: [{ criterion: 'first', actions: [{ type: 'flag', flagged: true }] }]
  });
  await vm.runInContext('applyAiRules([1])', context);
  await vm.runInContext('applyAiRules([1])', context);
  assert.equal(evaluated.length, 2, 'a finished message must not stay blocked');
});

test('the existing tags survive a header that cannot be read', async () => {
  const { context, actions, errors } = runner({
    rules: [{ criterion: 'first', actions: [{ type: 'tag', tagKey: 'new' }] }],
    store: { headerError: 'the header is unavailable' }
  });
  await vm.runInContext('applyAiRules([1])', context);
  assert.deepEqual(actions, [], 'an unknown tag list must not be written over the existing tags');
  assert.deepEqual(errors, []);
});

test('a rule restricted to an account stays out of scope when the header cannot be read', async () => {
  const { context, evaluated, errors } = runner({
    rules: [{ criterion: 'first', accounts: ['account'], actions: [{ type: 'flag', flagged: true }] }],
    store: { headerError: 'the header is unavailable' }
  });
  await vm.runInContext('applyAiRules([1])', context);
  assert.deepEqual(evaluated, [], 'a restricted rule must not act on a message whose scope is unknown');
  assert.deepEqual(errors, []);
});

test('a message that cannot be followed after a move is skipped without an error', async () => {
  const { context, actions, errors, live } = runner({
    rules: [{ criterion: 'first', actions: [{ type: 'move', folder: 'Archive' }, { type: 'delete' }] }],
    store: { headerError: 'the header is unavailable' }
  });
  await vm.runInContext('applyAiRules([1])', context);
  assert.deepEqual(actions, []);
  assert.deepEqual(errors, []);
  assert.ok(live.get(901), 'the moved message must not be deleted');
  assert.notEqual(live.get(901)?.gone, true);
});

test('deleting a message stops the remaining actions on it', async () => {
  const { context, actions, errors } = runner({
    rules: [
      { criterion: 'first', actions: [{ type: 'delete' }] },
      { criterion: 'second', actions: [{ type: 'read', read: true }] }
    ]
  });
  await vm.runInContext('applyAiRules([1])', context);
  assert.deepEqual(actions, []);
  assert.deepEqual(errors, []);
});
