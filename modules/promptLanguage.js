"use strict";

// Resolves the language used for the classification prompt and the returned
// reason. This is deliberately independent of the UI locale: a user may read
// an English interface while classifying Chinese mail, or the reverse.
//
// The resolution only ever looks at the classification criterion, never at the
// message body. The cache fingerprint is computed from
// `adapter.buildRequest('', criterion, snapshot)`, so a decision that depended
// on the body would make the fingerprint disagree with the request that is
// actually sent.

const HAN = /[㐀-䶿一-鿿豈-﫿]/;

export const PROMPT_LANGUAGES = ['auto', 'zh-CN', 'en'];

/** True when the text contains Chinese ideographs. */
export function containsHan(text) {
    return HAN.test(String(text || ''));
}

/**
 * @param {{promptLanguage?: string}} config
 * @param {string} criterion
 * @returns {'zh-CN'|'en'}
 */
export function resolvePromptLanguage(config, criterion) {
    const preference = config?.promptLanguage || 'auto';
    if (preference === 'zh-CN') return 'zh-CN';
    if (preference === 'en') return 'en';
    return containsHan(criterion) ? 'zh-CN' : 'en';
}
