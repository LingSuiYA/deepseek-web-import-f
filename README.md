<div align="center">

# deepseek-web-import · feature supplement

**Bring DeepSeek web conversations into DSH together with their images and documents**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
![Based on](https://img.shields.io/badge/based%20on-wpc0323%2Fdeepseek--web--import%200.2.0-blue)
![Plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B6BFB)

[Upstream](https://github.com/wpc0323/deepseek-web-import) · [Install from zero](docs/INSTALL-FROM-ZERO.md) · [Issues](https://github.com/LingSuiYA/deepseek-web-import-f/issues)

</div>

---

## Before anything else

This repository is a **feature supplement and modification** of
[wpc0323/deepseek-web-import](https://github.com/wpc0323/deepseek-web-import), not an
original project. Conversation listing, token storage, session-format compatibility,
the settings page and the diagnostics all come from upstream and remain the original
author's work.

The only thing added here is what an import used to drop: pictures, documents, and
the text cleanup, result feedback and refresh behavior that go with them.

- Same package name and same Cordis row as upstream, so installing one replaces the other.
- An upstream release restores the files this supplement touches; re-apply the overlay
  afterwards (see [Install and update](#install-and-update)).
- For text-only imports, upstream on its own is enough.

## Why this supplement exists

A stock import keeps text only. Pictures and PDFs attached to the conversation vanish,
search citations stay in the body as literal `[reference:N]` markers, the new session
only shows up after a manual refresh, and its title stays "untitled" until the session
is opened once.

None of that breaks importing. All of it decides whether the imported conversation is
actually usable.

## Features

### 1. Images and documents

- **Images**: read the file id from the human turn's `FILE` fragment, refresh the signed
  path through `fetch_files`, download the `ty=p` preview, sniff the real raster type
  from magic bytes, and store it through the DSH attachment service.
- **Documents**: fetch PDF / Word / text as the original bytes (`ty=r`) and **stream**
  them to a temporary file before `saveFileStream`. No 20 MB style limit: the ceiling
  follows the web client (100 MB per file, 50 files by default), with a 1 GiB runaway
  guard as the only bound.
- **Failure isolation**: one failed picture or document is skipped; the text and the
  session are still written.
- **Text cleanup**: `[reference:N]` citation markers and stray `<br>` tags are removed;
  fenced code blocks are left untouched.

### 2. Result report

A finished import reports the session id, message count, event count, session format
version, and `N images` / `N files`.

When items were found but none could be stored the line says `0/N`, which distinguishes
"there were none" from "there were some and they failed".

### 3. Automatic refresh

1.2 seconds after a successful import the page reloads once, so the new session appears
in the sidebar without a manual refresh.

For several imports in a row, the batch mode counts them instead and exposes a single
"Finish and refresh (N)" action. Both preferences live in `localStorage`.

### 4. Error handling

- Error codes follow upstream (`no_token`, `api`, `too_large`, `persist`, …); new
  failures are scoped to the attachment that hit them.
- Any image or document failure still lets the session be written.
- The result carries `titleCached` (`written` / `ok` / `error` / `no_cache`) so the
  title-cache outcome is visible.
- If startup reports `deepseek-web-import: import failed`, use the boot dialog's
  "disable third-party plugins" to get DSH running, then roll back only the client file
  (command in [Install from zero](docs/INSTALL-FROM-ZERO.md)).

## How it works

Upstream translates `history_messages` fragments into DSH session events. This
supplement adds two attachment passes and one text pass before the session is written:

```text
DeepSeek history
   │  fragments: REQUEST / RESPONSE / THINK / FILE
   ├─ image ── fetch_files ── ty=p ── magic-byte check ── attachments.saveImages
   ├─ file  ── fetch_files ── ty=r ── streamed temp file ── attachments.saveFileStream
   └─ text  ── strip [reference:N] / <br> ── written as a text block
                                   │
                             buildSessionEvents
```

| Piece | Role |
|---|---|
| `lib/images.js` | image discovery, download, sniffing (new) |
| `lib/files.js` | document discovery, streamed download, save (new) |
| `lib/text.js` | markdown cleanup, code fences preserved (new) |
| `lib/events.js` | `messageBlocks(message, role, images, files)`, `buildSessionEvents(…, imagesByMessage, filesByMessage)` |
| `lib/index.js` | attachment passes before writing, counts and `titleCached` |
| `lib/client.js` | result line, automatic refresh, batch mode |
| `test/*.test.mjs` | offline cases: parsing, URLs, event assembly, download/save pipeline, cleanup |

## Install and update

Starting from a client that has neither upstream nor this supplement? Pick one route in
[Install from zero](docs/INSTALL-FROM-ZERO.md). The routes differ in exactly one respect:
whether the plugin marketplace can keep the package updated.

### A. Once this repository is public: one step

The marketplace tracks this repository, so the install keeps itself current.

```sh
dsh plugin add LingSuiYA/deepseek-web-import-f
```

### B. Today: marketplace-managed base + local overlay

The marketplace keeps managing the upstream version; this supplement is a patch applied
on top, re-applied after each upstream update.

```sh
dsh plugin add https://github.com/wpc0323/deepseek-web-import/archive/refs/heads/main.tar.gz
git clone git@github.com:LingSuiYA/deepseek-web-import-f.git
node deepseek-web-import-f/tools/apply-dlc.mjs
```

### C. Offline: a local tarball

For an intranet machine or a quick trial, at the cost of marketplace updates.

```sh
npm pack && dsh plugin add file:/absolute/path/deepseek-web-import-*.tgz
```

A marketplace update restores the upstream files, so the overlay disappears; run
`node tools/apply-dlc.mjs` again. The script applies each stage only when missing and
fails loudly when an anchor moved, instead of leaving a half-patched package.

> Host-half changes need a DSH restart or one plugin toggle; client-only changes (refresh,
> batch mode) take effect on a page refresh.

## Compatibility and limits

- Base: upstream `0.2.0`, writing DSH session format v4.
- Document bytes are restored, but the model context still carries only the text
  DeepSeek stored for that turn — the parsed document text was never in the history payload.
- Replaying an imported turn with a `file` block depends on the target model adapter
  accepting it; verify once with a document conversation.
- Built on DeepSeek's unofficial API; an expired `userToken` has to be saved again.

## Credits

- [wpc0323](https://github.com/wpc0323) wrote the import implementation and the
  format-compatibility layer this repository builds on.
- The settings page and error conventions follow upstream; this supplement only adds to them.

## License

[MIT](LICENSE), inherited from upstream.
