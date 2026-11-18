import { afterEach, expect, test } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { MagpieAdapter } from '../src/host/adapter.js'
import { MagpieRuntime, lineCredentialRefs } from '../src/host/runtime.js'
import { credentialsMock } from './support/credentials.js'
import { createGateway, json, sse as openAiSse, type Reply } from './support/gateway.js'
import { LINE_ID, LINE_ID_2, line, memoryStore } from './support/line.js'
import { responseText } from './support/wire.js'

const model = 'claude/claude-sonnet-5'
const provider = 'dsh-magpie-connector-claude'
const path = 'POST /v1/messages'
const high = 'high' as NonNullable<GenerateOptions['reasoningEffort']>
const catalog = (native_endpoints = ['/v1/messages']) => json({
  data: [{ id: model, owned_by: 'claude', native_endpoints, reasoning_levels: ['none', 'high'] }],
})
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function gateway() {
  const g = await createGateway()
  g.handlers.set('GET /v1/models', catalog())
  cleanup.push(g.close)
  return g
}

async function setup(baseUrl: string) {
  const runtime = new MagpieRuntime(credentialsMock('sk-ant-oat-gateway-key').service, memoryStore([line(baseUrl)]))
  cleanup.push(() => runtime.dispose())
  await runtime.start()
  return new MagpieAdapter(runtime)
}

function sse(events: { type: string }[]): Reply {
  return res => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    res.end()
  }
}
const start = {
  type: 'message_start',
  message: { id: 'msg_1', model, role: 'assistant', content: [], stop_reason: null,
    usage: { input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 20, cache_creation_input_tokens: 2 } },
}
const blockStart = (index: number, content_block: object) => ({ type: 'content_block_start', index, content_block })
const delta = (index: number, content: object) => ({ type: 'content_block_delta', index, delta: content })
const blockStop = (index: number) => ({ type: 'content_block_stop', index })
const end = (stop_reason: string) => [
  { type: 'message_delta', delta: { stop_reason }, usage: { output_tokens: 6 } },
  { type: 'message_stop' },
]
const textReply = [start, blockStart(0, { type: 'text', text: '' }), delta(0, { type: 'text_delta', text: 'done' }), blockStop(0), ...end('end_turn')]
const options: GenerateOptions = {
  provider, model, system: 'System instructions', maxTokens: 256,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'User request' }] }],
  tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
}
async function generate(adapter: MagpieAdapter, overrides?: Partial<GenerateOptions>) {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({ ...options, ...overrides })) chunks.push(chunk)
  return chunks
}

test('uses native Messages under the configured prefix and replays signed thinking and tool results', async () => {
  const g = await gateway()
  g.handlers.set('GET /proxy/v1/models', catalog())
  const adapter = await setup(g.baseUrl.replace('/v1', '/proxy/v1'))
  const target = 'POST /proxy/v1/messages'
  g.handlers.set(target, sse([
    start, blockStart(0, { type: 'thinking', thinking: '', signature: '' }),
    delta(0, { type: 'thinking_delta', thinking: 'think' }),
    delta(0, { type: 'signature_delta', signature: 'signature' }), blockStop(0),
    blockStart(1, { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} }),
    delta(1, { type: 'input_json_delta', partial_json: '{"path":' }),
    delta(1, { type: 'input_json_delta', partial_json: '"a"}' }), blockStop(1), ...end('tool_use'),
  ]))
  const first = await generate(adapter, { reasoningEffort: high })
  const request = g.requests.at(-1)!
  expect(request).toMatchObject({
    path: '/proxy/v1/messages', query: '?beta=true',
    headers: { authorization: 'Bearer sk-ant-oat-gateway-key', 'anthropic-version': '2023-06-01' },
    body: {
      model, max_tokens: 256, stream: true, thinking: { type: 'adaptive' }, output_config: { effort: 'high' },
      system: [expect.objectContaining({ type: 'text', text: 'System instructions' })],
      messages: [{ role: 'user', content: [expect.objectContaining({ type: 'text', text: 'User request' })] }],
      tools: [{ name: 'read_file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
    },
  })
  expect(request.headers['x-api-key']).toBeUndefined()
  expect(first).toContainEqual({ type: 'tool-call-delta', index: 1, id: 'toolu_1', name: 'read_file', argumentsDelta: '{"path":' })
  expect(first).toContainEqual({ type: 'usage', usage: {
    inputTokens: 0, outputTokens: 6, cacheReadTokens: 20, cacheWriteTokens: 2, totalTokens: 28,
  } })
  const finish = first.at(-1)
  if (finish?.type !== 'finish' || !finish.replayState) throw new Error('Missing replay from Messages')
  expect(finish.reason.kind).toBe('tool-calls')
  const content = first.flatMap(chunk => chunk.type === 'block-end' ? [chunk.block] : [])
  expect(content).toContainEqual({ type: 'tool-call', id: 'toolu_1', name: 'read_file', arguments: '{"path":"a"}' })

  g.handlers.set(target, sse(textReply))
  const second = await generate(adapter, {
    stop: ['END'], reasoningEffort: high,
    messages: [
      ...options.messages,
      { role: 'assistant', content, source: { kind: 'model', provider, model, replayState: finish.replayState } },
      { role: 'tool', toolCallId: 'toolu_1', isError: true, content: [{ type: 'text', text: 'file missing' }] },
    ] as GenerateOptions['messages'],
  })
  expect(g.requests.at(-1)?.body).toMatchObject({
    stop_sequences: ['END'],
    messages: [
      expect.objectContaining({ role: 'user' }),
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'think', signature: 'signature' },
        { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a' } },
      ] },
      { role: 'user', content: [expect.objectContaining({
        type: 'tool_result', tool_use_id: 'toolu_1', is_error: true,
        content: 'file missing',
      })] },
    ],
  })
  expect(second).toContainEqual({ type: 'text-delta', index: 0, text: 'done' })
  expect(second.at(-1)).toMatchObject({ reason: { kind: 'stop' } })
})

test('maps Anthropic HTTP and stream failures without retrying or leaking the key', async () => {
  const g = await gateway()
  const adapter = await setup(g.baseUrl)
  g.handlers.set(path, res => {
    res.setHeader('retry-after', '3')
    json({ type: 'error', error: { type: 'rate_limit_error', message: 'sk-ant-oat-gateway-key' } }, 429)(res, {} as never)
  })
  const http = (await generate(adapter)).at(-1)
  expect(http).toMatchObject({ reason: { failure: { code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 3000 } } })
  expect(JSON.stringify(http)).not.toContain('sk-ant-oat-gateway-key')
  const error = { type: 'error', error: { type: 'overloaded_error', message: 'Try again' } }
  g.handlers.set(path, sse([start, error]))
  expect((await generate(adapter)).at(-1)).toMatchObject({ reason: { failure: { code: 'SERVER' } } })
  g.handlers.set(path, sse(textReply.slice(0, -1)))
  expect((await generate(adapter)).at(-1)).toMatchObject({ reason: { failure: { code: 'TRANSPORT' } } })
  expect(g.requests.filter(request => request.method === 'POST')).toHaveLength(3)
})

test('uses the new line catalog on failover and preserves Responses precedence', async () => {
  const first = await gateway()
  const second = await gateway()
  second.handlers.set('GET /v1/models', catalog(['/v1/messages', '/v1/responses']))
  first.handlers.set(path, sse(textReply))
  const credentials = credentialsMock('first-key')
  credentials.setRef(String(lineCredentialRefs(LINE_ID_2).key), 'second-key')
  let firstReachable = true
  const runtime = new MagpieRuntime(credentials.service, memoryStore([
    line(first.baseUrl, LINE_ID), line(second.baseUrl, LINE_ID_2),
  ]), () => {}, { probe: async (_host, port) => port !== first.port || firstReachable })
  cleanup.push(() => runtime.dispose())
  await runtime.start()
  const adapter = new MagpieAdapter(runtime)
  expect((await generate(adapter)).at(-1)).toMatchObject({ reason: { kind: 'stop' } })

  firstReachable = false
  runtime.selector.invalidate()
  await generate(adapter)
  expect(second.requests.map(request => request.path)).toEqual(['/v1/models', '/v1/responses'])
  expect(second.requests.at(-1)?.headers.authorization).toBe('Bearer second-key')
})

test('line override opts a Responses model into Messages and automatic mode restores Responses', async () => {
  const g = await gateway()
  g.handlers.set('GET /v1/models', catalog(['/v1/responses']))
  g.handlers.set(path, sse(textReply))
  g.handlers.set('POST /v1/responses', openAiSse(responseText()))
  const adapter = await setup(g.baseUrl)
  const runtime = adapter.runtime
  const prepared = await adapter.prepareCall(provider, model)
  const lines = [{ id: LINE_ID, protocol: 'anthropic-messages' }]
  expect((await runtime.settings({ lines })).status).toBe(200)
  expect(runtime.config()[0]).toMatchObject(lines[0]!)
  for await (const _chunk of prepared.stream(options)) { /* The prepared call still uses automatic mode. */ }
  expect(g.requests.at(-1)?.path).toBe('/v1/responses')
  expect((await generate(adapter)).at(-1)).toMatchObject({ reason: { kind: 'stop' } })
  expect(g.requests.at(-1)?.path).toBe('/v1/messages')
  expect((await runtime.settings({ lines: [{ id: LINE_ID, protocol: 'auto' }] })).status).toBe(200)
  expect(runtime.config()[0]?.protocol).toBeUndefined()
  expect((await generate(adapter)).at(-1)).toMatchObject({ reason: { kind: 'stop' } })
  expect(g.requests.at(-1)?.path).toBe('/v1/responses')
})
