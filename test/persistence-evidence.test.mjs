/**
 * Storage evidence: which Session format version this build writes.
 *
 * The writer has to pick a version before it writes anything, and the only
 * local evidence is what this profile already stored. `list()` promises no
 * order — and a long-lived profile holds sessions from several generations at
 * once — so the *newest* stored generation has to win, or the import spends
 * itself on a refusal from the backend.
 *
 *   node --test test/persistence-evidence.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_FORMAT_VERSION } from '../lib/formats.js'
import {
  openSessionWriter,
  requiredFormatVersion,
  resolveFormatVersion,
  resolveStorageEvidence,
} from '../lib/persistence.js'

test('the newest stored generation wins, whatever order the backend lists', async () => {
  const older = { version: 0, id: 'older' }
  const newer = { header: { version: 4, isSeeded: false } }

  assert.deepEqual(await resolveStorageEvidence({ list: async () => [older, newer] }), { version: 4, dialect: 'seeded' })
  assert.deepEqual(await resolveStorageEvidence({ list: async () => [newer, older] }), { version: 4, dialect: 'seeded' })
  /* a middle generation is not the answer while a newer one is stored */
  assert.deepEqual(
    await resolveStorageEvidence({ list: async () => [newer, { header: { version: 2, isSeeded: false } }, older] }),
    { version: 4, dialect: 'seeded' },
  )
  assert.equal(await resolveFormatVersion({ list: async () => [older, newer] }), 4)
})

test('the dialect comes from the same header that named the version', async () => {
  const oldStyle = { version: 0, seedLength: 0 }
  const newStyle = { header: { version: 4, isSeeded: false } }
  assert.deepEqual(await resolveStorageEvidence({ list: async () => [oldStyle, newStyle] }), { version: 4, dialect: 'seeded' })
  assert.deepEqual(await resolveStorageEvidence({ list: async () => [newStyle, oldStyle] }), { version: 4, dialect: 'seeded' })
})

test('equal versions keep the first answer', async () => {
  assert.deepEqual(
    await resolveStorageEvidence({ list: async () => [{ header: { version: 4, isSeeded: false } }, { header: { version: 4, isSeeded: false } }] }),
    { version: 4, dialect: 'seeded' },
  )
})

test('a legacy-shaped service still answers the v0 era', async () => {
  /* the legacy era cannot self-correct, so a foreign version in its listing is
     noise rather than evidence */
  const legacy = {
    create: async () => {},
    append: async () => {},
    list: async () => [{ version: 0, id: 'a' }, { version: 4, id: 'b' }],
  }
  assert.deepEqual(await resolveStorageEvidence(legacy), { version: 0, dialect: null })
  assert.equal(await resolveFormatVersion(legacy), 0)
  assert.equal(await resolveFormatVersion({ create: async () => {}, append: async () => {}, list: async () => [] }), 0)
})

test('nothing stored falls back to the service surface', async () => {
  assert.equal(await resolveFormatVersion({ list: async () => [] }), DEFAULT_FORMAT_VERSION)
  assert.deepEqual(
    await resolveStorageEvidence({ list: async () => { throw new Error('listing exploded') } }),
    { version: DEFAULT_FORMAT_VERSION, dialect: null },
  )
  assert.deepEqual(await resolveStorageEvidence({ list: async () => 'not a list' }), { version: DEFAULT_FORMAT_VERSION, dialect: null })
})

test('every known wording of a version refusal parses, in any case', () => {
  assert.equal(requiredFormatVersion(new Error('encodeCurrent requires Session format v4')), 4)
  assert.equal(requiredFormatVersion(new Error('session header version must be 3, got 0')), 3)
  assert.equal(requiredFormatVersion(new Error('this reader reads only v2')), 2)
  assert.equal(requiredFormatVersion(new Error('Session format version must be 1')), 1)
  assert.equal(requiredFormatVersion(new Error('REQUIRES SESSION FORMAT V5')), 5)
  assert.equal(requiredFormatVersion(new Error('HEADER VERSION MUST BE 0')), 0)
  assert.equal(requiredFormatVersion(new Error('READS ONLY V1')), 1)
  assert.equal(requiredFormatVersion(new Error('FORMAT VERSION MUST BE 12')), 12)
})

test('a refusal that names no usable version is not a version', () => {
  assert.equal(requiredFormatVersion(new Error('the disk is full')), null)
  assert.equal(requiredFormatVersion(new Error('')), null)
  assert.equal(requiredFormatVersion('requires Session format v7'), 7, 'a bare string is read too')
  assert.equal(requiredFormatVersion(null), null)
  assert.equal(requiredFormatVersion(undefined), null)
  assert.equal(
    requiredFormatVersion(new Error('requires Session format v99999999999999999999')),
    null,
    'a value that is not a safe integer is refused rather than stamped',
  )
})

test('a service that names a fresh version on every refusal cannot loop forever', async () => {
  const asked = []
  const persistence = {
    open: async () => {},
    list: async () => [],
    async create(header) {
      asked.push(header.version)
      throw new Error(`encodeCurrent requires Session format v${header.version + 1}`)
    },
  }
  await assert.rejects(
    () => openSessionWriter(persistence, { id: 'session-x', createdAt: 1, cwd: '/tmp/ws' }),
    /requires Session format v/,
  )
  assert.deepEqual(asked, [4, 5, 6, 7], 'the format retry budget is bounded')
})
