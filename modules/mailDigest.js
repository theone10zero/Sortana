// The email summary that is sent to the AI service.
//
// The classifier only has to recognise *what kind* of mail this is, so the
// summary carries the metadata that decides it (subject, date, sender,
// recipients), the attachment file names and three excerpts of the body
// instead of the whole text. The labels are lowercase ASCII keys on purpose:
// they are protocol markers, not prose. One summary has to serve a SystemOne
// batch whose criteria may resolve to different prompt languages, so the
// summary itself stays language neutral and the prompt template explains it.

const DEFAULT_BUDGET = 3686;

// A body excerpt below this size carries too little to judge, so it is
// dropped rather than sent as a fragment.
const MIN_BODY_CHARS = 200;

// Stands in for a body that did not fit into the budget.
const BODY_OMITTED_NOTE = 'body omitted (character budget exhausted)';

// At most this many recipient addresses are kept per header field. The
// message's own address (the account receiving the mail) is never dropped.
const MAX_RECIPIENTS = 8;

// Stands in for recipient addresses that were cut off.
const OMITTED_RECIPIENTS = '... (+N more)';

// Room reserved for the body block header and the two omission markers.
const BODY_HEADER_RESERVE = 44;
const MARKER_RESERVE = 60;

// How the body budget is split between the beginning, the middle and the end
// of the message. The opening carries the purpose of the mail, the closing
// carries the signature and the deadline, and the middle keeps the thread
// that both would otherwise hide.
const EXCERPT_SPLIT = { head: 0.5, middle: 0.2, tail: 0.3 };

const NORMAL_LIMITS = { subject: 200, sender: 120, recipients: 200, files: 20, detail: true };
const STRICT_LIMITS = { subject: 120, sender: 80, recipients: 120, files: 8, detail: false };

// The order in which parts of the summary give up room when the budget is
// tight: the recipient lists first, then the number of attachment names, then
// the body, and only then the remaining attachment names.
const REDUCTIONS = ['cc', 'to', 'files3', 'body', 'files0'];

function normalizeBudget(value) {
    const budget = Number(value);
    if (!Number.isFinite(budget) || budget <= 0) return DEFAULT_BUDGET;
    return Math.floor(budget);
}

// Cut a value to its limit. The marker stays ASCII so it cannot be confused
// with the content it replaces.
function clip(value, limit) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    if (text.length <= limit) return text;
    return `${text.slice(0, Math.max(1, limit - 3))}...`;
}

// Parse an RFC 5322 address header into a list of bare email addresses.
// Handles both `user@example.com` and `Display Name <user@example.com>`.
function parseAddresses(value) {
    if (!value) return [];
    return String(value).split(',').map(part => {
        const trimmed = part.trim();
        const match = trimmed.match(/<([^>]+)>/);
        return match ? match[1].trim() : trimmed;
    }).filter(addr => addr.length > 0);
}

// Keep at most `max` recipient addresses. Addresses that belong to one of the
// receiving identities (the account this mail was delivered to) are always
// retained; everything else is cut and summarised as an omission marker.
function truncateRecipients(addresses, identities, max = MAX_RECIPIENTS) {
    // Deduplicate while preserving order.
    const unique = [...new Set(addresses)];
    if (unique.length <= max) return unique;
    const identitySet = new Set(identities.filter(Boolean));
    const own = [...new Set(unique.filter(addr => identitySet.has(addr)))];
    const others = unique.filter(addr => !identitySet.has(addr));
    const kept = [...own];
    const room = max - kept.length;
    if (room > 0) kept.push(...others.slice(0, room));
    const omitted = unique.length - kept.length;
    if (omitted > 0) kept.push(OMITTED_RECIPIENTS.replace('N', String(omitted)));
    return kept;
}

function metaLines(state, plan) {
    const lines = [];
    if (state.subject) lines.push(`subject: ${state.subject}`);
    if (state.date) lines.push(`date: ${state.date}`);
    if (state.from) lines.push(`from: ${state.from}`);
    if (plan.withTo && state.to?.length) lines.push(`to: ${state.to.join(', ')}`);
    if (plan.withCc && state.cc?.length) lines.push(`cc: ${state.cc.join(', ')}`);
    return lines;
}

// The file names are the only thing known about an attachment. The content is
// never read, and in strict mode the type and the size are dropped as well.
function attachmentLines(files, limit, detail) {
    if (!files.length || limit <= 0) return [];
    const shown = files.slice(0, limit);
    const lines = [`attachments (${files.length}):`];
    for (const file of shown) {
        const name = String(file?.name ?? '').trim() || '(unnamed)';
        lines.push(detail ? `- ${name} (${file.type || 'unknown'}, ${file.size ?? 0} bytes)` : `- ${name}`);
    }
    if (files.length > shown.length) lines.push(`- ... ${files.length - shown.length} more`);
    return lines;
}

function omissionMarker(count) {
    return `[... omitted ${count} chars ...]`;
}

// Three windows of the body: the beginning, the middle and the end. The
// middle window is taken around the centre of the message and never overlaps
// the other two.
function excerpt(body, budget) {
    const usable = Math.max(0, budget - BODY_HEADER_RESERVE - MARKER_RESERVE);
    if (body.length <= usable) {
        return { parts: [body], shown: body.length, omitted: 0 };
    }
    const headLength = Math.floor(usable * EXCERPT_SPLIT.head);
    const middleLength = Math.floor(usable * EXCERPT_SPLIT.middle);
    const tailLength = usable - headLength - middleLength;
    const head = body.slice(0, headLength);
    const tail = body.slice(body.length - tailLength);
    const middleStart = Math.max(0, Math.min(
        Math.max(headLength, Math.floor((body.length - middleLength) / 2)),
        body.length - tailLength - middleLength
    ));
    const middle = body.slice(middleStart, middleStart + middleLength);
    const parts = [head, omissionMarker(middleStart - headLength), middle];
    if (middleStart + middleLength < body.length - tailLength) {
        parts.push(omissionMarker(body.length - tailLength - middleStart - middleLength));
    }
    parts.push(tail);
    const shown = head.length + middle.length + tail.length;
    return { parts, shown, omitted: body.length - shown };
}

function bodyBlock(body, budget) {
    if (!body) return { lines: [], shown: 0 };
    const { parts, shown, omitted } = excerpt(body, budget);
    const header = omitted > 0
        ? `body (excerpt, ${shown} of ${body.length} chars):`
        : `body (${body.length} chars):`;
    return { lines: [header, ...parts], shown };
}

// Apply one reduction that frees room. Returns false when the reduction does
// not apply, so the caller can move on to the next one.
function applyReduction(reduction, plan) {
    switch (reduction) {
        case 'cc':
            if (!plan.withCc) return false;
            plan.withCc = false;
            return true;
        case 'to':
            if (!plan.withTo) return false;
            plan.withTo = false;
            return true;
        case 'files3':
            if (plan.files <= 3) return false;
            plan.files = 3;
            return true;
        case 'body':
            if (!plan.withBody) return false;
            plan.withBody = false;
            return true;
        case 'files0':
            if (plan.files <= 0) return false;
            plan.files = 0;
            return true;
        default:
            return false;
    }
}

// The characters the metadata and the attachment names take up, including the
// blank line that separates them from the body.
function fixedLength(meta, fileLines) {
    let length = meta.join('\n').length;
    if (fileLines.length) length += 2 + fileLines.join('\n').length;
    return length;
}

/**
 * Build the summary that is sent to the AI service.
 *
 * @param {{headers?: object, body?: string, attachments?: Array}} mail
 * @param {{budget?: number, strict?: boolean}} options
 * @returns {{text: string, stats: object}}
 */
export function buildDigest(mail = {}, options = {}) {
    const strict = options.strict === true;
    const limits = strict ? STRICT_LIMITS : NORMAL_LIMITS;
    const budget = normalizeBudget(options.budget);
    const headers = mail.headers || {};
    const body = String(mail.body ?? '');
    const files = Array.isArray(mail.attachments) ? mail.attachments : [];
    const identities = Array.isArray(options.identities) ? options.identities : [];

    const state = {
        subject: clip(headers.subject, limits.subject),
        date: clip(headers.date, 120),
        from: clip(headers.from, limits.sender),
        to: truncateRecipients(parseAddresses(headers.to), identities),
        cc: truncateRecipients(parseAddresses(headers.cc), identities)
    };
    const plan = { withCc: true, withTo: true, withBody: true, files: limits.files };

    let meta = metaLines(state, plan);
    let fileLines = attachmentLines(files, plan.files, limits.detail);
    // Two characters separate the body block from what comes before it.
    let bodyBudget = budget - fixedLength(meta, fileLines) - 2;

    // Free room until the body fits: the recipient lists go first, then the
    // number of attachment names, then the body itself. Once the body is
    // gone, the note that replaces it has to fit as well.
    for (const reduction of REDUCTIONS) {
        if (!body) break;
        const fits = plan.withBody ? bodyBudget >= MIN_BODY_CHARS : bodyBudget >= 0;
        if (fits) break;
        if (!applyReduction(reduction, plan)) continue;
        meta = metaLines(state, plan);
        fileLines = attachmentLines(files, plan.files, limits.detail);
        bodyBudget = budget - fixedLength(meta, fileLines) - 2 -
            (plan.withBody ? 0 : BODY_OMITTED_NOTE.length);
    }

    const sections = [];
    if (meta.length) sections.push(meta.join('\n'));
    if (fileLines.length) sections.push(fileLines.join('\n'));
    let shown = 0;
    if (body && plan.withBody) {
        const block = bodyBlock(body, bodyBudget);
        shown = block.shown;
        sections.push(block.lines.join('\n'));
    } else if (body) {
        sections.push(BODY_OMITTED_NOTE);
    }

    let text = sections.join('\n\n');
    // The excerpts are sized from the budget, so this only corrects rounding.
    if (text.length > budget) text = text.slice(0, budget);

    return {
        text,
        stats: {
            budget,
            total: text.length,
            body: body.length,
            shown,
            attachments: files.length,
            strict
        }
    };
}
