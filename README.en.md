<div align="center">

# deepseek-web-import · feature supplement

**Bring DeepSeek web conversations into DSH together with their images and documents**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
![Based on](https://img.shields.io/badge/based%20on-wpc0323%2Fdeepseek--web--import%200.2.0-blue)
![Plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B6BFB)

[中文](README.md) · [Upstream](https://github.com/wpc0323/deepseek-web-import) · [Install from zero](docs/INSTALL-FROM-ZERO.md) · [Issues](https://github.com/LingSuiYA/deepseek-web-import-f/issues)

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
- Reinstalling upstream, switching the base, or reinstalling from the marketplace restores
  the files this supplement touches; re-apply the overlay afterwards (see
  [Install and update](#install-and-update)).
- For text-only imports, upstream on its own is enough.
- Not affiliated with DeepSeek or with the upstream author. This is an unofficial,
  community modification that reads the user's own conversations through DeepSeek's
  internal web API; use it at your own risk.

## Why this supplement exists

A stock import keeps text only. Pictures and PDFs attached to the conversation vanish,
search citations stay in the body as literal `[reference:N]` markers, the new session
only shows up after a manual refresh, and its title stays "untitled" until the session
is opened once.

None of that breaks importing. All of it decides whether the imported conversation is
actually usable.

## Quick start

1. **Install the plugin** using one route from [Install and update](#install-and-update),
   then restart DSH.
2. **Open Settings → Conversation Import**.
3. **Paste a `userToken`**: sign in to chat.deepseek.com → `F12` → `Application` →
   `Local Storage` → copy the `userToken` value → paste and save (the plugin extracts the
   `value` field itself).
4. **Load conversations → pick a workspace → Import as session**. The result line reports
   the message count and `N images` / `N files`; the page refreshes automatically and the
   new session appears in the sidebar.

The full acceptance checklist and failure table live in
[Install from zero](docs/INSTALL-FROM-ZERO.md).

## Requirements

- **DSH 0.2.x** (tested on `0.2.1-rc.2`), writing session format v4.
- **Node.js ≥ 18** for the overlay script and packaging (routes B and C).
- **git** for routes A and B; without `git` on the host's PATH, route A fails.
- **GitHub access** for routes A and B.
- **A DeepSeek web account** to obtain the `userToken`.
- The plugin marketplace is optional and only affects update prompts.

## Features

### 1. Images and documents

- **Images**: read the file id from the human turn's `FILE` fragment, refresh the signed
  path through `fetch_files`, download the `ty=p` preview, sniff the real raster type
  from magic bytes, and store it through the DSH attachment service. The preview endpoint
  is capped at 12 MB per image, far above a normal screenshot.
- **Documents**: fetch PDF / Word / text as the original bytes (`ty=r`) and **stream**
  them to a temporary file before `saveFileStream`. The importer adds no cap of its own:
  the web client's default is 100 MB per file and 50 files, and the only guard here is a
  1 GiB runaway limit.
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
- Startup failures and untitled sessions are covered in [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).
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
[Install from zero](docs/INSTALL-FROM-ZERO.md). The routes differ mainly in whether the
marketplace can keep the install updated afterwards.

### A. Install from the Git repository (one step)

Installing straight from this repository lets the marketplace track it.

```sh
dsh plugin add LingSuiYA/deepseek-web-import-f
```

Equivalent: `dsh plugin add github:LingSuiYA/deepseek-web-import-f`.

The repository must be reachable; when the host's PATH has no `git`, the command fails
with `git ls-remote failed`, so use route B instead.

### B. Pinned upstream base + local overlay

Install the upstream base first; this supplement is a patch applied on top (this route
does not install this repository's package, it modifies the installed upstream files).
The base is pinned to upstream `0.2.0`, commit `7727f18`, so the patch anchors stay stable.

```sh
dsh plugin add https://github.com/wpc0323/deepseek-web-import/archive/7727f18e3996713dec1b7046d07897c19efed5ae.tar.gz
git clone https://github.com/LingSuiYA/deepseek-web-import-f.git
cd deepseek-web-import-f
node tools/apply-dlc.mjs
```

The default target is `~/.dsh/profiles/desktop/node_modules/deepseek-web-import`; when
the profile has another name, pass the package directory or set the environment variable:

```sh
# POSIX
DSH_PLUGIN_DIR=/path/to/pkg node tools/apply-dlc.mjs
# PowerShell
$env:DSH_PLUGIN_DIR = "C:\path\to\pkg"; node tools/apply-dlc.mjs
```

### C. Offline: a local tarball

For an intranet machine or a quick trial, at the cost of marketplace updates.

```sh
cd deepseek-web-import-f
npm pack
dsh plugin add file:/absolute/path/deepseek-web-import-0.2.0-dlc.15.tgz
# Windows: file:C:/path/to/deepseek-web-import-0.2.0-dlc.15.tgz
```

The tarball contains `lib/`, `docs/`, `tools/`, `cordis.patch.yml` and both READMEs.
Windows shells do not expand `*`, so write the actual file name.

A fixed-commit archive never upgrades by itself. To follow upstream, point that URL at a
newer upstream commit and run `node tools/apply-dlc.mjs` again; if it reports a moved
anchor, upstream changed a patched file and this repository needs a rebase first.

> Host-half changes need a DSH restart, or disabling and re-enabling the entry under
> Settings → Plugins; client-only changes (refresh, batch mode) take effect on a page refresh.

## Uninstall and rollback

- **Back to upstream**: run `dsh plugin add <upstream archive URL>` (URL in
  [Install from zero](docs/INSTALL-FROM-ZERO.md)); the same package name is replaced and
  the overlay goes with it.
- **Roll back only the client half** (keeping images, documents and text cleanup).
  `git clone` brings only `origin`, so add `upstream` first:

  ```bash
  cd deepseek-web-import-f
  git remote add upstream https://github.com/wpc0323/deepseek-web-import.git
  git fetch upstream
  git show upstream/main:lib/client.js \
    > ~/.dsh/profiles/desktop/node_modules/deepseek-web-import/lib/client.js
  ```

  Run this in **Git Bash** on Windows: cmd does not expand `~`, and PowerShell 5.1's `>`
  writes UTF-16, which corrupts `client.js` and makes the plugin fail to load. The
  profile lives at `%USERPROFILE%\.dsh\profiles\desktop` unless it has another name.

  Simpler alternative: reinstall upstream ("Back to upstream" above); the client half is
  restored too.
- **Remove from the marketplace**: Settings → Plugins → find `deepseek-web-import` → remove.

## Compatibility and limits

- **DSH 0.2.x** (tested on `0.2.1-rc.2`), writing session format v4; the overlay targets
  upstream `0.2.0`, commit `7727f18`.
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

[MIT](LICENSE), inherited from upstream; modification notice in [NOTICE](NOTICE).
