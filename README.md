![logo](/resources/img/full-logo-white.png)

# Sortana

Sortana is an experimental Thunderbird add-on that integrates an AI-powered filter rule. 
It allows you to classify email messages by sending their contents to a configurable
HTTP endpoint. Choose **Chat Completions** for an OpenAI-compatible
`/v1/chat/completions` service or **SystemOne** for decision models served through
`/v1/systemone`. Chat Completions returns a match boolean and textual explanation;
SystemOne returns a match probability, compared against a configurable threshold.
The options page stores a base URL and shows the resolved request URL.

## Features

- **Configurable endpoint** – set the classification service base URL on the options page.
- **Model selection** – load available models from the endpoint and choose one (or omit the model field).
- **Optional OpenAI auth headers** – provide an API key plus optional organization/project headers when needed.
- **Custom system prompts** – tailor the instructions sent as the system message for more precise results.
- **Persistent result caching** – classification results and reasoning are saved to disk so messages aren't re-evaluated across restarts.
- **Advanced parameters (Chat Completions)** – tune generation settings like temperature, top‑p and more from the options page.
  Provider-specific advanced fields are forwarded as configured and may be rejected by strict OpenAI endpoints.
- **Markdown conversion** – optionally convert HTML bodies to Markdown before sending them to the AI service.
- **Debug logging** – optional colorized logs help troubleshoot interactions with the AI service.
- **Debug tab** – view the last request payload and a diff between the unaltered message text and the final prompt.
- **Light/Dark themes** – automatically match Thunderbird's appearance with optional manual override.
- **Automatic rules** – create rules that tag, move, copy, forward, reply, delete, archive, mark read/unread or flag/unflag messages based on AI classification. Rules can optionally apply only to unread messages and can ignore messages outside a chosen age range.
- **Rule ordering** – drag rules to prioritize them and optionally stop processing after a match.
- **Rule enable/disable** – temporarily turn a rule off without removing it.
- **Account & folder filters** – limit rules to specific accounts or folders.
- **Context menu** – apply AI rules from the message list or the message display action button.
- **Status icons** – toolbar icons show when classification is in progress and briefly display success states. If a failure occurs the icon turns red briefly before returning to normal.
- **Error notification** – failed classification displays a notification in Thunderbird.
- **Session error log** – the Errors tab (visible only when errors occur) shows errors recorded since the last add-on start.
- **View results** – inspect chat explanations or SystemOne probabilities and thresholds in the Details popup.
- **Cache management** – clear cached results from the context menu or options page.
- **Queue & timing stats** – monitor processing time on the Maintenance tab.
- **Packaging scripts** – `build-xpi.ps1` (PowerShell) or `build-xpi.sh` (bash) build an XPI ready for installation.
- **Icon generation scripts** – `resources/svg2img.ps1` (PowerShell) or `resources/svg2img.sh` (bash) regenerate themed PNG icons from the SVG sources.
- **Maintenance tab** – view rule counts, cache entries and clear cached results from the options page.

### Cache Storage

Classification results are stored under `aiCache` using version 2 entries. Keys
combine a hashed Message-ID with a fingerprint of the criterion, backend,
endpoint, selected model, effective request settings, and preprocessing settings.
Credentials and thresholds are excluded. SystemOne probabilities are retained at
full precision; changing a threshold reuses the evidence without another request.
Changing inference settings requires a fresh classification. If the model behind
an unchanged server/model alias changes, clear the cache manually.

**Version 4.0.0 upgrade note:** legacy cache entries and `aiReasonCache` are discarded because
they do not identify the inference configuration. Settings and rules are retained.
Imported legacy caches are also discarded. To restore cached Details after reinstalling,
export and import **Settings, Rules, and Cache** together: lookups require the
original criterion and matching inference settings. Import refreshes the running
classifier immediately; Maintenance counts its validated, loaded entries. A cache-only
import will not recreate rules or settings. Clearing a message's cache removes its
entries across rules and configurations.

### SystemOne with llama-server

Use a llama.cpp build supporting `/v1/systemone` and a compatible decision GGUF;
older builds and ordinary chat models cannot serve this API. A 404 with
`File Not Found` from `/v1/systemone` indicates the route is unavailable: check
the running server build and any reverse-proxy routing. Loading a decision GGUF
alone does not add this route to an older server. For example:

```sh
llama-server -hf ggml-org/Laya-GGUF
```

1. Select **SystemOne** in Settings and set the endpoint to `http://127.0.0.1:8080`
   (or your server's address). Refresh models and select one, or choose **None**
   for a single loaded model. Router deployments require the appropriate model ID.
2. Set the default match probability threshold (initially **50%**). Each rule has
   an optional percentage override; leave it blank to inherit the default.
3. Apply rules normally. One `noul` question is sent per evaluated rule. A rule
   matches when the unrounded probability is **greater than or equal to** its
   effective threshold. For example, 80% matches an 80% threshold.
4. Open Details to see a probability bar with the percentage inside. Hover over
   the bar to see the current threshold and model. This is the
   result under current settings, not an action history. Changing thresholds does
   not automatically rerun actions. Decision models provide no textual explanation;
   no second model is called to invent one. Use Chat Completions for explanations.

Probabilities are model estimates, not guaranteed accuracy. Evaluate thresholds
against representative labeled emails, including long messages and attachments.
SystemOne uses the existing text extraction and attachment summaries; it does not
send attachment binaries or images. Chat prompts and generation settings remain
saved but are inactive for SystemOne. Optional Bearer authentication works with
both APIs; organization/project headers apply only to Chat Completions.

**Input character limit** applies when aggressive reduction is enabled, independently
of maximum output tokens. Existing installations inherit their previous effective
character limit; the default is 3686. Character counts do not guarantee that input
fits a model's token context or llama-server batch limits. Leave room for question
instructions and configure the server for the chosen model.

A request or response-parsing failure stops the remaining rules for that email,
records an error, and allows the queue to continue with the next email. Failed
results are never cached. Actions already completed are not rolled back.

Upstream: [llama-server SystemOne documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#typesafe-compatible-api-endpoints).

### Verification

Run the dependency-free tests with Node.js 22 or newer:

```sh
node --test tests/*.test.mjs
```

Tests cover adapters, thresholds, URLs, settings validation, cache migration and
reuse, request failures, per-email snapshots, and queue behavior with mocked
Thunderbird services. Manual acceptance testing in Thunderbird should verify both
API types, model discovery, rule overrides and ordering, import/export, cache
clearing, Details, and stop-after-match against a running server.

## Architecture Overview

Sortana is implemented entirely with documented MailExtension/WebExtension APIs. No custom experiment code or Thunderbird-internal fallback paths are required:

- `background.js` loads saved settings, manages the classification queue and listens for new messages.
- `modules/AiClassifier.js` shares transport, threshold policy, and cache handling;
  `modules/backends/` contains the Chat Completions and SystemOne adapters.
- `options/` contains the HTML and JavaScript for configuring the endpoint and rules.
- `details.html` / `details.js` present cached classification evidence for a message.
- `_locales/` holds localized strings used throughout the UI.

### Key Files

| Path                                    | Purpose                                        |
| --------------------------------------- | ---------------------------------------------- |
| `manifest.json`                         | Extension manifest and entry points. |
| `background.js`                         | Startup tasks and classification queue management. |
| `modules/AiClassifier.js`               | Core classification logic and cache handling. |
| `options/options.html` and `options.js` | Endpoint and rule configuration UI. |
| `details.html` and `details.js`         | View stored classification evidence for a message. |
| `logger.js`                             | Colorized logging with optional debug mode. |

## Building

1. Ensure PowerShell is available on Windows or bash, `python3`, and Inkscape are
   available on Linux.
2. The Bulma stylesheet (v1.0.3) is already included as `options/bulma.css`.
3. Run `powershell ./build-xpi.ps1` or `./build-xpi.sh` from the repository root.
   The script reads the version from `manifest.json` and creates an XPI in the
   `release` folder.
4. Install the generated XPI in Thunderbird via the Add-ons Manager. During
   development you can also load the directory as a temporary add-on.
5. To regenerate PNG icons from the SVG sources, run `resources/svg2img.ps1` on
   Windows or `./resources/svg2img.sh` on Linux.

## Usage

1. Open the add-on's options and set the base URL of your classification service
   (Sortana appends the path for the selected API type). Use the Model dropdown to load
   `/v1/models` and select a model or choose **None** to omit the `model` field.
   Advanced settings include optional API key, organization, and project headers
   for OpenAI-hosted endpoints.
 2. Use the **Classification Rules** section to add a criterion and optional
   actions such as tagging, moving, copying, forwarding, replying,
   deleting or archiving a message when it matches. Drag rules to
   reorder them, check *Only apply to unread messages* to skip read mail,
   set optional minimum or maximum message age limits, select the accounts or
 folders a rule should apply to. Use the
 slashed-circle/check button to disable or re-enable a rule. The small
 circle buttons for optional conditions show a filled dot when active, and
 check *Stop after match* to halt further processing. Forward and reply actions
   open a compose window using the account that received the message.
3. Save your settings. New mail will be evaluated automatically using the
   configured rules.
4. If the toolbar icon shows a red X, it will clear after a few seconds. Open the Errors tab in Options to review the latest failures.

### Example Filters

Here are some useful and fun example criteria you can use in your filters. Filters should be able to be answered as either `true` or `false`.

- **"Does this message require my attention, response, or decision soon?"**  
  Identify emails with deadlines, requests, or actionable items.

- **"Is this message spam, phishing, or irrelevant bulk mail?"**  
  Catch low-value or deceptive messages and sweep them into the junk folder.

- **"Is this email promotional, advertising a product or service, or part of a mass mailing?"**  
  Great for filtering out newsletters, deals, and marketing campaigns.

- **"Is this a personal message from a friend or family member?"**  
  Keep emotionally meaningful or social emails from getting lost.

- **"Is this message a receipt, invoice, or shipping notification?"**  
  Automatically tag or file transactional messages for easy lookup.

- **"Does this message relate to one of my current work projects?"**  
  Focus your inbox around what matters right now.

- **"Would I roll my eyes reading this email?"**  
  For when you're ready to filter based on vibes.

You can define as many filters as you'd like, each using a different prompt and
triggering tags, moves, copies, deletes, archives, read/unread changes or flag updates based on the model's classification.

## Required Permissions

Sortana requests the following Thunderbird permissions:

- `storage` – store configuration and cached classification results.
- `messagesRead` – read message contents for classification.
- `messagesMove` – move or copy messages when a rule specifies a target folder.
 - `messagesUpdate` – change message properties such as tags, junk status, read/unread state and flags.
- `messagesTagsList` – retrieve existing message tags for rule actions.
- `accountsRead` – list accounts and folders for move or copy actions.
- `menus` – add context menu commands.
- `tabs` – open new tabs and query the active tab.
- `notifications` – display error notifications.
- `compose` – create reply and forward compose windows for matching rules.

## Thunderbird Add-on Store Disclosures

The [Third Party Library Usage](https://extensionworkshop.com/documentation/publish/third-party-library-usage/) policy
requires disclosure of third party libraries that are included in the add-on. Even though
the disclosure is only required for add-on review, they'll be listed here as well. Sortana
uses the following third party libraries:

- [Bulma.css v1.0.3](https://github.com/jgthms/bulma/blob/1.0.3/css/bulma.css)
  - MIT License
- [turndown v7.2.0](https://github.com/mixmark-io/turndown/tree/v7.2.0)
  - MIT License
- [diff](https://github.com/google/diff-match-patch/blob/62f2e689f498f9c92dbc588c58750addec9b1654/javascript/diff_match_patch_uncompressed.js)
  -  Apache-2.0 license

## License

This project is licensed under the terms of the GNU General Public License
version 3. See `LICENSE` for the full text. Third party libraries are licensed seperately.

## Acknowledgments

Sortana builds upon knowledge gained from open-source projects. In particular,
[FiltaQuilla](https://github.com/RealRaven2000/FiltaQuilla) and
[Expression-Search-NG](https://github.com/opto/expression-search-NG) clarified
how Thunderbird's WebExtension and experiment APIs can be extended. Their code
provided invaluable guidance during development.

- Icons from [cc0-icons.jonh.eu](https://cc0-icons.jonh.eu/) are used under the CC0 license.
