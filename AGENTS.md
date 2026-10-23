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
**They must stay byte-for-byte identical to the pre-4.2.0 strings**, otherwise
every stored classification result becomes unreachable. `tests/i18n.test.mjs`
pins the exact legacy request payload and the resulting cache key. Changing an
English template requires a deliberate cache version bump.

For the same reason the options page stores an empty `customSystemPrompt` when
the text box still holds a built-in default. The adapter then falls back to the
default for the resolved prompt language, which for English is the same string
that was stored before 4.2.0.

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

Chat Completions sends system/user messages and extracts the last JSON object from
`choices[0].message.content`, requiring a `match` or `matched` boolean. SystemOne
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
`inputCharacterLimit` replaces coupling input truncation to output `max_tokens`;
it applies with aggressive reduction and migrates from the old effective limit.
It is a character count, not a token count, and the two differ sharply by
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
  the tracker id does not;
- treats a `Message not found` error as benign: the message was removed by
  something else (another filter, an expunge, a compacted folder), so the
  remaining actions on it are skipped instead of failing the whole email and
  raising a user-visible error.

`messages.move()` does not resolve with the new ids in every Thunderbird
release, so the re-resolution must not rely on its return value.

### SystemOne batching

`systemOneProcessAll` defaults to true; `systemOneBatchSize` defaults to 8 and must
be a positive safe integer. Only SystemOne shows these controls. The numeric input
is disabled while Process all is enabled, retaining its value. Include both in
settings import/export, startup loading, live updates, and per-email snapshots.

`classifyRules()` is a lazy ordered async iterator over precomputed candidate keys.
Chat requests stay sequential. SystemOne batches the next N unique uncached keys
(or all), sends state once, validates the whole response, and persists one batch
of evidence before yielding ordered results. Per-rule thresholds remain independent.
Do not change existing cache keys or include batch settings in their fingerprint.
Prepare eligibility and keys before actions, using the existing initial mail metadata.

Stop-after-match ends action iteration and prevents further requests; already
computed later answers remain cached. A malformed answer fails its entire batch:
no partial cache writes or new actions. Keep cache-generation guards for imports
and clearing during inference. No automatic splitting or retries. Tests in
`tests/batching.test.mjs` cover batching, cache reuse, failure atomicity, and actual
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

When constructing the text sent to the AI service, parse the full message
recursively. Include key headers such as `from`, `to`, `subject`, and others, and
record attachment summaries rather than raw binary data. Inline or attached
base64 data should be replaced with placeholders showing the byte size. The
final string should have the headers, a brief attachment section, then the plain
text extracted from all text parts.

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

Markers sent to the model (`__IMG__`, `__BASE64__`, `url(__IMG__)`) stay ASCII
and untranslated. They are protocol markers, not prose.

### Cache Strategy

`aiCache` persists version 2 inference evidence. Keys are
`v2:<SHA-256 Message-ID>:<SHA-256 stable configuration/criterion fingerprint>`.
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

### Icon Set Usage

Toolbar and menu icons reside under `resources/img` and are provided in 16, 32
and 64 pixel variants. When changing these icons, pass a dictionary mapping the
sizes to the paths in `browserAction.setIcon` or `messageDisplayAction.setIcon`.
Use `resources/svg2img.ps1` on Windows or `resources/svg2img.sh` on Linux to
regenerate PNGs from the SVG sources.
