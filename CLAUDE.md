# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Sortana is a Thunderbird WebExtension (Manifest V2) that classifies incoming email with an AI service and applies rule-based actions (tag, move, copy, forward, reply, delete, archive, read state, flag).

`AGENTS.md` in the repo root is the authoritative behavioral spec — endpoint semantics, threshold policy, cache format, batching rules, message-format rules. Read it before changing inference, cache, or rule behavior. This file covers how the code is put together and how to work in it.

## Commands

```sh
node --test tests/*.test.mjs                      # full suite (Node 22+, no dependencies)
node --test tests/batching.test.mjs               # one file
node --test --test-name-pattern "batch" tests/*.test.mjs   # one test by name
node build-xpi.mjs                                # package XPI into release/ (Node only)
```

There is no package.json, bundler, linter, or CI config. The extension ships source as-is and is loaded unpacked or as an XPI.

`build-xpi.mjs` writes the ZIP archive with Node's built-in `zlib` and then reads it back to verify every entry, so it is the portable build — `./build-xpi.sh` and `build-xpi.ps1` are the equivalents that shell out to `zip` and PowerShell. All three must select the same file set: build scripts, `*.sln`, `*.ps1`, `*.sh`, and the `release/`, `.git/`, `.vs/` and `.claude/` directories are excluded.

Do **not** run `build-xpi.ps1` or `resources/svg2img.{ps1,sh}` (AGENTS.md). Icon PNGs are committed.

## Architecture

Four layers, each depending only on the one below it:

| Layer | Files | Responsibility |
| --- | --- | --- |
| UI | `options/options.html`, `options/options.js`, `options/dataTransfer.js`, `details.html`, `details.js` | Settings/rules editor, import/export, evidence viewer |
| Orchestration | `background.js` | Message queue, rule eligibility, action execution, runtime message bus |
| Policy | `modules/AiClassifier.js` | Transport, config snapshot, threshold policy, cache read/write |
| Summary | `modules/mailDigest.js` | Builds the email summary (metadata, attachment names, body excerpts) that is sent instead of the full message |
| Adapters | `modules/backends/chatCompletions.js`, `modules/backends/systemOne.js` | Request construction and response parsing only |
| Cross-cutting | `modules/i18n.js`, `modules/promptLanguage.js`, `_locales/` | UI translations, prompt-language resolution, message catalogs |

`modules/classificationConfig.js` holds `CONFIG_DEFAULTS` plus `validateSettings`/`validateThreshold` — the single source of truth for the settings schema, shared by the options page, background startup, and import/export. `modules/defaultParams.js` holds the Chat Completions generation defaults.

### Module loading

`background.js` is a classic background script, so ES modules are pulled in at runtime with `await import(browser.runtime.getURL('modules/...'))`. Options and details pages do the same. There is no build step to resolve imports — a new module must be reachable by that path.

### Backend adapter contract

Each adapter exports `path`, `buildRequest(text, criterion, config)`, and `parseResponse(result)`. SystemOne additionally exports `buildBatchRequest(text, questions, config)` and `parseBatchResponse(result, questions)`. `AiClassifier` dispatches through a plain object keyed by `apiType` (`chat-completions`, `systemone`); adding a backend means adding the adapter plus a `CONFIG_DEFAULTS.apiType` entry and the `path` in `buildEndpointUrl`.

Adapters are pure: no fetch, no storage, no globals. All transport lives in `AiClassifier.sendRequest`.

### Localization

The UI language follows Thunderbird's locale; `modules/i18n.js` wraps `browser.i18n` and provides `t()`, `applyToDocument()` and `currentLocale()`. Static markup is marked with `data-i18n` / `data-i18n-title` / `data-i18n-placeholder` / `data-i18n-alt` / `data-i18n-aria-label`; dynamically built nodes call `t()` directly. `_locales/` ships `en-US`, `zh_CN` and `zh_TW` — all three must expose the **same key set** and the same `$NAME$` placeholders, enforced by `tests/i18n.test.mjs`.

The **prompt language** is a separate setting (`promptLanguage`: `auto` / `zh-CN` / `en`). `modules/promptLanguage.js` resolves it from the **criterion only** — never from the message body, because the cache fingerprint is computed from `adapter.buildRequest('', criterion, snapshot)` and a body-dependent decision would desynchronise the key from the request actually sent.

**The English templates in the adapters are part of the cache fingerprint.** They must stay byte-for-byte identical to the strings the current cache version was built with, or every stored classification result becomes unreachable. `tests/i18n.test.mjs` pins the exact request payload and the resulting cache key. Changing an English template — or the summary that is sent — requires a deliberate cache version bump.

### Classification flow

`background.js`:

1. `applyAiRules(ids)` appends to a serialized promise chain (`queue`) — one message processed at a time, in arrival order.
2. `processMessage(id)` snapshots config (`AiClassifier.getConfig()`) and clones `aiRules`, so a settings change mid-run cannot affect the email in flight.
3. `buildEmailSummary(full, { budget, strict })` reduces the mail to the summary that is actually sent: the metadata (subject, date, sender, recipients), the attachment file names and three excerpts of the body. Each of `to` and `cc` is capped at 8 addresses; duplicate addresses are collapsed, and the receiving account's own identities are always retained even when the list is truncated, with the remainder replaced by `... (+N more)`. `extractMail()` pulls the parts out of the MIME tree (`collectText`/`collectRawText` apply the preprocessing toggles `htmlToMarkdown`, `stripUrlParams`, `altTextImages`, `collapseWhitespace`, `tokenReduction`), and `modules/mailDigest.js` — a pure module — cuts the body into excerpts and fits everything into the character budget. `buildFullEmailText(full)` renders the unaltered message for the debug tab only.
4. Eligibility filtering happens *before* any inference: `enabled`, `accounts`, `folders`, `unreadOnly`, `minAgeDays`/`maxAgeDays`.
5. Each surviving rule gets a cache key via `AiClassifier.buildCacheKey(id, rule.criterion, snapshot)`.
6. `AiClassifier.classifyRules(text, candidates, snapshot)` is an async iterator. The rule runner consumes it with `for await`, so `stopProcessing` can break out *before* the next request is issued. Actions run inline as each result is yielded.
7. A thrown error aborts the remaining rules for that email only; the error is recorded and the queue continues with the next email.

### Message ids and rule actions

Thunderbird's numeric message id is an internal tracker id. Moving a message to another folder or deleting it **removes the id from the tracker** and gives the message a new one, so a later `messages.update()` on the old id throws `Error updating message: Message not found: <id>.`

The action runner therefore keeps a mutable `currentId`, orders the actions with `orderedActions()` (property changes and compose first, then copy, then move/archive, then delete), re-resolves the id after a move or archive with `messages.query({ folder, headerMessageId })`, and treats a "Message not found" error as benign — the message was removed by something else, so the remaining actions on it are skipped rather than failing the email. `messages.move()` does not resolve with the new ids in every Thunderbird release, so the re-resolution must not rely on its return value.

### Cache

Keys are `v4:<sha256(Message-ID)>:<sha256(fingerprint)>`. The fingerprint covers backend, resolved endpoint, the built request, org/project headers, and preprocessing options — deliberately **not** thresholds, secrets, actions, or batch settings, so changing a threshold or batch size reuses evidence while changing inference settings forces a fresh request.

`AiClassifier` keeps the cache in an in-memory `Map` mirrored to `storage.local.aiCache`, and a `generation` counter. Any clear, import, or `replaceCache` bumps the counter; in-flight writes compare their captured epoch against it and discard themselves if the cache was replaced underneath them. This is why "clearing the cache during inference" must not repopulate.

Do not change the cache key format or the fingerprint fields — it invalidates every user's stored evidence.

### Batch/chat asymmetry

Both backends group the uncached criteria of one email into a single request. Chat Completions sends the criteria as a numbered list in the **system** message and the email summary alone in the user message, and expects one JSON array element per criterion. SystemOne sends the summary as `state` and one `noul` question per criterion, keyed `rule_<snapshot index>`. A batch is validated as a whole before any of it is cached. Cached rules consume no batch capacity, and duplicate criteria keep independent thresholds.

A model does not always answer every criterion. Chat Completions therefore asks again for the criteria it skipped, with a shorter list; a criterion that stays unanswered counts as a non-match and is **not** cached, so a later run can ask for it again. SystemOne keeps its stricter rule: a single malformed answer fails the entire batch, caches nothing, and executes no actions from it.

### Threshold policy

`decisionThreshold` is stored as a number in `[0, 1]`. A SystemOne rule matches when `probability >= threshold`, evaluated on the **unrounded** value; the UI percent is a display rounding only. Rule-level `decisionThreshold` overrides the global one. `withPolicy` in `AiClassifier` is the single place this is decided — Details and the rule runner both read it from there, so Details always reflects current thresholds without re-running inference.

### Message bus

`background.js` registers one `browser.runtime.onMessage` listener handling `sortana:*` types (`getDetails`, `getReasons`, `getCacheSize`, `getTiming`, `clearCacheForMessage`, `recordError`, `getErrorLog`, `getDisplayedMessages`, `test`, …). The options and details pages talk to the background only through this bus — never directly to `AiClassifier` for message-scoped work.

`storage.onChanged` in the background applies live updates to `aiRules`, the classifier config, the cache, preprocessing flags, and theme.

## Testing approach

The suite is dependency-free (`node:test` + `node:assert/strict`) and exercises the real modules, not reimplementations.

- `tests/classification.test.mjs` — adapters, URL normalization, settings validation, cache fingerprint/migration, failure handling.
- `tests/batching.test.mjs` — SystemOne batching, cache reuse, batch atomicity, stop-after-match, snapshot isolation.
- `tests/ruleExecution.test.mjs` — the actual `background.js` rule runner.
- `tests/cacheRestore.test.mjs` — export/reinstall/import round trip through real storage handlers.
- `tests/i18n.test.mjs` — message catalogs, prompt-language resolution, cache-fingerprint stability, non-ASCII text handling.

Tests that need `background.js` use `node:vm`: the file's source is read as text, sliced between function markers (`source.slice(source.indexOf('async function processMessage('), source.indexOf('async function clearCacheForMessages('))`), and run in a context with mocked `messenger`/`browser`/`AiClassifier`. **This means the function names and their order in `background.js` are load-bearing** — renaming or moving `processMessage`, `applyAiRules`, or `clearCacheForMessages` breaks the tests, and any new dependency of a sliced function must be added to the mock context. `tests/support/i18n.js` provides a `t()` bound to the real message catalogs for those contexts.

## Non-ASCII text handling

`background.js` undoes the encodings mail clients use before the text reaches the model:

- `decodeMimeWords()` — RFC 2047 encoded header values (`=?UTF-8?B?…?=`, `=?UTF-8?Q?…?=`, `=?GB2312?B?…?=`). A no-op for plain text.
- `decodeFilename()` — RFC 5987 `filename*=UTF-8''…` first, then plain `filename=`, then `name=`. The plain pattern alone never matches the extended form, so non-ASCII names would be lost.
- `URL_PATTERN` / `stripUrlQueryParams()` — a URL ends at whitespace, ASCII closing punctuation, or any CJK character. Chinese has no inter-word spaces, so a URL pattern that stops only at whitespace swallows the rest of the sentence.

Markers sent to the model (`__IMG__`, `__BASE64__`) stay ASCII and untranslated — they are protocol markers, not prose.

## Conventions

- Modern JS only: `const`/`let`, template literals, ES modules. No `var`.
- `background.js` and `options/options.js` use 4-space indentation; `modules/` and `logger.js` use 2-space.
- No trailing whitespace; files end with a newline.
- `logger.js` exports `aiLog(message, { level, debug }, ...args)`; debug-level logs are suppressed unless `debugLogging` is on.
- `AGENTS.md` must be updated alongside behavior changes, and `README.md` when user-visible behavior changes.

## Gotchas

- The stored endpoint is a **base URL**. `normalizeEndpointBase` strips a trailing `/v1` or a recognized full API path, preserves proxy prefixes, and defaults to HTTPS when no scheme is given. `buildEndpointUrl` re-appends the adapter's `path`.
- Model discovery always uses `/v1/models`. Model `None` means the `model` field is omitted entirely, not sent as null.
- Organization/project headers are sent for Chat Completions only.
- `inputCharacterLimit` is the character budget of the email summary, always applies and is independent of `max_tokens`; it migrates from the old effective limit via `migratedInputLimit`.
- The single-question SystemOne path still uses the key `match` for backward compatibility and cache fingerprinting.
- Failed results are never cached. `classify()` throws; `classifyText()` is a boolean wrapper.
- Icons live in `resources/img` in 16/32/64 variants; `browserAction.setIcon`/`messageDisplayAction.setIcon` take a size→path dictionary.
