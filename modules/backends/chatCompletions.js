import { resolvePromptLanguage } from '../promptLanguage.js';
import { aiLog } from '../../logger.js';

// The system message is one editable template. The user message carries the
// email summary only, so the model cannot confuse a line of the mail with an
// instruction, and the criteria sit next to the task description instead of
// trailing a long body of text.
//
// The template holds placeholders that are filled in for every request:
//
//   %CRITERIA%  the numbered list of criteria
//   %STRICT%    the rule for the strict mode, empty when it is off
//   %COUNT%     the number of criteria
//   %EXAMPLE%   an example of the expected answer
//
// The options page shows this template as it is, so what the user edits is
// what the model receives. A template without %CRITERIA% still gets the
// criteria appended, so a criterion can never be lost.
//
// The templates are part of the cache fingerprint, because the fingerprint is
// derived from buildRequest(). Changing them invalidates every stored
// classification result, so they change together with the cache version.

const TEMPLATES = {
    en: `You are an email-classification assistant.
Read the email summary below and the classification criteria provided by the user.
The summary lists the metadata of the message (the lines subject, date, from, to and cc), the file names of the attachments, and three excerpts of the body: the beginning, the middle and the end. The complete body text and the attachment contents are not included, so judge each criterion from the metadata and the excerpts. Content that is missing from an excerpt is not proof that it is missing from the email.
%CRITERIA%
%STRICT%
Return ONLY a JSON array on a single line, with %COUNT% element(s) — one for each criterion, each naming the criterion it belongs to with the number given above:
[%EXAMPLE%]

Every criterion must appear exactly once, identified by its number. Do not add any other keys, text, or formatting.`,
    'zh-CN': `你是一个邮件分类助手。
请阅读下面的邮件摘要，以及用户提供的分类标准列表。
摘要包含邮件的元数据（subject、date、from、to、cc 各行）、附件文件名，以及正文的三段片段：开头、中间和结尾。完整正文与附件内容并未包含，请依据元数据与片段判断每个标准。片段中没有出现的内容，不能说明原邮件里也没有。
%CRITERIA%
%STRICT%
只返回一行 JSON 数组，共 %COUNT% 个元素——每个分类标准一个元素，并用上面给出的编号标明它对应的是哪个分类标准：
[%EXAMPLE%]

每个分类标准必须恰好出现一次，用它的编号标识。不要添加任何其他键、文本或格式。reason 请使用与分类标准相同的语言撰写。`
};

const CRITERIA_HEADING = {
    en: '\nClassification Criteria:\n',
    'zh-CN': '\n分类标准：\n'
};

const SUMMARY_LABEL = {
    en: 'Email Summary',
    'zh-CN': '邮件摘要'
};

const STRICT_NOTE = {
    en: 'The summary is heavily abbreviated. Only use what is shown. If the available evidence does not clearly satisfy a criterion, answer false for that criterion and state that the evidence was insufficient.',
    'zh-CN': '摘要经过了高度压缩，请只依据所示内容判断。若现有证据不足以明确满足某个分类标准，请对该标准回答 false，并说明证据不足。'
};

// The placeholders that the options page shows. They are filled in for every
// request, so the text the user edits is the text the model receives.
export const PLACEHOLDERS = ['%CRITERIA%', '%STRICT%', '%COUNT%', '%EXAMPLE%'];

/**
 * The built-in template for a prompt language.
 *
 * @param {'en'|'zh-CN'} language
 * @returns {string}
 */
export function getDefaultTemplate(language) {
    return TEMPLATES[language] || TEMPLATES.en;
}

/**
 * Fill the placeholders of a template.
 *
 * @param {string} template
 * @param {string[]} criteria
 * @param {number[]} labels the number shown for each criterion
 * @param {boolean} strict
 * @param {'en'|'zh-CN'} language
 * @returns {string}
 */
function renderTemplate(template, criteria, labels, strict, language) {
    const list = criteria.map((criterion, index) => `${labels[index]}. ${criterion}`).join('\n');
    const heading = CRITERIA_HEADING[language] || CRITERIA_HEADING.en;
    // The example carries the real numbers, so a model that copies it cannot
    // put an answer into the slot of a different criterion.
    const example = labels.slice(0, 3).map((label, index) =>
        `{"index": ${label}, "match": ${index === 0 ? 'true' : 'false'}, "reason": "<reason>"}`).join(', ');
    const strictNote = strict ? STRICT_NOTE[language] || STRICT_NOTE.en : '';
    let text = template
        .replaceAll('%CRITERIA%', `${heading}${list}`)
        .replaceAll('%STRICT%', strictNote)
        .replaceAll('%COUNT%', String(criteria.length))
        .replaceAll('%EXAMPLE%', example);
    // A template that lost a placeholder still has to carry the criteria.
    if (!template.includes('%CRITERIA%')) {
        text += `${heading}${list}`;
    }
    if (strict && !template.includes('%STRICT%')) {
        text += `\n${strictNote}`;
    }
    // An empty placeholder leaves a blank line behind.
    return text.replace(/\n{3,}/g, '\n\n');
}


function extractLastJsonArray(text) {
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
        if (ch === "[") {
            if (depth === 0) {
                start = i;
            }
            depth += 1;
            continue;
        }
        if (ch === "]" && depth > 0) {
            depth -= 1;
            if (depth === 0 && start !== -1) {
                last = text.slice(start, i + 1);
                start = -1;
            }
        }
    }

    return last;
}

export const path = '/v1/chat/completions';
export function buildRequest(text, criteria, config, numbers = null) {
    // criteria can be a single string or an array of criterion strings
    const criteriaArray = Array.isArray(criteria) ? criteria : [criteria];
    // The number shown for each criterion. A retry for a skipped criterion
    // keeps the number the criterion had in the original batch, so the number
    // always identifies the same criterion.
    const labels = numbers && numbers.length === criteriaArray.length
        ? numbers
        : criteriaArray.map((_, i) => i + 1);
    // The prompt language follows the first criterion. A batch with criteria
    // in different languages therefore uses one language for the whole batch.
    const language = resolvePromptLanguage(config, criteriaArray[0]);
    // The strict variant is selected by the configuration alone, never by the
    // body, because the cache fingerprint is built from an empty body.
    const strict = config.tokenReduction === true;
    // A custom template replaces the built-in one entirely; it is the text the
    // user edited on the options page, so it is what the model receives.
    const template = config.customSystemPrompt || getDefaultTemplate(language);
    const system = renderTemplate(template, criteriaArray, labels, strict, language);
    const payload = {
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: `**${SUMMARY_LABEL[language] || SUMMARY_LABEL.en}**\n\`\`\`\n${text}\n\`\`\`` }
        ], ...config.aiParams
    };
    if (config.model) payload.model = config.model;
    return payload;
}

// Parse a single result object.
function parseSingleObject(obj) {
    const matched = Object.hasOwn(obj, 'match') ? obj.match : obj.matched;
    if (typeof matched !== 'boolean') throw new Error('AI response missing valid match boolean.');
    const reason = obj.reason ?? obj.reasoning ?? obj.explaination;
    return { matched, reason: typeof reason === 'string' ? reason : null, probability: null };
}

/**
 * Put the answers into the slot of the criterion they belong to.
 *
 * A model does not always answer every criterion, and it does not always
 * answer them in order. Every element therefore names its criterion with the
 * number the prompt gave it, and the element is placed in that slot. An
 * element without a usable number falls back to the next free slot, so a
 * model that ignores the numbering still works. A criterion that nobody
 * answered stays empty and is reported as `null`.
 *
 * @param {Array} arr the parsed answer
 * @param {number[]} labels the number shown for each criterion
 * @returns {Array<{matched: boolean, reason: string|null, probability: null}|null>}
 */
function alignResults(arr, labels) {
    const slots = new Array(labels.length).fill(null);
    let nextSlot = 0;
    let unassigned = 0;
    for (const item of arr) {
        if (!item || typeof item !== 'object') {
            unassigned += 1;
            continue;
        }
        let slot = -1;
        if (Number.isInteger(item.index)) {
            const named = labels.indexOf(item.index);
            if (named >= 0 && slots[named] === null) slot = named;
        }
        if (slot === -1) {
            // No usable number: fall back to the next free slot.
            while (nextSlot < slots.length && slots[nextSlot] !== null) nextSlot += 1;
            if (nextSlot < slots.length) slot = nextSlot;
        }
        if (slot === -1) {
            unassigned += 1;
            continue;
        }
        try {
            slots[slot] = parseSingleObject(item);
        } catch (error) {
            // A malformed element is treated like a missing one: the caller
            // can ask for that criterion again instead of failing the email.
            aiLog(`Malformed result for criterion ${labels[slot]}`, { level: 'warn' }, error);
            slots[slot] = null;
        }
    }
    const answered = slots.filter(slot => slot !== null).length;
    if (answered !== slots.length || unassigned > 0) {
        aiLog(`Model answered ${answered} of ${slots.length} criteria (${unassigned} unassigned)`, { level: 'warn' });
    }
    return slots;
}

export function parseResponse(result) {
    const content = result?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('Chat response missing text content.');
    const candidate = extractLastJsonArray(content);
    if (!candidate) throw new Error('No JSON array found in AI response.');
    const arr = JSON.parse(candidate);
    if (!Array.isArray(arr)) throw new Error('AI response is not an array.');
    return alignResults(arr, [1]);
}

/**
 * Parse a batch answer into one result per criterion.
 *
 * @param {object} result the raw answer
 * @param {string[]} criteria the criteria of the request
 * @param {number[]|null} labels the number shown for each criterion
 * @returns {Array<{matched: boolean, reason: string|null, probability: null}|null>}
 */
export function parseBatchResponse(result, criteria, labels = null) {
    const content = result?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('Chat response missing text content.');
    const candidate = extractLastJsonArray(content);
    if (!candidate) throw new Error('No JSON array found in AI response.');
    const arr = JSON.parse(candidate);
    if (!Array.isArray(arr)) throw new Error('AI response is not an array.');
    const used = labels && labels.length === criteria.length
        ? labels
        : criteria.map((_, index) => index + 1);
    return alignResults(arr, used);
}
