export const path = '/v1/systemone';
export function buildRequest(text, criterion, config) {
  return buildBatchRequest(text, [{ id: 'match', criterion }], config);
}
export function buildBatchRequest(text, questions, config) {
  const payload = { state: text, questions: Object.fromEntries(questions.map(({ id, criterion }) =>
    [id, { type: 'noul', instructions: `Does this email satisfy the following criterion: ${criterion}` }])) };
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
