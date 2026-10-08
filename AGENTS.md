# AGENTS Guidelines for Sortana

This file provides guidelines for codex agents contributing to the Sortana project. It describes the repository structure, the expected coding conventions, and testing commands. If you make changes to Sortana, make sure to update this document and the README.md if applicable.

## Repository Overview

- `background.js`: Handles startup tasks and coordinates message passing within the extension.
- `modules/`: Contains reusable JavaScript modules such as `AiClassifier.js`,
  `defaultParams.js` and `themeUtils.js`.
- `options/`: The options page HTML, JavaScript and bundled Bulma CSS (v1.0.3).
- `details.html` and `details.js`: View classification evidence and clear cache for a message.
- `resources/`: Images and other static files.
- `build-xpi.ps1`: PowerShell script to package the extension.
- `build-xpi.sh`: Bash script to package the extension.
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

## Endpoint Notes

Sortana supports `apiType: "chat-completions"` (default) and `"systemone"`.
Plain adapter modules under `modules/backends/` own request construction and response
validation; `AiClassifier` owns shared transport, configuration snapshots, threshold
policy, and caching. The stored endpoint is a base URL. Normalization accepts `/v1`
and recognized full API paths, preserves proxy prefixes, and defaults to HTTPS
when no scheme is supplied. Model discovery uses `/v1/models`; **None** omits `model`.
Bearer authentication is optional for both APIs. Organization/project headers are
sent only for Chat Completions.

Chat Completions sends system/user messages and extracts the last JSON object from
`choices[0].message.content`, requiring a `match` or `matched` boolean. SystemOne
sends prepared email text as `state` and a single `questions.match` of type `noul`.
It requires `answers.match.type === "noul"` and a finite numeric `noul` in `[0, 1]`.
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

### Cache Strategy

`aiCache` persists version 2 inference evidence. Keys are
`v2:<SHA-256 Message-ID>:<SHA-256 stable configuration/criterion fingerprint>`.
Include backend, endpoint, model, effective request parameters and preprocessing;
exclude secrets, actions and thresholds. Recompute SystemOne matches from cached
probability and current thresholds without automatically executing actions.
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

### Icon Set Usage

Toolbar and menu icons reside under `resources/img` and are provided in 16, 32
and 64 pixel variants. When changing these icons, pass a dictionary mapping the
sizes to the paths in `browserAction.setIcon` or `messageDisplayAction.setIcon`.
Use `resources/svg2img.ps1` on Windows or `resources/svg2img.sh` on Linux to
regenerate PNGs from the SVG sources.
