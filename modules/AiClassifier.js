"use strict";
import { aiLog, setDebug } from "../logger.js";
import { DEFAULT_AI_PARAMS } from "./defaultParams.js";

const storage = (globalThis.messenger ?? globalThis.browser).storage;

let Services;
try {
  if (typeof globalThis !== "undefined" && globalThis.Services) {
    Services = globalThis.Services;
  } else if (typeof ChromeUtils !== "undefined" && ChromeUtils.importESModule) {
    ({ Services } = ChromeUtils.importESModule("resource://gre/modules/Services.sys.mjs"));
  }
} catch (e) {
  Services = undefined;
}

const COMPLETIONS_PATH = "/v1/completions";

const SYSTEM_PREFIX = `You are an email-classification assistant.
Read the email below and the classification criterion provided by the user.
`;

const DEFAULT_CUSTOM_SYSTEM_PROMPT = "Determine whether the email satisfies the user's criterion.";

const SYSTEM_SUFFIX = `
Return ONLY a JSON object on a single line of the form:
{"match": true, "reason": "<short explanation>"} - if the email satisfies the criterion
{"match": false, "reason": "<short explanation>"} - otherwise

Do not add any other keys, text, or formatting.`;

let gEndpointBase = "http://127.0.0.1:5000";
let gEndpoint = buildEndpointUrl(gEndpointBase);
let gTemplateName = "openai";
let gCustomTemplate = "";
let gCustomSystemPrompt = DEFAULT_CUSTOM_SYSTEM_PROMPT;
let gTemplateText = "";

let gAiParams = Object.assign({}, DEFAULT_AI_PARAMS);

let gCache = new Map();
let gCacheLoaded = false;

function normalizeEndpointBase(endpoint) {
  if (typeof endpoint !== "string") {
    return "";
  }
  let base = endpoint.trim();
  if (!base) {
    return "";
  }
  base = base.replace(/\/v1\/completions\/?$/i, "");
  return base;
}

function buildEndpointUrl(endpointBase) {
  const base = normalizeEndpointBase(endpointBase);
  if (!base) {
    return "";
  }
  const withScheme = /^https?:\/\//i.test(base) ? base : `https://${base}`;
  const needsSlash = withScheme.endsWith("/");
  return `${withScheme}${needsSlash ? "" : "/"}v1/completions`;
}

function sha256HexSync(str) {
  try {
    const hasher = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
    hasher.init(Ci.nsICryptoHash.SHA256);
    const data = new TextEncoder().encode(str);
    hasher.update(data, data.length);
    const binary = hasher.finish(false);
    return Array.from(binary, c => ("0" + c.charCodeAt(0).toString(16)).slice(-2)).join("");
  } catch (e) {
    aiLog(`sha256HexSync failed`, { level: 'error' }, e);
    return "";
  }
}

async function sha256Hex(str) {
  if (typeof crypto?.subtle?.digest === "function") {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, "0")).join("");
  }
  return sha256HexSync(str);
}

async function resolveHeaderId(id) {
  if (typeof id === "number" && typeof messenger?.messages?.get === "function") {
    try {
      const hdr = await messenger.messages.get(id);
      if (hdr?.headerMessageId) {
        return hdr.headerMessageId;
      }
    } catch (e) {
      aiLog(`Failed to resolve headerMessageId for ${id}`, { level: 'warn' }, e);
    }
  }
  return String(id);
}

async function buildCacheKey(id, criterion) {
  const resolvedId = await resolveHeaderId(id);
  if (Services) {
    return sha256HexSync(`${resolvedId}|${criterion}`);
  }
  return sha256Hex(`${resolvedId}|${criterion}`);
}

async function loadCache() {
  if (gCacheLoaded) {
    return;
  }
  aiLog(`[AiClassifier] Loading cache`, {debug: true});
  try {
    const { aiCache, aiReasonCache } = await storage.local.get(["aiCache", "aiReasonCache"]);
    if (aiCache) {
      for (let [k, v] of Object.entries(aiCache)) {
        if (v && typeof v === "object") {
          gCache.set(k, { matched: v.matched ?? null, reason: v.reason || "" });
        } else {
          gCache.set(k, { matched: v, reason: "" });
        }
      }
      aiLog(`[AiClassifier] Loaded ${gCache.size} cache entries`, {debug: true});
    } else {
      aiLog(`[AiClassifier] Cache is empty`, {debug: true});
    }
    if (aiReasonCache) {
      aiLog(`[AiClassifier] Migrating ${Object.keys(aiReasonCache).length} reason entries`, {debug: true});
      for (let [k, reason] of Object.entries(aiReasonCache)) {
        let entry = gCache.get(k) || { matched: null, reason: "" };
        entry.reason = reason;
        gCache.set(k, entry);
      }
      await storage.local.remove("aiReasonCache");
      await storage.local.set({ aiCache: Object.fromEntries(gCache) });
    }
  } catch (e) {
    aiLog(`Failed to load cache`, {level: 'error'}, e);
  }
  gCacheLoaded = true;
}


async function saveCache(updatedKey, updatedValue) {
  if (typeof updatedKey !== "undefined") {
    aiLog(`[AiClassifier] ⮡ Persisting entry '${updatedKey}' → ${updatedValue}`, {debug: true});
  }
  try {
    await storage.local.set({ aiCache: Object.fromEntries(gCache) });
  } catch (e) {
    aiLog(`Failed to save cache`, {level: 'error'}, e);
  }
}


async function loadTemplate(name) {
  try {
    const url = typeof browser !== "undefined" && browser.runtime?.getURL
      ? browser.runtime.getURL(`prompt_templates/${name}.txt`)
      : `resource://aifilter/prompt_templates/${name}.txt`;
    const res = await fetch(url);
    if (res.ok) {
      return await res.text();
    }
  } catch (e) {
    aiLog(`Failed to load template '${name}':`, {level: 'error'}, e);
  }
  return "";
}

function loadTemplateSync(name) {
  if (!Services?.tm?.spinEventLoopUntil) {
    throw new Error("loadTemplateSync requires Services");
  }
  let text = "";
  let done = false;
  loadTemplate(name).then(t => { text = t; }).catch(() => {}).finally(() => { done = true; });
  Services.tm.spinEventLoopUntil(() => done);
  return text;
}

async function setConfig(config = {}) {
  if (typeof config.endpoint === "string") {
    const base = normalizeEndpointBase(config.endpoint);
    if (base) {
      gEndpointBase = base;
    }
    gEndpoint = buildEndpointUrl(gEndpointBase);
  }
  if (config.templateName) {
    gTemplateName = config.templateName;
  }
  if (typeof config.customTemplate === "string") {
    gCustomTemplate = config.customTemplate;
  }
  if (typeof config.customSystemPrompt === "string") {
    gCustomSystemPrompt = config.customSystemPrompt;
  }
  if (config.aiParams && typeof config.aiParams === "object") {
    for (let [k, v] of Object.entries(config.aiParams)) {
      if (k in gAiParams && typeof v !== "undefined") {
        gAiParams[k] = v;
      }
    }
  }
  if (typeof config.debugLogging === "boolean") {
    setDebug(config.debugLogging);
  }
  if (gTemplateName === "custom") {
    gTemplateText = gCustomTemplate;
  } else if (Services?.tm?.spinEventLoopUntil) {
    gTemplateText = loadTemplateSync(gTemplateName);
  } else {
    gTemplateText = await loadTemplate(gTemplateName);
  }
  if (!gEndpoint) {
    gEndpoint = buildEndpointUrl(gEndpointBase);
  }
  aiLog(`[AiClassifier] Endpoint base set to ${gEndpointBase}`, {debug: true});
  aiLog(`[AiClassifier] Endpoint set to ${gEndpoint}`, {debug: true});
  aiLog(`[AiClassifier] Template set to ${gTemplateName}`, {debug: true});
}

function buildSystemPrompt() {
  return SYSTEM_PREFIX + (gCustomSystemPrompt || DEFAULT_CUSTOM_SYSTEM_PROMPT) + SYSTEM_SUFFIX;
}

function buildPrompt(body, criterion) {
  aiLog(`[AiClassifier] Building prompt with criterion: "${criterion}"`, {debug: true});
  const data = {
    system: buildSystemPrompt(),
    email: body,
    query: criterion,
  };
  let template = gTemplateText || loadTemplateSync(gTemplateName);
  return template.replace(/{{\s*(\w+)\s*}}/g, (m, key) => data[key] || "");
}

function getCachedResult(cacheKey) {
  if (!gCacheLoaded) {
    return null;
  }
  if (cacheKey && gCache.has(cacheKey)) {
    aiLog(`[AiClassifier] Cache hit for key: ${cacheKey}`, {debug: true});
    const entry = gCache.get(cacheKey);
    return entry?.matched ?? null;
  }
  return null;
}

function getReason(cacheKey) {
  if (!gCacheLoaded) {
    return null;
  }
  const entry = gCache.get(cacheKey);
  return cacheKey && entry ? entry.reason || null : null;
}

function buildPayload(text, criterion) {
  let payloadObj = Object.assign({
    prompt: buildPrompt(text, criterion)
  }, gAiParams);
  return JSON.stringify(payloadObj);
}

function reportParseError(message, detail) {
  try {
    const runtime = (globalThis.browser ?? globalThis.messenger)?.runtime;
    if (!runtime?.sendMessage) {
      return;
    }
    runtime.sendMessage({
      type: "sortana:recordError",
      context: "AI response parsing",
      message,
      detail
    }).catch(() => {});
  } catch (e) {
    aiLog("Failed to report parse error", { level: "warn" }, e);
  }
}

function extractLastJsonObject(text) {
  let last = null;
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }
    if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        last = text.slice(start, i + 1);
        start = -1;
      }
    }
  }

  return last;
}

function parseMatch(result) {
  const rawText = result.choices?.[0]?.text || "";
  const candidate = extractLastJsonObject(rawText);
  if (!candidate) {
    reportParseError("No JSON object found in AI response.", rawText.slice(0, 800));
    return { matched: false, reason: "" };
  }

  let obj;
  try {
    obj = JSON.parse(candidate);
  } catch (e) {
    reportParseError("Failed to parse JSON from AI response.", candidate.slice(0, 800));
    return { matched: false, reason: "" };
  }

  const matchValue = Object.prototype.hasOwnProperty.call(obj, "match") ? obj.match : obj.matched;
  const matched = matchValue === true;
  if (matchValue !== true && matchValue !== false) {
    reportParseError("AI response missing valid match boolean.", candidate.slice(0, 800));
  }

  const reasonValue = obj.reason ?? obj.reasoning ?? obj.explaination;
  const reason = typeof reasonValue === "string" ? reasonValue : "";

  return { matched, reason };
}

function cacheEntry(cacheKey, matched, reason) {
  if (!cacheKey) {
    return;
  }
  aiLog(`[AiClassifier] Caching entry '${cacheKey}'`, {debug: true});
  const entry = gCache.get(cacheKey) || { matched: null, reason: "" };
  if (typeof matched === "boolean") {
    entry.matched = matched;
  }
  if (typeof reason === "string") {
    entry.reason = reason;
  }
  gCache.set(cacheKey, entry);
  saveCache(cacheKey, entry);
}

async function removeCacheEntries(keys = []) {
  if (!Array.isArray(keys)) {
    keys = [keys];
  }
  if (!gCacheLoaded) {
    await loadCache();
  }
  let removed = false;
  for (let key of keys) {
    if (gCache.delete(key)) {
      removed = true;
      aiLog(`[AiClassifier] Removed cache entry '${key}'`, {debug: true});
    }
  }
  if (removed) {
    await saveCache();
  }
}

async function clearCache() {
  if (!gCacheLoaded) {
    await loadCache();
  }
  if (gCache.size > 0) {
    gCache.clear();
    await saveCache();
    aiLog(`[AiClassifier] Cleared cache`, {debug: true});
  }
}

async function getCacheSize() {
  if (!gCacheLoaded) {
    await loadCache();
  }
  return gCache.size;
}


async function classifyText(text, criterion, cacheKey = null) {
  if (!gCacheLoaded) {
    await loadCache();
  }
  const cached = getCachedResult(cacheKey);
  if (cached !== null) {
    return cached;
  }

  const payload = buildPayload(text, criterion);
  try {
    await storage.local.set({ lastPayload: JSON.parse(payload) });
  } catch (e) {
    aiLog('failed to save last payload', { level: 'warn' }, e);
  }

  aiLog(`[AiClassifier] Sending classification request to ${gEndpoint}`, {debug: true});
  aiLog(`[AiClassifier] Classification request payload:`, { debug: true }, payload);

  try {
    const response = await fetch(gEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });

    if (!response.ok) {
      aiLog(`HTTP status ${response.status}`, {level: 'warn'});
      return false;
    }

    const result = await response.json();
    aiLog(`[AiClassifier] Received response:`, {debug: true}, result);
    const parsed = parseMatch(result);
    cacheEntry(cacheKey, parsed.matched, parsed.reason);
    return parsed.matched;
  } catch (e) {
    aiLog(`HTTP request failed`, {level: 'error'}, e);
    return false;
  }
}

async function init() {
  await loadCache();
}

export { buildEndpointUrl, normalizeEndpointBase, classifyText, setConfig, removeCacheEntries, clearCache, getReason, getCachedResult, buildCacheKey, getCacheSize, init };
