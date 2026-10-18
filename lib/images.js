/**
 * Image attachments for an imported conversation.
 *
 * chat.deepseek.com does not put a picture in the message text: an upload is a
 * `FILE` fragment on the human turn whose `files[]` entries carry the id and,
 * once parsed, the pixel size. The bytes are not in `history_messages`; they
 * come from a signed path that `GET /api/v0/file/fetch_files?file_ids=…`
 * refreshes, and that path is served by a separate CDN origin:
 *
 *   https://files.deepseeksvc.com/api<path>?ty=p[&fmt=jpeg]
 *
 * `ty` is mandatory (omitting it is a 400), `ty=p` is the preview rendition and
 * `fmt=jpeg` asks the server to transcode; without `fmt` the server may answer
 * WebP. Both are decoded by the host's attachment service, so the bytes are
 * sniffed rather than trusted from the extension or the response header.
 *
 * This module owns only that translation: it never touches the session log. The
 * caller saves the returned bytes through the `attachments` service and passes
 * the resulting references to `events.js`, which writes them as `image` blocks.
 *
 * A failed picture is skipped, never fatal: the text of the conversation is
 * still imported, and the summary reports how many images were found versus
 * saved.
 *
 * @module deepseek-web-import/images
 */

/** Media types the DSH attachment service accepts from this importer. */
export const IMAGE_MEDIA_BY_EXTENSION = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
})

/** Largest single image downloaded; the attachment service has its own limit. */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024

/** Collected stdout bound: base64 expands by 4/3 plus the JSON wrapper. */
const STDOUT_LIMIT_BYTES = 20 * 1024 * 1024

/** Collected stderr bound: diagnostics only. */
const STDERR_LIMIT_BYTES = 256 * 1024

/** Per-image request timeout. */
const DOWNLOAD_TIMEOUT_MS = 60000

/** Grace period the spawn seam adds around that timeout. */
const SPAWN_GRACE_MS = 70000

/** The CDN origin that serves signed DeepSeek file paths. */
const FILES_ORIGIN = 'https://files.deepseeksvc.com/api'

/**
 * The child program: read one JSON spec from stdin, download one URL, print one
 * JSON line with the bytes as base64. Same conventions as `transport.js` — the
 * spec (which carries the token-derived headers) travels on stdin, never argv,
 * and TLS verification is retried unverified only after a certificate failure so
 * the compromise is reported instead of hidden.
 */
export const DOWNLOAD_SCRIPT = [
  "const chunks = [];",
  "process.stdin.on('data', (c) => chunks.push(c));",
  "process.stdin.on('end', () => {",
  "  let spec = {};",
  "  try { spec = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { console.log(JSON.stringify({ error: 'invalid spec' })); return; }",
  "  const https = require('https');",
  "  const http = require('http');",
  "  let parsed;",
  "  try { parsed = new URL(spec.url); } catch { console.log(JSON.stringify({ error: 'invalid url' })); return; }",
  "  const lib = parsed.protocol === 'http:' ? http : https;",
  "  const MAX = Number(spec.maxBytes || __MAX_IMAGE_BYTES__);",
  "  const certCodes = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_UNTRUSTED', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID']);",
  "  const isCertError = (e) => (e !== undefined && e !== null && certCodes.has(e.code)) || /certificate|self[- ]signed|unable to verify/i.test(String((e && e.message) || e));",
  "  const print = (value) => { console.log(JSON.stringify(value)); };",
  "  const attempt = (insecure) => {",
  "    const opts = { method: 'GET', headers: Object.assign({ 'Accept': 'image/*,*/*;q=0.8', 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'identity' }, spec.headers || {}) };",
  "    if (lib === https) opts.rejectUnauthorized = !insecure;",
  "    const req = lib.request(parsed, opts, (res) => {",
  "      const out = [];",
  "      let total = 0;",
  "      let over = false;",
  "      res.on('data', (c) => {",
  "        if (over) return;",
  "        total += c.length;",
  "        if (total > MAX) {",
  "          over = true;",
  "          out.length = 0;",
  "          res.destroy();",
  "          print({ status: res.statusCode, error: 'too_large', bytes: total, insecureTls: insecure });",
  "          return;",
  "        }",
  "        out.push(c);",
  "      });",
  "      res.on('end', () => {",
  "        if (over) return;",
  "        const buf = Buffer.concat(out);",
  "        print({ status: res.statusCode, contentType: String(res.headers['content-type'] || ''), bytes: buf.length, base64: buf.toString('base64'), insecureTls: insecure });",
  "      });",
  "    });",
  "    req.on('error', (e) => {",
  "      if (!insecure && lib === https && isCertError(e)) {",
  "        attempt(true);",
  "        return;",
  "      }",
  "      print({ error: String((e && e.message) || e), insecureTls: insecure });",
  "    });",
  "    req.setTimeout(Number(spec.timeoutMs || __TIMEOUT_MS__), () => { req.destroy(new Error('timeout')); });",
  "    req.end();",
  "  };",
  "  attempt(false);",
  "});",
].join('\n')
  .replaceAll('__MAX_IMAGE_BYTES__', String(MAX_IMAGE_BYTES))
  .replaceAll('__TIMEOUT_MS__', String(DOWNLOAD_TIMEOUT_MS))

/** @param {string} name @returns {string} lower-case extension without the dot. */
export function extensionOf(name) {
  const text = String(name === undefined || name === null ? '' : name)
  const dot = text.lastIndexOf('.')
  return dot >= 0 ? text.slice(dot + 1).toLowerCase() : ''
}

/**
 * Detect a raster type from magic bytes. The CDN transcodes, so neither the
 * file name nor the response header is authoritative.
 * @param {Uint8Array|Buffer|null} bytes - downloaded bytes.
 * @returns {string|null} DSH media type, or null when the bytes are not one.
 */
export function sniffImageMediaType(bytes) {
  if (!bytes || bytes.length < 12) return null
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return null
}

/**
 * The server file id of one `files[]` entry, in either casing.
 * @param {object} file - one fragment file entry.
 * @returns {string} the id, or an empty string.
 */
export function fileIdOf(file) {
  if (!file || typeof file !== 'object') return ''
  const raw = file.id !== undefined ? file.id
    : (file.file_id !== undefined ? file.file_id
      : (file.fileId !== undefined ? file.fileId : file.server_id))
  if (raw === undefined || raw === null) return ''
  const text = String(raw)
  return text === '' || text === '0' ? '' : text
}

/** @param {object} file @returns {string} the display name, possibly empty. */
export function fileNameOf(file) {
  if (!file || typeof file !== 'object') return ''
  const raw = file.file_name !== undefined ? file.file_name
    : (file.fileName !== undefined ? file.fileName : file.name)
  return typeof raw === 'string' ? raw : ''
}

/** @param {object} file @returns {string} the signed CDN path, possibly empty. */
export function signedPathOf(file) {
  if (!file || typeof file !== 'object') return ''
  const raw = file.signed_path !== undefined ? file.signed_path : file.signedPath
  return typeof raw === 'string' ? raw : ''
}

/**
 * Whether one fragment entry denotes an image this importer can store.
 * @param {object} file - one fragment file entry.
 * @returns {boolean} true for a flagged image or a supported image extension.
 */
export function isImageFile(file) {
  if (!file || typeof file !== 'object') return false
  const flag = file.is_image !== undefined ? file.is_image : file.isImage
  if (flag === true) return true
  if (flag === false) return false
  return IMAGE_MEDIA_BY_EXTENSION[extensionOf(fileNameOf(file))] !== undefined
}

/**
 * Build the CDN URL for one signed path.
 * @param {string} path - `signed_path` from the API.
 * @param {string} [format] - `jpeg` to ask for a transcoded preview.
 * @returns {string} the absolute URL (`ty=p` is mandatory).
 */
export function imageSignedUrl(path, format) {
  const raw = String(path === undefined || path === null ? '' : path)
  let url = /^https?:\/\//i.test(raw) ? raw : FILES_ORIGIN + (raw.charAt(0) === '/' ? '' : '/') + raw
  url += (url.indexOf('?') >= 0 ? '&' : '?') + 'ty=p'
  if (format) url += '&fmt=' + format
  return url
}

/**
 * Group the image entries of every human turn by message index.
 * @param {object[]} messages - importable messages, oldest first.
 * @returns {Map<number, object[]>} index → file entries carrying an id.
 */
export function imageFilesByMessage(messages) {
  const grouped = new Map()
  const list = Array.isArray(messages) ? messages : []
  list.forEach((message, index) => {
    if (String((message && message.role) || '').toLowerCase() !== 'user') return
    const fragments = Array.isArray(message && message.fragments) ? message.fragments : []
    const files = []
    for (const fragment of fragments) {
      if (!fragment || String(fragment.type || '').toUpperCase() !== 'FILE') continue
      for (const entry of (Array.isArray(fragment.files) ? fragment.files : [])) {
        if (!isImageFile(entry) || fileIdOf(entry) === '') continue
        files.push(entry)
      }
    }
    /* Some responses carry files on the message instead of a FILE fragment. */
    if (files.length === 0 && Array.isArray(message && message.files)) {
      for (const entry of message.files) {
        if (isImageFile(entry) && fileIdOf(entry) !== '') files.push(entry)
      }
    }
    if (files.length > 0) grouped.set(index, files)
  })
  return grouped
}

/**
 * Perform one binary download through the subprocess seam.
 * @param {object} subprocess - the DSH `subprocess` service.
 * @param {object} spec - `{url, headers?, maxBytes?, timeoutMs?}`.
 * @param {{cwd?: string}} [options] - working directory for the child.
 * @returns {Promise<object>} `{status?, contentType?, bytes?, base64?, error?, insecureTls?}`.
 */
export async function runDownload(subprocess, spec, options = {}) {
  const handle = subprocess.spawn({
    argv: ['node', '-e', DOWNLOAD_SCRIPT],
    cwd: options.cwd === undefined ? '.' : options.cwd,
    stdio: {
      stdin: 'pipe',
      stdout: { maxBytes: STDOUT_LIMIT_BYTES },
      stderr: { maxBytes: STDERR_LIMIT_BYTES },
    },
    graceMs: SPAWN_GRACE_MS,
  })
  const stdin = handle.stdin
  if (stdin === undefined) return { error: 'subprocess 未提供 stdin，无法下载图片' }
  stdin.on('error', () => {})
  stdin.end(JSON.stringify(spec || {}))

  const outcome = await handle.done
  const out = handle.collected && handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
  const err = handle.collected && handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
  const trimmed = (out || '').trim()
  if (trimmed === '') {
    return { exitCode: outcome.exitCode, error: '子进程没有输出', stderr: String(err || '').slice(0, 500) }
  }
  try {
    return { exitCode: outcome.exitCode, ...JSON.parse(trimmed) }
  } catch {
    return { exitCode: outcome.exitCode, error: '子进程输出无法解析', stderr: String(err || '').slice(0, 500) }
  }
}

/**
 * Read the refreshed descriptors of uploaded files.
 * @param {(spec: object) => Promise<object>} request - JSON request runner with headers applied.
 * @param {string[]} ids - server file ids.
 * @returns {Promise<Map<string, object>>} id → descriptor (may be empty).
 */
export async function fetchFileDescriptors(request, ids) {
  const descriptors = new Map()
  if (!Array.isArray(ids) || ids.length === 0) return descriptors
  const result = await request({
    url: 'https://chat.deepseek.com/api/v0/file/fetch_files?file_ids=' + encodeURIComponent(ids.join(',')),
    method: 'GET',
  })
  if (!result || typeof result.body !== 'string' || result.transport === true) return descriptors
  let parsed
  try { parsed = JSON.parse(result.body) } catch { return descriptors }
  const data = parsed && parsed.data
  const biz = (data && (data.biz_data || data)) || {}
  const files = Array.isArray(biz.files) ? biz.files : []
  for (const file of files) {
    const id = fileIdOf(file)
    if (id !== '') descriptors.set(id, file)
  }
  return descriptors
}

/** Merge a refreshed descriptor over the fragment entry, ignoring empty values. */
function mergeDescriptor(entry, descriptor) {
  const merged = { ...entry }
  if (!descriptor) return merged
  for (const key of Object.keys(descriptor)) {
    const value = descriptor[key]
    if (value !== undefined && value !== null && value !== '') merged[key] = value
  }
  return merged
}

/**
 * Download and persist every image of one conversation.
 *
 * @param {object} options
 * @param {object[]} options.messages - importable messages, oldest first.
 * @param {object|undefined} options.attachments - the DSH `attachments` service.
 * @param {object|undefined} options.subprocess - the DSH `subprocess` service.
 * @param {(spec: object) => Promise<object>} options.request - JSON request runner.
 * @param {(message: string) => void} [options.log] - server-side diagnostics.
 * @param {string} [options.cwd] - working directory for download children.
 * @returns {Promise<{byIndex: Map<number, object[]>, found: number, imported: number, unavailable?: string}>}
 *   `byIndex` maps a message index to the saved `ImageAttachmentRef`s.
 */
export async function importImages(options) {
  const { messages, attachments, subprocess, request, log, cwd } = options || {}
  const empty = { byIndex: new Map(), found: 0, imported: 0 }
  if (!attachments) return { ...empty, unavailable: 'attachments_unavailable' }
  if (!subprocess) return { ...empty, unavailable: 'subprocess_unavailable' }

  const grouped = imageFilesByMessage(messages)
  if (grouped.size === 0) return empty

  const ids = []
  const seen = new Set()
  for (const files of grouped.values()) {
    for (const entry of files) {
      const id = fileIdOf(entry)
      if (!seen.has(id)) { seen.add(id); ids.push(id) }
    }
  }

  const descriptors = await fetchFileDescriptors(request, ids)
  const byIndex = new Map()
  let found = ids.length
  let imported = 0

  for (const [index, files] of grouped) {
    const inputs = []
    for (const entry of files) {
      const id = fileIdOf(entry)
      const merged = mergeDescriptor(entry, descriptors.get(id))
      const status = merged.status === undefined ? '' : String(merged.status)
      if (status !== '' && status !== 'SUCCESS') continue
      const path = signedPathOf(merged)
      if (path === '') continue
      const name = fileNameOf(merged) || ('deepseek-image-' + id)
      let download = null
      /* `ty=p` is mandatory; `fmt=jpeg` transcodes, and without it the server
         may answer WebP. Both are accepted; the bytes decide the type. */
      for (const format of ['jpeg', '']) {
        const attempt = await runDownload(subprocess, {
          url: imageSignedUrl(path, format),
          maxBytes: MAX_IMAGE_BYTES,
        }, { cwd })
        if (attempt && attempt.error === undefined && attempt.status === 200 && attempt.base64) {
          download = attempt
          break
        }
      }
      if (!download) continue
      if (download.insecureTls === true && typeof log === 'function') {
        log('image download continued without TLS verification')
      }
      const bytes = Buffer.from(download.base64, 'base64')
      const mediaType = sniffImageMediaType(bytes) || IMAGE_MEDIA_BY_EXTENSION[extensionOf(name)]
      if (!mediaType) continue
      inputs.push({ data: new Uint8Array(bytes), mediaType, name })
    }
    if (inputs.length === 0) continue
    try {
      byIndex.set(index, await attachments.saveImages(inputs))
      imported += inputs.length
    } catch {
      /* A batch can be refused for count or byte limits: keep what fits. */
      const saved = []
      for (const input of inputs) {
        try { saved.push(await attachments.saveImage(input)) } catch { /* skip this picture */ }
      }
      if (saved.length > 0) { byIndex.set(index, saved); imported += saved.length }
    }
  }

  return { byIndex, found, imported }
}
