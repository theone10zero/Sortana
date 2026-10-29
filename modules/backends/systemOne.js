import { resolvePromptLanguage } from '../promptLanguage.js';

// The email is sent as a summary: the metadata, the attachment file names and
// three excerpts of the body. The instruction tells the model that it reads a
// summary, and the strict variant (aggressive token reduction) adds the rule
// that missing evidence has to be answered with a low probability.
//
// The instruction is part of the cache fingerprint, because the fingerprint is
// derived from buildRequest(). Changing it invalidates every stored SystemOne
// classification result, so it changes together with the cache version.

export const path = '/v1/systemone';

function instructionFor(criterion, config) {
    // The strict variant is selected by the configuration alone, never by the
    // body, because the cache fingerprint is built from an empty body.
    const strict = config.tokenReduction === true;
    if (resolvePromptLanguage(config, criterion) === 'zh-CN') {
        // The summary note sits in brackets, so a criterion that ends with a
        // question mark does not run into a second full stop.
        const summary = '（邮件以摘要形式提供，包含元数据、附件文件名以及正文的三段片段）';
        return strict
            ? `这封邮件是否满足以下分类标准：${criterion}${summary}。请只依据摘要中的信息判断；若信息不足，请给出接近 0 的概率。`
            : `这封邮件是否满足以下分类标准：${criterion}${summary}`;
    }
    const summary = '. The email is provided as a summary: metadata, attachment file names and three excerpts of the body.';
    return strict
        ? `Does this email satisfy the following criterion: ${criterion}${summary} Use only the information it contains, and answer with a probability of 0 if it is not enough to decide.`
        : `Does this email satisfy the following criterion: ${criterion}${summary}`;
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
