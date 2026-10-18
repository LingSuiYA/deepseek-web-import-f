#!/usr/bin/env node
/**
 * Re-apply the image-import DLC onto a market-installed `deepseek-web-import`.
 *
 * The plugin market owns the base package: it installs it from an archive URL
 * and updates it in place. A market update restores the pristine upstream
 * files, which removes this overlay — run this script again afterwards.
 *
 * The overlay is deliberately small and anchor-checked: every edit must match
 * exactly once, so an upstream change fails the script instead of silently
 * producing a half-patched package.
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

/* Already carrying the overlay? Then this is a no-op, not an error. */
if (fs.readFileSync(eventsPath, 'utf8').includes('imagesByMessage')) {
  console.log('overlay already applied — nothing to do')
  process.exit(0)
}

/* 1) lib/images.js is a pure addition. */
writeSafely(path.join(lib, 'images.js'), fs.readFileSync(path.join(repoRoot, 'lib', 'images.js'), 'utf8'))

/* 2) events.js: messageBlocks gains saved image references. */
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

/* 3) index.js: run the image pass before the session is written. */
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

/* 4) client.js: report the image count in the localized result line. */
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

console.log('overlay applied: lib/images.js + events.js + index.js + client.js')
console.log('restart DSH (or reload the plugin) to load the patched host half.')
