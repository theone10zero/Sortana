/*
 * Runs in the **WebExtension (addon)** context.
 * For this minimal working version we only expose an async helper
 * so UI pages / devtools panels can test the classifier without
 * needing Thunderbird’s filter engine.
 *
 * Note: the filter-engine itself NEVER calls this file – the
 * synchronous work is all done in experiment/api.js (chrome side).
 */

"use strict";

const storage = (globalThis.messenger ?? browser).storage;

let logger;
let AiClassifier;
let mailDigest = null;
let i18n = null;
let aiRules = [];
let queue = Promise.resolve();
let queuedCount = 0;
let processing = false;
let iconTimer = null;
let errorTimer = null;
let timingStats = { count: 0, mean: 0, m2: 0, total: 0, last: -1 };
let currentStart = 0;
let logGetTiming = true;
let htmlToMarkdown = false;
let stripUrlParams = false;
let altTextImages = false;
let collapseWhitespace = false;
let tokenReduction = false;
let TurndownService = null;
let userTheme = 'auto';
let currentTheme = 'light';
let detectSystemTheme;
let errorPending = false;
let errorLog = [];
let showDebugTab = false;
const ERROR_NOTIFICATION_ID = 'sortana-error';
const ERROR_ICON_TIMEOUT = 4500;
const MAX_ERROR_LOG = 50;

// The debug tab compares the full message with the summary that was sent.
// The comparison is capped so that a huge message cannot stall the diff.
const DEBUG_TEXT_LIMIT = 20000;

// The UI locale follows Thunderbird's language. Falls back to the message key
// until modules/i18n.js has been imported.
function t(key, subs = null) {
    if (i18n) return i18n.t(key, subs);
    let message = '';
    try {
        message = browser.i18n.getMessage(key) || '';
    } catch (e) {
        message = '';
    }
    if (!message) return key;
    if (!subs) return message;
    return message.replace(/\$([A-Za-z_][A-Za-z0-9_]*)\$/g, (match, name) => {
        const value = subs[name];
        return value === undefined || value === null ? match : String(value);
    });
}

// Thunderbird's numeric message id is an internal tracker id. It is dropped
// from the tracker as soon as the message is moved to another folder or
// deleted, and any later `messages.update()` on it fails with
// "Message not found". A move therefore hands the message a new id.
const MESSAGE_GONE_PATTERN = /message not found/i;

// Actions that only change message properties need a live message id, so they
// run before the actions that invalidate it. The order inside a group is the
// order the user configured.
const ACTION_STAGE = {
    tag: 0, junk: 0, read: 0, flag: 0, forward: 0, reply: 0,
    copy: 1,
    move: 2, archive: 2,
    delete: 3
};

function orderedActions(actions) {
    return (Array.isArray(actions) ? actions : [])
        .map((action, index) => ({ action, index }))
        .sort((a, b) => (ACTION_STAGE[a.action.type] ?? 0) - (ACTION_STAGE[b.action.type] ?? 0) || a.index - b.index)
        .map(entry => entry.action);
}

function isMessageGone(error) {
    return MESSAGE_GONE_PATTERN.test(String(error?.message || ''));
}

// Bookkeeping for one email, shared by the success, failure and skip paths.
async function finishMessage() {
    processing = false;
    const elapsed = Date.now() - currentStart;
    currentStart = 0;
    updateTimingStats(elapsed);
    updateActionIcon();
    try {
        await storage.local.set({ classifyStats: timingStats });
    } catch (e) {
        logger?.aiLog('failed to store the timing stats', { level: 'warn' }, e);
    }
}

// The Message-ID header survives a move. Thunderbird reports it as
// `headerMessageId` and also exposes the raw header, and the two may differ
// in angle brackets, so both forms are kept for the lookup after a move.
function headerIdVariants(value) {
    if (typeof value !== 'string' || !value.trim()) return [];
    const raw = value.trim();
    const bare = raw.replace(/^</, '').replace(/>$/, '').trim();
    return [...new Set(raw === bare ? [raw] : [raw, bare])];
}

// A moved message keeps its RFC 5322 Message-ID header but is given a new
// tracker id, so the new id is found by looking that header up in the
// destination folder.
async function findMessageId(criteria, headerMessageIds = []) {
    const ids = Array.isArray(headerMessageIds) ? headerMessageIds : [headerMessageIds];
    for (const headerMessageId of ids) {
        if (!headerMessageId) continue;
        try {
            const list = await messenger.messages.query({ ...criteria, headerMessageId });
            const found = list?.messages || [];
            if (found.length) return found[0].id;
        } catch (e) {
            logger?.aiLog('failed to re-resolve a moved message', { level: 'warn' }, e);
            return null;
        }
    }
    return null;
}

async function findArchiveFolderId(accountId) {
    if (!accountId) return null;
    try {
        const list = await messenger.folders.query({ accountId, specialUse: ['archives'] });
        return list?.folders?.[0]?.id ?? null;
    } catch (e) {
        return null;
    }
}

function normalizeRules(rules) {
    return Array.isArray(rules) ? rules.map(r => {
        if (r.actions) {
            if (!Array.isArray(r.accounts)) r.accounts = [];
            if (!Array.isArray(r.folders)) r.folders = [];
            r.enabled = r.enabled !== false;
            return r;
        }
        const actions = [];
        if (r.tag) actions.push({ type: 'tag', tagKey: r.tag });
        if (r.moveTo) actions.push({ type: 'move', folder: r.moveTo });
        if (r.copyTarget || r.copyTo) actions.push({ type: 'copy', copyTarget: r.copyTarget || r.copyTo });
        const rule = { criterion: r.criterion, actions };
        if (r.decisionThreshold !== undefined) rule.decisionThreshold = r.decisionThreshold;
        if (r.stopProcessing) rule.stopProcessing = true;
        if (r.unreadOnly) rule.unreadOnly = true;
        if (typeof r.minAgeDays === 'number') rule.minAgeDays = r.minAgeDays;
        if (typeof r.maxAgeDays === 'number') rule.maxAgeDays = r.maxAgeDays;
        if (Array.isArray(r.accounts)) rule.accounts = r.accounts;
        if (Array.isArray(r.folders)) rule.folders = r.folders;
        rule.enabled = r.enabled !== false;
        return rule;
    }) : [];
}

function iconPaths(name) {
    return {
        16: `resources/img/${name}-${currentTheme}-16.png`,
        32: `resources/img/${name}-${currentTheme}-32.png`,
        64: `resources/img/${name}-${currentTheme}-64.png`
    };
}


const ICONS = {
    logo: () => 'resources/img/logo.png',
    circledots: () => iconPaths('circledots'),
    circle: () => iconPaths('circle'),
    average: () => iconPaths('average'),
    error: () => iconPaths('x')
};

function setIcon(path) {
    if (browser.browserAction) {
        browser.browserAction.setIcon({ path });
    }
    if (browser.messageDisplayAction) {
        browser.messageDisplayAction.setIcon({ path });
    }
}

function updateActionIcon() {
    let path = ICONS.logo();
    if (errorPending) {
        path = ICONS.error();
    } else if (processing || queuedCount > 0) {
        path = ICONS.circledots();
    }
    setIcon(path);
}

function showTransientIcon(factory, delay = 1500) {
    if (errorPending) {
        return;
    }
    clearTimeout(iconTimer);
    const path = typeof factory === 'function' ? factory() : factory;
    setIcon(path);
    iconTimer = setTimeout(updateActionIcon, delay);
}

async function clearError() {
    errorPending = false;
    clearTimeout(errorTimer);
    await browser.notifications.clear(ERROR_NOTIFICATION_ID);
    updateActionIcon();
}

function recordError(context, err) {
    let message = 'Unknown error';
    let detail = '';
    if (err instanceof Error) {
        message = err.message;
        detail = err.stack || '';
    } else if (err && typeof err === 'object') {
        message = typeof err.message === 'string' ? err.message : String(err || 'Unknown error');
        detail = typeof err.detail === 'string' ? err.detail : '';
    } else {
        message = String(err || 'Unknown error');
    }
    errorLog.unshift({
        time: Date.now(),
        context,
        message,
        detail
    });
    if (errorLog.length > MAX_ERROR_LOG) {
        errorLog.length = MAX_ERROR_LOG;
    }
    errorPending = true;
    updateActionIcon();
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => {
        errorPending = false;
        updateActionIcon();
    }, ERROR_ICON_TIMEOUT);
    browser.runtime.sendMessage({ type: 'sortana:errorLogUpdated', count: errorLog.length }).catch(() => {});
}

function refreshMenuIcons() {
    browser.menus.update('apply-ai-rules-list', { icons: iconPaths('eye') });
    browser.menus.update('apply-ai-rules-display', { icons: iconPaths('eye') });
    browser.menus.update('clear-ai-cache-list', { icons: iconPaths('trash') });
    browser.menus.update('clear-ai-cache-display', { icons: iconPaths('trash') });
    browser.menus.update('view-ai-reason-list', { icons: iconPaths('clipboarddata') });
    browser.menus.update('view-ai-reason-display', { icons: iconPaths('clipboarddata') });
}


function byteSize(str) {
    return new TextEncoder().encode(str || "").length;
}

// A URL ends at whitespace, ASCII closing punctuation, or any CJK character.
// Chinese text has no inter-word spaces, so a naive `[^\s)]+` match swallows
// every following character up to the next space and silently deletes the
// rest of the sentence.
const URL_PATTERN = /https?:\/\/[^\s"'<>()\[\]{}　-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]+/g;

function stripUrlQueryParams(match) {
    const cleaned = match.replace(/[.,;:!?'")\]}]+$/, '');
    const idx = cleaned.indexOf('?');
    return idx >= 0 ? cleaned.slice(0, idx) : cleaned;
}

const MIME_WORD = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;

// RFC 2047 encoded words, e.g. `=?UTF-8?B?5Y+R56Wo?=`. Mail clients encode
// non-ASCII header values this way, so the raw value is unreadable without
// decoding. Applied defensively: values that are already plain text are
// returned unchanged.
function decodeMimeWords(value) {
    if (typeof value !== 'string' || !value.includes('=?')) return value;
    // Whitespace between two adjacent encoded words is not part of the text.
    const collapsed = value.replace(/(\?=)[ \t]+(=\?)/g, '$1$2');
    return collapsed.replace(MIME_WORD, (match, charset, encoding, data) => {
        try {
            let bytes;
            if (encoding.toUpperCase() === 'B') {
                const binary = atob(data);
                bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i += 1) {
                    bytes[i] = binary.charCodeAt(i);
                }
            } else {
                const raw = new Uint8Array(data.length);
                let length = 0;
                for (let i = 0; i < data.length; i += 1) {
                    if (data[i] === '_') {
                        raw[length++] = 0x20;
                    } else if (data[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(data.slice(i + 1, i + 3))) {
                        raw[length++] = parseInt(data.slice(i + 1, i + 3), 16);
                        i += 2;
                    } else {
                        raw[length++] = data.charCodeAt(i) & 0xFF;
                    }
                }
                bytes = raw.subarray(0, length);
            }
            return new TextDecoder(charset).decode(bytes);
        } catch (e) {
            return match;
        }
    });
}

// Attachment file names. Clients that send non-ASCII names use the RFC 5987
// `filename*=UTF-8''percent-encoded` form, which the plain `filename=` pattern
// does not match at all.
function decodeFilename(headerValue) {
    if (!headerValue) return '';
    const extended = /filename\*\s*=\s*([^;]+)/i.exec(headerValue);
    if (extended) {
        const raw = extended[1].trim().replace(/^"|"$/g, '');
        const parts = raw.split("'");
        const encoded = parts.length >= 3 ? parts.slice(2).join("'") : raw;
        try {
            return decodeMimeWords(decodeURIComponent(encoded));
        } catch (e) {
            return encoded;
        }
    }
    const plain = /filename\s*=\s*"?([^";]+)/i.exec(headerValue);
    if (plain) return decodeMimeWords(plain[1]);
    const named = /name\s*=\s*"?([^";]+)/i.exec(headerValue);
    if (named) return decodeMimeWords(named[1]);
    return '';
}

function replaceInlineBase64(text) {
    return text.replace(/(?:data:[^;]+;base64,)?[A-Za-z0-9+/=\r\n]{100,}/g,
        m => tokenReduction ? '__BASE64__' : `[base64: ${byteSize(m)} bytes]`);
}

function sanitizeString(text) {
    let sanitized = String(text);
    if (tokenReduction) {
        sanitized = sanitized.replace(/<!--.*?-->/gs, '')
            .replace(/url\([^\)]*\)/gi, 'url(__IMG__)');
    }
    if (stripUrlParams) {
        sanitized = sanitized.replace(URL_PATTERN, stripUrlQueryParams);
    }
    if (collapseWhitespace) {
        sanitized = sanitized.replace(/[\u200B-\u200D\u2060\s]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
    }
    return sanitized;
}

function collectText(part, bodyParts, attachments) {
    if (part.parts && part.parts.length) {
        for (const p of part.parts) collectText(p, bodyParts, attachments);
        return;
    }
    const ct = (part.contentType || "text/plain").toLowerCase();
    const cd = (part.headers?.["content-disposition"]?.[0] || "").toLowerCase();
    const body = String(part.body || "");
    if (cd.includes("attachment") || !ct.startsWith("text/")) {
        const name = decodeFilename(cd) || decodeFilename(part.headers?.["content-type"]?.[0] || "");
        attachments.push({ name, type: ct, size: part.size || byteSize(body) });
    } else if (ct.startsWith("text/html")) {
        const doc = new DOMParser().parseFromString(body, 'text/html');
        if (tokenReduction) {
            doc.querySelectorAll('script,style').forEach(el => el.remove());
            const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_COMMENT);
            let node;
            while ((node = walker.nextNode())) {
                node.parentNode.removeChild(node);
            }
            doc.querySelectorAll('*').forEach(el => {
                for (const attr of Array.from(el.attributes)) {
                    if (!['href','src','alt'].includes(attr.name)) {
                        el.removeAttribute(attr.name);
                    }
                }
            });
        }
        doc.querySelectorAll('img').forEach(img => {
            const alt = img.getAttribute('alt') || '';
            const text = altTextImages ? alt : '__IMG__';
            img.replaceWith(doc.createTextNode(text));
        });
        if (stripUrlParams) {
            doc.querySelectorAll('[href]').forEach(a => {
                const href = a.getAttribute('href');
                if (href) a.setAttribute('href', href.split('?')[0]);
            });
            doc.querySelectorAll('[src]').forEach(e => {
                const src = e.getAttribute('src');
                if (src) e.setAttribute('src', src.split('?')[0]);
            });
        }
        if (htmlToMarkdown && TurndownService) {
            try {
                const td = new TurndownService();
                const md = sanitizeString(td.turndown(doc.body.innerHTML || body));
                bodyParts.push(replaceInlineBase64(`[HTML Body converted to Markdown]\n${md}`));
            } catch (e) {
                bodyParts.push(replaceInlineBase64(sanitizeString(doc.body.textContent || "")));
            }
        } else {
            bodyParts.push(replaceInlineBase64(sanitizeString(doc.body.textContent || "")));
        }
    } else {
        bodyParts.push(replaceInlineBase64(sanitizeString(body)));
    }
}

function collectRawText(part, bodyParts, attachments) {
    if (part.parts && part.parts.length) {
        for (const p of part.parts) collectRawText(p, bodyParts, attachments);
        return;
    }
    const ct = (part.contentType || "text/plain").toLowerCase();
    const cd = (part.headers?.["content-disposition"]?.[0] || "").toLowerCase();
    const body = String(part.body || "");
    if (cd.includes("attachment") || !ct.startsWith("text/")) {
        const name = decodeFilename(cd) || decodeFilename(part.headers?.["content-type"]?.[0] || "");
        attachments.push({ name, type: ct, size: part.size || byteSize(body) });
    } else if (ct.startsWith("text/html")) {
        const doc = new DOMParser().parseFromString(body, 'text/html');
        bodyParts.push(doc.body.textContent || "");
    } else {
        bodyParts.push(body);
    }
}

// The message reduced to the parts that decide a classification: the
// metadata that says what the mail is about, the body text and the file
// names of the attachments. The attachment contents are never read.
function extractMail(full, applyTransforms = true) {
    const bodyParts = [];
    const attachments = [];
    const collect = applyTransforms ? collectText : collectRawText;
    collect(full, bodyParts, attachments);
    let body = bodyParts.join('\n');
    if (applyTransforms && tokenReduction) {
        // A reply chain repeats whole lines. Left in place they would fill
        // the excerpt windows with duplicates, so they are removed before
        // the body is cut into excerpts.
        const seen = new Set();
        body = body.split('\n').filter(line => {
            if (seen.has(line)) return false;
            seen.add(line);
            return true;
        }).join('\n');
    }
    const raw = full.headers || {};
    const header = (name) => {
        const value = raw[name];
        if (!value) return '';
        const text = decodeMimeWords(Array.isArray(value) ? value.join(' ') : String(value));
        return applyTransforms ? sanitizeString(text) : text;
    };
    return {
        headers: {
            subject: header('subject'),
            date: header('date'),
            from: header('from'),
            to: header('to'),
            cc: header('cc')
        },
        body,
        attachments
    };
}

// The summary that is sent to the AI service. It replaces the full text:
// the metadata, the attachment file names and three excerpts of the body,
// sized by the character budget.
function buildEmailSummary(full, options = {}) {
    const mail = extractMail(full, true);
    const digest = mailDigest.buildDigest(mail, options);
    logger?.aiLog('email summary built', { debug: true }, digest.stats);
    return digest.text;
}

// The unaltered message text. Only the debug tab compares it with the
// summary, so it is not built for every email.
function buildFullEmailText(full) {
    const mail = extractMail(full, false);
    const headers = Object.entries(full.headers || {})
        .map(([k, v]) => `${k}: ${decodeMimeWords(v.join(' '))}`)
        .join('\n');
    const attachInfo = `Attachments: ${mail.attachments.length}` +
        (mail.attachments.length
            ? "\n" + mail.attachments.map(a => ` - ${a.name} (${a.type}, ${a.size} bytes)`).join('\n')
            : "");
    return `${headers}\n${attachInfo}\n\n${mail.body}`.trim();
}

function updateTimingStats(elapsed) {
    const stats = timingStats;
    stats.count += 1;
    stats.total += elapsed;
    stats.last = elapsed;
    const delta = elapsed - t.mean;
    t.mean += delta / t.count;
    t.m2 += delta * (elapsed - t.mean);
}

async function getAllMessageIds(list) {
    const ids = [];
    if (!list) {
        return ids;
    }
    let page = list;
    ids.push(...(page.messages || []).map(m => m.id));
    while (page.id) {
        page = await messenger.messages.continueList(page.id);
        ids.push(...(page.messages || []).map(m => m.id));
    }
    return ids;
}

async function processMessage(id) {
    processing = true;
    currentStart = Date.now();
    queuedCount--;
    updateActionIcon();
    // The addresses this mail was delivered to. Used by the summary builder
    // so the account's own address is never dropped when the recipient list is
    // truncated. Populated after reading the headers below.
    let identities = [];
    try {
        let full = null;
        try {
            full = await messenger.messages.getFull(id);
        } catch (e) {
            if (!isMessageGone(e)) throw e;
            // The message was moved or deleted while it was queued. There is
            // nothing left to classify, and it is not a failure the user has
            // to act on, so the email is skipped instead of failing.
            logger?.aiLog('message is no longer available, skipping it', { debug: true }, e);
            await finishMessage();
            return;
        }
        const snapshot = AiClassifier.getConfig();
        const rules = structuredClone(aiRules);
        const limit = snapshot.inputCharacterLimit;
        // The summary carries the metadata, the attachment file names and
        // three excerpts of the body. The strict mode (aggressive token
        // reduction) compresses it further and asks the model to treat
        // missing evidence as a non-match.
        let text = buildEmailSummary(full, {
            budget: limit,
            strict: snapshot.tokenReduction === true,
            identities
        });
        if (Number.isSafeInteger(limit) && limit > 0 && text.length > limit) {
            // The summary is sized from the same budget, so this only guards
            // against a rounding error.
            text = text.slice(0, limit);
        }
        if (showDebugTab) {
            // The debug tab diffs the full message against the summary. A huge
            // message would make that diff crawl, so the comparison is capped.
            const fullText = buildFullEmailText(full).slice(0, DEBUG_TEXT_LIMIT);
            await storage.local.set({ lastFullText: fullText, lastPromptText: text });
        }
        let hdr;
        let currentTags = [];
        let alreadyRead = false;
        let identityId = null;
        let accountId = null;
        // The id Thunderbird tracks the message under. It is replaced when the
        // message is moved, so actions follow it instead of the original id.
        let currentId = id;
        // The RFC 5322 Message-ID header survives a move and is used to find
        // the message again in its new folder.
        let headerMessageId = null;
        let headerMessageIds = [];
        try {
            hdr = await messenger.messages.get(id);
            currentTags = Array.isArray(hdr.tags) ? [...hdr.tags] : [];
            alreadyRead = hdr.read === true;
            accountId = hdr.folder.accountId;
            headerMessageId = typeof hdr.headerMessageId === 'string' ? hdr.headerMessageId : null;
            const ids = await messenger.identities.list(accountId);
            identityId = ids[0]?.id || null;
            identities = ids.map(ident => String(ident?.email ?? '')).filter(Boolean);
        } catch (e) {
            if (isMessageGone(e)) {
                // The message vanished between reading it and reading its
                // header. Skip it rather than failing the whole email.
                logger?.aiLog('message is no longer available, skipping it', { debug: true }, e);
                await finishMessage();
                return;
            }
            // The header could not be read, but the message itself is still
            // there. Its existing tags stay unknown, so a tag action cannot
            // replace them with an incomplete list.
            currentTags = null;
            alreadyRead = false;
            identityId = null;
            identities = [];
        }
        if (!headerMessageId) {
            // The Message-ID header survives a move and can re-locate the
            // message even when its header could not be read.
            headerMessageId = full?.headers?.['message-id']?.[0] || null;
        }
        headerMessageIds = headerIdVariants(headerMessageId);

        const candidates = [];
        for (const [index, rule] of rules.entries()) {
            if (rule.enabled === false) {
                continue;
            }
            if (!hdr) {
                // The header could not be read, so the account and folder
                // restrictions cannot be checked. A restricted rule stays out
                // of scope instead of acting on a message it may not cover.
                if ((Array.isArray(rule.accounts) && rule.accounts.length) ||
                    (Array.isArray(rule.folders) && rule.folders.length)) {
                    continue;
                }
            }
            if (hdr && Array.isArray(rule.accounts) && rule.accounts.length &&
                !rule.accounts.includes(hdr.folder.accountId)) {
                continue;
            }
            if (hdr && Array.isArray(rule.folders) && rule.folders.length &&
                !rule.folders.includes(hdr.folder.path)) {
                continue;
            }
            if (rule.unreadOnly && alreadyRead) {
                continue;
            }
            if (hdr && (typeof rule.minAgeDays === 'number' || typeof rule.maxAgeDays === 'number')) {
                const msgTime = new Date(hdr.date).getTime();
                if (!isNaN(msgTime)) {
                    const ageDays = (Date.now() - msgTime) / 86400000;
                    if (typeof rule.minAgeDays === 'number' && ageDays < rule.minAgeDays) {
                        continue;
                    }
                    if (typeof rule.maxAgeDays === 'number' && ageDays > rule.maxAgeDays) {
                        continue;
                    }
                }
            }
            let cacheKey = null;
            try {
                cacheKey = await AiClassifier.buildCacheKey(id, rule.criterion, snapshot);
            } catch (e) {
                if (!isMessageGone(e)) throw e;
                // The message was removed while its cache key was computed.
                // There is nothing left to classify, so the email is skipped.
                logger?.aiLog('message is no longer available, skipping it', { debug: true }, e);
                await finishMessage();
                return;
            }
            candidates.push({ id: `rule_${index}`, rule, cacheKey });
        }
        for await (const { rule, result: { matched } } of AiClassifier.classifyRules(text, candidates, snapshot)) {
            if (matched) {
                for (const act of orderedActions(rule.actions)) {
                    // The message is gone (deleted, or moved somewhere we could
                    // not follow), so there is nothing left to act on.
                    if (currentId === null) break;
                    try {
                        if (act.type === 'tag' && act.tagKey) {
                            // The existing tags are unknown, so writing them
                            // would drop the tags the message already has.
                            if (currentTags === null) {
                                logger?.aiLog('the existing tags are unknown, skipping the tag action', { debug: true });
                                continue;
                            }
                            if (!currentTags.includes(act.tagKey)) {
                                currentTags.push(act.tagKey);
                                await messenger.messages.update(currentId, { tags: currentTags });
                            }
                        } else if (act.type === 'move' && act.folder) {
                            await messenger.messages.move([currentId], act.folder);
                            // The move invalidated the id, so look the message
                            // up in its new folder by its Message-ID header.
                            currentId = headerMessageIds.length
                                ? await findMessageId({ folder: act.folder }, headerMessageIds)
                                : null;
                        } else if (act.type === 'copy' && act.copyTarget) {
                            await messenger.messages.copy([currentId], act.copyTarget);
                        } else if (act.type === 'junk') {
                            await messenger.messages.update(currentId, { junk: !!act.junk });
                        } else if (act.type === 'read') {
                            await messenger.messages.update(currentId, { read: !!act.read });
                        } else if (act.type === 'flag') {
                            await messenger.messages.update(currentId, { flagged: !!act.flagged });
                        } else if (act.type === 'delete') {
                            await messenger.messages.delete([currentId]);
                            currentId = null;
                        } else if (act.type === 'archive') {
                            await messenger.messages.archive([currentId]);
                            const archiveFolderId = await findArchiveFolderId(accountId);
                            currentId = headerMessageIds.length
                                ? await findMessageId({
                                    ...(archiveFolderId ? { folder: archiveFolderId } : { accountId })
                                }, headerMessageIds)
                                : null;
                        } else if (act.type === 'forward' && act.address && identityId) {
                            await browser.compose.beginForward(currentId, { to: [act.address], identityId });
                        } else if (act.type === 'reply' && act.replyType && identityId) {
                            await browser.compose.beginReply(currentId, { replyType: act.replyType, identityId });
                        }
                    } catch (e) {
                        if (!isMessageGone(e)) throw e;
                        // The message was removed by something else (another
                        // filter, an expunge, a compacted folder). Stop acting
                        // on it instead of failing the whole email.
                        logger?.aiLog('message is no longer available, skipping its remaining actions', { debug: true }, e);
                        currentId = null;
                    }
                }
                if (rule.stopProcessing) {
                    break;
                }
            }
        }
        await finishMessage();
        showTransientIcon(ICONS.circle);
    } catch (e) {
        await finishMessage();
        logger.aiLog("failed to apply AI rules", { level: 'error' }, e);
        recordError(t('bg.errorApplyFailed'), e);
        browser.notifications.create(ERROR_NOTIFICATION_ID, {
            type: 'basic',
            iconUrl: browser.runtime.getURL('resources/img/logo.png'),
            title: t('bg.notifyTitle'),
            message: t('bg.notifyApplyFailed')
        });
    }
}
// Ids that are queued but not processed yet. The same message can reach the
// queue twice (the new-mail listener plus a manual run), and processing it
// twice would fail the second time, because the first run may have moved or
// deleted it.
const pendingMessageIds = new Set();

async function applyAiRules(idsInput) {
    const ids = Array.isArray(idsInput) ? idsInput : [idsInput];
    if (!ids.length) return queue;

    if (!aiRules.length) {
        const { aiRules: stored } = await storage.local.get("aiRules");
        aiRules = normalizeRules(stored);
    }

    for (const msg of ids) {
        const id = msg?.id ?? msg;
        if (pendingMessageIds.has(id)) {
            logger?.aiLog('message is already queued, skipping the duplicate', { debug: true }, id);
            continue;
        }
        pendingMessageIds.add(id);
        queuedCount++;
        updateActionIcon();
        queue = queue.then(() => processMessage(id)).finally(() => pendingMessageIds.delete(id));
    }

    return queue;
}

async function clearCacheForMessages(idsInput) {
    const ids = Array.isArray(idsInput) ? idsInput : [idsInput];
    if (!ids.length) return;

    if (!aiRules.length) {
        const { aiRules: stored } = await storage.local.get("aiRules");
        aiRules = normalizeRules(stored);
    }

    for (const msg of ids) await AiClassifier.clearCacheForMessage(msg?.id ?? msg);
    showTransientIcon(ICONS.circle);
}

(async () => {
    logger = await import(browser.runtime.getURL("logger.js"));
    i18n = await import(browser.runtime.getURL('modules/i18n.js'));
    ({ detectSystemTheme } = await import(browser.runtime.getURL('modules/themeUtils.js')));
    try {
        AiClassifier = await import(browser.runtime.getURL("modules/AiClassifier.js"));
        mailDigest = await import(browser.runtime.getURL('modules/mailDigest.js'));
        logger.aiLog("AiClassifier imported", { debug: true });
        const td = await import(browser.runtime.getURL("resources/js/turndown.js"));
        TurndownService = td.default || td.TurndownService;
    } catch (e) {
        console.error("failed to import AiClassifier", e);
        return;
    }

    try {
        const store = await storage.local.get(["systemOneProcessAll", "systemOneBatchSize", "apiType", "decisionThreshold", "inputCharacterLimit", "endpoint", "model", "apiKey", "openaiOrganization", "openaiProject", "customSystemPrompt", "promptLanguage", "aiParams", "debugLogging", "htmlToMarkdown", "stripUrlParams", "altTextImages", "collapseWhitespace", "tokenReduction", "aiRules", "theme", "showDebugTab"]);
        logger.setDebug(store.debugLogging);
        const { migratedInputLimit } = await import(browser.runtime.getURL('modules/classificationConfig.js'));
        if (store.inputCharacterLimit === undefined) {
            store.inputCharacterLimit = migratedInputLimit(store);
            await storage.local.set({ inputCharacterLimit: store.inputCharacterLimit });
        }
        await AiClassifier.setConfig(store);
        userTheme = store.theme || 'auto';
        currentTheme = userTheme === 'auto' ? await detectSystemTheme() : userTheme;
        await AiClassifier.init();
        htmlToMarkdown = store.htmlToMarkdown === true;
        stripUrlParams = store.stripUrlParams === true;
        altTextImages = store.altTextImages === true;
        collapseWhitespace = store.collapseWhitespace === true;
        tokenReduction = store.tokenReduction === true;
        showDebugTab = store.showDebugTab === true;
        const savedStats = await storage.local.get('classifyStats');
        if (savedStats.classifyStats && typeof savedStats.classifyStats === 'object') {
            Object.assign(timingStats, savedStats.classifyStats);
        }
        if (typeof timingStats.last !== 'number') {
            timingStats.last = -1;
        }
        aiRules = normalizeRules(store.aiRules);
        logger.aiLog("configuration loaded", { debug: true }, store);
        storage.onChanged.addListener(async changes => {
            if (changes.aiRules) {
                const newRules = changes.aiRules.newValue || [];
                aiRules = normalizeRules(newRules);
                logger.aiLog("aiRules updated from storage change", { debug: true }, aiRules);
            }
            const configChanges = Object.fromEntries(Object.entries(changes).map(([key, change]) => [key, change.newValue]));
            AiClassifier.setConfig(configChanges);
            if (changes.aiCache) AiClassifier.replaceCache(changes.aiCache.newValue);
            if (changes.htmlToMarkdown) {
                htmlToMarkdown = changes.htmlToMarkdown.newValue === true;
                logger.aiLog("htmlToMarkdown updated from storage change", { debug: true }, htmlToMarkdown);
            }
            if (changes.stripUrlParams) {
                stripUrlParams = changes.stripUrlParams.newValue === true;
                logger.aiLog("stripUrlParams updated from storage change", { debug: true }, stripUrlParams);
            }
            if (changes.altTextImages) {
                altTextImages = changes.altTextImages.newValue === true;
                logger.aiLog("altTextImages updated from storage change", { debug: true }, altTextImages);
            }
            if (changes.collapseWhitespace) {
                collapseWhitespace = changes.collapseWhitespace.newValue === true;
                logger.aiLog("collapseWhitespace updated from storage change", { debug: true }, collapseWhitespace);
            }
            if (changes.tokenReduction) {
                tokenReduction = changes.tokenReduction.newValue === true;
                logger.aiLog("tokenReduction updated from storage change", { debug: true }, tokenReduction);
            }
            if (changes.showDebugTab) {
                showDebugTab = changes.showDebugTab.newValue === true;
            }
            if (changes.theme) {
                userTheme = changes.theme.newValue || 'auto';
                currentTheme = userTheme === 'auto' ? await detectSystemTheme() : userTheme;
                updateActionIcon();
                refreshMenuIcons();
            }
        });

        if (browser.theme?.onUpdated) {
            browser.theme.onUpdated.addListener(async () => {
                if (userTheme === 'auto') {
                    const theme = await detectSystemTheme();
                    if (theme !== currentTheme) {
                        currentTheme = theme;
                        updateActionIcon();
                        refreshMenuIcons();
                    }
                }
            });
        }
    } catch (err) {
        logger.aiLog("failed to load config", { level: 'error' }, err);
    }

    logger.aiLog("background.js loaded – ready to classify", { debug: true });
    updateActionIcon();
    if (browser.messageDisplayAction) {
        browser.messageDisplayAction.setTitle({ title: t('bg.actionDetails') });
        if (browser.messageDisplayAction.setLabel) {
            browser.messageDisplayAction.setLabel({ label: t('bg.actionDetails') });
        }

    }

    browser.menus.create({
        id: "apply-ai-rules-list",
        title: t('bg.menu.applyRules'),
        contexts: ["message_list"],
        icons: iconPaths('eye')
    });
    browser.menus.create({
        id: "apply-ai-rules-display",
        title: t('bg.menu.applyRules'),
        contexts: ["message_display_action"],
        icons: iconPaths('eye')
    });
    browser.menus.create({
        id: "clear-ai-cache-list",
        title: t('bg.menu.clearCache'),
        contexts: ["message_list"],
        icons: iconPaths('trash')
    });
    browser.menus.create({
        id: "clear-ai-cache-display",
        title: t('bg.menu.clearCache'),
        contexts: ["message_display_action"],
        icons: iconPaths('trash')
    });
    browser.menus.create({
        id: "view-ai-reason-list",
        title: t('bg.menu.viewReasoning'),
        contexts: ["message_list"],
        icons: iconPaths('clipboarddata')
    });
    browser.menus.create({
        id: "view-ai-reason-display",
        title: t('bg.menu.viewReasoning'),
        contexts: ["message_display_action"],
        icons: iconPaths('clipboarddata')
    });
    refreshMenuIcons();

    browser.menus.onClicked.addListener(async (info, tab) => {
        if (info.menuItemId === "apply-ai-rules-list" || info.menuItemId === "apply-ai-rules-display") {
            let ids = info.messageId ? [info.messageId] : [];
            if (info.selectedMessages) {
                ids = await getAllMessageIds(info.selectedMessages);
            }
            await applyAiRules(ids);
        } else if (info.menuItemId === "clear-ai-cache-list" || info.menuItemId === "clear-ai-cache-display") {
            let ids = info.messageId ? [info.messageId] : [];
            if (info.selectedMessages) {
                ids = await getAllMessageIds(info.selectedMessages);
            }
            await clearCacheForMessages(ids);
        } else if (info.menuItemId === "view-ai-reason-list" || info.menuItemId === "view-ai-reason-display") {
            const [header] = await browser.messageDisplay.getDisplayedMessages(tab.id);
            if (!header) { return; }

            const url = `${browser.runtime.getURL("details.html")}?mid=${header.id}`;

            await browser.tabs.create({ url });
        }
    });

    // Listen for messages from UI/devtools
    browser.runtime.onMessage.addListener(async (msg) => {
        if ((msg?.type === "sortana:getTiming" && logGetTiming) || (msg?.type !== "sortana:getTiming")) {
            logGetTiming = false;
            logger.aiLog("onMessage received", { debug: true }, msg);
        }

        if (msg?.type === "sortana:test") {
            const { text = "", criterion = "" } = msg;
            logger.aiLog("sortana:test – text", { debug: true }, text);
            logger.aiLog("sortana:test – criterion", { debug: true }, criterion);

            try {
                logger.aiLog("Calling AiClassifier.classify()", { debug: true });
                const result = await AiClassifier.classify(text, criterion, { threshold: msg.decisionThreshold ?? AiClassifier.getConfig().decisionThreshold });
                logger.aiLog("classify() returned", { debug: true }, result);
                return { ...result, match: result.matched };
            }
            catch (err) {
                logger.aiLog("Error in classify()", { level: 'error' }, err);
                // rethrow so the caller sees the failure
                throw err;
            }
        } else if (msg?.type === "sortana:clearCacheForDisplayed") {
            try {
                const msgs = await browser.messageDisplay.getDisplayedMessages();
                const ids = msgs.map(m => m.id);
                await clearCacheForMessages(ids);
            } catch (e) {
                logger.aiLog("failed to clear cache from message script", { level: 'error' }, e);
            }
        } else if (msg?.type === "sortana:getReasons") {
            try {
                const id = msg.id;
                const hdr = await messenger.messages.get(id);
                const subject = hdr?.subject || "";
                if (!aiRules.length) {
                    const { aiRules: stored } = await storage.local.get("aiRules");
                    aiRules = normalizeRules(stored);
                }
                const reasons = [];
                for (const rule of aiRules) {
                    const key = await AiClassifier.buildCacheKey(id, rule.criterion);
                    const reason = AiClassifier.getReason(key);
                    if (reason) {
                        reasons.push({ criterion: rule.criterion, reason });
                    }
                }
                return { subject, reasons };
            } catch (e) {
                logger.aiLog("failed to collect reasons", { level: 'error' }, e);
                return { subject: '', reasons: [] };
            }
        } else if (msg?.type === "sortana:getDetails") {
            try {
                const id = msg.id;
                const hdr = await messenger.messages.get(id);
                const subject = hdr?.subject || "";
                if (!aiRules.length) {
                    const { aiRules: stored } = await storage.local.get("aiRules");
                    aiRules = normalizeRules(stored);
                }
                const results = [];
                const snapshot = AiClassifier.getConfig();
                for (const rule of structuredClone(aiRules)) {
                    const key = await AiClassifier.buildCacheKey(id, rule.criterion, snapshot);
                    const detail = AiClassifier.getCachedDetails(key, rule.decisionThreshold ?? snapshot.decisionThreshold);
                    if (detail) results.push({ criterion: rule.criterion, ...detail });
                }
                return { subject, results };
            } catch (e) {
                logger.aiLog("failed to collect details", { level: 'error' }, e);
                return { subject: '', results: [] };
            }
        } else if (msg?.type === "sortana:getDisplayedMessages") {
            try {
                const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
                const messages = await browser.messageDisplay.getDisplayedMessages(tab?.id);
                const ids = messages.map(hdr => hdr.id);

                return { ids };
            } catch (e) {
                logger.aiLog("failed to get displayed messages", { level: 'error' }, e);
                return { messages: [] };
            }
        } else if (msg?.type === "sortana:clearCacheForMessage") {
            try {
                await clearCacheForMessages([msg.id]);
                return { ok: true };
            } catch (e) {
                logger.aiLog("failed to clear cache for message", { level: 'error' }, e);
                return { ok: false };
            }
        } else if (msg?.type === "sortana:resetTimingStats") {
            const last = timingStats.last;
            timingStats.count = 0;
            timingStats.mean = 0;
            timingStats.m2 = 0;
            timingStats.total = 0;
            timingStats.last = typeof last === 'number' ? last : -1;
            await storage.local.set({ classifyStats: timingStats });
            return { ok: true };
        } else if (msg?.type === "sortana:getCacheSize") {
            return { count: await AiClassifier.getCacheSize() };
        } else if (msg?.type === "sortana:getQueueCount") {
            return { count: queuedCount + (processing ? 1 : 0) };
        } else if (msg?.type === "sortana:getErrorLog") {
            return { errors: errorLog.slice() };
        } else if (msg?.type === "sortana:recordError") {
            recordError(msg.context || "Sortana Error", { message: msg.message, detail: msg.detail });
            return { ok: true };
        } else if (msg?.type === "sortana:getTiming") {
            const stats = timingStats;
            const std = stats.count > 1 ? Math.sqrt(stats.m2 / (stats.count - 1)) : 0;
            return {
                count: queuedCount + (processing ? 1 : 0),
                current: currentStart ? Date.now() - currentStart : -1,
                last: stats.last,
                runs: stats.count,
                average: stats.mean,
                total: stats.total,
                stddev: std
            };
        } else {
            logger.aiLog("Unknown message type, ignoring", { level: 'warn' }, msg?.type);
        }
    });

    // Automatically classify new messages
    if (typeof messenger !== "undefined" && messenger.messages?.onNewMailReceived) {
        messenger.messages.onNewMailReceived.addListener(async (folder, messages) => {
            logger.aiLog("onNewMailReceived", { debug: true }, messages);
            const ids = (messages?.messages || messages || []).map(m => m.id ?? m);
            await applyAiRules(ids);
        });
    } else {
        logger.aiLog("messenger.messages API unavailable, skipping new mail listener", { level: 'warn' });
    }

    // Catch any unhandled rejections
    window.addEventListener("unhandledrejection", ev => {
        logger.aiLog("Unhandled promise rejection", { level: 'error' }, ev.reason);
        recordError(t('bg.errorUnhandledRejection'), ev.reason);
    });

    browser.notifications.onClicked.addListener(id => {
        if (id === ERROR_NOTIFICATION_ID) {
            clearError();
        }
    });

    browser.notifications.onButtonClicked.addListener((id) => {
        if (id === ERROR_NOTIFICATION_ID) {
            clearError();
        }
    });

    browser.runtime.onInstalled.addListener(async ({ reason }) => {
        if (reason === "install") {
            await browser.runtime.openOptionsPage();
        }
    });

})();
