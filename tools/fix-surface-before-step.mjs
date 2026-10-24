#!/usr/bin/env node
/**
 * Repair legacy session logs whose first surface event precedes the first
 * `step/start`.
 *
 * Why this exists: the 0.1.x importer wrote `turn/start → user/message →
 * step/start …`. DSH's v2→v3 migration inserts the system head at the log's
 * first `step/start`, and refuses a log whose first surface event comes earlier
 * (`format v2 surface before first step cannot acquire a system head without
 * changing chronology`). A conversation imported by that old version therefore
 * becomes unreadable after upgrading to a v3+ DSH build (0.1.7+/0.2.x).
 *
 * The repair moves those leading surface events to just after the first
 * `step/start`, and renumbers only the seq-bearing events of that window; rows
 * that carry `seq0`/`time0` instead of `seq` (reasoning-chunk rows) are left
 * byte-for-byte as written.
 *
 * Usage (dry run by default — nothing is written):
 *
 *   node tools/fix-surface-before-step.mjs --root ~/.dsh/sessions
 *   node tools/fix-surface-before-step.mjs --root ~/.dsh/sessions --apply
 *   node tools/fix-surface-before-step.mjs --root ~/.dsh/sessions --apply --verify
 *
 * `--apply` backs the original artifacts up next to the sessions root before
 * writing. `--verify` additionally re-opens each repaired session through the
 * real `@deepseek-ai/dsh-session-persistence-jsonl` when that package resolves
 * from the current directory (run it from a directory that has DSH installed).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

/** zstd frame magic: every append batch is its own frame in a JSONL artifact. */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Event types that render into the conversation surface. */
const SURFACE = new Set(['user/message', 'assistant/message', 'tool/result'])

/** Artifact suffixes this tool understands, most specific first. */
const SUFFIXES = ['.jsonl.zstd', '.jsonl']

/**
 * Decode every zstd frame of one artifact and concatenate the text.
 *
 * A session artifact is a sequence of independently compressed append batches,
 * so the whole-file decompressor would stop after the first one. Splitting on
 * the frame magic is what the backend's own reader does.
 * @param {Buffer} buffer - the artifact bytes.
 * @returns {string} the concatenated JSONL text.
 */
export function decodeFrames(buffer) {
  const offsets = []
  let from = 0
  while (true) {
    const at = buffer.indexOf(MAGIC, from)
    if (at === -1) break
    offsets.push(at)
    from = at + 1
  }
  /* An artifact with no frame magic is either empty or not zstd at all. */
  if (offsets.length === 0) return zstdDecompressSync(buffer).toString('utf8')
  let text = ''
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
    /* A dropped frame is a corrupt batch; the backend drops it too, so the
       repair keeps the same view of the log. */
    try { text += zstdDecompressSync(buffer.subarray(start, end)).toString('utf8') } catch { /* skip */ }
  }
  return text
}

/**
 * Encode JSONL lines as one zstd frame per line, mirroring per-batch appends.
 * @param {string[]} lines - JSON text lines, header first.
 * @returns {Buffer} the artifact bytes.
 */
export function encodeFrames(lines) {
  return Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(line + '\n'))))
}

/**
 * Split decoded text into the header record and its events.
 * @param {string} text - decoded artifact text.
 * @returns {{header: object, events: object[]}} the parsed log.
 * @throws {Error} when the header line is not a JSON object.
 */
export function parseLog(text) {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  if (lines.length === 0) throw new Error('artifact is empty')
  const header = JSON.parse(lines[0])
  if (header === null || typeof header !== 'object' || Array.isArray(header)) {
    throw new Error('first line is not a session header object')
  }
  const events = []
  for (const line of lines.slice(1)) {
    try { events.push(JSON.parse(line)) } catch { /* a corrupt batch is dropped, as the backend does */ }
  }
  return { header, events }
}

/**
 * Indices of the surface events that sit before the log's first `step/start`.
 * @param {object[]} events - the log's events in file order.
 * @returns {number[]} the offending indices, ascending.
 */
export function leadingSurface(events) {
  const firstStep = events.findIndex((event) => event && event.type === 'step/start')
  if (firstStep === -1) return []
  const indices = []
  for (let index = 0; index < firstStep; index += 1) {
    if (SURFACE.has(events[index] && events[index].type)) indices.push(index)
  }
  return indices
}

/**
 * Reorder the log so no surface event precedes the first `step/start`.
 *
 * Only the events between the first offending surface event and the first
 * `step/start` change place, and only the seq VALUES of the seq-bearing events
 * in that window are permuted; every other record keeps its position and its
 * fields. Rows without `seq` (reasoning-chunk projections) are never touched.
 * @param {object[]} events - the log's events.
 * @returns {{events: object[], moved: string[], window: [number, number]}|null} the
 *   repaired log, or null when it needs no repair.
 */
export function planRepair(events) {
  const offending = leadingSurface(events)
  if (offending.length === 0) return null
  const firstOffending = offending[0]
  const moved = offending.map((index) => events[index])
  const kept = events.filter((_, index) => !offending.includes(index))
  const stepIndex = kept.findIndex((event) => event && event.type === 'step/start')
  const ordered = [
    ...kept.slice(0, stepIndex + 1),
    ...moved,
    ...kept.slice(stepIndex + 1),
  ]
  const windowEnd = stepIndex + moved.length
  /* The window's seq values, ascending, reassigned in the new order. */
  const seqValues = []
  for (let position = firstOffending; position <= windowEnd; position += 1) {
    if (events[position] && typeof events[position].seq === 'number') seqValues.push(events[position].seq)
  }
  seqValues.sort((left, right) => left - right)
  let cursor = 0
  const repaired = ordered.map((event, position) => {
    if (position >= firstOffending && position <= windowEnd && typeof event.seq === 'number') {
      return { ...event, seq: seqValues[cursor++] }
    }
    return event
  })
  const stillBad = leadingSurface(repaired)
  if (stillBad.length > 0) throw new Error('repair left a surface event before the first step/start')
  return { events: repaired, moved: moved.map((event) => event.type), window: [firstOffending, windowEnd] }
}

/**
 * Whether a repaired log keeps the fields the backend validates.
 * @param {object[]} events - a repaired log.
 * @returns {string|null} a problem description, or null when it looks sane.
 */
export function checkRepaired(events) {
  /* A row that already carries seq0 must never also carry seq: those rows are
     projections, and the backend's strict row validation rejects the extra key. */
  for (const [index, event] of events.entries()) {
    const hasSeq = event && typeof event.seq === 'number'
    const hasSeq0 = event && event.seq0 !== undefined
    if (hasSeq && hasSeq0) return `event ${index} carries both seq and seq0`
  }
  const seqBearing = events.filter((event) => event && typeof event.seq === 'number')
  for (let index = 1; index < seqBearing.length; index += 1) {
    if (seqBearing[index].seq !== seqBearing[index - 1].seq + 1) {
      return `seq is not contiguous at event ${index} (${seqBearing[index - 1].seq} -> ${seqBearing[index].seq})`
    }
  }
  return null
}

/**
 * Repair one artifact's text.
 * @param {string} text - decoded artifact text.
 * @returns {{changed: boolean, text: string, moved: string[]}} the outcome.
 */
export function repairText(text) {
  const { header, events } = parseLog(text)
  const plan = planRepair(events)
  if (plan === null) return { changed: false, text, moved: [] }
  const problem = checkRepaired(plan.events)
  if (problem !== null) throw new Error(problem)
  const lines = [JSON.stringify(header), ...plan.events.map((event) => JSON.stringify(event))]
  return { changed: true, text: lines.join('\n') + '\n', moved: plan.moved }
}

/** Whether one artifact name is a session log this tool can read. */
export function isArtifact(name) {
  return SUFFIXES.some((suffix) => name.endsWith(suffix))
}

/** Whether one artifact is zstd-compressed. */
export function isCompressed(name) {
  return name.endsWith('.jsonl.zstd')
}

/**
 * Read one artifact's decoded text.
 * @param {string} path - artifact path.
 * @returns {string} its JSONL text.
 */
export function readArtifact(path) {
  const buffer = readFileSync(path)
  return isCompressed(path) ? decodeFrames(buffer) : buffer.toString('utf8')
}

/**
 * Write one artifact, preserving its container (zstd frames or plain text).
 * @param {string} path - artifact path.
 * @param {string} text - the JSONL text.
 */
export function writeArtifact(path, text) {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  writeFileSync(path, isCompressed(path) ? encodeFrames(lines) : lines.join('\n') + '\n')
}

/**
 * Every session artifact under one sessions root.
 * @param {string} root - the `sessions` directory.
 * @returns {{path: string, session: string, project: string}[]} the artifacts.
 */
export function listArtifacts(root) {
  const found = []
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    for (const session of readdirSync(projectDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const sessionDir = join(projectDir, session.name)
      for (const entry of readdirSync(sessionDir, { withFileTypes: true })) {
        if (!entry.isFile() || !isArtifact(entry.name)) continue
        found.push({ path: join(sessionDir, entry.name), project: project.name, session: session.name })
      }
    }
  }
  return found
}

/** Default sessions root: `$DSH_HOME/sessions`, falling back to `~/.dsh/sessions`. */
export function defaultRoot() {
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
  return join(home, 'sessions')
}

/**
 * Re-open one repaired session through the real DSH backend, when it resolves.
 * Reads a throwaway copy so the user's logs are never touched by verification.
 * @param {string} artifact - the repaired artifact path.
 * @returns {Promise<{ok: boolean, detail: string}>} the verification outcome.
 */
export async function verifyWithBackend(artifact) {
  let Jsonl = null
  let Context = null
  let packages = null
  try {
    const require = createRequire(join(process.cwd(), 'package.json'))
    packages = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
    Jsonl = (await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href)).default
    Context = packages.Context
  } catch {
    return { ok: true, detail: 'skipped (DSH packages do not resolve from this directory)' }
  }
  const stage = join(tmpdir(), 'dswi-verify-' + process.pid + '-' + Date.now())
  mkdirSync(stage, { recursive: true })
  const project = 'verify-project'
  const session = 'verify-session'
  mkdirSync(join(stage, project, session), { recursive: true })
  copyFileSync(artifact, join(stage, project, session, basename(artifact)))
  const make = () => {
    const context = new Context()
    try {
      return new Jsonl(context, { root: stage })
    } catch {
      const retry = new Context()
      retry.provide('sessions', { list: () => [], get: () => undefined })
      return new Jsonl(retry, { root: stage })
    }
  }
  try {
    const handle = await make().open(session, 'read')
    const read = await handle.read()
    const version = handle.header && handle.header.version
    await handle.close()
    return { ok: true, detail: `opened as v${version}, ${read.events.length} events` }
  } catch (error) {
    return { ok: false, detail: String((error && error.message) || error) }
  }
}

/**
 * CLI: scan (and optionally repair) every session artifact under a root.
 * @param {string[]} argv - arguments after the script name.
 * @returns {Promise<number>} the process exit code.
 */
async function main(argv) {
  let root = defaultRoot()
  let apply = false
  let verify = false
  let backupRoot = null
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--root') { root = argv[++index]; continue }
    if (argument === '--apply') { apply = true; continue }
    if (argument === '--verify') { verify = true; continue }
    if (argument === '--backup') { backupRoot = argv[++index]; continue }
    if (argument === '--help' || argument === '-h') {
      process.stdout.write('usage: node tools/fix-surface-before-step.mjs [--root <dir>] [--apply] [--backup <dir>] [--verify]\n')
      return 0
    }
    process.stderr.write(`unknown argument ${JSON.stringify(argument)}\n`)
    return 2
  }
  if (!existsSync(root)) {
    process.stderr.write(`sessions root not found: ${root}\n`)
    return 2
  }
  const artifacts = listArtifacts(root)
  if (artifacts.length === 0) {
    process.stdout.write(`no session artifacts under ${root}\n`)
    return 0
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = backupRoot || join(dirname(root), 'session-repair-backup-' + stamp)
  let repaired = 0
  let skipped = 0
  let failed = 0
  for (const artifact of artifacts) {
    const label = relative(root, artifact.path)
    let outcome
    try {
      outcome = repairText(readArtifact(artifact.path))
    } catch (error) {
      process.stdout.write(`FAIL    ${label}: ${(error && error.message) || error}\n`)
      failed += 1
      continue
    }
    if (!outcome.changed) {
      skipped += 1
      continue
    }
    process.stdout.write(`REPAIR  ${label}  moved: ${outcome.moved.join(', ')}\n`)
    repaired += 1
    if (apply) {
      mkdirSync(backupDir, { recursive: true })
      const backupPath = join(backupDir, artifact.project, artifact.session, basename(artifact.path))
      mkdirSync(dirname(backupPath), { recursive: true })
      copyFileSync(artifact.path, backupPath)
      writeArtifact(artifact.path, outcome.text)
      process.stdout.write(`        backed up to ${backupPath}\n`)
      if (verify) {
        const checked = await verifyWithBackend(artifact.path)
        process.stdout.write(`        verify: ${checked.ok ? 'OK' : 'FAIL'} — ${checked.detail}\n`)
        if (!checked.ok) failed += 1
      }
    }
  }
  process.stdout.write(`\n${repaired} need repair, ${skipped} already fine, ${failed} failed`
    + (apply ? `; backups in ${backupDir}` : '; dry run — rerun with --apply to write') + '\n')
  return failed === 0 ? 0 : 1
}

/* Run as a CLI, but stay importable for the unit tests. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
