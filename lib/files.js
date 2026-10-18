/**
 * Non-image attachments for an imported conversation.
 *
 * DeepSeek keeps every upload as a `FILE` fragment on the human turn; the
 * entries whose `is_image` is false are documents (PDF, Word, text, …). Their
 * bytes live behind the same signed CDN path as pictures, but the rendition is
 * different: documents are fetched with `ty=r` (the original), while pictures
 * use `ty=p` (a transcoded preview).
 *
 * Size is not capped by this importer. The web client itself allows **100 MB per
 * file by default** (`0x6400000` bytes) and up to 50 files, and a model may raise
 * that through its `file_feature.max_upload_file_size`; imposing a smaller limit
 * here would silently drop files the user could upload in the browser. The only
 * bound is a runaway guard well above any web limit.
 *
 * Because a file can be large, the child writes bytes straight to a temporary
 * file and prints metadata only — never base64 on stdout. The host then streams
 * that file into the attachment service, so a 100 MB document costs disk I/O
 * rather than several hundred MB of heap.
 *
 * @module deepseek-web-import/files
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { fetchFileDescriptors, fileIdOf, fileNameOf, isImageFile, signedPathOf } from './images.js'

/** Runaway guard, far above every web upload limit (default 100 MB). */
export const MAX_FILE_BYTES = 1024 * 1024 * 1024

/** Per-file request timeout: large files need more than the JSON path's minute. */
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000

/** Collected stdout bound: metadata only, never the payload. */
const STDOUT_LIMIT_BYTES = 256 * 1024

/** Collected stderr bound: diagnostics only. */
const STDERR_LIMIT_BYTES = 1024 * 1024

/** Grace period the spawn seam adds around the timeout. */
const SPAWN_GRACE_MS = DOWNLOAD_TIMEOUT_MS + 15000

/**
 * The child program: read one JSON spec from stdin, stream one URL into a local
 * file, print one JSON line with the byte count. Same conventions as the other
 * transport scripts — the spec travels on stdin, and TLS verification is retried
 * unverified only after a certificate failure so the compromise is reported.
 */
export const DOWNLOAD_TO_FILE_SCRIPT = [
  "const chunks = [];",
  "process.stdin.on('data', (c) => chunks.push(c));",
  "process.stdin.on('end', () => {",
  "  let spec = {};",
  "  try { spec = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { console.log(JSON.stringify({ error: 'invalid spec' })); return; }",
  "  const fs = require('fs');",
  "  const https = require('https');",
  "  const http = require('http');",
  "  let parsed;",
  "  try { parsed = new URL(spec.url); } catch { console.log(JSON.stringify({ error: 'invalid url' })); return; }",
  "  const lib = parsed.protocol === 'http:' ? http : https;",
  "  const certCodes = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_UNTRUSTED', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID']);",
  "  const isCertError = (e) => (e !== undefined && e !== null && certCodes.has(e.code)) || /certificate|self[- ]signed|unable to verify/i.test(String((e && e.message) || e));",
  "  let settled = false;",
  "  const print = (value) => { if (settled) return; settled = true; console.log(JSON.stringify(value)); };",
  "  const discard = () => { try { fs.unlinkSync(spec.path); } catch { /* already gone */ } };",
  "  const attempt = (insecure) => {",
  "    const opts = { method: 'GET', headers: Object.assign({ 'Accept': '*/*', 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'identity' }, spec.headers || {}) };",
  "    if (lib === https) opts.rejectUnauthorized = !insecure;",
  "    const req = lib.request(parsed, opts, (res) => {",
  "      if (res.statusCode !== 200) {",
  "        res.resume();",
  "        print({ status: res.statusCode, error: 'http_status', insecureTls: insecure });",
  "        return;",
  "      }",
  "      const out = fs.createWriteStream(spec.path);",
  "      let total = 0;",
  "      let broken = false;",
  "      res.on('data', (c) => {",
  "        if (broken) return;",
  "        total += c.length;",
  "        if (total > Number(spec.maxBytes || __MAX_FILE_BYTES__)) {",
  "          broken = true;",
  "          res.destroy();",
  "          out.destroy();",
  "          discard();",
  "          print({ status: res.statusCode, error: 'too_large', bytes: total, insecureTls: insecure });",
  "          return;",
  "        }",
  "        if (!out.write(c)) res.pause();",
  "      });",
  "      out.on('drain', () => res.resume());",
  "      out.on('error', (e) => {",
  "        broken = true;",
  "        res.destroy();",
  "        discard();",
  "        print({ error: String((e && e.message) || e), insecureTls: insecure });",
  "      });",
  "      res.on('error', (e) => {",
  "        broken = true;",
  "        out.destroy();",
  "        discard();",
  "        print({ error: String((e && e.message) || e), insecureTls: insecure });",
  "      });",
  "      res.on('end', () => {",
  "        if (broken) return;",
  "        out.end(() => print({ status: res.statusCode, bytes: total, path: spec.path, insecureTls: insecure }));",
  "      });",
  "    });",
  "    req.on('error', (e) => {",
  "      if (!insecure && lib === https && isCertError(e)) {",
  "        discard();",
  "        attempt(true);",
  "        return;",
  "      }",
  "      discard();",
  "      print({ error: String((e && e.message) || e), insecureTls: insecure });",
  "    });",
  "    req.setTimeout(Number(spec.timeoutMs || __TIMEOUT_MS__), () => { req.destroy(new Error('timeout')); });",
  "    req.end();",
  "  };",
  "  attempt(false);",
  "});",
].join('\n')
  .replaceAll('__MAX_FILE_BYTES__', String(MAX_FILE_BYTES))
  .replaceAll('__TIMEOUT_MS__', String(DOWNLOAD_TIMEOUT_MS))

/**
 * Build the CDN URL for one document: `ty=r` is the original rendition.
 * @param {string} signedPath - `signed_path` from the API.
 * @returns {string} the absolute URL.
 */
export function fileSignedUrl(signedPath) {
  const raw = String(signedPath === undefined || signedPath === null ? '' : signedPath)
  const base = 'https://files.deepseeksvc.com/api'
  const url = /^https?:\/\//i.test(raw) ? raw : base + (raw.charAt(0) === '/' ? '' : '/') + raw
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'ty=r'
}

/** Strip path separators and control characters from a server-supplied name. */
export function sanitizeFileName(name, fallback) {
  const text = String(name === undefined || name === null ? '' : name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  const capped = text.length > 180 ? text.slice(0, 180) : text
  return capped.length > 0 ? capped : fallback
}

/**
 * Group the document entries of every human turn by message index.
 * @param {object[]} messages - importable messages, oldest first.
 * @returns {Map<number, object[]>} index → non-image file entries carrying an id.
 */
export function fileEntriesByMessage(messages) {
  const grouped = new Map()
  const list = Array.isArray(messages) ? messages : []
  list.forEach((message, index) => {
    if (String((message && message.role) || '').toLowerCase() !== 'user') return
    const fragments = Array.isArray(message && message.fragments) ? message.fragments : []
    const files = []
    for (const fragment of fragments) {
      if (!fragment || String(fragment.type || '').toUpperCase() !== 'FILE') continue
      for (const entry of (Array.isArray(fragment.files) ? fragment.files : [])) {
        if (!entry || isImageFile(entry) || fileIdOf(entry) === '') continue
        files.push(entry)
      }
    }
    if (files.length === 0 && Array.isArray(message && message.files)) {
      for (const entry of message.files) {
        if (entry && !isImageFile(entry) && fileIdOf(entry) !== '') files.push(entry)
      }
    }
    if (files.length > 0) grouped.set(index, files)
  })
  return grouped
}

/**
 * Stream one document to a local temporary file.
 * @param {object} subprocess - the DSH `subprocess` service.
 * @param {{url: string, path: string, maxBytes?: number, timeoutMs?: number}} spec - request spec.
 * @param {{cwd?: string}} [options] - working directory for the child.
 * @returns {Promise<{status?: number, bytes?: number, path?: string, error?: string, insecureTls?: boolean}>} the download result.
 */
export async function runDownloadToFile(subprocess, spec, options = {}) {
  const handle = subprocess.spawn({
    argv: ['node', '-e', DOWNLOAD_TO_FILE_SCRIPT],
    cwd: options.cwd === undefined ? '.' : options.cwd,
    stdio: {
      stdin: 'pipe',
      stdout: { maxBytes: STDOUT_LIMIT_BYTES },
      stderr: { maxBytes: STDERR_LIMIT_BYTES },
    },
    graceMs: SPAWN_GRACE_MS,
  })
  const stdin = handle.stdin
  if (stdin === undefined) return { error: 'subprocess 未提供 stdin，无法下载附件' }
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

/** Create a scratch directory outside the user's workspace when possible. */
function makeScratchDirectory(cwd) {
  const candidates = [os.tmpdir(), cwd || '.', process.cwd()]
  for (const base of candidates) {
    try {
      return fs.mkdtempSync(path.join(base, 'dsh-web-import-'))
    } catch { /* try the next location */ }
  }
  throw new Error('无法创建临时目录')
}

/** Persist one downloaded file through whichever attachment API this build has. */
async function saveDownloadedFile(attachments, filePath, name) {
  if (typeof attachments.saveFileStream === 'function') {
    return attachments.saveFileStream({ data: fs.createReadStream(filePath), name })
  }
  const data = await fs.promises.readFile(filePath)
  return attachments.saveFile({ data, name })
}

/**
 * Download and persist every non-image attachment of one conversation.
 *
 * @param {object} options
 * @param {object[]} options.messages - importable messages, oldest first.
 * @param {object|undefined} options.attachments - the DSH `attachments` service.
 * @param {object|undefined} options.subprocess - the DSH `subprocess` service.
 * @param {(spec: object) => Promise<object>} options.request - JSON request runner.
 * @param {(message: string) => void} [options.log] - server-side diagnostics.
 * @param {string} [options.cwd] - working directory for download children.
 * @returns {Promise<{byIndex: Map<number, object[]>, found: number, imported: number, unavailable?: string}>}
 */
export async function importFiles(options) {
  const { messages, attachments, subprocess, request, log, cwd } = options || {}
  const empty = { byIndex: new Map(), found: 0, imported: 0 }
  if (!attachments) return { ...empty, unavailable: 'attachments_unavailable' }
  if (!subprocess) return { ...empty, unavailable: 'subprocess_unavailable' }

  const grouped = fileEntriesByMessage(messages)
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
  const found = ids.length
  let imported = 0
  let scratch = null

  try {
    for (const [index, files] of grouped) {
      const refs = []
      for (const entry of files) {
        const id = fileIdOf(entry)
        const descriptor = descriptors.get(id)
        const merged = { ...entry }
        if (descriptor) {
          for (const key of Object.keys(descriptor)) {
            const value = descriptor[key]
            if (value !== undefined && value !== null && value !== '') merged[key] = value
          }
        }
        const status = merged.status === undefined ? '' : String(merged.status)
        if (status !== '' && status !== 'SUCCESS') continue
        const signedPath = signedPathOf(merged)
        if (signedPath === '') continue
        const declared = Number(merged.file_size)
        if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) continue
        if (scratch === null) scratch = makeScratchDirectory(cwd)
        const localPath = path.join(scratch, 'file-' + index + '-' + refs.length)
        const download = await runDownloadToFile(subprocess, {
          url: fileSignedUrl(signedPath),
          path: localPath,
          maxBytes: MAX_FILE_BYTES,
          timeoutMs: DOWNLOAD_TIMEOUT_MS,
        }, { cwd })
        try {
          if (download === null || download.error !== undefined || download.status !== 200) {
            if (download && download.insecureTls === true) log?.('file download continued without TLS verification')
            continue
          }
          const name = sanitizeFileName(fileNameOf(merged), 'deepseek-file-' + id)
          refs.push(await saveDownloadedFile(attachments, localPath, name))
          imported += 1
        } finally {
          try { fs.unlinkSync(localPath) } catch { /* the child may have removed it */ }
        }
      }
      if (refs.length > 0) byIndex.set(index, refs)
    }
  } finally {
    if (scratch !== null) {
      try { fs.rmSync(scratch, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }

  return { byIndex, found, imported }
}
