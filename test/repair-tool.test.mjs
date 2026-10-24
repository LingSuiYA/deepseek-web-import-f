/**
 * Tests for tools/fix-surface-before-step.mjs: the repair keeps every record it
 * did not have to move, and produces a log whose first surface event no longer
 * precedes the first `step/start` (the v2→v3 migration requirement).
 *
 *   node --test test/repair-tool.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkRepaired,
  decodeFrames,
  encodeFrames,
  isArtifact,
  isCompressed,
  leadingSurface,
  listArtifacts,
  planRepair,
  readArtifact,
  repairText,
  writeArtifact,
} from '../tools/fix-surface-before-step.mjs'

/** One event record with a stable identity for equality assertions. */
function event(type, seq, extra = {}) {
  return { type, seq, time: 1000 + seq, data: { marker: type + '#' + seq }, ...extra }
}

/**
 * A log shaped like the 0.1.x importer wrote it: the step opens *after* the
 * message it carries, and a reasoning-chunk row carries `seq0` (no `seq`).
 */
function legacyLog() {
  return [
    event('session/title', 0),
    event('turn/start', 1),
    event('user/message', 2, { surfaceOp: 'append' }),
    event('step/start', 3),
    event('assistant/message', 4, { surfaceOp: 'append' }),
    { type: 'reasoning-chunks', seq0: 5, time0: 1005, data: { turn: 1, step: 1, texts: ['a', 'b'] } },
    event('step/end', 5),
    event('turn/end', 6),
    event('session/end-seed', 7),
  ]
}

/** The corrected order: the step opens before the message it carries. */
function repairedLog() {
  const events = legacyLog()
  const byType = (type) => events.find((entry) => entry.type === type)
  return [
    byType('session/title'),
    byType('turn/start'),
    { ...byType('step/start'), seq: 2 },
    { ...byType('user/message'), seq: 3 },
    byType('assistant/message'),
    events[5],
    byType('step/end'),
    byType('turn/end'),
    byType('session/end-seed'),
  ]
}

test('the repair opens the step before the message it carries', () => {
  const plan = planRepair(legacyLog())
  assert.ok(plan !== null, 'the legacy order needs a repair')
  assert.deepEqual(plan.moved, ['user/message'])
  assert.deepEqual(plan.events.map((entry) => entry.type), [
    'session/title', 'turn/start', 'step/start', 'user/message', 'assistant/message',
    'reasoning-chunks', 'step/end', 'turn/end', 'session/end-seed',
  ])
  assert.deepEqual(plan.events.map((entry) => entry.seq), [0, 1, 2, 3, 4, undefined, 5, 6, 7])
  assert.deepEqual(leadingSurface(plan.events), [], 'no surface event precedes the first step')
  assert.equal(checkRepaired(plan.events), null)
})

test('every record the repair does not move is preserved exactly', () => {
  const before = legacyLog()
  const after = planRepair(before).events
  const untouched = ['session/title', 'turn/start', 'assistant/message', 'reasoning-chunks', 'step/end', 'turn/end', 'session/end-seed']
  for (const type of untouched) {
    assert.deepEqual(after.find((entry) => entry.type === type), before.find((entry) => entry.type === type), type)
  }
  /* the reasoning-chunk row keeps seq0 and never grows a seq member */
  const chunk = after.find((entry) => entry.type === 'reasoning-chunks')
  assert.equal(chunk.seq, undefined)
  assert.equal(chunk.seq0, 5)
})

test('a log that is already correct is left alone', () => {
  assert.equal(planRepair(repairedLog()), null)
  assert.equal(leadingSurface(repairedLog()).length, 0)
})

test('a log with no turn at all is left alone', () => {
  const events = [event('session/title', 0), event('session/end-seed', 1)]
  assert.equal(planRepair(events), null)
  assert.equal(leadingSurface(events).length, 0)
})

test('several leading surface events all move, in order', () => {
  const events = [
    event('turn/start', 0),
    event('user/message', 1, { surfaceOp: 'append' }),
    event('tool/result', 2, { surfaceOp: 'append' }),
    event('step/start', 3),
    event('assistant/message', 4, { surfaceOp: 'append' }),
    event('step/end', 5),
    event('turn/end', 6),
  ]
  const plan = planRepair(events)
  assert.deepEqual(plan.moved, ['user/message', 'tool/result'])
  assert.deepEqual(plan.events.map((entry) => entry.type), [
    'turn/start', 'step/start', 'user/message', 'tool/result', 'assistant/message', 'step/end', 'turn/end',
  ])
  assert.deepEqual(plan.events.map((entry) => entry.seq), [0, 1, 2, 3, 4, 5, 6])
  assert.deepEqual(leadingSurface(plan.events), [])
})

test('checkRepaired reports a seq gap and a seq/seq0 clash', () => {
  const gap = repairedLog().map((entry) => (entry.type === 'turn/end' ? { ...entry, seq: 9 } : entry))
  assert.match(checkRepaired(gap), /seq is not contiguous/)
  const clash = repairedLog().map((entry) => (entry.type === 'reasoning-chunks' ? { ...entry, seq: 100 } : entry))
  assert.match(checkRepaired(clash), /both seq and seq0/)
})

test('artifact decode/encode round-trips across several zstd frames', () => {
  const lines = ['{"type":"session","version":0}', '{"type":"turn/start","seq":0}']
  const buffer = encodeFrames(lines)
  assert.equal(decodeFrames(buffer), lines.join('\n') + '\n')
})

test('names are classified by artifact suffix', () => {
  assert.equal(isArtifact('session.jsonl.zstd'), true)
  assert.equal(isArtifact('session.v4.jsonl.zstd'), true)
  assert.equal(isArtifact('session.jsonl'), true)
  assert.equal(isArtifact('session.jsonl.zstd.tmp'), false)
  assert.equal(isCompressed('session.jsonl.zstd'), true)
  assert.equal(isCompressed('session.jsonl'), false)
})

test('repairText keeps the header and rewrites the events', () => {
  const header = { type: 'session', version: 0, id: 'session-t', createdAt: 1, cwd: '/tmp' }
  const text = [JSON.stringify(header), ...legacyLog().map((entry) => JSON.stringify(entry))].join('\n') + '\n'
  const outcome = repairText(text)
  assert.equal(outcome.changed, true)
  assert.deepEqual(outcome.moved, ['user/message'])
  const lines = outcome.text.trim().split('\n')
  assert.deepEqual(JSON.parse(lines[0]), header)
  assert.equal(lines.length, 10, 'header + the same nine events')
  assert.deepEqual(leadingSurface(lines.slice(1).map((line) => JSON.parse(line))), [])
  /* an already-correct text is returned unchanged */
  const again = repairText(outcome.text)
  assert.equal(again.changed, false)
  assert.equal(again.text, outcome.text)
})

test('a repaired artifact on disk is written back readable and discoverable', () => {
  const root = mkdtempSync(join(tmpdir(), 'dswi-repair-'))
  try {
    const project = '--tmp-project--'
    const session = 'session-legacy'
    const directory = join(root, project, session)
    mkdirSync(directory, { recursive: true })
    const target = join(directory, 'session.jsonl.zstd')
    const header = JSON.stringify({ type: 'session', version: 0, id: session, createdAt: 1, cwd: '/tmp' })
    const original = [header, ...legacyLog().map((entry) => JSON.stringify(entry))].join('\n') + '\n'
    writeArtifact(target, original)

    const artifacts = listArtifacts(root)
    assert.equal(artifacts.length, 1)
    assert.equal(artifacts[0].session, session)

    const outcome = repairText(readArtifact(target))
    assert.equal(outcome.changed, true)
    writeArtifact(target, outcome.text)

    const repaired = readArtifact(target)
    const events = repaired.trim().split('\n').slice(1).map((line) => JSON.parse(line))
    assert.deepEqual(leadingSurface(events), [])
    assert.equal(events.length, legacyLog().length)
    assert.equal(readFileSync(target).subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd])), true, 'still a zstd artifact')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
