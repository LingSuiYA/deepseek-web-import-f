# deepseek-web-import — DLC overlay

[中文](README.zh.md)

This repository is a thin overlay on **[wpc0323/deepseek-web-import](https://github.com/wpc0323/deepseek-web-import)**.
It tracks upstream `0.2.0` and adds one capability: **importing the pictures users
uploaded to a DeepSeek conversation**.

Conversation listing, token storage, session-format compatibility, the localized
settings page and diagnostics all come from upstream — read the
[upstream README](https://github.com/wpc0323/deepseek-web-import#readme) for those.
This page documents only the overlay.

## Added by this overlay

- An imported human turn keeps its pictures: each image is downloaded, stored as a
  DSH attachment, and rendered inline after the prompt text.
- It also keeps **documents** (PDF, Word, text, …) as file attachments, with their
  original names and bytes.
- Text is normalized for a plain Markdown viewer: DeepSeek's `[reference:N]`
  citation markers (their targets are not in the history payload) and stray
  `<br>` tags are removed, while fenced code blocks are left untouched.
- The result line reports how many were kept (`N images`, `N files`), or `0/N` when
  items were found but none could be stored.
- After a successful import the page refreshes once so the new session appears in
  the sidebar without a manual reload. Batch mode defers that to one
  "Finish and refresh" button when importing several conversations.
- The stored title is written into the projection cache at import time, so the
  sidebar shows the real conversation name immediately instead of "untitled"
  until the session is opened once.
- An attachment that fails to download or decode is skipped; the text import still succeeds.

## How it works

DeepSeek keeps an upload as a `FILE` fragment on the human turn:

```json
{ "type": "FILE", "files": [{ "id": "file-…", "file_name": "image.png",
  "is_image": true, "width": 2559, "height": 1440,
  "status": "SUCCESS", "signed_path": "/file?file_id=…&state=…" }] }
```

The bytes are not in `history_messages`; they sit behind a signed CDN path. Three
steps run before the session is written:

1. `GET /api/v0/file/fetch_files?file_ids=…` refreshes the descriptors — the
   `signed_path` carried by history can be stale;
2. download from `https://files.deepseeksvc.com/api<path>` through the same
   `subprocess` transport as every other request; the rendition depends on the
   entry:
   - images use `?ty=p` (`&fmt=jpeg` transcodes, omitting it may yield WebP);
   - documents use `?ty=r`, the original bytes;
3. persist through the DSH `attachments` service and reference the result as
   `{ "type": "image" | "file", "attachment": … }` after the prompt text.

**No artificial size cap.** The web client allows **100 MB per file** by default
(`0x6400000`) and up to 50 files, and a model can raise that through its
`file_feature.max_upload_file_size`; a smaller importer limit would drop files the
user could upload in the browser. The only bound here is a 1 GiB runaway guard.
Documents stream to a temporary file and then into `attachments.saveFileStream`
(no base64, no whole-file buffer), so a file at the web limit costs disk I/O
rather than heap.

| Piece | Role |
|---|---|
| `lib/images.js` | image discovery, download, sniffing (new file) |
| `lib/files.js` | document discovery, streamed download, save (new file) |
| `lib/text.js` | markdown cleanup, code fences preserved (new file) |
| `lib/events.js` | `messageBlocks(message, role, images, files)` and `buildSessionEvents(…, imagesByMessage, filesByMessage)` |
| `lib/index.js` | runs both passes before writing, reports the counts |
| `lib/client.js` | localized image/file counts in the result line |
| `test/images.test.mjs`, `test/files.test.mjs`, `test/text.test.mjs` | 22 cases: parsing, URLs, event assembly, download/save pipeline, size guard, cleanup |

## Install and update

The marketplace only updates sources it can re-resolve (`npm:`, `github:`, or a
fixed archive URL); a `file:` tarball is invisible to it. Keep the base
market-managed and re-apply the overlay:

```sh
# base: the same archive URL the marketplace uses
dsh plugin add https://github.com/wpc0323/deepseek-web-import/archive/refs/heads/main.tar.gz

# overlay
node tools/apply-dlc.mjs
```

**After every marketplace update of the base, run `node tools/apply-dlc.mjs`
again** — the update restores pristine upstream files and removes the overlay.
The script is idempotent, writes through a fresh inode (never editing pnpm's store
link), and fails loudly when an anchor moved, which means the overlay needs a rebase.

Once this repository is public, the single-step install is:

```sh
dsh plugin add LingSuiYA/deepseek-web-import-f
```

It replaces the base, because both packages carry the same name and Cordis row.

## Staying in sync

```sh
git fetch upstream
git rebase upstream/main     # replay the overlay commits
npm test
```

Bump the suffix after a rebase (`0.2.0-dlc.1` → `0.2.1-dlc.1`). Overlay commits
stay small and self-contained so a rebase is a replay, not a merge.

## Compatibility

- Base: upstream `0.2.0`, writing DSH session format v4.
- `lib/images.js` and `lib/files.js` are additive; the three patched files are
  anchor-checked.
- Document bytes are restored, but the model context still carries only the text
  DeepSeek stored for that turn — the parsed document text was never part of the
  history payload.
- Replaying an imported turn that carries a file depends on the target model
  adapter accepting `file` blocks; verify once with a document conversation.

## License

MIT, inherited from upstream.
