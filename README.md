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
- The result line reports how many were kept (`N images`), or `0/N` when pictures
  were found but none could be stored.
- A picture that fails to download or decode is skipped; the text import still succeeds.

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
2. `GET https://files.deepseeksvc.com/api<path>?ty=p` through the same
   `subprocess` transport as every other request (`ty` is mandatory; `&fmt=jpeg`
   transcodes, omitting it may yield WebP; 12 MB cap per image);
3. sniff the raster type from magic bytes, commit through the DSH `attachments`
   service, and reference the result as `{ "type": "image", "attachment": … }`
   after the prompt text.

| Piece | Role |
|---|---|
| `lib/images.js` | discovery, download, sniffing (new file) |
| `lib/events.js` | `messageBlocks(message, role, images)` and `buildSessionEvents(…, imagesByMessage)` |
| `lib/index.js` | runs the image pass before writing, reports the counts |
| `lib/client.js` | localized image count in the result line |
| `test/images.test.mjs` | 9 cases: parsing, URL construction, event assembly, download/save pipeline |

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
- `lib/images.js` is additive; the three patched files are anchor-checked.
- Non-image attachments (PDF, Word) remain text-only, as upstream.

## License

MIT, inherited from upstream.
