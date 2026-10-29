# AGENTS Guidelines for Sortana

This file provides guidelines for codex agents contributing to the Sortana project. It describes the repository structure, the expected coding conventions, and testing commands. If you make changes to Sortana, make sure to update this document and the README.md if applicable.

## Repository Overview

- `background.js`: Handles startup tasks and coordinates message passing within the extension.
- `modules/`: Contains reusable JavaScript modules such as `AiClassifier.js`,
  `defaultParams.js` and `themeUtils.js`.
- `_locales/`: Message catalogs. `en-US` is the default locale; `zh_CN` and
  `zh_TW` ship alongside it.
- `options/`: The options page HTML, JavaScript and bundled Bulma CSS (v1.0.3).
- `details.html` and `details.js`: View classification evidence and clear cache for a message.
- `resources/`: Images and other static files.
- `build-xpi.ps1`: PowerShell script to package the extension.
- `build-xpi.sh`: Bash script to package the extension.
- `build-xpi.mjs`: Node script to package the extension. Needs nothing but
  Node.js, so it works where `zip` is unavailable.
- `resources/svg2img.ps1`: PowerShell script to regenerate themed PNG icons from SVGs.
- `resources/svg2img.sh`: Bash script to regenerate themed PNG icons from SVGs.

## Coding Style

- Use **modern JavaScript** (ES6 or later). Prefer `const` and `let` over `var`.
- Keep functions small and focused. Aim for clear naming and concise comments when necessary.
- Use template literals for string interpolation.
- Avoid trailing whitespace and ensure files end with a newline.

## Commit Guidelines

- Group related changes together. Each commit should have a clear purpose.
- Use descriptive commit messages in the imperative mood (e.g., "Add filter editor patch").
- Run `git status` before committing to verify only intended files are staged.

## Testing

Run the dependency-free suite with Node.js 22 or newer: `node --test tests/*.test.mjs`.
The tests mock extension storage, HTTP responses, and Thunderbird rule execution.
Manual verification in Thunderbird is still required for UI and real-server integration.
Do **not** run the `ps1` build script or the SVG processing script.

### Localization

The UI language follows Thunderbird's locale. `browser.i18n` resolves the
catalog; `modules/i18n.js` wraps it and provides `t()`, `applyToDocument()` and
`currentLocale()`. Static markup carries `data-i18n` (text), `data-i18n-title`,
`data-i18n-placeholder`, `data-i18n-alt` and `data-i18n-aria-label`
attributes; dynamically built nodes call `t()` directly.

All shipped locales must expose **exactly the same message keys**, and every
`$NAME$` placeholder must survive translation. `tests/i18n.test.mjs` enforces
both. When adding a message, add it to `en-US`, `zh_CN` and `zh_TW` in the same
change.

Two language concerns are deliberately separate:

- **UI locale** – Thunderbird's language. Never affects inference.
- **Prompt language** – the `promptLanguage` setting (`auto`, `zh-CN`, `en`),
  which selects the template used for the classification prompt and the
  returned reason. It is independent of the UI locale.

`auto` resolves from the **classification criterion only**: a criterion
containing Han characters uses the Chinese template, otherwise the English one.
It must never depend on the message body, because the cache fingerprint is
computed from `adapter.buildRequest('', criterion, snapshot)` — a body-dependent
decision would make the fingerprint disagree with the request actually sent.

The English templates in `modules/backends/` are part of the cache fingerprint.
**They must stay byte-for-byte identical to the strings the current cache
version was built with**, otherwise every stored classification result becomes
unreachable. `tests/i18n.test.mjs` pins the exact request payload and the
resulting cache key. Changing an English template — or the email summary that
is sent — requires a deliberate cache version bump.

The Chat Completions system message is **one editable template**. The options page
shows the built-in template, so what the user edits is what the model receives.
The template carries placeholders that are filled in for every request:

| Placeholder | Replaced with |
| --- | --- |
| `%CRITERIA%` | the numbered list of criteria |
| `%STRICT%` | the strict-mode rule, empty when the strict mode is off |
| `%COUNT%` | the number of criteria |
| `%EXAMPLE%` | an example answer, with the real criterion numbers |

A template that lost `%CRITERIA%` still gets the criteria appended, so a
criterion can never be lost. `getDefaultTemplate(language)` and `PLACEHOLDERS`
are exported for the options page.

An empty `customSystemPrompt` means "use the built-in template", which follows
the language of the criterion. The options page stores an empty value when the
text box still holds the built-in template, so a user who did not edit it keeps
following the criterion language.

The template the options page *shows* comes from `templateLanguage()` in
`modules/promptLanguage.js`: an explicit `promptLanguage` wins, and the
automatic setting falls back to the interface language, because the page cannot
know the language of the criterion. A Chinese Thunderbird therefore shows the
Chinese template even while the prompt language is automatic.

## Endpoint Notes

Sortana supports `apiType: "chat-completions"` (default) and `"systemone"`.
Plain adapter modules under `modules/backends/` own request construction and response
validation; `AiClassifier` owns shared transport, configuration snapshots, threshold
policy, and caching. The stored endpoint is a base URL. Normalization accepts `/v1`
and recognized full API paths, preserves proxy prefixes, and defaults to HTTPS
when no scheme is supplied. Model discovery uses `/v1/models`; **None** omits `model`.
Bearer authentication is optional for both APIs. Organization/project headers are
sent only for Chat Completions.

The credential is stored as `apiKey` and labelled **API Token** in the options
page, where it sits in the main Settings tab next to the endpoint — not in the
collapsed Advanced panel, because a hidden credential field is indistinguishable
from a missing one. It is sent as `Authorization: Bearer <token>`, the
OpenAI-compatible convention. Secrets are excluded from the cache fingerprint,
so the credential and its header never affect cache validity.

Chat Completions sends a system message (role, task, the numbered criteria and the
output format) and a user message that carries the email summary alone. It extracts
the last JSON array from `choices[0].message.content` and reads one element per
criterion, each requiring a `match` or `matched` boolean. SystemOne
sends prepared email text as `state` with `noul` questions identified by stable
`rule_<snapshot index>` IDs. The single-question API still uses `match` for backward
compatibility and cache fingerprinting. Every requested answer must have type
`noul` and a finite numeric probability in `[0, 1]`; response order is irrelevant.
No chat generation parameters or system prompt are sent to SystemOne.

The global `decisionThreshold` defaults to 0.5; optional rule-level
`decisionThreshold` overrides it. UI percentages are stored as numbers in `[0, 1]`.
Matching uses `probability >= threshold` before display rounding. Details displays
probabilities in a progress bar with the percentage inside; threshold and model
appear in its tooltip. Results use the current threshold, never fabricated reasoning or action
history. No secondary model calls are made.

`classify()` returns structured evidence; `classifyText()` remains a boolean wrapper.
Failures throw and are never cached. HTTP errors include the request URL and
JSON server error message when available; SystemOne 404 errors suggest checking
the running server build and decision-model support. The rule runner stops that email, reports the
error, and continues the next queued email. Snapshot settings and rules per email.
`inputCharacterLimit` is the character budget of the **email summary** and
always applies. It is independent of the output `max_tokens` and migrates from
the old effective limit. It is a character count, not a token count, and the
two differ sharply by
script: Latin text runs about four characters per token, Chinese about one. The
options page shows both readings next to the field so the limit can be chosen
against the model's real context window. The stored value keeps its character
semantics; changing that would invalidate every cache entry.

`promptLanguage` (`auto`, `zh-CN`, `en`; default `auto`) selects the language of
the classification prompt and the returned reason. `auto` follows the criterion.
It is included in settings import/export, startup loading and live updates, and
like the other inference settings it is snapshotted per email.

### Rule actions and message ids

The numeric message id handed out by Thunderbird is an internal tracker id. It
is dropped from the tracker as soon as the message is **moved** to another
folder or **deleted**, and the message is tracked under a new id afterwards. A
later `messages.update()` on the old id fails with
`Error updating message: Message not found: <id>.`

The action runner therefore:

- keeps a mutable `currentId` instead of reusing the id the email arrived with;
- runs the actions that need a live id (`tag`, `junk`, `read`, `flag`,
  `forward`, `reply`) **before** the ones that invalidate it, using
  `orderedActions()`; `copy` is safe anywhere because it leaves the source in
  place, and `delete` runs last;
- re-resolves the id after a move or archive with
  `messages.query({ folder, headerMessageId })`, which finds the message in its
  new folder by its RFC 5322 `Message-ID` header. The header survives a move,
  the tracker id does not. Both the bare and the bracketed form of the header
  are tried, because `headerMessageId` and the raw header may differ;
- treats a `Message not found` error as benign: the message was removed by
  something else (another filter, an expunge, a compacted folder), so the
  remaining actions on it are skipped instead of failing the whole email and
  raising a user-visible error.

`messages.move()` does not resolve with the new ids in every Thunderbird
release, so the re-resolution must not rely on its return value.

### Vanished messages

A queued id can be stale before the email is even read: another filter moved
the message, it was deleted, the folder was compacted, or the same message
reached the queue twice and the first run already moved it away. Reading a
message that is gone must never fail the email.

`Message not found` is therefore benign **before** the actions as well, in
every place a message is touched:

- `messages.getFull(id)` — the email is skipped before it is classified;
- `messages.get(id)` — the email is skipped before it is classified;
- `AiClassifier.buildCacheKey()` — the key is computed from the tracker id when
  the header can no longer be read, because a key for a message that no longer
  exists is unreachable anyway. Other errors are still reported.

A skipped email produces no error record and no notification; it is logged at
debug level only. The queue continues with the next email.

The same message must not be queued twice while it is still pending: the
duplicate is dropped, because the first run may have moved or deleted it. A
message can be applied again once it has been processed.

When the header cannot be read but the message itself is still there, the
runner stays conservative instead of guessing:

- the existing tags stay **unknown**, so the `tag` action is skipped rather
  than writing an incomplete tag list over the tags the message already has;
- a rule restricted to an account or a folder stays out of scope, because its
  restriction cannot be checked.

### Batching

`systemOneProcessAll` defaults to true; `systemOneBatchSize` defaults to 8 and must
be a positive safe integer. Only SystemOne shows these controls. The numeric input
is disabled while Process all is enabled, retaining its value. Include both in
settings import/export, startup loading, live updates, and per-email snapshots.

`classifyRules()` is a lazy ordered async iterator over precomputed candidate keys.
**Both backends batch** the uncached criteria of one email into a single request.
Chat Completions sends the criteria as a numbered list in the **system** message and
the email summary alone in the user message, and expects one JSON array element per
criterion. SystemOne sends the summary as `state` and one `noul` question per
criterion, keyed `rule_<snapshot index>`. Per-rule thresholds remain independent.
Do not change existing cache keys or include batch settings in their fingerprint.
Prepare eligibility and keys before actions, using the existing initial mail metadata.

The criteria belong in the system message: the user message carries the mail only,
so a line of the mail can never be read as an instruction, and the criteria sit next
to the task description instead of trailing a long body of text. The prompt language
of a batch follows its **first** criterion; a mixed-language batch therefore uses one
language for the whole batch.

A model does not always answer every criterion. Every answer therefore names its
criterion with the number the prompt gave it (`{"index": 2, "match": …, "reason": …}`),
and the answer is placed in the slot of that criterion — not in the position it
happened to arrive in. An answer without a usable number falls back to the next
free slot, so a model that ignores the numbering still works. Chat Completions
asks again for the criteria it skipped, with a shorter list; that retry keeps the
original numbers, so a number always identifies the same criterion. A criterion
that stays unanswered counts as a non-match and is **not** cached, so a later run
can ask for it again. A malformed element is treated like a missing one. SystemOne
keeps its stricter rule: a single malformed answer fails its entire batch, caches
nothing, and executes no actions from it.

The JSON example in the prompt is built from the numbers of the criteria that are
actually in the request. A fixed example would let a model copy a number that
belongs to a different criterion — the numbers of a retry are the original ones,
so they are not `1, 2, 3 …` — and every answer would land in the wrong slot.

Stop-after-match ends action iteration and prevents further requests; already
computed later answers remain cached. Keep cache-generation guards for imports
and clearing during inference. Tests in `tests/batching.test.mjs` cover batching,
cache reuse, the retry for skipped criteria, failure atomicity, and actual
rule-runner stop behavior with the real classifier.

## Documentation

Additional documentation exists outside this repository.

- Development guide: [Webextention-API for Thunderbird](https://webextension-api.thunderbird.net/en/stable/)
  - [Messages API](https://webextension-api.thunderbird.net/en/stable/messages.html)
  - [Message Tags API](https://webextension-api.thunderbird.net/en/stable/messages.tags.html)
  - [messageDisplayAction API](https://webextension-api.thunderbird.net/en/stable/messageDisplayAction.html)
  - [Storage API](https://webextension-api.thunderbird.net/en/stable/storage.html)
- Thunderbird Add-on Store Policies
  - [Third Party Library Usage](https://extensionworkshop.com/documentation/publish/third-party-library-usage/)
- Third Party Libraries
  - [Bulma.css v1.0.3](https://github.com/jgthms/bulma/blob/1.0.3/css/bulma.css)
- Issue tracker: [Thunderbird tracker on Bugzilla](https://bugzilla.mozilla.org/describecomponents.cgi?product=Thunderbird)


### Message Structure Notes

Messages retrieved with `messenger.messages.getFull` are returned as
nested objects. The root contains `headers` and a `parts` array. Each part may
itself contain `parts` for multipart messages or a `body` string. Attachments are
indicated via the `content-disposition` header.

The message is parsed recursively. Inline or attached base64 data is replaced
with a placeholder showing the byte size, and the attachment contents are never
read. What is sent to the AI service is not the message itself but the
**summary** described below.

### Email summary format

The classification request never carries the full message. Every message is
reduced to a summary: the metadata that decides the classification, the
attachment file names and three excerpts of the body.
`modules/mailDigest.js` builds it; it is a pure module and is covered by
`tests/digest.test.mjs`.

The summary uses lowercase ASCII keys — `subject`, `date`, `from`, `to`, `cc`,
`attachments`, `body` — because they are protocol markers, not prose. One
summary has to serve a SystemOne batch whose criteria may resolve to
different prompt languages, so the summary stays language neutral and the
prompt template explains the keys.

```
subject: 项目周报 2026-10-20
date: Mon, 20 Oct 2026 09:30:00 +0800
from: 张三 <zhangsan@example.com>
to: me@example.com

attachments (1):
- 周报.pdf (application/pdf, 245760 bytes)

body (excerpt, 1843 of 41230 chars):
[begin]
...
[... omitted 30000 chars ...]
[middle]
...
[end]
...
```

- only `subject`, `date`, `from`, `to` and `cc` are kept; every other header
  (`Received`, `Message-ID`, `X-*`, …) is dropped;
- an attachment contributes its **file name** (plus type and size outside
  strict mode); its content is never read;
- the body is cut into three windows — the beginning (50%), the middle (20%)
  and the end (30%) — and every gap is marked with `[... omitted N chars ...]`;
- the body is sent in full only when it fits into the budget;
- each of `to` and `cc` lists at most 8 addresses. Duplicate addresses are
  collapsed, and any address that belongs to the receiving account (the
  identities on that account) is always retained even when the list is
  truncated; the remaining addresses are replaced by `... (+N more)`.

`inputCharacterLimit` is the budget, and it bounds the **whole summary**. It
always applies, not only in strict mode, and the stored value keeps its
character semantics (no migration). When the budget is tight the summary gives
up room in this order: the `cc` line, the `to` line, the number of attachment
names, the body, and finally the remaining attachment names. An excerpt below
200 characters carries too little to judge, so it is dropped and the summary
says `body omitted (character budget exhausted)`.

The budget covers the summary only. The system instructions, the classification
criterion and the per-rule SystemOne instructions are outside it, so the
request as a whole is larger than the budget.

### Strict mode

"Strict mode" is the **aggressive token reduction** setting (`tokenReduction`).
It compresses the summary further and makes the verdict conservative:

- the metadata is truncated harder, the attachment type and size are dropped
  and at most eight file names are listed;
- the chat prompt adds "If the available evidence does not clearly satisfy
  the criterion, answer false and state that the evidence was insufficient.",
  the SystemOne instruction asks for a probability of 0;
- a mail whose decisive content was cut away is therefore not matched. Missing
  evidence counts as a non-match, not as a guess.

Whether a request is strict is decided by the **snapshot**
(`snapshot.tokenReduction`), never by the body: the cache fingerprint is built
from `adapter.buildRequest('', criterion, snapshot)`, so a body dependent
decision would desynchronise the key from the request that is sent. Strict and
normal requests have separate cache entries because `tokenReduction` is part of
the fingerprint's `preprocessing` map.

The strict prompt is a soft constraint — the model can still answer
confidently. Do not add a second, system side threshold to correct that:
thresholds have a single source, `AiClassifier.withPolicy`.

### Non-ASCII Text Handling

Mail clients encode non-ASCII values, and the encodings differ per client. The
text builder must undo them:

- **Header values** are RFC 2047 encoded words (`=?UTF-8?B?…?=`,
  `=?UTF-8?Q?…?=`, `=?GB2312?B?…?=`). `decodeMimeWords()` in `background.js`
  decodes base64 and quoted-printable forms and honours the declared charset.
  It is applied to every header value and is a no-op for plain text.
- **Attachment names** use the RFC 5987 extended form
  (`filename*=UTF-8''%E9%99%84%E4%BB%B6.pdf`). `decodeFilename()` handles the
  extended form first, then plain `filename=`, then `name=`. The plain pattern
  alone never matches the extended form, so non-ASCII names would be lost.
- **URLs** end at whitespace, ASCII closing punctuation, or any CJK character.
  Chinese has no inter-word spaces, so a URL pattern that stops only at
  whitespace swallows the rest of the sentence. `URL_PATTERN` in `background.js`
  excludes the CJK and full-width ranges; `stripUrlQueryParams()` then removes
  the query string and any trailing punctuation.

Markers sent to the model (`__IMG__`, `__BASE64__`, `url(__IMG__)`,
`[... omitted N chars ...]`) stay ASCII and untranslated. They are protocol
markers, not prose.

### Cache Strategy

`aiCache` persists version 4 inference evidence. Keys are
`v4:<SHA-256 Message-ID>:<SHA-256 stable configuration/criterion fingerprint>`.
Include backend, endpoint, model, effective request parameters and preprocessing;
exclude secrets, actions and thresholds. The fingerprint is built from
`adapter.buildRequest('', criterion, snapshot)`, so it reflects the request that
is actually sent — a setting that changes the request changes the fingerprint,
while one that does not (such as a threshold) does not. Recompute SystemOne
matches from cached probability and current thresholds without automatically
executing actions.
Entries retain a hashed message identifier for clearing across configurations.
Version 4.0.0 intentionally breaks legacy cache compatibility: legacy caches
(including `aiReasonCache`) are invalidated because their inference
configuration is unknown. Import/export validates versioned evidence; storage
changes refresh the running cache. Maintenance uses `sortana:getCacheSize` to
count validated entries in the background classifier, rather than raw storage keys.
Full restoration requires matching settings and rules as well as cache evidence;
`tests/cacheRestore.test.mjs` exercises export/reinstall/import through the actual
storage and Details handlers, including changed numeric Thunderbird message IDs. Clearing/importing during inference prevents
that in-flight result from repopulating the replaced cache.

Version 4.2.0 adds localization and **does not** break the cache. `promptLanguage`
is not a fingerprint field of its own; it reaches the fingerprint only through the
request payload. For an English criterion the request is byte-for-byte the one
sent before 4.2.0, so existing entries remain valid. A criterion whose prompt
resolves to Chinese produces a different request and therefore a different entry,
which is correct. Never add a field to the fingerprint's `preprocessing` map
without accepting a full cache invalidation.

The email summary **breaks the cache deliberately**: version 4.3.0 replaces the
full message text with the summary and changes the prompt templates, so the
stored evidence of every previous version describes an input that is no longer
sent. The cache moves to `v4:` and the old entries are dropped when the cache is
loaded. The same reasoning applies to any later change of the summary, of the
templates or of the preprocessing: a classification result belongs to the exact
request that produced it, and the same mail under a different summary is a
different request.

### Icon Set Usage

Toolbar and menu icons reside under `resources/img` and are provided in 16, 32
and 64 pixel variants. When changing these icons, pass a dictionary mapping the
sizes to the paths in `browserAction.setIcon` or `messageDisplayAction.setIcon`.
Use `resources/svg2img.ps1` on Windows or `resources/svg2img.sh` on Linux to
regenerate PNGs from the SVG sources.
