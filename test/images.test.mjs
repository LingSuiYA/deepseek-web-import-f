import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSessionEvents, messageBlocks } from '../lib/events.js'
import {
  extensionOf,
  fetchFileDescriptors,
  fileIdOf,
  fileNameOf,
  imageFilesByMessage,
  imageSignedUrl,
  importImages,
  isImageFile,
  signedPathOf,
  sniffImageMediaType,
} from '../lib/images.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')])

test('sniffs raster types from magic bytes', () => {
  assert.equal(sniffImageMediaType(PNG), 'image/png')
  assert.equal(sniffImageMediaType(JPEG), 'image/jpeg')
  assert.equal(sniffImageMediaType(WEBP), 'image/webp')
  assert.equal(sniffImageMediaType(Buffer.from('plain text!!')), null)
  assert.equal(sniffImageMediaType(null), null)
})

test('reads file fields in snake_case and camelCase', () => {
  const snake = { id: 'file-1', file_name: 'a.PNG', is_image: true, signed_path: '/file?x=1' }
  const camel = { fileId: 7, fileName: 'b.webp', isImage: false, signedPath: '/file?y=2' }
  assert.equal(fileIdOf(snake), 'file-1')
  assert.equal(fileIdOf(camel), '7')
  assert.equal(fileNameOf(snake), 'a.PNG')
  assert.equal(signedPathOf(camel), '/file?y=2')
  assert.equal(extensionOf('x.Y.JPEG'), 'jpeg')
  assert.equal(extensionOf('no-extension'), '')
  assert.equal(isImageFile(snake), true)
  assert.equal(isImageFile(camel), false, 'an explicit false flag wins')
  assert.equal(isImageFile({ id: 'z', file_name: 'c.gif' }), true)
  assert.equal(isImageFile({ id: 'z', file_name: 'c.pdf' }), false)
})

test('builds mandatory-ty CDN URLs', () => {
  assert.equal(
    imageSignedUrl('/file?x=1', 'jpeg'),
    'https://files.deepseeksvc.com/api/file?x=1&ty=p&fmt=jpeg',
  )
  assert.equal(
    imageSignedUrl('file?x=1'),
    'https://files.deepseeksvc.com/api/file?x=1&ty=p',
  )
})

test('groups image entries by message index', () => {
  const messages = [
    { role: 'user', fragments: [{ type: 'FILE', files: [{ id: 'a', is_image: true }, { id: 'b', is_image: false }] }, { type: 'REQUEST', content: 'hi' }] },
    { role: 'assistant', fragments: [{ type: 'FILE', files: [{ id: 'c', is_image: true }] }] },
    { role: 'user', files: [{ id: 'd', file_name: 'shot.png' }] },
  ]
  const grouped = imageFilesByMessage(messages)
  assert.deepEqual([...grouped.keys()], [0, 2])
  assert.equal(grouped.get(0).length, 1)
  assert.equal(grouped.get(2)[0].id, 'd')
})

test('messageBlocks places images after the prompt text', () => {
  const ref = { attachmentId: 'att-1', mediaType: 'image/png', bytes: 12, width: 1, height: 1 }
  const withText = messageBlocks({ role: 'user', fragments: [{ type: 'REQUEST', content: '看图' }] }, 'user', [ref])
  assert.deepEqual(withText.map((block) => block.type), ['text', 'image'])
  assert.equal(withText[1].attachment, ref)

  const onlyImage = messageBlocks({ role: 'user', fragments: [] }, 'user', [ref])
  assert.deepEqual(onlyImage.map((block) => block.type), ['image'])

  const onlyText = messageBlocks({ role: 'user', fragments: [] }, 'user', [])
  assert.equal(onlyText.length, 1)
  assert.equal(onlyText[0].type, 'text')
})

test('buildSessionEvents writes image blocks against the right message', () => {
  const ref = { attachmentId: 'att-9', mediaType: 'image/jpeg', bytes: 1, width: 1, height: 1 }
  const profile = { version: 4, assistantStream: true, isSeededFlag: true, delegationDepth: true }
  const messages = [
    { role: 'user', fragments: [{ type: 'REQUEST', content: 'first' }] },
    { role: 'assistant', fragments: [{ type: 'RESPONSE', content: 'a' }] },
    { role: 'user', fragments: [{ type: 'REQUEST', content: 'second' }] },
    { role: 'assistant', fragments: [{ type: 'RESPONSE', content: 'b' }] },
  ]
  const events = buildSessionEvents(messages, 't', profile, new Map([[2, [ref]]]))
  const userMessages = events.filter((event) => event.type === 'user/message')
  assert.equal(userMessages.length, 2)
  assert.deepEqual(userMessages[0].data.content.map((block) => block.type), ['text'])
  assert.deepEqual(userMessages[1].data.content.map((block) => block.type), ['text', 'image'])
  assert.equal(events.at(-1).type, 'session/end-seed')
})

test('fetchFileDescriptors maps server descriptors', async () => {
  const request = async () => ({
    body: JSON.stringify({ data: { biz_code: 0, biz_data: { files: [{ id: 'f1', signed_path: '/file?x=1' }] } } }),
  })
  const descriptors = await fetchFileDescriptors(request, ['f1'])
  assert.equal(descriptors.get('f1').signed_path, '/file?x=1')
  assert.equal((await fetchFileDescriptors(request, [])).size, 0)
})

test('importImages downloads, sniffs, and saves through stubs', async () => {
  const saved = []
  const attachments = {
    async saveImage(input) {
      const ref = { attachmentId: 'att-' + (saved.length + 1), mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1, name: input.name }
      saved.push({ ref, input })
      return ref
    },
    async saveImages(inputs) {
      const refs = []
      for (const input of inputs) refs.push(await attachments.saveImage(input))
      return refs
    },
  }
  const subprocess = {
    spawn() {
      let out = ''
      const done = Promise.resolve().then(() => {
        out = JSON.stringify({ status: 200, contentType: 'image/png', bytes: PNG.length, base64: PNG.toString('base64') })
        return { exitCode: 0 }
      })
      return {
        done,
        stdin: { on() {}, end() {} },
        collected: { stdout: { readFrom: () => ({ text: out }) }, stderr: { readFrom: () => ({ text: '' }) } },
      }
    },
  }
  const request = async () => ({
    body: JSON.stringify({
      data: {
        biz_code: 0,
        biz_data: { files: [{ id: 'f1', status: 'SUCCESS', is_image: true, file_name: 'a.png', signed_path: '/file?x=1' }] },
      },
    }),
  })
  const messages = [{ role: 'user', fragments: [{ type: 'FILE', files: [{ id: 'f1', is_image: true }] }, { type: 'REQUEST', content: 'hi' }] }]
  const result = await importImages({ messages, attachments, subprocess, request, cwd: '.' })
  assert.equal(result.found, 1)
  assert.equal(result.imported, 1)
  assert.equal(result.byIndex.get(0)[0].mediaType, 'image/png')
  assert.equal(saved[0].input.name, 'a.png')
})

test('importImages reports unavailable services instead of throwing', async () => {
  const messages = [{ role: 'user', fragments: [{ type: 'FILE', files: [{ id: 'f1', is_image: true }] }] }]
  const noAttachments = await importImages({ messages, attachments: undefined, subprocess: {}, request: async () => ({}) })
  assert.equal(noAttachments.unavailable, 'attachments_unavailable')
  assert.equal(noAttachments.imported, 0)
  const noSubprocess = await importImages({ messages, attachments: {}, subprocess: undefined, request: async () => ({}) })
  assert.equal(noSubprocess.unavailable, 'subprocess_unavailable')
})
