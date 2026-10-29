import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { CONFIG_DEFAULTS, validateSettings } from '../modules/classificationConfig.js';
import { DEFAULT_AI_PARAMS } from '../modules/defaultParams.js';
import * as chat from '../modules/backends/chatCompletions.js';
import * as systemone from '../modules/backends/systemOne.js';
import { resolvePromptLanguage, containsHan, templateLanguage } from '../modules/promptLanguage.js';
import { loadMessages, placeholdersOf } from './support/i18n.js';

const LOCALES = ['en-US', 'zh_CN', 'zh_TW'];
const catalogs = Object.fromEntries(await Promise.all(
    LOCALES.map(async locale => [locale, await loadMessages(locale)])
));

// ---------------------------------------------------------------------------
// Message catalogs
// ---------------------------------------------------------------------------

test('every locale ships the same message keys', () => {
    const reference = Object.keys(catalogs['en-US']);
    assert.ok(reference.length > 100, 'expected a substantial message catalog');
    for (const locale of LOCALES) {
        assert.deepEqual(Object.keys(catalogs[locale]), reference, `${locale} key set differs`);
    }
});

test('no translation is left empty', () => {
    for (const locale of LOCALES) {
        for (const [key, entry] of Object.entries(catalogs[locale])) {
            assert.equal(typeof entry?.message, 'string', `${locale}/${key} is not a string`);
            assert.ok(entry.message.trim().length > 0, `${locale}/${key} is empty`);
        }
    }
});

test('placeholders survive translation', () => {
    for (const [key, entry] of Object.entries(catalogs['en-US'])) {
        const expected = placeholdersOf(entry.message);
        for (const locale of LOCALES) {
            assert.deepEqual(placeholdersOf(catalogs[locale][key].message), expected,
                `${locale}/${key} placeholder mismatch`);
        }
    }
});

test('Chinese catalog translates the user-visible strings', () => {
    const zh = catalogs['zh_CN'];
    assert.equal(zh['tab.settings'].message, '设置');
    assert.equal(zh['action.save'].message, '保存');
    assert.equal(zh['actionType.junk'].message, '垃圾邮件');
    assert.notEqual(zh['settings.endpoint'].message, catalogs['en-US']['settings.endpoint'].message);
});

test('Traditional Chinese catalog uses Taiwan terminology', () => {
    const tw = catalogs['zh_TW'];
    assert.equal(tw['action.clearCache'].message, '清除快取');
    assert.equal(tw['maint.categoryRules'].message, '規則');
    assert.notEqual(tw['settings.endpoint'].message, catalogs['en-US']['settings.endpoint'].message);
});

test('every marked-up string is translatable text', async () => {
    // A checkbox label is a sibling text node of its input, so data-i18n on
    // the input itself would translate nothing. The markup must wrap the
    // label text in an element instead.
    for (const file of ['options/options.html', 'details.html']) {
        const html = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
        const onInputs = [...html.matchAll(/<input[^>]*\sdata-i18n=/g)];
        assert.deepEqual(onInputs.map(m => m[0]), [], `${file} marks an input instead of its label`);
    }
});

test('applyToDocument translates text and attributes and substitutes placeholders', async () => {
    const { applyToDocument } = await import('../modules/i18n.js');
    const messages = catalogs['en-US'];
    const make = (dataset) => ({
        dataset,
        textContent: '',
        title: '',
        placeholder: '',
        alt: '',
        attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; }
    });
    const elements = [
        make({ i18n: 'tab.settings' }),
        make({ i18nTitle: 'settings.endpoint' }),
        make({ i18nPlaceholder: 'rules.criterionPlaceholder' }),
        make({ i18nAlt: 'app.logoAlt' }),
        make({ i18nAriaLabel: 'param.address' })
    ];
    const root = { querySelectorAll: () => elements };
    globalThis.browser = { i18n: { getMessage: key => messages[key]?.message || '' } };
    applyToDocument(root);
    delete globalThis.browser;

    assert.equal(elements[0].textContent, 'Settings');
    assert.equal(elements[1].title, 'Endpoint');
    assert.equal(elements[2].placeholder, 'e.g. Does this email need a reply soon?');
    assert.equal(elements[3].alt, 'Sortana logo');
    assert.equal(elements[4].attributes['aria-label'], 'address');
});

test('a missing key falls back to the key instead of blanking the label', async () => {
    const { t } = await import('../modules/i18n.js');
    globalThis.browser = { i18n: { getMessage: () => '' } };
    assert.equal(t('does.not.exist'), 'does.not.exist');
    delete globalThis.browser;
});

// The chain of elements still open at a given offset in the markup.
function ancestorChain(html, index) {
    const stack = [];
    const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        if (m.index >= index) break;
        if (m[1] === '/') { stack.pop(); continue; }
        if (m[3] === '/') continue;
        stack.push(m[0]);
    }
    return stack;
}

test('the API token field is reachable without expanding a collapsed panel', async () => {
    const html = await readFile(new URL('../options/options.html', import.meta.url), 'utf8');
    const tokenAt = html.indexOf('id="api-key"');
    assert.ok(tokenAt > 0, 'the token input is missing from the options page');
    assert.equal(html.split('id="api-key"').length - 1, 1, 'the token input must appear exactly once');

    // The credential must not be buried inside a container that starts hidden.
    for (const ancestor of ancestorChain(html, tokenAt)) {
        assert.ok(!/\bis-hidden\b/.test(ancestor),
            `the token input is inside a collapsed element: ${ancestor}`);
    }
});

test('the token field is not hidden by the API type switch', async () => {
    const source = await readFile(new URL('../options/options.js', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('function updateApiControls()'), source.indexOf('apiTypeInput.addEventListener'));
    const hidden = body.match(/\[[^\]]*\]/)?.[0] ?? '';
    assert.ok(hidden, 'could not locate the hidden-field list in updateApiControls');
    assert.ok(!hidden.includes('api-key'),
        'the token field must stay visible for both API types');
    // The organisation and project headers remain Chat Completions only.
    assert.ok(hidden.includes('openai-organization'));
    assert.ok(hidden.includes('openai-project'));
});

// ---------------------------------------------------------------------------
// Prompt language
// ---------------------------------------------------------------------------

const chatConfig = {
    ...CONFIG_DEFAULTS,
    apiType: 'chat-completions',
    endpoint: 'https://api.example.com',
    aiParams: { ...DEFAULT_AI_PARAMS }
};

// The exact request the add-on produces for an email summary. If this
// changes, every stored cache entry becomes unreachable.
const SUMMARY_SYSTEM_CONTENT = `You are an email-classification assistant.
Read the email summary below and the classification criteria provided by the user.
The summary lists the metadata of the message (the lines subject, date, from, to and cc), the file names of the attachments, and three excerpts of the body: the beginning, the middle and the end. The complete body text and the attachment contents are not included, so judge each criterion from the metadata and the excerpts. Content that is missing from an excerpt is not proof that it is missing from the email.

Classification Criteria:
1. Is this a bill?

Return ONLY a JSON array on a single line, with 1 element(s) — one for each criterion, each naming the criterion it belongs to with the number given above:
[{"index": 1, "match": true, "reason": "<reason>"}]

Every criterion must appear exactly once, identified by its number. Do not add any other keys, text, or formatting.`;

test('an English criterion produces the summary request byte for byte', () => {
    const payload = chat.buildRequest('body', 'Is this a bill?', chatConfig);
    assert.equal(payload.messages[0].content, SUMMARY_SYSTEM_CONTENT);
    assert.equal(payload.messages[1].content, '**Email Summary**\n```\nbody\n```');
});

test('the criteria sit in the system message and the user message carries only the summary', () => {
    const payload = chat.buildRequest('body', ['Is this a bill?', 'Does it need a reply?'], chatConfig);
    assert.ok(payload.messages[0].content.includes('Classification Criteria:\n1. Is this a bill?\n2. Does it need a reply?'));
    assert.equal(payload.messages[1].content, '**Email Summary**\n```\nbody\n```');
});

test('the answer example uses the numbers of the actual criteria', () => {
    // A model that copies the example must not copy a number that belongs to
    // a different criterion, so the example carries the real numbers.
    const payload = chat.buildRequest('body', ['Only criterion'], chatConfig, [3]);
    assert.ok(payload.messages[0].content.includes('Classification Criteria:\n3. Only criterion'));
    assert.ok(payload.messages[0].content.includes('[{"index": 3,'));
    assert.ok(!payload.messages[0].content.includes('"index": 1'), 'no foreign number in the example');
    assert.ok(payload.messages[0].content.includes('with 1 element'));
});

test('the strict prompt demands a conservative verdict', () => {
    const strict = chat.buildRequest('body', 'Is this a bill?', { ...chatConfig, tokenReduction: true });
    assert.ok(strict.messages[0].content.includes('heavily abbreviated'));
    assert.ok(strict.messages[0].content.includes('answer false'));
    assert.ok(!chat.buildRequest('body', 'Is this a bill?', chatConfig).messages[0].content.includes('heavily abbreviated'));
});

test('the template shown on the options page follows the interface language when it is automatic', () => {
    // The automatic setting follows the criterion, which the options page
    // cannot know, so the interface language decides what is shown there.
    assert.equal(templateLanguage('auto', 'zh-CN'), 'zh-CN');
    assert.equal(templateLanguage('auto', 'zh-TW'), 'zh-CN');
    assert.equal(templateLanguage('auto', 'en-US'), 'en');
    assert.equal(templateLanguage('auto', ''), 'en');
    // An explicit choice always wins over the interface language.
    assert.equal(templateLanguage('zh-CN', 'en-US'), 'zh-CN');
    assert.equal(templateLanguage('en', 'zh-CN'), 'en');
});

test('the built-in template is shown on the options page and carries the placeholders', () => {
    const english = chat.getDefaultTemplate('en');
    const chinese = chat.getDefaultTemplate('zh-CN');
    for (const placeholder of chat.PLACEHOLDERS) {
        assert.ok(english.includes(placeholder), `the English template is missing ${placeholder}`);
        assert.ok(chinese.includes(placeholder), `the Chinese template is missing ${placeholder}`);
    }
    // The template is what the model receives, with the placeholders filled in.
    const payload = chat.buildRequest('body', 'Is this a bill?', chatConfig);
    assert.ok(!payload.messages[0].content.includes('%'), 'no placeholder is left in the request');
    assert.ok(payload.messages[0].content.includes('Classification Criteria:'));
    assert.ok(payload.messages[0].content.includes('with 1 element(s)'));
});

test('a custom system prompt replaces the built-in template', () => {
    const custom = 'Answer the question.\n%CRITERIA%';
    const payload = chat.buildRequest('body', 'Is this a bill?', { ...chatConfig, customSystemPrompt: custom });
    assert.ok(payload.messages[0].content.startsWith('Answer the question.'), 'the custom text leads');
    assert.ok(payload.messages[0].content.includes('1. Is this a bill?'), 'the criteria are still there');
    assert.ok(!payload.messages[0].content.includes('You are an email-classification assistant.'));
    // A custom template without the placeholder still gets the criteria, so
    // a criterion can never be lost.
    const bare = chat.buildRequest('body', 'Is this a bill?', { ...chatConfig, customSystemPrompt: 'Answer it.' });
    assert.ok(bare.messages[0].content.includes('1. Is this a bill?'));
    // An empty custom prompt falls back to the built-in template.
    const built = chat.buildRequest('body', 'Is this a bill?', chatConfig);
    assert.ok(built.messages[0].content.includes('You are an email-classification assistant.'));
    assert.ok(built.messages[0].content.includes('1. Is this a bill?'));
});

test('auto follows the criterion language, not the body or the UI locale', () => {
    assert.equal(resolvePromptLanguage({ promptLanguage: 'auto' }, 'Is this a bill?'), 'en');
    assert.equal(resolvePromptLanguage({ promptLanguage: 'auto' }, '这封邮件是账单吗？'), 'zh-CN');
    // The body is irrelevant: the cache fingerprint is computed with an empty
    // body, so a body-dependent decision would desynchronise key and request.
    assert.equal(resolvePromptLanguage({ promptLanguage: 'auto' }, '这封邮件是账单吗？'), 'zh-CN');
    assert.equal(containsHan('账单'), true);
    assert.equal(containsHan('bill'), false);
});

test('the prompt language can be pinned regardless of the criterion', () => {
    const english = { ...chatConfig, promptLanguage: 'en' };
    const chinese = { ...chatConfig, promptLanguage: 'zh-CN' };
    assert.ok(chat.buildRequest('body', '这封邮件是账单吗？', english).messages[0].content.includes('You are an email-classification assistant.'));
    assert.ok(chat.buildRequest('body', 'Is this a bill?', chinese).messages[0].content.includes('你是一个邮件分类助手。'));
});

test('a Chinese criterion produces a Chinese prompt and asks for a Chinese reason', () => {
    const payload = chat.buildRequest('正文内容', '这封邮件需要我尽快回复吗？', chatConfig);
    assert.ok(payload.messages[0].content.includes('你是一个邮件分类助手。'));
    assert.ok(payload.messages[0].content.includes('reason 请使用与分类标准相同的语言撰写。'));
    assert.ok(payload.messages[0].content.includes('分类标准：\n1. 这封邮件需要我尽快回复吗？'));
    assert.equal(payload.messages[1].content, '**邮件摘要**\n```\n正文内容\n```');
});

test('SystemOne instructions follow the criterion language', () => {
    const english = systemone.buildRequest('state', 'Is this a bill?', { ...CONFIG_DEFAULTS, promptLanguage: 'auto' });
    assert.match(english.questions.match.instructions, /^Does this email satisfy the following criterion: Is this a bill\?/);
    assert.match(english.questions.match.instructions, /provided as a summary/);
    const chinese = systemone.buildRequest('state', '这封邮件是账单吗？', { ...CONFIG_DEFAULTS, promptLanguage: 'auto' });
    assert.match(chinese.questions.match.instructions, /^这封邮件是否满足以下分类标准：这封邮件是账单吗？/);
    assert.match(chinese.questions.match.instructions, /摘要形式/);
});

test('the strict SystemOne instruction asks for a low probability when the evidence is thin', () => {
    const strict = systemone.buildRequest('state', 'Is this a bill?', { ...CONFIG_DEFAULTS, tokenReduction: true });
    assert.match(strict.questions.match.instructions, /probability of 0/);
    const chinese = systemone.buildRequest('state', '这封邮件是账单吗？', { ...CONFIG_DEFAULTS, tokenReduction: true });
    assert.match(chinese.questions.match.instructions, /接近 0 的概率/);
});

test('an unknown prompt language is rejected', () => {
    assert.throws(() => validateSettings({ promptLanguage: 'fr' }), /Unknown prompt language/);
    assert.throws(() => validateSettings({ promptLanguage: 'zh_CN' }), /Unknown prompt language/);
});

// ---------------------------------------------------------------------------
// Cache fingerprint stability
// ---------------------------------------------------------------------------

// The request construction as it is now. Used to prove that the cache key of
// an installation is stable.
const SUMMARY_SYSTEM_TEMPLATE = `You are an email-classification assistant.
Read the email summary below and the classification criteria provided by the user.
The summary lists the metadata of the message (the lines subject, date, from, to and cc), the file names of the attachments, and three excerpts of the body: the beginning, the middle and the end. The complete body text and the attachment contents are not included, so judge each criterion from the metadata and the excerpts. Content that is missing from an excerpt is not proof that it is missing from the email.
%CRITERIA%
%STRICT%
Return ONLY a JSON array on a single line, with %COUNT% element(s) — one for each criterion, each naming the criterion it belongs to with the number given above:
[%EXAMPLE%]

Every criterion must appear exactly once, identified by its number. Do not add any other keys, text, or formatting.`;

function summaryBuildRequest(text, criterion, config) {
    const criteriaArray = Array.isArray(criterion) ? criterion : [criterion];
    const list = criteriaArray.map((c, i) => `${i + 1}. ${c}`).join('\n');
    const example = criteriaArray.slice(0, 3).map((c, i) =>
        `{"index": ${i + 1}, "match": ${i === 0 ? 'true' : 'false'}, "reason": "<reason>"}`).join(', ');
    const template = config.customSystemPrompt || SUMMARY_SYSTEM_TEMPLATE;
    const system = template
        .replaceAll('%CRITERIA%', `\nClassification Criteria:\n${list}`)
        .replaceAll('%STRICT%', '')
        .replaceAll('%COUNT%', String(criteriaArray.length))
        .replaceAll('%EXAMPLE%', example)
        .replace(/\n{3,}/g, '\n\n');
    const payload = {
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: `**Email Summary**\n\`\`\`\n${text}\n\`\`\`` }
        ], ...config.aiParams
    };
    if (config.model) payload.model = config.model;
    return payload;
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
    }
    return value;
}

async function sha256(value) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

globalThis.messenger = { storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } },
    messages: { async get(id) { return { headerMessageId: `mail-${id}` }; } } };
const classifier = await import('../modules/AiClassifier.js');

test('the cache key of an English installation is stable', async () => {
    const snapshot = { ...chatConfig, customSystemPrompt: '', model: 'gpt-test' };
    const criterion = 'Is this a bill?';
    const id = 42;

    const fingerprint = {
        backend: snapshot.apiType,
        endpoint: classifier.buildEndpointUrl(snapshot.endpoint, snapshot.apiType),
        request: summaryBuildRequest('', criterion, snapshot),
        organization: snapshot.openaiOrganization,
        project: snapshot.openaiProject,
        preprocessing: Object.fromEntries(
            ['htmlToMarkdown', 'stripUrlParams', 'altTextImages', 'collapseWhitespace', 'tokenReduction', 'inputCharacterLimit']
                .map(k => [k, snapshot[k]])
        )
    };
    const messageHash = await sha256(`mail-${id}`);
    const expectedKey = `v4:${messageHash}:${await sha256(JSON.stringify(stable(fingerprint)))}`;

    assert.equal(await classifier.buildCacheKey(id, criterion, snapshot), expectedKey);
});

test('the strict mode has its own cache entries', async () => {
    const snapshot = { ...chatConfig, customSystemPrompt: '', model: 'gpt-test' };
    const normal = await classifier.buildCacheKey(1, 'Is this a bill?', snapshot);
    const strict = await classifier.buildCacheKey(1, 'Is this a bill?', { ...snapshot, tokenReduction: true });
    assert.notEqual(normal, strict, 'a strict request must not reuse a normal entry');
});

test('the prompt language reaches the fingerprint only through the request', async () => {
    const snapshot = { ...chatConfig, customSystemPrompt: '', model: 'gpt-test' };
    const criterion = 'Is this a bill?';
    const english = await classifier.buildCacheKey(1, criterion, { ...snapshot, promptLanguage: 'en' });
    const auto = await classifier.buildCacheKey(1, criterion, { ...snapshot, promptLanguage: 'auto' });
    const chinese = await classifier.buildCacheKey(1, criterion, { ...snapshot, promptLanguage: 'zh-CN' });
    assert.equal(english, auto, 'auto and en must share a cache entry');
    assert.notEqual(english, chinese, 'a Chinese prompt must not reuse an English entry');
});

// ---------------------------------------------------------------------------
// Chinese text handling in background.js
// ---------------------------------------------------------------------------

const backgroundSource = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const textHelpers = backgroundSource.slice(
    backgroundSource.indexOf('const URL_PATTERN'),
    backgroundSource.indexOf('function collectText(')
);
function helpers(overrides = {}) {
    const context = vm.createContext({
        TextEncoder, TextDecoder, atob, decodeURIComponent, console,
        tokenReduction: false, stripUrlParams: true, collapseWhitespace: false,
        ...overrides
    });
    vm.runInContext(textHelpers, context);
    return context;
}

test('removing URL parameters keeps the Chinese sentence that follows the link', () => {
    const { sanitizeString } = helpers();
    const text = '详情请见 https://example.com/a?x=1，然后请回复本邮件。谢谢。';
    const result = sanitizeString(text);
    assert.ok(result.includes('然后请回复本邮件。谢谢。'), 'Chinese text after the URL was deleted');
    assert.ok(result.includes('https://example.com/a'));
    assert.ok(!result.includes('x=1'));
});

test('removing URL parameters still works for English text', () => {
    const { sanitizeString } = helpers();
    const result = sanitizeString('See https://example.com/a?x=1, then reply.');
    assert.equal(result, 'See https://example.com/a then reply.');
});

test('a URL without a query string is left intact', () => {
    const { sanitizeString } = helpers();
    assert.equal(sanitizeString('访问 https://example.com/page 了解详情'),
        '访问 https://example.com/page 了解详情');
});

test('RFC 5987 attachment names are decoded', () => {
    const { decodeFilename } = helpers();
    assert.equal(decodeFilename("attachment; filename*=UTF-8''%E9%99%84%E4%BB%B6.pdf"), '附件.pdf');
    assert.equal(decodeFilename('attachment; filename="report.pdf"'), 'report.pdf');
    assert.equal(decodeFilename('attachment; name="report.pdf"'), 'report.pdf');
    assert.equal(decodeFilename('application/pdf'), '');
});

test('RFC 2047 encoded headers are decoded', () => {
    const { decodeMimeWords } = helpers();
    assert.equal(decodeMimeWords('=?UTF-8?B?5Y+R56Wo?='), '发票');
    assert.equal(decodeMimeWords('=?UTF-8?Q?=E5=8F=91=E7=A5=A8?='), '发票');
    assert.equal(decodeMimeWords('=?GB2312?B?t6LGsQ==?='), '发票');
    assert.equal(decodeMimeWords('Plain Subject'), 'Plain Subject');
    assert.equal(decodeMimeWords('=?UTF-8?B?5Y+R56Wo?= =?UTF-8?B?5pS25o2u?='), '发票收据');
});
