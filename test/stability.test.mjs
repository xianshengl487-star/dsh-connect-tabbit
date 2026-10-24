import test from 'node:test'
import assert from 'node:assert/strict'
import { currentRequest, buildPrompt, recentContext } from '../lib/embedded/protocol.js'
import { taskContext, continuationReason } from '../lib/embedded/task-state.js'
import { TabbitUpstream } from '../lib/embedded/upstream.js'

const breaker = '[Circuit Breaker] The runtime interrupted a degeneration loop: repeated long reasoning with no tool call and no reply. Stop re-deriving in thought. Do exactly ONE of these now: 1. give the user the best final answer you already have, or 2. take ONE materially different concrete action and verify its result.'
test('runtime circuit breaker preserves the active user goal and remains in prompt context', () => {
  const messages = [{ role: 'user', content: '请修复动画并导出 final.mp4。' }, { role: 'user', content: breaker }]
  assert.equal(currentRequest(messages), messages[0].content)
  assert.equal(taskContext(messages).actionable, true)
  assert.equal(taskContext([...messages, { role: 'user', content: '继续' }]).goal, messages[0].content)
  assert.equal(continuationReason({ reason: 'stop', message: { content: '现在写入修复代码。' } }, taskContext(messages)), 'progress_only')
  assert.ok(buildPrompt(messages, []).includes(breaker), 'the protection instruction is not removed')
})

test('repeated explicit continue fails within the correction budget instead of looping forever', async () => {
  const { createEmbeddedGateway } = await import('../lib/embedded/gateway.js')
  const { GatewayClient, REGIONS } = await import('../lib/gateway.js')
  const service = await createEmbeddedGateway({region: REGIONS[0], catalogReader: async()=>[{id:'best',name:'default'}], upstreamFactory:()=>({async *completion(){yield {content:'<dsh_task_status>{"state":"continue"}</dsh_task_status>'}}})})
  try { const gateway=new GatewayClient({region:REGIONS[0],...service}); await gateway.addToken({value:'a.b.c'}); await assert.rejects(gateway.chatCompletions({model:'best',stream:false,tools:[{type:'function',function:{name:'read',parameters:{type:'object',properties:{}}}}],messages:[{role:'user',content:'请读取文件'}]}), /task_incomplete/)
  } finally {await service.close()}
})

test('recent attachment preview keeps tool observations ahead of large runtime catalogs', () => {
  const messages=[{role:'user',content:'请修复动画'}, {role:'tool',tool_call_id:'c1',content:'ACTUAL_RESULT_SENTINEL'}, {role:'user',content:'<system-reminder>\nThe following tools are available in this session:\n'+ 'schema '.repeat(3000)}]
  assert.match(recentContext(messages, 5000), /ACTUAL_RESULT_SENTINEL/)
  assert.ok(buildPrompt(messages, []).includes('schema '.repeat(100)), 'full attached context remains intact')
})

test('events belonging to another run cannot consume a real event cursor or mark the run complete', async () => {
  const event=(id,run,type,content)=>`id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({payload:{run_id:run,chunk_type:'message_chunk',chunk_payload:{content}}})}\n\n`
  const client=new TabbitUpstream({value:'a.b.c',origin:'https://web.tabbit.com',fetchImpl:async url=>{
    const p=new URL(url).pathname
    if(p==='/panel/session')return Response.json({chat_session_id:'s'})
    if(p==='/session/s')return new Response('ok')
    if(p.endsWith('/runs'))return Response.json({run_id:'r'})
    if(p.endsWith('/join'))return new Response(event('1','other','event_message_chunk','WRONG')+event('1','r','event_message_chunk','OK')+event('2','r','run_completed'))
    return Response.json({ok:true})
  }})
  let text=''; for await(const row of client.completion('test','default'))text+=row.content??''
  assert.equal(text,'OK')
})

test('numeric event zero remains resumable after a disconnect', async () => {
  let joins=0
  const cursors=[]
  const event=(id,type,content)=>`event: ${type}\ndata: ${JSON.stringify({event_id:id,payload:{run_id:'r',chunk_type:'message_chunk',chunk_payload:{content}}})}\n\n`
  const client=new TabbitUpstream({value:'a.b.c',origin:'https://web.tabbit.com',policy:{retryDelayMs:1},fetchImpl:async(url,init)=>{
    const p=new URL(url).pathname
    if(p==='/panel/session')return Response.json({chat_session_id:'s'})
    if(p==='/session/s')return new Response('ok')
    if(p.endsWith('/runs'))return Response.json({run_id:'r'})
    if(p.endsWith('/join')){cursors.push(JSON.parse(init.body).last_event_id); return new Response(++joins===1?event(0,'event_message_chunk','A'):event(0,'event_message_chunk','A')+event(1,'event_message_chunk','B')+event(2,'run_completed'))}
    return Response.json({ok:true})
  }})
  let text='';for await(const row of client.completion('test','default'))text+=row.content??''
  assert.equal(text,'AB');assert.deepEqual(cursors,[null,'0'])
})
