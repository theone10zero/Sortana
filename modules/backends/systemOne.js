import { resolvePromptLanguage } from '../promptLanguage.js';

// The English instruction is byte-for-byte identical to the pre-4.2.0 string.
// The cache fingerprint is derived from buildRequest(), so changing it
// invalidates every stored SystemOne classification result.

export const path = '/v1/systemone';

function instructionFor(criterion, config) {
    if (resolvePromptLanguage(config, criterion) === 'zh-CN') {
        return `这封邮件是否满足以下分类标准：${criterion}`;
    }
    return `Does this email satisfy the following criterion: ${criterion}`;
}

export function buildRequest(text, criterion, config) {
    return buildBatchRequest(text, [{ id: 'match', criterion }], config);
}
export function buildBatchRequest(text, questions, config) {
    const payload = { state: text, questions: Object.fromEntries(questions.map(({ id, criterion }) =>
        [id, { type: 'noul', instructions: instructionFor(criterion, config) }])) };
    if (config.model) payload.model = config.model;
    return payload;
}
export function parseResponse(result) { return parseAnswer(result, 'match'); }
export function parseBatchResponse(result, questions) {
    return questions.map(({ id }) => parseAnswer(result, id));
}
function parseAnswer(result, id) {
    const answer = result?.answers?.[id];
    if (answer?.type !== 'noul' || typeof answer.noul !== 'number' ||
      !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
        throw new Error(`SystemOne response must contain answers.${id} with type noul and a probability from 0 to 1.`);
    }
    return { matched: null, reason: null, probability: answer.noul };
}
