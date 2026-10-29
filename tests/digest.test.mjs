import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDigest } from '../modules/mailDigest.js';

const mail = {
    headers: {
        subject: '项目周报 2026-10-20',
        date: 'Mon, 20 Oct 2026 09:30:00 +0800',
        from: '张三 <zhangsan@example.com>',
        to: 'me@example.com',
        cc: 'boss@example.com'
    },
    body: `${'HEAD'.repeat(100)}MIDDLE${'TAIL'.repeat(100)}`,
    attachments: [
        { name: '周报.pdf', type: 'application/pdf', size: 245760 },
        { name: '数据.xlsx', type: 'application/vnd.ms-excel', size: 10240 }
    ]
};

test('the summary keeps the metadata that decides a classification', () => {
    const { text } = buildDigest({
        ...mail,
        headers: { ...mail.headers, received: 'from nowhere', 'message-id': '<1@example.com>' }
    }, { budget: 2000 });
    assert.ok(text.includes('subject: 项目周报 2026-10-20'));
    assert.ok(text.includes('date: Mon, 20 Oct 2026 09:30:00 +0800'));
    assert.ok(text.includes('from: 张三 <zhangsan@example.com>'));
    assert.ok(text.includes('to: me@example.com'));
    assert.ok(text.includes('cc: boss@example.com'));
    assert.ok(!text.includes('received'), 'headers that do not classify are dropped');
    assert.ok(!text.includes('message-id'), 'headers that do not classify are dropped');
});

test('a missing header leaves no empty line', () => {
    const { text } = buildDigest({ ...mail, headers: { subject: 'Only a subject' } }, { budget: 2000 });
    assert.ok(text.includes('subject: Only a subject'));
    assert.ok(!text.includes('from:'), 'an absent header is not rendered');
    assert.ok(!/\n\s*\n\s*(from|date|to|cc):/.test(text));
});

test('attachments contribute their file names', () => {
    const normal = buildDigest(mail, { budget: 2000 }).text;
    assert.ok(normal.includes('attachments (2):'));
    assert.ok(normal.includes('- 周报.pdf (application/pdf, 245760 bytes)'));
    const strict = buildDigest(mail, { budget: 2000, strict: true }).text;
    assert.ok(strict.includes('- 周报.pdf'));
    assert.ok(!strict.includes('application/pdf'), 'strict mode drops the attachment details');
    assert.ok(!strict.includes('bytes'), 'strict mode drops the attachment details');
});

test('an attachment without a name is still listed', () => {
    const { text } = buildDigest({
        ...mail, attachments: [{ name: '', type: 'application/pdf', size: 10 }]
    }, { budget: 2000, strict: true });
    assert.ok(text.includes('- (unnamed)'));
});

test('only the first attachment names are listed', () => {
    const files = Array.from({ length: 12 }, (_, i) => ({ name: `file-${i}.pdf`, type: 'application/pdf', size: 1 }));
    const { text } = buildDigest({ ...mail, attachments: files }, { budget: 2000, strict: true });
    assert.ok(text.includes('- file-0.pdf'));
    assert.ok(!text.includes('- file-8.pdf'), 'strict mode caps the number of names');
    assert.ok(text.includes('4 more'), 'the remaining names are counted');
});

test('a short body is sent in full', () => {
    const { text } = buildDigest({ ...mail, body: 'A short note.' }, { budget: 2000 });
    assert.ok(text.includes('A short note.'));
    assert.ok(!text.includes('omitted'), 'a body that fits needs no omission marker');
});

test('a long body is sent as three excerpts', () => {
    const { text } = buildDigest(mail, { budget: 600 });
    assert.ok(text.includes('body (excerpt,'), 'the summary announces the excerpt');
    assert.ok(text.includes('HEAD'), 'the beginning of the body is kept');
    assert.ok(text.includes('MIDDLE'), 'the middle of the body is kept');
    assert.ok(text.includes('TAIL'), 'the end of the body is kept');
    assert.ok(/omitted \d+ chars/.test(text), 'the gaps are marked');
    assert.ok(text.length <= 600, `the summary must stay within the budget (${text.length})`);
});

test('the summary never contains the complete body', () => {
    const body = `${'HEAD'.repeat(500)}SECRETMIDDLE${'TAIL'.repeat(500)}`;
    const { text } = buildDigest({ ...mail, body }, { budget: 800 });
    assert.ok(!text.includes(body), 'the whole body must not be sent');
    assert.ok(text.length <= 800, 'the summary stays within the budget');
    assert.ok(/omitted \d+ chars/.test(text), 'the gaps between the excerpts are marked');
});

test('the strict summary stays within the budget and keeps the metadata', () => {
    const { text } = buildDigest(mail, { budget: 600, strict: true });
    assert.ok(text.length <= 600);
    assert.ok(text.includes('subject:'), 'the metadata survives the compression');
    assert.ok(text.includes('from:'));
    assert.ok(text.includes('- 周报.pdf'));
});

test('the body is dropped when the budget leaves no room for it', () => {
    const { text } = buildDigest(mail, { budget: 200, strict: true });
    assert.ok(text.includes('body omitted (character budget exhausted)'));
    assert.ok(!text.includes('HEAD'));
    assert.ok(text.length <= 200);
});

test('an invalid budget falls back to the default', () => {
    for (const budget of [undefined, NaN, 0, -5, 'abc']) {
        const { text, stats } = buildDigest(mail, { budget });
        assert.equal(stats.budget, 3686, `budget ${budget} must fall back to the default`);
        assert.ok(text.length > 0);
    }
});

test('a small budget is honoured instead of being replaced', () => {
    const { text, stats } = buildDigest(mail, { budget: 100 });
    assert.equal(stats.budget, 100);
    assert.ok(text.length <= 100, `the summary must stay within the budget (${text.length})`);
});

test('a message without a body or attachments still yields a summary', () => {
    const { text } = buildDigest({ headers: { subject: 'Only a subject' } }, { budget: 2000 });
    assert.ok(text.includes('subject: Only a subject'));
    assert.ok(!text.includes('attachments'), 'there are no attachments to list');
    assert.ok(!text.includes('body omitted'), 'there is no body to omit');
});

test('recipient lists are truncated to at most 8 addresses per header', () => {
    const addresses = Array.from({ length: 12 }, (_, i) => `user${i}@example.com`);
    const { text } = buildDigest({
        headers: { to: addresses.join(', '), cc: addresses.join(', ') }
    }, { budget: 5000 });
    const toLine = text.split('\n').find(l => l.startsWith('to: '));
    const ccLine = text.split('\n').find(l => l.startsWith('cc: '));
    assert.ok(toLine, 'to line is present');
    assert.ok(ccLine, 'cc line is present');
    assert.ok(toLine.includes('... (+4 more)'), 'to line shows the omission marker');
    assert.ok(ccLine.includes('... (+4 more)'), 'cc line shows the omission marker');
    assert.ok(!toLine.includes('user11@example.com'), 'truncated addresses are not listed');
});

test('the account\'s own address is never dropped from recipients', () => {
    const own = 'me@example.com';
    const others = Array.from({ length: 10 }, (_, i) => `other${i}@example.com`);
    const { text } = buildDigest({
        headers: { to: [own, ...others].join(', ') }
    }, { budget: 5000, identities: [own] });
    const toLine = text.split('\n').find(l => l.startsWith('to: '));
    assert.ok(toLine.includes(own), "the account's own address is kept");
    assert.ok(toLine.includes('... (+3 more)'), 'other addresses beyond the limit are omitted');
});

test('duplicate own addresses are deduplicated', () => {
    const own = 'me@example.com';
    const { text } = buildDigest({
        headers: { to: `${own}, ${own}, other@example.com` }
    }, { budget: 5000, identities: [own] });
    const toLine = text.split('\n').find(l => l.startsWith('to: '));
    assert.equal(toLine.split(': ')[1].split(', ').filter(Boolean).length, 2, 'duplicates are collapsed');
});

test('addresses with display names are parsed to bare emails', () => {
    const { text } = buildDigest({
        headers: { to: '张三 <zhang@example.com>, 李四 <li@example.com>' }
    }, { budget: 5000 });
    const toLine = text.split('\n').find(l => l.startsWith('to: '));
    assert.ok(toLine.includes('zhang@example.com'), 'bare email is extracted');
    assert.ok(toLine.includes('li@example.com'), 'bare email is extracted');
    assert.ok(!toLine.includes('<'), 'angle brackets are stripped');
});

test('short recipient lists are kept in full', () => {
    const { text } = buildDigest({
        headers: { to: 'a@example.com, b@example.com', cc: 'c@example.com' }
    }, { budget: 5000 });
    assert.ok(text.includes('to: a@example.com, b@example.com'));
    assert.ok(text.includes('cc: c@example.com'));
    assert.ok(!text.includes('more'), 'no omission marker for short lists');
});
