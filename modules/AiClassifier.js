"use strict";
import { aiLog, setDebug } from '../logger.js';
import { CONFIG_DEFAULTS, validateSettings, validateThreshold } from './classificationConfig.js';
import * as chat from './backends/chatCompletions.js';
import * as systemone from './backends/systemOne.js';
const storage = (globalThis.messenger ?? globalThis.browser).storage;
const adapters = { 'chat-completions': chat, systemone };
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
async function messageHash(id) {
  const api = globalThis.messenger ?? globalThis.browser;
  if (typeof id === 'number' && api.messages?.get) {
    const header = await api.messages.get(id);
    id = header.headerMessageId || id;
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
    request: adapters[snapshot.apiType].buildRequest('', criterion, snapshot),
    organization: snapshot.apiType === 'chat-completions' ? snapshot.openaiOrganization : '',
    project: snapshot.apiType === 'chat-completions' ? snapshot.openaiProject : '',
    preprocessing: Object.fromEntries(['htmlToMarkdown', 'stripUrlParams', 'altTextImages', 'collapseWhitespace', 'tokenReduction', 'inputCharacterLimit'].map(k => [k, snapshot[k]]))
  };
  return `v2:${await messageHash(id)}:${await hash(JSON.stringify(stable(fingerprint)))}`;
}
export function validCacheEntry(key, entry) {
  return /^v2:[a-f0-9]{64}:[a-f0-9]{64}$/.test(key) && entry?.version === 2 &&
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
export async function classify(text, criterion, { cacheKey = null, snapshot = getConfig(), threshold = snapshot.decisionThreshold } = {}) {
  await init();
  if (snapshot.apiType === 'systemone') validateThreshold(threshold);
  const cached = getCachedDetails(cacheKey, threshold);
  if (cached) return cached;
  const epoch = generation;
  const adapter = adapters[snapshot.apiType];
  const payload = adapter.buildRequest(text, criterion, snapshot);
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
  const raw = await response.json();
  const entry = { ...adapter.parseResponse(raw), backend: snapshot.apiType,
    model: typeof raw.model === 'string' ? raw.model : snapshot.model, version: 2,
    messageHash: cacheKey?.split(':')[1] };
  if (cacheKey && epoch === generation) {
    cache.set(cacheKey, entry);
    await saveCache();
  }
  return withPolicy(entry, threshold);
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
