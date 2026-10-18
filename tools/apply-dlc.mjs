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

console.log('overlay is up to date')
console.log('restart DSH (or toggle the plugin) to load the patched host half.')
