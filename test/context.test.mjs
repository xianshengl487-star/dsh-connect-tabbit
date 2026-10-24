import { test } from 'node:test'
import assert from 'node:assert/strict'
import { officialContext, modelContext } from '../lib/model-context.js'
import { readModelCatalog, parseTokenValue } from '../lib/tabbit.js'

test('official explicit context metadata takes priority over description and reply limits', () => {
  assert.deepEqual(officialContext({ context_window: 262144, max_tokens: 8192, description: '支持 1M 上下文' }),
    { contextWindow: 262144, contextSource: 'tabbit-field' })
  assert.equal(officialContext({ context_length: '200000' }).contextWindow, 200000)
  assert.deepEqual(officialContext({ max_tokens: 32768 }), {})
})

test('explicit multilingual descriptions preserve capacities without guessing from model names', () => {
  for (const [description, expected] of [
    ['支持 1M token 上下文与视觉理解', 1000000],
    ['原生支持 1M 上文', 1000000],
    ['上下文：256K tokens', 256000],
    ['支持 128K 上下文', 128000],
    ['context window of 1.5M tokens', 1500000],
    ['支持 100万 上下文', 1000000],
  ]) assert.equal(officialContext({ description }).contextWindow, expected, description)
  for (const row of [
    { display_name: 'GLM-5.3-FlashX', description: '高吞吐的编程和智能体任务' },
    { display_name: 'Kimi-K3', description: '旗舰模型' },
    { description: '1M 参数，支持多轮对话和长上下文' },
    { description: '每日 1000000 tokens 免费额度' },
    { context_window: -1, description: '' },
  ]) assert.deepEqual(officialContext(row), {})
})

test('legacy gateway context remains usable; invalid or missing limits remain conservative', () => {
  assert.equal(modelContext({ maxTokens: 128000 }).contextWindow, 128000)
  assert.equal(modelContext({ contextWindow: 200000, maxTokens: 100000 }).contextWindow, 200000)
  for (const value of [-1, 0, Infinity, 1.5, true, 'NaN', '']) {
    assert.deepEqual(modelContext({ contextWindow: value }), { contextWindow: 100000, contextSource: 'fallback' })
  }
})

test('live catalog parsing carries declared context without inventing an unknown model capacity', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'success', models: [
    { display_name: 'LongCat-2.0', description: '原生支持 1M 上文' },
    { display_name: 'GLM-5.3-FlashX', description: '智能体任务' },
  ] }))
  const token = parseTokenValue('test.jwt.value|session|device')
  const [long, unknown] = await readModelCatalog({ origin: 'https://web.tabbit.com', token })
  assert.equal(long.contextWindow, 1000000)
  assert.equal(long.contextSource, 'tabbit-description')
  assert.equal(unknown.contextWindow, undefined)
})
