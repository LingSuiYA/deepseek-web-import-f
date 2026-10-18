import assert from 'node:assert/strict'
import test from 'node:test'

import { messageBlocks } from '../lib/events.js'
import { cleanDeepSeekMarkdown } from '../lib/text.js'

test('removes reference markers', () => {
  assert.equal(cleanDeepSeekMarkdown('风险很高[reference:0][reference:1]。'), '风险很高。')
  assert.equal(cleanDeepSeekMarkdown('a[reference:12] b'), 'a b')
  assert.equal(cleanDeepSeekMarkdown('no markers here'), 'no markers here')
})

test('replaces stray break tags with a space', () => {
  assert.equal(cleanDeepSeekMarkdown('line<br>next'), 'line next')
  assert.equal(cleanDeepSeekMarkdown('line<br/>next'), 'line next')
  assert.equal(cleanDeepSeekMarkdown('line<BR />next'), 'line next')
})

test('leaves fenced code untouched', () => {
  const input = [
    'text[reference:0]',
    '```html',
    'a<br>b [reference:1]',
    '```',
    'tail<br>end',
  ].join('\n')
  assert.equal(cleanDeepSeekMarkdown(input), [
    'text',
    '```html',
    'a<br>b [reference:1]',
    '```',
    'tail end',
  ].join('\n'))
})

test('messageBlocks cleans both prompt and answer text', () => {
  const prompt = messageBlocks({ role: 'user', fragments: [{ type: 'REQUEST', content: '问题[reference:3]' }] }, 'user')
  assert.equal(prompt[0].text, '问题')

  const answer = messageBlocks({
    role: 'assistant',
    fragments: [
      { type: 'THINK', content: '想[reference:1]' },
      { type: 'RESPONSE', content: '答<br>案[reference:2]' },
    ],
  }, 'assistant')
  assert.equal(answer.find((block) => block.type === 'reasoning').text, '想')
  assert.equal(answer.find((block) => block.type === 'text').text, '答 案')
})
