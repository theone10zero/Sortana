export const path = '/v1/systemone';
export function buildRequest(text, criterion, config) {
  const payload = {
    state: text,
    questions: { match: { type: 'noul', instructions: `Does this email satisfy the following criterion: ${criterion}` } }
  };
  if (config.model) payload.model = config.model;
  return payload;
}
export function parseResponse(result) {
  const answer = result?.answers?.match;
  if (answer?.type !== 'noul' || typeof answer.noul !== 'number' ||
      !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
    throw new Error('SystemOne response must contain answers.match with type noul and a probability from 0 to 1.');
  }
  return { matched: null, reason: null, probability: answer.noul };
}
