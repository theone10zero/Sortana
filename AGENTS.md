# AGENTS Guidelines for Sortana

This file provides guidelines for codex agents contributing to the Sortana project. It describes the repository structure, the expected coding conventions, and testing commands. If you make changes to Sortana, make sure to update this document and the README.md if applicable.

## Repository Overview

- `background.js`: Handles startup tasks and coordinates message passing within the extension.
- `modules/`: Contains reusable JavaScript modules such as `AiClassifier.js`,
  `defaultParams.js` and `themeUtils.js`.
- `options/`: The options page HTML, JavaScript and bundled Bulma CSS (v1.0.3).
- `details.html` and `details.js`: View AI reasoning and clear cache for a message.
- `resources/`: Images and other static files.
- `prompt_templates/`: Prompt template files for the AI service (openai, qwen, mistral, harmony).
- `build-xpi.ps1`: PowerShell script to package the extension.
- `build-xpi.sh`: Bash script to package the extension.

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

There are currently no automated tests for this project. If you add tests in the future, specify the commands to run them here. For now, verification must happen manually in Thunderbird. Do **not** run the `ps1` build script or the SVG processing script.

## Endpoint Notes

Sortana targets the `/v1/completions` API. The endpoint value stored in settings is a base URL; the full request URL is constructed by appending `/v1/completions` (adding a slash when needed) and defaulting to `https://` if no scheme is provided.
Responses are expected to include a JSON object with `match` (or `matched`) plus a short `reason` string; the parser extracts the last JSON object in the response text and ignores any surrounding commentary.

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

`aiCache` persists classification results. Each key is the SHA‑256 hex of
`"<message Message-ID>|<criterion>"` and maps to an object with `matched` and `reason`
properties. Any legacy `aiReasonCache` data is merged into `aiCache` the first
time the add-on loads after an update.

### Icon Set Usage

Toolbar and menu icons reside under `resources/img` and are provided in 16, 32
and 64 pixel variants. When changing these icons, pass a dictionary mapping the
sizes to the paths in `browserAction.setIcon` or `messageDisplayAction.setIcon`.
Use `resources/svg2img.ps1` to regenerate PNGs from the SVG sources.
