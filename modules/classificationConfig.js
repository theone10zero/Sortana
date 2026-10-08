import { DEFAULT_AI_PARAMS } from './defaultParams.js';
export const CONFIG_DEFAULTS = {
  apiType: 'chat-completions', endpoint: 'http://127.0.0.1:5000', model: '',
  apiKey: '', openaiOrganization: '', openaiProject: '', customSystemPrompt: '',
  systemOneProcessAll: true, systemOneBatchSize: 8,
  decisionThreshold: 0.5, inputCharacterLimit: 3686, aiParams: DEFAULT_AI_PARAMS,
  htmlToMarkdown: false, stripUrlParams: false, altTextImages: false,
  collapseWhitespace: false, tokenReduction: false, debugLogging: false
};
export function validateThreshold(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('Match threshold must be between 0% and 100%.');
  }
  return value;
}
export function validateSettings(data) {
  if (data.systemOneProcessAll !== undefined && typeof data.systemOneProcessAll !== 'boolean') {
    throw new Error('Process all must be a boolean.');
  }
  if (data.systemOneBatchSize !== undefined && (!Number.isSafeInteger(data.systemOneBatchSize) || data.systemOneBatchSize < 1)) {
    throw new Error('Rules per request must be a positive whole number.');
  }
  if (data.apiType !== undefined && !['chat-completions', 'systemone'].includes(data.apiType)) throw new Error('Unknown API type.');
  if (data.decisionThreshold !== undefined) validateThreshold(data.decisionThreshold);
  if (data.inputCharacterLimit !== undefined && (!Number.isSafeInteger(data.inputCharacterLimit) || data.inputCharacterLimit < 1)) {
    throw new Error('Input character limit must be a positive integer.');
  }
  if (data.aiRules !== undefined) {
    if (!Array.isArray(data.aiRules)) throw new Error('Rules must be an array.');
    for (const rule of data.aiRules) {
      if (rule.decisionThreshold !== undefined) validateThreshold(rule.decisionThreshold);
    }
  }
}
export function migratedInputLimit(data) {
  if (data.inputCharacterLimit !== undefined) return data.inputCharacterLimit;
  const value = Math.floor(Number(data.aiParams?.max_tokens ?? 4096) * 0.9);
  return Number.isSafeInteger(value) && value > 0 ? value : 3686;
}
