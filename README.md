![logo](/resources/img/full-logo-white.png)

# Sortana

Sortana is an experimental Thunderbird add-on that integrates an AI-powered filter rule. 
It allows you to classify email messages by sending their contents to a configurable
HTTP endpoint. Sortana uses `POST /v1/chat/completions`; the options page stores a
base URL and appends `/v1/chat/completions` when sending classification requests.
The same base URL is used with `/v1/models` when refreshing the model list.
Classification requests ask the model for structured JSON output with a required
`match` boolean and `reason` string.

## Features

- **Configurable endpoint** – set the classification service base URL on the options page.
- **Model selection** – load available models from the endpoint and choose one (or omit the model field).
- **Optional OpenAI auth headers** – provide an API key plus optional organization/project headers when needed.
- **Request formats** – built-in formats use native chat messages; a custom format can still send one templated user message when needed.
- **Custom system prompts** – tailor the instructions sent to the model for more precise results.
- **Persistent result caching** – classification results and reasoning are saved to disk so messages aren't re-evaluated across restarts.
- **Advanced parameters** – tune generation settings like temperature and top‑p from the options page. Unsupported OpenAI sampling fields are filtered out automatically.
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
- **View reasoning** – inspect why rules matched via the Details popup.
- **Cache management** – clear cached results from the context menu or options page.
- **Queue & timing stats** – monitor processing time on the Maintenance tab.
- **Packaging scripts** – `build-xpi.ps1` (PowerShell) or `build-xpi.sh` (bash) build an XPI ready for installation.
- **Icon generation scripts** – `resources/svg2img.ps1` (PowerShell) or `resources/svg2img.sh` (bash) regenerate themed PNG icons from the SVG sources.
- **Maintenance tab** – view rule counts, cache entries and clear cached results from the options page.

### Cache Storage

Classification results are stored under the `aiCache` key in extension storage.
Each entry maps a SHA‑256 hash of `"<message Message-ID>|<criterion>"` to an object
containing `matched` and `reason` fields. Older installations with a separate
`aiReasonCache` will be migrated automatically on startup.

## Architecture Overview

Sortana is implemented entirely with documented MailExtension/WebExtension APIs. No custom experiment code or Thunderbird-internal fallback paths are required:

- `background.js` loads saved settings, manages the classification queue and listens for new messages.
- `modules/AiClassifier.js` implements the classification logic and cache handling.
- `options/` contains the HTML and JavaScript for configuring the endpoint and rules.
- `details.html` / `details.js` present cached reasoning for a message.
- `_locales/` holds localized strings used throughout the UI.

### Key Files

| Path                                    | Purpose                                        |
| --------------------------------------- | ---------------------------------------------- |
| `manifest.json`                         | Extension manifest and entry points. |
| `background.js`                         | Startup tasks and classification queue management. |
| `modules/AiClassifier.js`               | Core classification logic and cache handling. |
| `options/options.html` and `options.js` | Endpoint and rule configuration UI. |
| `details.html` and `details.js`         | View stored reasoning for a message. |
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
   (Sortana will append `/v1/chat/completions`). Endpoints ending in `/v1`,
   `/v1/chat/completions`, `/v1/completions`, or `/v1/models` are normalized back
   to the same base URL. Use the Model dropdown to load `/v1/models` and select a
   model or choose **None** to omit the `model` field. Advanced settings include
   optional API key, organization, and project headers for OpenAI-hosted endpoints.
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

OpenAI Chat requests are sent with a `messages` array plus a strict
`response_format` JSON schema. Sortana maps the saved `max_tokens` setting to
`max_completion_tokens` for Chat Completions and only forwards OpenAI-supported
sampling fields.

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
