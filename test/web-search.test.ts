import { expect, test } from 'vitest'
import ToolsService, { type ToolActivationContext, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createGateway, deferred, json } from './support/gateway.js'
import { mountRealHost, until } from './support/host.js'

test('DSH admits Magpie search for Magpie models and executes it on the configured gateway', async () => {
  const gateway = await createGateway()
  const host = await mountRealHost()
  const searchPath = '/proxy/mcp/magpie/web-search'
  const toolName = 'magpie_web_search'
  const key = 'mock-magpie-key'
  const context = host.ctx as unknown as { provide(name: string): void; set(name: string, value: unknown): void }
  context.provide('systemPrompt')
  context.set('systemPrompt', { tools: () => () => {} })
  host.ctx.plugin(ToolsService)

  try {
    gateway.handlers.set('GET /proxy/v1/models', json({ data: [{ id: 'test/model', owned_by: 'test' }] }))
    const hit = 'Example result — https://example.com/source'
    gateway.handlers.set(`POST ${searchPath}`, json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: `${hit}\n${key}` }] } }))
    const tools = await until(() => host.ctx.get('tools')?.get(toolName) && host.ctx.get('tools'), 'DSH search registration')
    const response = await host.call('settings', { lines: [{ baseUrl: gateway.baseUrl.replace('/v1', '/proxy/v1'), key }] })
    expect(response.status).toBe(200)

    const signal = new AbortController().signal
    const agent = {} as ToolActivationContext['agent']
    const resolve = (provider: string) => tools.resolve({ agent, modelSelection: { provider, model: 'test/model' }, signal })
    const foreign = await resolve('other-provider')
    const magpie = await resolve('dsh-magpie-connector-test')
    expect(tools.executable(toolName, agent, foreign)).toBeUndefined()
    const tool = tools.executable(toolName, agent, magpie)!
    expect(tool).toBeDefined()
    const call = (args: unknown, callSignal = signal) => tool.execute(args, { signal: callSignal } as ToolRunContext)

    await expect(call({ query: '  example  ', count: 3 })).resolves.toBe(`${hit}\n[redacted]`)
    expect(gateway.requests.find(request => request.path === searchPath)).toMatchObject({
      method: 'POST',
      query: '',
      headers: { authorization: `Bearer ${key}` },
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_search', arguments: { query: 'example', count: 3 } } },
    })
    await expect(call({ query: '' })).rejects.toThrow('non-empty query')
    await expect(call({ query: 'example', count: 21 })).rejects.toThrow('between 1 and 20')
    expect(gateway.requests.filter(request => request.path === searchPath)).toHaveLength(1)

    gateway.handlers.set(`POST ${searchPath}`, json({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: `Search unavailable: ${key}` }] } }))
    await expect(call({ query: 'example' })).rejects.toThrow('Search unavailable: [redacted]')
    expect(gateway.requests.filter(request => request.path === searchPath).at(-1)?.body).toMatchObject({ params: { arguments: { query: 'example' } } })

    const dispatched = deferred()
    gateway.handlers.set(`POST ${searchPath}`, () => { dispatched.resolve() })
    const controller = new AbortController()
    const failed = expect(call({ query: 'example' }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    await dispatched.promise
    controller.abort()
    await failed
    foreign.dispose()
    magpie.dispose()

    await host.dispose()
    expect(tools.get(toolName)).toBeUndefined()
  } finally {
    await host.dispose()
    await gateway.close()
  }
})
