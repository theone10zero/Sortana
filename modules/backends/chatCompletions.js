import { resolvePromptLanguage } from '../promptLanguage.js';

// The English templates are byte-for-byte identical to the pre-4.2.0 strings.
// The cache fingerprint is derived from buildRequest(), so any edit here
// invalidates every stored classification result. Keep the "en" entries
// unchanged unless the cache version is bumped alongside.

const PROMPTS = {
    en: {
        prefix: `You are an email-classification assistant.
Read the email below and the classification criterion provided by the user.
`,
        defaultPrompt: "Determine whether the email satisfies the user's criterion.",
        suffix: `
Return ONLY a JSON object on a single line of the form:
{"match": true, "reason": "<short explanation>"} - if the email satisfies the criterion
{"match": false, "reason": "<short explanation>"} - otherwise

Do not add any other keys, text, or formatting.`,
        user: (text, criterion) => `**Email Contents**\n\`\`\`\n${text}\n\`\`\`\nClassification Criterion: ${criterion}`
    },
    'zh-CN': {
        prefix: `你是一个邮件分类助手。
请阅读下面的邮件，以及用户提供的分类标准。
`,
        defaultPrompt: '判断这封邮件是否满足用户给出的分类标准。',
        suffix: `
只返回一行 JSON 对象，格式如下：
{"match": true, "reason": "<简短理由>"} - 若邮件满足该分类标准
{"match": false, "reason": "<简短理由>"} - 否则

不要添加任何其他键、文本或格式。reason 请使用与分类标准相同的语言撰写。`,
        user: (text, criterion) => `**邮件内容**\n\`\`\`\n${text}\n\`\`\`\n分类标准：${criterion}`
    }
};

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

export const path = '/v1/chat/completions';
export function buildRequest(text, criterion, config) {
    const prompt = PROMPTS[resolvePromptLanguage(config, criterion)] || PROMPTS.en;
    const payload = {
        messages: [
            { role: 'system', content: prompt.prefix + (config.customSystemPrompt || prompt.defaultPrompt) + prompt.suffix },
            { role: 'user', content: prompt.user(text, criterion) }
        ], ...config.aiParams
    };
    if (config.model) payload.model = config.model;
    return payload;
}
export function parseResponse(result) {
    const content = result?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('Chat response missing text content.');
    const candidate = extractLastJsonObject(content);
    if (!candidate) throw new Error('No JSON object found in AI response.');
    const obj = JSON.parse(candidate);
    const matched = Object.hasOwn(obj, 'match') ? obj.match : obj.matched;
    if (typeof matched !== 'boolean') throw new Error('AI response missing valid match boolean.');
    const reason = obj.reason ?? obj.reasoning ?? obj.explaination;
    return { matched, reason: typeof reason === 'string' ? reason : null, probability: null };
}
