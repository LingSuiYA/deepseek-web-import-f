import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { buildSessionEvents, messageBlocks } from '../lib/events.js'
import {
  fileEntriesByMessage,
  fileSignedUrl,
  importFiles,
  MAX_FILE_BYTES,
  sanitizeFileName,
} from '../lib/files.js'

test('builds the document rendition URL', () => {
  assert.equal(
    fileSignedUrl('/file?file_id=x&state=y'),
    'https://files.deepseeksvc.com/api/file?file_id=x&state=y&ty=r',
  )
  assert.equal(
    fileSignedUrl('file?file_id=x'),
    'https://files.deepseeksvc.com/api/file?file_id=x&ty=r',
  )
})

test('sanitizes server-supplied names', () => {
  assert.equal(sanitizeFileName('报告 2024.pdf', 'fallback.bin'), '报告 2024.pdf')
  assert.equal(sanitizeFileName('../../etc/passwd', 'fallback.bin'), '_.._etc_passwd')
  assert.equal(sanitizeFileName('a\\b/c:d*e?f"g<h>i|j', 'fallback.bin'), 'a_b_c_d_e_f_g_h_i_j')
  assert.equal(sanitizeFileName('', 'fallback.bin'), 'fallback.bin')
  assert.equal(sanitizeFileName(null, 'fallback.bin'), 'fallback.bin')
})

test('groups only non-image entries', () => {
  const messages = [
    {
      role: 'user',
      fragments: [
        { type: 'FILE', files: [
          { id: 'img', is_image: true },
          { id: 'doc', is_image: false, file_name: 'a.pdf' },
        ] },
        { type: 'REQUEST', content: 'hi' },
      ],
    },
    { role: 'assistant', fragments: [{ type: 'FILE', files: [{ id: 'x', is_image: false }] }] },
  ]
  const grouped = fileEntriesByMessage(messages)
  assert.deepEqual([...grouped.keys()], [0])
  assert.equal(grouped.get(0).length, 1)
  assert.equal(grouped.get(0)[0].id, 'doc')
})

test('messageBlocks appends file blocks after images', () => {
  const image = { attachmentId: 'img-1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }
  const file = { attachmentId: 'file-1', name: 'a.pdf', bytes: 3 }
  const blocks = messageBlocks({ role: 'user', fragments: [{ type: 'REQUEST', content: 'look' }] }, 'user', [image], [file])
  assert.deepEqual(blocks.map((block) => block.type), ['text', 'image', 'file'])
  assert.equal(blocks[2].attachment, file)

  const onlyFile = messageBlocks({ role: 'user', fragments: [] }, 'user', [], [file])
  assert.deepEqual(onlyFile.map((block) => block.type), ['file'])
})

test('buildSessionEvents writes file blocks at the right message', () => {
  const file = { attachmentId: 'file-9', name: 'a.pdf', bytes: 3 }
  const profile = { version: 4, assistantStream: true, isSeededFlag: true, delegationDepth: true }
  const messages = [
    { role: 'user', fragments: [{ type: 'REQUEST', content: 'first' }] },
    { role: 'assistant', fragments: [{ type: 'RESPONSE', content: 'a' }] },
    { role: 'user', fragments: [{ type: 'REQUEST', content: 'second' }] },
    { role: 'assistant', fragments: [{ type: 'RESPONSE', content: 'b' }] },
  ]
  const events = buildSessionEvents(messages, 't', profile, new Map(), new Map([[2, [file]]]))
  const userMessages = events.filter((event) => event.type === 'user/message')
  assert.deepEqual(userMessages[1].data.content.map((block) => block.type), ['text', 'file'])
})

function fakeSubprocess(payload) {
  return {
    spawn(spec) {
      let out = ''
      let resolveDone
      const done = new Promise((resolve) => { resolveDone = resolve })
      const stdin = {
        on() {},
        end(text) {
          const request = JSON.parse(text || '{}')
          try {
            fs.writeFileSync(request.path, payload)
            out = JSON.stringify({ status: 200, bytes: payload.length, path: request.path })
          } catch (error) {
            out = JSON.stringify({ error: String(error.message) })
          }
          resolveDone({ exitCode: 0 })
        },
      }
      return {
        done,
        stdin,
        collected: { stdout: { readFrom: () => ({ text: out }) }, stderr: { readFrom: () => ({ text: '' }) } },
      }
    },
  }
}

const descriptorRequest = async () => ({
  body: JSON.stringify({
    data: {
      biz_code: 0,
      biz_data: { files: [{ id: 'doc-1', status: 'SUCCESS', signed_path: '/file?file_id=doc-1', file_name: '报告.pdf', file_size: 6 }] },
    },
  }),
})

test('importFiles streams a document through saveFileStream', async () => {
  const payload = Buffer.from('%PDF-1')
  const saved = []
  const attachments = {
    async saveFileStream({ data, name }) {
      const chunks = []
      for await (const chunk of data) chunks.push(Buffer.from(chunk))
      const bytes = Buffer.concat(chunks)
      const ref = { attachmentId: 'file-1', name, bytes: bytes.length }
      saved.push({ ref, bytes })
      return ref
    },
  }
  const messages = [{ role: 'user', fragments: [{ type: 'FILE', files: [{ id: 'doc-1', is_image: false }] }] }]
  const result = await importFiles({
    messages,
    attachments,
    subprocess: fakeSubprocess(payload),
    request: descriptorRequest,
    cwd: process.cwd(),
  })
  assert.equal(result.found, 1)
  assert.equal(result.imported, 1)
  assert.equal(result.byIndex.get(0)[0].name, '报告.pdf')
  assert.equal(saved[0].bytes.length, payload.length)
})

test('importFiles falls back to saveFile when streaming is absent', async () => {
  const payload = Buffer.from('%PDF-1-fallback')
  const attachments = {
    async saveFile({ data, name }) {
      return { attachmentId: 'file-2', name, bytes: data.length }
    },
  }
  const messages = [{ role: 'user', fragments: [{ type: 'FILE', files: [{ id: 'doc-1', is_image: false }] }] }]
  const result = await importFiles({
    messages,
    attachments,
    subprocess: fakeSubprocess(payload),
    request: descriptorRequest,
    cwd: process.cwd(),
  })
  assert.equal(result.imported, 1)
  assert.equal(result.byIndex.get(0)[0].name, '报告.pdf')
})

test('importFiles skips oversized and failed downloads', async () => {
  const oversized = async () => ({
    body: JSON.stringify({
      data: { biz_code: 0, biz_data: { files: [{ id: 'big', status: 'SUCCESS', signed_path: '/file?x=1', file_name: 'big.iso', file_size: MAX_FILE_BYTES + 1 }] } },
    }),
  })
  const attachments = { async saveFile() { throw new Error('should not be called') } }
  const messages = [{ role: 'user', fragments: [{ type: 'FILE', files: [{ id: 'big', is_image: false }] }] }]
  const result = await importFiles({ messages, attachments, subprocess: fakeSubprocess(Buffer.from('x')), request: oversized })
  assert.equal(result.found, 1)
  assert.equal(result.imported, 0)
  assert.equal(result.byIndex.size, 0)
})

test('importFiles reports unavailable services', async () => {
  const messages = [{ role: 'user', fragments: [{ type: 'FILE', files: [{ id: 'd', is_image: false }] }] }]
  assert.equal((await importFiles({ messages, attachments: undefined, subprocess: {} })).unavailable, 'attachments_unavailable')
  assert.equal((await importFiles({ messages, attachments: {}, subprocess: undefined })).unavailable, 'subprocess_unavailable')
})
