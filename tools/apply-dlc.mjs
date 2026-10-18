#!/usr/bin/env node
/**
 * Re-apply the image/file overlay onto a market-installed `deepseek-web-import`.
 *
 * The plugin market owns the base package: it installs it from an archive URL
 * and updates it in place. A market update restores the pristine upstream
 * files, which removes this overlay — run this script again afterwards.
 *
 * The overlay is staged so it can grow without invalidating old installs:
 *   1. image import (lib/images.js + messageBlocks/buildSessionEvents/index/client)
 *   2. document import (lib/files.js + the same call sites)
 * Each stage is detected by its own marker and skipped when already present.
 *
 * Every edit is anchor-checked: it must match exactly once, so an upstream
 * change fails the script instead of silently producing a half-patched package.
 *
 * Usage:
 *   node tools/apply-dlc.mjs [package-directory]
 *
 * Default target: ~/.dsh/profiles/desktop/node_modules/deepseek-web-import
 * (override with DSH_PLUGIN_DIR, or pass a path).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = process.argv[2]
  || process.env.DSH_PLUGIN_DIR
  || path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'deepseek-web-import')

/** Write through a fresh inode so a pnpm hard link into the store is not edited. */
function writeSafely(file, content) {
  const temporary = file + '.dlc-tmp'
  fs.writeFileSync(temporary, content, 'utf8')
  fs.renameSync(temporary, file)
}

/** Replace one anchor that must occur exactly once. */
function replaceOnce(file, from, to) {
  const text = fs.readFileSync(file, 'utf8')
  const parts = text.split(from)
  if (parts.length !== 2) {
    throw new Error(
      path.basename(file) + ': expected 1 match for an anchor, found ' + (parts.length - 1) + '\n'
      + '--- anchor ---\n' + from.slice(0, 240) + '\n--------------',
    )
  }
  writeSafely(file, parts[0] + to + parts[1])
}

const lib = path.join(target, 'lib')
if (!fs.existsSync(path.join(target, 'package.json'))) {
  console.error('target is not an installed deepseek-web-import package: ' + target)
  process.exit(1)
}

const manifest = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'))
if (manifest.name !== 'deepseek-web-import') {
  console.error('unexpected package: ' + manifest.name)
  process.exit(1)
}
console.log('target: ' + target)
console.log('base version: ' + manifest.version)

const eventsPath = path.join(lib, 'events.js')
const indexPath = path.join(lib, 'index.js')
const clientPath = path.join(lib, 'client.js')

function read(file) { return fs.readFileSync(file, 'utf8') }

/* ---------------------------------------------------------------- stage 1 */
if (!read(eventsPath).includes('imagesByMessage')) {
  writeSafely(path.join(lib, 'images.js'), read(path.join(repoRoot, 'lib', 'images.js')))

  replaceOnce(eventsPath,
`export function messageBlocks(message, role) {
  if (role === 'user') {
    const text = fragmentText(message, USER_TEXT_FRAGMENTS) || legacyText(message.content)
    /* An attachment-only prompt has no text; an empty user turn would reach the
       model as an empty message, so it keeps an explicit note instead. */
    return [{ type: 'text', text: text.trim().length > 0 ? text : EMPTY_PROMPT_NOTE }]
  }`,
`export function messageBlocks(message, role, images = []) {
  if (role === 'user') {
    const text = fragmentText(message, USER_TEXT_FRAGMENTS) || legacyText(message.content)
    const blocks = []
    if (text.trim().length > 0) blocks.push({ type: 'text', text })
    /* Pictures follow the prompt they were attached to, in upload order. */
    for (const ref of images) blocks.push({ type: 'image', attachment: ref })
    /* An attachment-only prompt has no text; an empty user turn would reach the
       model as an empty message, so it keeps an explicit note instead. A prompt
       that carried a picture is not empty, so the note is skipped there. */
    if (blocks.length === 0) blocks.push({ type: 'text', text: EMPTY_PROMPT_NOTE })
    return blocks
  }`)

  replaceOnce(eventsPath,
    `export function buildSessionEvents(messages, title, profile) {`,
    `export function buildSessionEvents(messages, title, profile, imagesByMessage) {`)

  replaceOnce(eventsPath,
    `  list.forEach((source) => {`,
    `  list.forEach((source, index) => {`)

  replaceOnce(eventsPath,
`    if (!IMPORTABLE_ROLES.includes(role)) return
    const blocks = messageBlocks(message, role)`,
`    if (!IMPORTABLE_ROLES.includes(role)) return
    const images = imagesByMessage && typeof imagesByMessage.get === 'function'
      ? (imagesByMessage.get(index) || [])
      : []
    const blocks = messageBlocks(message, role, images)`)

  replaceOnce(indexPath,
`import { buildSessionEvents, importableMessages } from './events.js'
import { writeVerifiedSession } from './persistence.js'`,
`import { buildSessionEvents, importableMessages } from './events.js'
import { importImages } from './images.js'
import { writeVerifiedSession } from './persistence.js'`)

  replaceOnce(indexPath,
`    const usable = importableMessages(hist.messages)
    if (usable.length === 0) {
      return { ok: false, error: 'empty_history', msg: '该 DeepSeek 对话没有可导入的消息' }
    }

    const sid = newSessionId()`,
`    const usable = importableMessages(hist.messages)
    if (usable.length === 0) {
      return { ok: false, error: 'empty_history', msg: '该 DeepSeek 对话没有可导入的消息' }
    }

    /* Pictures are downloaded and stored before the event that references them.
       A failure here never blocks the text import: the summary reports how many
       images were found versus saved. */
    const policy = ctx.get('sandboxPolicy')
    const images = await (async () => {
      try {
        return await importImages({
          messages: usable,
          attachments: ctx.get('attachments'),
          subprocess: ctx.get('subprocess'),
          cwd: (policy && policy.workspaceRoot) ? policy.workspaceRoot : '.',
          log,
          request: (spec) => nodeHttp({ ...spec, headers: defaultHeaders(token) }),
        })
      } catch (e) {
        log('image import failed: ' + redact(String((e && e.message) || e), token, 300))
        return { byIndex: new Map(), found: 0, imported: 0 }
      }
    })()

    const sid = newSessionId()`)

  replaceOnce(indexPath,
    `        (profile) => buildSessionEvents(usable, title, profile),`,
    `        (profile) => buildSessionEvents(usable, title, profile, images.byIndex),`)

  replaceOnce(indexPath,
`      title: String(title || ''),
    }`,
`      title: String(title || ''),
      /* Images the conversation carried, and how many were stored. */
      imageFiles: images.found,
      imageCount: images.imported,
      ...images.unavailable ? { imagesUnavailable: images.unavailable } : {},
    }`)

  replaceOnce(clientPath,
`      importedDetail: ['（格式 v{version}，{count} 个事件）', ' (format v{version}, {count} events)'],`,
`      importedDetail: ['（格式 v{version}，{count} 个事件）', ' (format v{version}, {count} events)'],
      importedImages: ['，含图片 {count} 张', ', {count} images'],
      importedImagesMissing: ['，图片 0/{count} 张（详见 DSH 日志）', ', 0/{count} images (see the DSH log)'],`)

  replaceOnce(clientPath,
`        if (res.sessionFormatVersion !== undefined) {
          text += t('importedDetail', { version: res.sessionFormatVersion, count: res.eventCount });
        }`,
`        if (res.sessionFormatVersion !== undefined) {
          text += t('importedDetail', { version: res.sessionFormatVersion, count: res.eventCount });
        }
        if (res.imageCount > 0) text += t('importedImages', { count: res.imageCount });
        else if (res.imageFiles > 0) text += t('importedImagesMissing', { count: res.imageFiles });`)

  console.log('stage 1 applied: image import')
}

/* ---------------------------------------------------------------- stage 2 */
if (!read(eventsPath).includes('filesByMessage')) {
  writeSafely(path.join(lib, 'files.js'), read(path.join(repoRoot, 'lib', 'files.js')))

  replaceOnce(eventsPath,
    `export function messageBlocks(message, role, images = []) {`,
    `export function messageBlocks(message, role, images = [], files = []) {`)

  replaceOnce(eventsPath,
`    for (const ref of images) blocks.push({ type: 'image', attachment: ref })`,
`    for (const ref of images) blocks.push({ type: 'image', attachment: ref })
    /* Documents keep their original bytes and name; the model context still
       carries only the text DeepSeek stored for the turn. */
    for (const ref of files) blocks.push({ type: 'file', attachment: ref })`)

  replaceOnce(eventsPath,
    `export function buildSessionEvents(messages, title, profile, imagesByMessage) {`,
    `export function buildSessionEvents(messages, title, profile, imagesByMessage, filesByMessage) {`)

  replaceOnce(eventsPath,
`    const images = imagesByMessage && typeof imagesByMessage.get === 'function'
      ? (imagesByMessage.get(index) || [])
      : []
    const blocks = messageBlocks(message, role, images)`,
`    const images = imagesByMessage && typeof imagesByMessage.get === 'function'
      ? (imagesByMessage.get(index) || [])
      : []
    const files = filesByMessage && typeof filesByMessage.get === 'function'
      ? (filesByMessage.get(index) || [])
      : []
    const blocks = messageBlocks(message, role, images, files)`)

  replaceOnce(indexPath,
`import { buildSessionEvents, importableMessages } from './events.js'
import { importImages } from './images.js'`,
`import { buildSessionEvents, importableMessages } from './events.js'
import { importFiles } from './files.js'
import { importImages } from './images.js'`)

  replaceOnce(indexPath,
`    const sid = newSessionId()
    let written`,
`    /* Documents stream to a temporary file and then into the attachment store, so
       a file at the web limit does not have to fit in the heap. Same rules: a
       failed file is skipped, the text import continues. */
    const files = await (async () => {
      try {
        return await importFiles({
          messages: usable,
          attachments: ctx.get('attachments'),
          subprocess: ctx.get('subprocess'),
          cwd: (policy && policy.workspaceRoot) ? policy.workspaceRoot : '.',
          log,
          request: (spec) => nodeHttp({ ...spec, headers: defaultHeaders(token) }),
        })
      } catch (e) {
        log('file import failed: ' + redact(String((e && e.message) || e), token, 300))
        return { byIndex: new Map(), found: 0, imported: 0 }
      }
    })()

    const sid = newSessionId()
    let written`)

  replaceOnce(indexPath,
    `(profile) => buildSessionEvents(usable, title, profile, images.byIndex),`,
    `(profile) => buildSessionEvents(usable, title, profile, images.byIndex, files.byIndex),`)

  replaceOnce(indexPath,
`      ...images.unavailable ? { imagesUnavailable: images.unavailable } : {},
    }`,
`      ...images.unavailable ? { imagesUnavailable: images.unavailable } : {},
      fileFiles: files.found,
      fileCount: files.imported,
      ...files.unavailable ? { filesUnavailable: files.unavailable } : {},
    }`)

  replaceOnce(clientPath,
`      importedImagesMissing: ['，图片 0/{count} 张（详见 DSH 日志）', ', 0/{count} images (see the DSH log)'],`,
`      importedImagesMissing: ['，图片 0/{count} 张（详见 DSH 日志）', ', 0/{count} images (see the DSH log)'],
      importedFiles: ['，含附件 {count} 个', ', {count} files'],
      importedFilesMissing: ['，附件 0/{count} 个（详见 DSH 日志）', ', 0/{count} files (see the DSH log)'],`)

  replaceOnce(clientPath,
`        if (res.imageCount > 0) text += t('importedImages', { count: res.imageCount });
        else if (res.imageFiles > 0) text += t('importedImagesMissing', { count: res.imageFiles });`,
`        if (res.imageCount > 0) text += t('importedImages', { count: res.imageCount });
        else if (res.imageFiles > 0) text += t('importedImagesMissing', { count: res.imageFiles });
        if (res.fileCount > 0) text += t('importedFiles', { count: res.fileCount });
        else if (res.fileFiles > 0) text += t('importedFilesMissing', { count: res.fileFiles });`)

  console.log('stage 2 applied: document attachments (streamed, no size cap below the web limit)')
}

/* ---------------------------------------------------------------- stage 3 */
if (!read(eventsPath).includes('cleanDeepSeekMarkdown')) {
  writeSafely(path.join(lib, 'text.js'), read(path.join(repoRoot, 'lib', 'text.js')))

  replaceOnce(eventsPath,
    `import { assistantMessageData, SURFACE_APPEND } from './formats.js'`,
    `import { assistantMessageData, SURFACE_APPEND } from './formats.js'
import { cleanDeepSeekMarkdown } from './text.js'`)

  replaceOnce(eventsPath,
    `    const text = fragmentText(message, USER_TEXT_FRAGMENTS) || legacyText(message.content)`,
    `    const text = cleanDeepSeekMarkdown(fragmentText(message, USER_TEXT_FRAGMENTS) || legacyText(message.content))`)

  replaceOnce(eventsPath,
`  const reasoning = fragmentText(message, ASSISTANT_THINKING_FRAGMENTS)
  const answer = fragmentText(message, ASSISTANT_ANSWER_FRAGMENTS) || legacyText(message.content)`,
`  const reasoning = cleanDeepSeekMarkdown(fragmentText(message, ASSISTANT_THINKING_FRAGMENTS))
  const answer = cleanDeepSeekMarkdown(fragmentText(message, ASSISTANT_ANSWER_FRAGMENTS) || legacyText(message.content))`)

  console.log('stage 3 applied: markdown cleanup (citation markers, stray <br>)')
}

/* ---------------------------------------------------------------- stage 4 */
if (!read(clientPath).includes('autoRefresh')) {
  replaceOnce(clientPath,
    `      '.dswi select{padding:6px;border-radius:6px;border:1px solid #ccc;max-width:200px}',`,
    `      '.dswi select{padding:6px;border-radius:6px;border:1px solid #ccc;max-width:200px}',
      '.dswi-check{display:inline-flex;align-items:center;gap:6px;margin-left:10px;font-size:12px;color:var(--color-text-secondary,#666);cursor:pointer}',`)

  replaceOnce(clientPath,
    `      importedFilesMissing: ['，附件 0/{count} 个（详见 DSH 日志）', ', 0/{count} files (see the DSH log)'],`,
    `      importedFilesMissing: ['，附件 0/{count} 个（详见 DSH 日志）', ', 0/{count} files (see the DSH log)'],
      autoRefresh: ['导入后自动刷新页面（侧边栏立即出现）', 'Refresh the page after import (the new session appears immediately)'],`)

  replaceOnce(clientPath,
`      const [probeOut, setProbeOut] = React.useState('');`,
`      const [probeOut, setProbeOut] = React.useState('');
      /* The sidebar is fed by a live stream; a session written and attached by
         the import route is not guaranteed to arrive on it before the next
         refresh. Reload once by default so the new session shows up, and let the
         operator turn that off when importing several conversations in a row. */
      const [autoRefresh, setAutoRefresh] = React.useState(function () {
        try { return window.localStorage.getItem('dswi.autoRefresh') !== '0'; } catch (e) { return true; }
      });
      function toggleAutoRefresh(next) {
        setAutoRefresh(next);
        try { window.localStorage.setItem('dswi.autoRefresh', next ? '1' : '0'); } catch (e) { /* private mode */ }
      }`)

  replaceOnce(clientPath,
`        const r = await call('importToSession', { sessionId: s.id, title: s.title, workspaceId: wid });
        setResults(function (p) { const n = {}; for (const k in p) n[k] = p[k]; n[s.id] = r; return n; });`,
`        const r = await call('importToSession', { sessionId: s.id, title: s.title, workspaceId: wid });
        setResults(function (p) { const n = {}; for (const k in p) n[k] = p[k]; n[s.id] = r; return n; });
        /* Give the result line a beat to render, then reload so the sidebar
           stream re-subscribes and shows the imported session. */
        if (r && r.ok === true && autoRefresh && r.attached !== false) {
          window.setTimeout(function () { window.location.reload(); }, 1200);
        }`)

  replaceOnce(clientPath,
`          React.createElement('button', { onClick: list, disabled: loading }, loading ? t('loadingList') : t('loadList')),
          error ? React.createElement('p', { className: 'dswi-err' }, error) : null,`,
`          React.createElement('button', { onClick: list, disabled: loading }, loading ? t('loadingList') : t('loadList')),
          React.createElement('label', { className: 'dswi-check' },
            React.createElement('input', {
              type: 'checkbox',
              checked: autoRefresh,
              onChange: function (e) { toggleAutoRefresh(e.target.checked); },
            }),
            t('autoRefresh')
          ),
          error ? React.createElement('p', { className: 'dswi-err' }, error) : null,`)

  console.log('stage 4 applied: optional refresh-after-import')
}

/* ---------------------------------------------------------------- stage 5 */
if (!read(clientPath).includes('warmProjections')) {
  replaceOnce(clientPath,
    `      const t = props.t;`,
    `      const t = props.t;
      const ctx = props.ctx;`)

  replaceOnce(clientPath,
    `      '.dswi-check{display:inline-flex;align-items:center;gap:6px;margin-left:10px;font-size:12px;color:var(--color-text-secondary,#666);cursor:pointer}',`,
    `      '.dswi-check{display:inline-flex;align-items:center;gap:6px;margin-left:10px;font-size:12px;color:var(--color-text-secondary,#666);cursor:pointer}',
      '.dswi-refresh{margin-left:10px;border-color:#1e8e3e;color:#1e8e3e;font-weight:600}',`)

  replaceOnce(clientPath,
    `      autoRefresh: ['导入后自动刷新页面（侧边栏立即出现）', 'Refresh the page after import (the new session appears immediately)'],`,
    `      autoRefresh: ['导入后自动刷新页面（侧边栏立即出现）', 'Refresh the page after import (the new session appears immediately)'],
      batchMode: ['批量导入（最后统一刷新）', 'Batch import (refresh once at the end)'],
      refreshNow: ['完成导入并刷新（{count} 条）', 'Finish and refresh ({count} imported)'],`)

  replaceOnce(clientPath,
`      function toggleAutoRefresh(next) {
        setAutoRefresh(next);
        try { window.localStorage.setItem('dswi.autoRefresh', next ? '1' : '0'); } catch (e) { /* private mode */ }
      }`,
`      /* Batch mode: import several conversations, then refresh once at the end. */
      const [batchMode, setBatchMode] = React.useState(function () {
        try { return window.localStorage.getItem('dswi.batchMode') === '1'; } catch (e) { return false; }
      });
      const [pendingRefresh, setPendingRefresh] = React.useState(0);
      function toggleAutoRefresh(next) {
        setAutoRefresh(next);
        try { window.localStorage.setItem('dswi.autoRefresh', next ? '1' : '0'); } catch (e) { /* private mode */ }
      }
      function toggleBatchMode(next) {
        setBatchMode(next);
        try { window.localStorage.setItem('dswi.batchMode', next ? '1' : '0'); } catch (e) { /* private mode */ }
      }

      /* A freshly imported session has a log but no projection-cache entry, so
         the sidebar shows the untitled placeholder until the session is opened
         once. Ask the sessions service to compute (and cache) its projections
         right away, so a reload shows the stored title. Best effort: an older
         host without this method still imports normally. */
      async function warmProjections(sessionId) {
        try {
          const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
          if (sessions && typeof sessions.refreshProjections === 'function') {
            await sessions.refreshProjections(sessionId);
          }
        } catch (e) { /* projection warm-up must never fail an import */ }
      }`)

  replaceOnce(clientPath,
`        /* Give the result line a beat to render, then reload so the sidebar
           stream re-subscribes and shows the imported session. */
        if (r && r.ok === true && autoRefresh && r.attached !== false) {
          window.setTimeout(function () { window.location.reload(); }, 1200);
        }`,
`        if (r && r.ok === true) {
          /* Warm the projection cache first: it is what carries the stored
             title into the sidebar, so the reload below shows the real name. */
          await warmProjections(r.sessionId);
          if (r.attached !== false) {
            if (batchMode) setPendingRefresh(function (n) { return n + 1; });
            else if (autoRefresh) window.setTimeout(function () { window.location.reload(); }, 1200);
          }
        }`)

  replaceOnce(clientPath,
`            t('autoRefresh')
          ),
          error ? React.createElement('p', { className: 'dswi-err' }, error) : null,`,
`            t('autoRefresh')
          ),
          React.createElement('label', { className: 'dswi-check' },
            React.createElement('input', {
              type: 'checkbox',
              checked: batchMode,
              onChange: function (e) { toggleBatchMode(e.target.checked); },
            }),
            t('batchMode')
          ),
          pendingRefresh > 0
            ? React.createElement('button', {
              className: 'dswi-refresh',
              onClick: function () { window.location.reload(); },
            }, t('refreshNow', { count: pendingRefresh }))
            : null,
          error ? React.createElement('p', { className: 'dswi-err' }, error) : null,`)

  replaceOnce(clientPath,
    `}, (props) => React.createElement(App, Object.assign({}, props, { t: translate }))));`,
    `}, (props) => React.createElement(App, Object.assign({}, props, { t: translate, ctx: ctx }))));`)

  console.log('stage 5 applied: batch refresh + projection warm-up for titles')
}

/* ---------------------------------------------------------------- stage 6 */
if (!read(indexPath).includes('warmSessionProjections')) {
  replaceOnce(indexPath,
    `  async function importToSessionInternal(deepseekSessionId, title, workspaceId, token) {`,
    `  /**
   * Warm the projection cache for one just-written session.
   *
   * The sidebar's session list is a zero-I/O read of \`session_projcache\`, which
   * is why an imported session shows the untitled placeholder until something
   * reads it once. \`coldSnapshot\` is the documented cold-read entry point: it
   * folds the stored log and writes the cache row back, so the listing already
   * has the stored title on the next render. Fail-soft by design — a cache miss
   * only costs the placeholder, never the import.
   * @param {object} persistence - the \`sessionPersistence\` service.
   * @param {string} sessionId - the session just written.
   */
  async function warmSessionProjections(persistence, sessionId) {
    const cache = ctx.get('sessionProjectionCache')
    if (!cache || typeof cache.coldSnapshot !== 'function') return 'no_cache'
    let handle = null
    try {
      handle = await persistence.open(sessionId, 'read')
      const result = await handle.read()
      if (!result || !Array.isArray(result.events) || result.events.length === 0) return 'no_events'
      cache.coldSnapshot(handle.header, handle.inheritedEventCount, result.events)
      /* A cold snapshot is a best-effort fold; the durable checkpoint entry point
         is \`write(session)\`, which needs a Session object. Prepare one from the
         stored log without entering the live store, then checkpoint it. */
      const store = ctx.get('sessions')
      if (store && typeof store.prepare === 'function' && typeof cache.write === 'function') {
        const session = store.prepare(sessionId, {
          seed: result.events,
          meta: handle.header,
          inheritedEventCount: handle.inheritedEventCount,
          eventState: 'detached',
        })
        await cache.write(session)
        return 'written'
      }
      return 'ok'
    } catch (e) {
      log('projection warm-up failed for ' + sessionId + ': ' + redact(String((e && e.message) || e), null, 200))
      return 'error'
    } finally {
      if (handle !== null) {
        try { await handle.close() } catch { /* the read already happened */ }
      }
    }
  }

  async function importToSessionInternal(deepseekSessionId, title, workspaceId, token) {`)

  replaceOnce(indexPath,
`    return { ...summary, attached: true }
  }`,
`    /* Before the listing can read it: fold the new log into the projection cache,
       which is what carries the stored title into the sidebar. */
    const titleCached = await warmSessionProjections(persistence, sid)

    return { ...summary, attached: true, titleCached }
  }`)

  console.log('stage 6 applied: host-side projection warm-up (titles without opening)')
}

console.log('overlay is up to date')
console.log('restart DSH (or toggle the plugin) to load the patched host half.')
