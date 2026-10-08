import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { CONFIG_DEFAULTS } from '../modules/classificationConfig.js';

const persisted = {};
const listeners = [];
const storage = {
  local: {
    async get(keys) {
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys])
        .filter(key => key in persisted).map(key => [key, structuredClone(persisted[key])]));
    },
    async set(values) {
      const changes = {};
      for (const [key, value] of Object.entries(values)) {
        changes[key] = { oldValue: persisted[key], newValue: structuredClone(value) };
        persisted[key] = structuredClone(value);
      }
      for (const listener of listeners) await listener(changes, 'local');
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete persisted[key];
    }
  },
  onChanged: { addListener(listener) { listeners.push(listener); } }
};
const messenger = { storage, messages: { async get(id) {
  // Numeric Thunderbird IDs may change after reinstall; RFC Message-ID does not.
  return { subject: 'Invoice', headerMessageId: 'persistent-message@example.com' };
} } };
globalThis.messenger = messenger;
const classifier = await import('../modules/AiClassifier.js');
const transfer = await import('../options/dataTransfer.js');
const source = await readFile(new URL('../background.js', import.meta.url), 'utf8');
let onMessage;
const context = vm.createContext({
  storage, messenger, structuredClone, AiClassifier: classifier, aiRules: [],
  logger: { aiLog() {} }, logGetTiming: false,
  htmlToMarkdown: false, stripUrlParams: false, altTextImages: false,
  collapseWhitespace: false, tokenReduction: false, showDebugTab: false,
  browser: { runtime: { onMessage: { addListener(listener) { onMessage = listener; } } } }
});
// Exercise the actual background storage and Details handlers, not a manual cache reload.
const normalizeStart = source.indexOf('function normalizeRules(');
vm.runInContext(source.slice(normalizeStart, source.indexOf('function iconPaths(', normalizeStart)), context);
const changesStart = source.indexOf('storage.onChanged.addListener(');
vm.runInContext(source.slice(changesStart, source.indexOf('\n\n        if (browser.theme', changesStart)), context);
const messageStart = source.indexOf('browser.runtime.onMessage.addListener(');
vm.runInContext(source.slice(messageStart, source.indexOf('\n\n    // Automatically classify', messageStart)), context);

test('export/reinstall/import restores Details immediately with changed Thunderbird IDs', async () => {
  const settings = { ...CONFIG_DEFAULTS, systemOneProcessAll: false, systemOneBatchSize: 3, apiType: 'systemone', endpoint: 'http://decision-server:8080', tokenReduction: true, inputCharacterLimit: 5000 };
  const rules = [{ criterion: 'invoice', decisionThreshold: 0.8, actions: [] }];
  await storage.local.set({ ...settings, aiRules: rules });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ answers: { match: { type: 'noul', noul: 0.9 } } }) });
  const key = await classifier.buildCacheKey(1, 'invoice');
  await classifier.classify('Invoice attached', 'invoice', { cacheKey: key, threshold: 0.8 });
  let exported;
  const originalDocument = globalThis.document;
  const createURL = URL.createObjectURL;
  const revokeURL = URL.revokeObjectURL;
  URL.createObjectURL = blob => { exported = blob; return 'blob:export'; };
  URL.revokeObjectURL = () => {};
  globalThis.document = { body: { appendChild() {} }, createElement() { return { click() {}, remove() {} }; } };
  try { await transfer.exportData(['settings', 'rules', 'cache']); }
  finally { globalThis.document = originalDocument; URL.createObjectURL = createURL; URL.revokeObjectURL = revokeURL; }
  await classifier.clearCache();
  for (const key of Object.keys(persisted)) delete persisted[key];
  classifier.setConfig(CONFIG_DEFAULTS);
  context.aiRules = [];
  assert.equal((await onMessage({ type: 'sortana:getDetails', id: 99 })).results.length, 0);
  await transfer.importData(exported, ['settings', 'rules', 'cache']);
  assert.equal((await onMessage({ type: 'sortana:getCacheSize' })).count, 1);
  assert.equal(classifier.getConfig().systemOneProcessAll, false);
  assert.equal(classifier.getConfig().systemOneBatchSize, 3);
  const details = await onMessage({ type: 'sortana:getDetails', id: 99 });
  assert.equal(details.results.length, 1);
  assert.equal(details.results[0].criterion, 'invoice');
  assert.equal(details.results[0].probability, 0.9);
  assert.equal(details.results[0].threshold, 0.8);
  assert.equal(details.results[0].matched, true);
  globalThis.fetch = () => { throw new Error('Restored cache must avoid inference'); };
  assert.equal((await classifier.classify('Invoice attached', 'invoice', { cacheKey: await classifier.buildCacheKey(99, 'invoice') })).matched, true);
});
