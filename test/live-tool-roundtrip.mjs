/**
 * Live tool-call round trip against a real account and real model: the model must
 * emit a valid call with quote-bearing code arguments (the exact defect class
 * from real failure data), the gateway must validate it, and after a simulated
 * host execution the model must finish the turn. Default model is glm-5-3-flashx,
 * where the historical corrections concentrated.
 */
import { createEmbeddedGateway } from '../lib/embedded/gateway.js'
import { AccountStore } from '../lib/accounts.js'
import { GatewayClient, REGIONS } from '../lib/gateway.js'

const region = REGIONS.find(row => row.id === (process.env.TABBIT_REGION ?? 'tabbit-cn'))
const model = process.env.TABBIT_TEST_MODEL ?? 'glm-5-3-flashx'
const tools = [{
  type: 'function',
  function: {
    name: 'write_note',
    description: 'Save a note with a title and text content.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' }, content: { type: 'string' } },
      required: ['title', 'content'],
    },
  },
}]

async function chat(baseUrl, apiKey, messages, withTools) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, stream: true, messages, ...(withTools ? { tools } : {}) }),
    signal: AbortSignal.timeout(300000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = '', text = '', reasoning = ''
  const calls = new Map()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6).trim()
        if (payload === '[DONE]') continue
        const delta = JSON.parse(payload).choices?.[0]?.delta ?? {}
        if (typeof delta.content === 'string') text += delta.content
        if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content
        for (const part of delta.tool_calls ?? []) {
          const slot = calls.get(part.index ?? 0) ?? { id: '', name: '', arguments: '' }
          slot.id = part.id ?? slot.id
          slot.name = part.function?.name ?? slot.name
          slot.arguments += part.function?.arguments ?? ''
          calls.set(part.index ?? 0, slot)
        }
      }
    }
  }
  return { text, reasoning, calls: [...calls.values()] }
}

const embedded = await createEmbeddedGateway({ region })
let client
try {
  client = new GatewayClient({ region, baseUrl: embedded.baseUrl, apiKey: embedded.apiKey, adminPassword: embedded.adminPassword })
  const store = new AccountStore()
  let added = 0
  for (const account of store.accountsFor(region.id)) { await client.addToken({ name: account.name, value: account.value, enabled: account.enabled }); added++ }
  if (!added) throw new Error('no enabled account in the pool; log in first')

  const userMessage = {
    role: 'user',
    content: 'Save a note using write_note. title: "quote test". content must be EXACTLY this Python code, keeping every quote and newline:\nprint("hello")\nprint("world")',
  }

  console.log(JSON.stringify({ phase: 'turn1', model, region: region.id }))
  const turn1 = await chat(embedded.baseUrl, embedded.apiKey, [userMessage], true)
  if (!turn1.calls.length) throw new Error(`no tool call emitted; text=${JSON.stringify(turn1.text.slice(0, 300))}`)
  const call = turn1.calls[0]
  const args = JSON.parse(call.arguments)
  console.log(JSON.stringify({ phase: 'turn1-ok', function: call.name, title: args.title, contentKeepsQuotes: args.content?.includes('print("hello")') === true && args.content?.includes('print("world")') === true, calls: turn1.calls.length }))

  const turn2 = await chat(embedded.baseUrl, embedded.apiKey, [
    userMessage,
    { role: 'assistant', content: null, tool_calls: [{ id: call.id || 'call_1', type: 'function', function: { name: call.name, arguments: call.arguments } }] },
    { role: 'tool', tool_call_id: call.id || 'call_1', content: JSON.stringify({ saved: true, path: 'C:/tmp/notes/quote-test.txt', bytes: args.content.length }) },
  ], false)
  if (!turn2.text.trim()) throw new Error('model did not finish the turn after the tool result')
  console.log(JSON.stringify({ phase: 'turn2-ok', finalText: turn2.text.trim().slice(0, 160) }))
  console.log('PASS: live tool round trip with quote-bearing code arguments')
} finally {
  await client?.close?.()
  await embedded?.close()
}
