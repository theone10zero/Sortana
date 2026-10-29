"use strict";
import { aiLog, setDebug } from '../logger.js';
import { CONFIG_DEFAULTS, validateSettings, validateThreshold } from './classificationConfig.js';
import * as chat from './backends/chatCompletions.js';
import * as systemone from './backends/systemOne.js';
const storage = (globalThis.messenger ?? globalThis.browser).storage;
const adapters = { 'chat-completions': chat, systemone };
// The reason recorded for a criterion the model did not answer. The result is
// not cached, so a later run can ask for that criterion again.
const MISSING_REASON = 'The model did not answer this criterion; treated as a non-match.';
let config = structuredClone(CONFIG_DEFAULTS);
let cache = new Map();
let loaded = false;
let loading;
let generation = 0;

export function normalizeEndpointBase(endpoint) {
  if (typeof endpoint !== 'string' || !endpoint.trim()) return '';
  return endpoint.trim().replace(/\/+$/, '').replace(/\/v1(?:\/(?:chat\/completions|completions|models|systemone))?$/i, '');
}
function urlFor(endpoint, path) {
  const base = normalizeEndpointBase(endpoint);
  return base ? `${/^https?:\/\//i.test(base) ? base : `https://${base}`}${path}` : '';
}
export function buildEndpointUrl(endpoint, apiType = 'chat-completions') {
  if (!adapters[apiType]) throw new Error('Unknown API type.');
  return urlFor(endpoint, adapters[apiType].path);
}
export function buildModelsUrl(endpoint) { return urlFor(endpoint, '/v1/models'); }
export function getConfig() { return structuredClone(config); }
export function setConfig(update = {}) {
  validateSettings(update);
  for (const key of Object.keys(CONFIG_DEFAULTS)) {
    if (update[key] !== undefined) config[key] = structuredClone(update[key]);
  }
  config.aiParams = { ...CONFIG_DEFAULTS.aiParams, ...config.aiParams };
  for (const key of ['model', 'apiKey', 'openaiOrganization', 'openaiProject']) config[key] = String(config[key]).trim();
  setDebug(config.debugLogging);
}
async function hash(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
// The same pattern the rule runner uses. A message that was moved or
// deleted is gone from Thunderbird's tracker, so its header cannot be read.
const MESSAGE_GONE_PATTERN = /message not found/i;

async function messageHash(id) {
  const api = globalThis.messenger ?? globalThis.browser;
  if (typeof id === 'number' && api.messages?.get) {
    try {
      const header = await api.messages.get(id);
      id = header.headerMessageId || id;
    } catch (error) {
      // The message was removed before its cache key could be computed. Such
      // a key is only reachable for a message that no longer exists, so the
      // tracker id is a safe stand-in and the lookup must not fail the whole
      // email with an error the user cannot act on.
      if (!MESSAGE_GONE_PATTERN.test(String(error?.message || ''))) throw error;
    }
  }
  return hash(String(id));
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
export async function buildCacheKey(id, criterion, snapshot = getConfig()) {
  const fingerprint = {
    backend: snapshot.apiType, endpoint: buildEndpointUrl(snapshot.endpoint, snapshot.apiType),
    request: adapters[snapshot.apiType].buildRequest('', [criterion], snapshot),
    organization: snapshot.apiType === 'chat-completions' ? snapshot.openaiOrganization : '',
    project: snapshot.apiType === 'chat-completions' ? snapshot.openaiProject : '',
    preprocessing: Object.fromEntries(['htmlToMarkdown', 'stripUrlParams', 'altTextImages', 'collapseWhitespace', 'tokenReduction', 'inputCharacterLimit'].map(k => [k, snapshot[k]]))
  };
  return `v4:${await messageHash(id)}:${await hash(JSON.stringify(stable(fingerprint)))}`;
}
export function validCacheEntry(key, entry) {
  return /^v4:[a-f0-9]{64}:[a-f0-9]{64}$/.test(key) && entry?.version === 4 &&
    entry.messageHash === key.split(':')[1] && typeof entry.model === 'string' &&
    (entry.backend === 'systemone'
      ? typeof entry.probability === 'number' && Number.isFinite(entry.probability) && entry.probability >= 0 && entry.probability <= 1 && entry.reason === null
      : entry.backend === 'chat-completions' && typeof entry.matched === 'boolean' && entry.probability === null && (entry.reason === null || typeof entry.reason === 'string'));
}
export function replaceCache(data = {}) {
  cache = new Map(Object.entries(data || {}).filter(([key, entry]) => validCacheEntry(key, entry)));
  loaded = true;
  generation++;
}
async function saveCache() { await storage.local.set({ aiCache: Object.fromEntries(cache) }); }
export async function init() {
  if (loaded) return;
  if (!loading) loading = (async () => {
    const { aiCache = {}, aiReasonCache } = await storage.local.get(['aiCache', 'aiReasonCache']);
    replaceCache(aiCache);
    if (Object.keys(aiCache || {}).length !== cache.size) await saveCache();
    if (aiReasonCache !== undefined) await storage.local.remove('aiReasonCache');
  })().finally(() => { loading = null; });
  await loading;
}
function withPolicy(entry, threshold) {
  const isDecision = entry.backend === 'systemone';
  if (isDecision) validateThreshold(threshold);
  return { matched: isDecision ? entry.probability >= threshold : entry.matched,
    reason: entry.reason, probability: entry.probability, threshold: isDecision ? threshold : null,
    backend: entry.backend, model: entry.model };
}
export function getCachedDetails(key, threshold = config.decisionThreshold) {
  const entry = cache.get(key);
  return entry ? withPolicy(entry, threshold) : null;
}
export function getCachedResult(key, threshold) { return getCachedDetails(key, threshold)?.matched ?? null; }
export function getReason(key) { return cache.get(key)?.reason ?? null; }
async function sendRequest(payload, snapshot) {
  try { await storage.local.set({ lastPayload: payload }); }
  catch (error) { aiLog('Failed to save last payload', { level: 'warn' }, error); }
  const headers = { 'Content-Type': 'application/json' };
  if (snapshot.apiKey) headers.Authorization = `Bearer ${snapshot.apiKey}`;
  if (snapshot.apiType === 'chat-completions') {
    if (snapshot.openaiOrganization) headers['OpenAI-Organization'] = snapshot.openaiOrganization;
    if (snapshot.openaiProject) headers['OpenAI-Project'] = snapshot.openaiProject;
  }
  const endpoint = buildEndpointUrl(snapshot.endpoint, snapshot.apiType);
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      const message = body?.error?.message;
      if (typeof message === 'string') detail = ` Server response: ${message.slice(0, 300)}.`;
    } catch { /* Non-JSON error responses still report the URL and status. */ }
    const hint = response.status === 404 && snapshot.apiType === 'systemone'
      ? ' Verify that the running server build supports /v1/systemone and the selected decision model.' : '';
    throw new Error(`Classification request failed: HTTP ${response.status} at ${endpoint}.${detail}${hint}`);
  }
  return response.json();
}

export async function classify(text, criterion, { cacheKey = null, snapshot = getConfig(), threshold = snapshot.decisionThreshold } = {}) {
  await init();
  if (snapshot.apiType === 'systemone') validateThreshold(threshold);
  const cached = getCachedDetails(cacheKey, threshold);
  if (cached) return cached;
  const epoch = generation;
  const adapter = adapters[snapshot.apiType];
  const payload = adapter.buildRequest(text, criterion, snapshot);
  const raw = await sendRequest(payload, snapshot);
  const parsed = adapter.parseResponse(raw);
  // Chat Completions returns one slot per criterion; a single criterion uses
  // the first one. An empty slot means the model did not answer.
  const answer = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!answer) throw new Error('The model did not answer this criterion.');
  const entry = { ...answer, backend: snapshot.apiType,
    model: typeof raw.model === 'string' ? raw.model : snapshot.model, version: 4,
    messageHash: cacheKey?.split(':')[1] };
  if (cacheKey && epoch === generation) {
    cache.set(cacheKey, entry);
    await saveCache();
  }
  return withPolicy(entry, threshold);
}
// Yield lazily so the action runner can stop without starting the next request.
// Candidates have precomputed keys, allowing actions to move/delete the message.
export async function* classifyRules(text, candidates, snapshot = getConfig()) {
  await init();
  validateSettings(snapshot);

  // First pass: collect cached evidence for all candidates.
  const evidence = new Map();
  for (const candidate of candidates) {
    const threshold = candidate.rule.decisionThreshold ?? snapshot.decisionThreshold;
    validateThreshold(threshold);
    const entry = cache.get(candidate.cacheKey);
    if (entry) evidence.set(candidate.cacheKey, entry);
  }

  // For both Chat Completions and SystemOne, batch the uncached criteria.
  const adapter = adapters[snapshot.apiType];
  const isSystemOne = snapshot.apiType === 'systemone';
  const limit = isSystemOne
    ? (snapshot.systemOneProcessAll ? Infinity : snapshot.systemOneBatchSize)
    : candidates.length; // Chat Completions: send all at once

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    if (evidence.has(candidate.cacheKey)) {
      yield { rule: candidate.rule, result: withPolicy(evidence.get(candidate.cacheKey),
        candidate.rule.decisionThreshold ?? snapshot.decisionThreshold) };
      continue;
    }

    // Gather the next batch of uncached criteria.
    const pending = new Map();
    for (let next = index; next < candidates.length && pending.size < limit; next++) {
      const item = candidates[next];
      if (!evidence.has(item.cacheKey) && !pending.has(item.cacheKey)) {
        pending.set(item.cacheKey, { ...item, criterion: item.rule.criterion });
      }
    }
    const questions = [...pending.values()];
    const criteria = questions.map(q => q.criterion);

    const epoch = generation;
    let raw;
    let parsed;
    if (isSystemOne) {
      raw = await sendRequest(systemone.buildBatchRequest(text, questions, snapshot), snapshot);
      parsed = systemone.parseBatchResponse(raw, questions);
    } else {
      // The number of each criterion identifies it in the answer.
      const labels = criteria.map((_, index) => index + 1);
      raw = await sendRequest(chat.buildRequest(text, criteria, snapshot), snapshot);
      parsed = chat.parseBatchResponse(raw, criteria, labels);
      // A model may skip a criterion. Ask again for the ones it left out,
      // with a shorter list, before treating them as unanswered. The retry
      // keeps the original numbers so a number still names the same criterion.
      const missing = parsed.map((value, index) => (value === null ? index : -1)).filter(index => index >= 0);
      if (missing.length) {
        const missingCriteria = missing.map(index => criteria[index]);
        const missingLabels = missing.map(index => labels[index]);
        aiLog(`Model skipped ${missing.length} of ${criteria.length} criteria; asking again`, { level: 'warn' });
        const retryRaw = await sendRequest(
          chat.buildRequest(text, missingCriteria, snapshot, missingLabels), snapshot);
        const retryParsed = chat.parseBatchResponse(retryRaw, missingCriteria, missingLabels);
        retryParsed.forEach((value, index) => {
          if (value) parsed[missing[index]] = value;
        });
      }
    }

    // Parse the complete batch before accepting any of its evidence. A
    // criterion the model never answered counts as a non-match, and it is not
    // cached, so a later run can ask for it again.
    const entries = questions.map((question, i) => ({
      key: question.cacheKey,
      answered: parsed[i] !== null,
      entry: {
        ...(parsed[i] || { matched: false, reason: MISSING_REASON, probability: null }),
        backend: snapshot.apiType, version: 4,
        model: typeof raw.model === 'string' ? raw.model : snapshot.model,
        messageHash: question.cacheKey.split(':')[1]
      }
    }));
    for (const { key, entry } of entries) evidence.set(key, entry);
    if (epoch === generation) {
      // Only evidence the model actually produced is persisted.
      for (const { key, entry, answered } of entries) {
        if (answered) cache.set(key, entry);
      }
      await saveCache();
    }

    yield { rule: candidate.rule, result: withPolicy(evidence.get(candidate.cacheKey),
      candidate.rule.decisionThreshold ?? snapshot.decisionThreshold) };
  }
}

export async function classifyText(text, criterion, cacheKey = null) { return (await classify(text, criterion, { cacheKey })).matched; }
export async function removeCacheEntries(keys = []) {
  await init(); generation++;
  for (const key of Array.isArray(keys) ? keys : [keys]) cache.delete(key);
  await saveCache();
}
export async function clearCacheForMessage(id) {
  await init();
  const identifier = await messageHash(id);
  await removeCacheEntries([...cache].filter(([, entry]) => entry.messageHash === identifier).map(([key]) => key));
}
export async function clearCache() { await init(); generation++; cache.clear(); await saveCache(); }
export async function getCacheSize() { await init(); return cache.size; }
