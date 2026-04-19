"use strict";
import { aiLog, setDebug } from "../logger.js";
import { DEFAULT_AI_PARAMS } from "./defaultParams.js";

const storage = (globalThis.messenger ?? globalThis.browser).storage;

const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
const MODELS_PATH = "/v1/models";

const SYSTEM_PREFIX = `You are an email-classification assistant.
Read the email below and the classification criterion provided by the user.
`;

const DEFAULT_CUSTOM_SYSTEM_PROMPT = "Determine whether the email satisfies the user's criterion.";

const SYSTEM_SUFFIX = `
Return JSON that matches the requested schema exactly.
Set "match" to true when the email satisfies the criterion, otherwise false.
Set "reason" to a short explanation grounded in the email contents.`;

const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "email_classification",
    strict: true,
    schema: {
      type: "object",
      properties: {
        match: { type: "boolean" },
        reason: { type: "string" },
      },
      required: ["match", "reason"],
      additionalProperties: false,
    },
  },
};

let gEndpointBase = "http://127.0.0.1:5000";
let gEndpoint = buildEndpointUrl(gEndpointBase);
let gTemplateName = "openai";
let gCustomTemplate = "";
let gCustomSystemPrompt = DEFAULT_CUSTOM_SYSTEM_PROMPT;
let gTemplateText = "";

let gAiParams = Object.assign({}, DEFAULT_AI_PARAMS);
let gModel = "";
let gApiKey = "";
let gOpenaiOrganization = "";
let gOpenaiProject = "";

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
  base = base.replace(/\/v1(?:\/(?:chat\/completions|completions|models))?\/?$/i, "");
  return base;
}

function buildEndpointUrl(endpointBase) {
  const base = normalizeEndpointBase(endpointBase);
  if (!base) {
    return "";
  }
  const withScheme = /^https?:\/\//i.test(base) ? base : `https://${base}`;
  const needsSlash = withScheme.endsWith("/");
  const path = CHAT_COMPLETIONS_PATH.replace(/^\//, "");
  return `${withScheme}${needsSlash ? "" : "/"}${path}`;
}

function buildModelsUrl(endpointBase) {
  const base = normalizeEndpointBase(endpointBase);
  if (!base) {
    return "";
  }
  const withScheme = /^https?:\/\//i.test(base) ? base : `https://${base}`;
  const needsSlash = withScheme.endsWith("/");
  const path = MODELS_PATH.replace(/^\//, "");
  return `${withScheme}${needsSlash ? "" : "/"}${path}`;
}

async function sha256Hex(str) {
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, "0")).join("");
  } catch (e) {
    aiLog("sha256Hex failed", { level: "error" }, e);
    return "";
  }
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
  if (typeof config.model === "string") {
    gModel = config.model.trim();
  }
  if (typeof config.apiKey === "string") {
    gApiKey = config.apiKey.trim();
  }
  if (typeof config.openaiOrganization === "string") {
    gOpenaiOrganization = config.openaiOrganization.trim();
  }
  if (typeof config.openaiProject === "string") {
    gOpenaiProject = config.openaiProject.trim();
  }
  if (typeof config.debugLogging === "boolean") {
    setDebug(config.debugLogging);
  }
  if (gTemplateName === "openai") {
    gTemplateText = "";
  } else if (gTemplateName === "custom") {
    gTemplateText = gCustomTemplate;
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

function buildAuthHeaders() {
  const headers = {};
  if (gApiKey) {
    headers.Authorization = `Bearer ${gApiKey}`;
  }
  if (gOpenaiOrganization) {
    headers["OpenAI-Organization"] = gOpenaiOrganization;
  }
  if (gOpenaiProject) {
    headers["OpenAI-Project"] = gOpenaiProject;
  }
  return headers;
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
  let template = gTemplateText || "";
  return template.replace(/{{\s*(\w+)\s*}}/g, (m, key) => data[key] || "");
}

function buildUserMessage(body, criterion) {
  return `Email contents:
${body}

Classification criterion: ${criterion}`;
}

function buildMessages(body, criterion) {
  if (gTemplateName !== "custom") {
    return [
      {
        role: "system",
        content: buildSystemPrompt(),
      },
      {
        role: "user",
        content: buildUserMessage(body, criterion),
      },
    ];
  }

  return [
    {
      role: "user",
      content: buildPrompt(body, criterion),
    },
  ];
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

function buildOpenAiParams() {
  const params = {};

  if (Number.isFinite(gAiParams.max_tokens) && gAiParams.max_tokens > 0) {
    params.max_completion_tokens = Math.trunc(gAiParams.max_tokens);
  }
  if (Number.isFinite(gAiParams.temperature)) {
    params.temperature = gAiParams.temperature;
  }
  if (Number.isFinite(gAiParams.top_p)) {
    params.top_p = gAiParams.top_p;
  }
  if (Number.isFinite(gAiParams.presence_penalty)) {
    params.presence_penalty = gAiParams.presence_penalty;
  }
  if (Number.isFinite(gAiParams.frequency_penalty)) {
    params.frequency_penalty = gAiParams.frequency_penalty;
  }
  if (Number.isInteger(gAiParams.seed) && gAiParams.seed >= 0) {
    params.seed = gAiParams.seed;
  }

  return params;
}

function buildPayloadObject(text, criterion) {
  const payloadObj = {
    messages: buildMessages(text, criterion),
    response_format: RESPONSE_FORMAT,
    ...buildOpenAiParams(),
  };
  if (gModel) {
    payloadObj.model = gModel;
  }
  return payloadObj;
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

function extractMessageContent(content) {
  if (typeof content === "string") {
    return { text: content, refusal: "" };
  }
  if (!Array.isArray(content)) {
    return { text: "", refusal: "" };
  }

  const textParts = [];
  const refusalParts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    if (part.type === "text" && typeof part.text === "string") {
      textParts.push(part.text);
    }
    if (part.type === "refusal" && typeof part.refusal === "string") {
      refusalParts.push(part.refusal);
    }
  }

  return {
    text: textParts.join("\n").trim(),
    refusal: refusalParts.join("\n").trim(),
  };
}

function extractLastJsonObject(text) {
  if (typeof text !== "string" || !text) {
    return null;
  }

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
  const message = result?.choices?.[0]?.message;
  if (!message || typeof message !== "object") {
    reportParseError("AI response missing assistant message.", JSON.stringify(result).slice(0, 800));
    return { matched: false, reason: "" };
  }

  if (typeof message.refusal === "string" && message.refusal.trim()) {
    reportParseError("Model refused classification request.", message.refusal.slice(0, 800));
    return { matched: false, reason: message.refusal.trim() };
  }

  if (message.parsed && typeof message.parsed === "object") {
    const parsed = message.parsed;
    if (typeof parsed.match === "boolean" && typeof parsed.reason === "string") {
      return { matched: parsed.match, reason: parsed.reason };
    }
  }

  const extracted = extractMessageContent(message.content);
  if (extracted.refusal) {
    reportParseError("Model refused classification request.", extracted.refusal.slice(0, 800));
    return { matched: false, reason: extracted.refusal };
  }
  if (!extracted.text) {
    reportParseError("AI response missing assistant message content.", JSON.stringify(message).slice(0, 800));
    return { matched: false, reason: "" };
  }

  let obj;
  try {
    obj = JSON.parse(extracted.text);
  } catch (e) {
    const candidate = extractLastJsonObject(extracted.text);
    if (!candidate) {
      reportParseError("Failed to parse JSON from AI response.", extracted.text.slice(0, 800));
      return { matched: false, reason: "" };
    }
    try {
      obj = JSON.parse(candidate);
    } catch (inner) {
      reportParseError("Failed to parse JSON from AI response.", extracted.text.slice(0, 800));
      return { matched: false, reason: "" };
    }
  }

  if (typeof obj?.match !== "boolean") {
    reportParseError("AI response missing valid match boolean.", extracted.text.slice(0, 800));
    return { matched: false, reason: "" };
  }
  if (typeof obj?.reason !== "string") {
    reportParseError("AI response missing valid reason string.", extracted.text.slice(0, 800));
    return { matched: false, reason: "" };
  }

  return { matched: obj.match, reason: obj.reason };
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

  const payloadObj = buildPayloadObject(text, criterion);
  const payload = JSON.stringify(payloadObj);
  try {
    await storage.local.set({ lastPayload: payloadObj });
  } catch (e) {
    aiLog('failed to save last payload', { level: 'warn' }, e);
  }

  aiLog(`[AiClassifier] Sending classification request to ${gEndpoint}`, {debug: true});
  aiLog(`[AiClassifier] Classification request payload:`, { debug: true }, payload);

  try {
    const response = await fetch(gEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...buildAuthHeaders() },
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

export { buildEndpointUrl, buildModelsUrl, normalizeEndpointBase, classifyText, setConfig, removeCacheEntries, clearCache, getReason, getCachedResult, buildCacheKey, getCacheSize, init };
