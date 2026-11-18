import { expect, test } from 'vitest'
import ToolsService, { type ToolActivationContext, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type { WebFetchProvider, WebSearchProvider } from '@deepseek-ai/dsh-web'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
    expect((await response.json()).webSearch).toEqual({ enabled: true, count: null })

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

    const updated = await host.call('settings', { webSearch: { count: 4 } })
    expect((await updated.json()).webSearch).toEqual({ enabled: true, count: 4 })
    expect((await host.call('settings', { webSearch: { enabled: false, count: 21 } })).status).toBe(400)
    expect((await host.call('settings', { webSearch: { adminUrl: 'javascript:alert(1)' } })).status).toBe(400)
    gateway.handlers.set(`POST ${searchPath}`, json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: hit }] } }))
    await expect(call({ query: 'default count' })).resolves.toBe(hit)
    expect(gateway.requests.filter(request => request.path === searchPath).at(-1)?.body).toMatchObject({ params: { arguments: { query: 'default count', count: 4 } } })

    expect((await host.call('settings', { webSearch: { enabled: false } })).status).toBe(200)
    const disabled = await resolve('dsh-magpie-connector-test')
    expect(tools.executable(toolName, agent, disabled)).toBeUndefined()
    await expect(call({ query: 'formerly admitted' })).rejects.toThrow('disabled')
    expect(gateway.requests.filter(request => request.path === searchPath)).toHaveLength(3)
    disabled.dispose()
    expect((await host.call('settings', { sidebarUsage: true })).status).toBe(200)
    const persisted = JSON.parse(readFileSync(join(host.home, 'plugins/dsh-magpie-connector/settings.json'), 'utf8'))
    expect(persisted.webSearch).toEqual({ enabled: false, count: 4 })
    expect((await host.call('settings', { webSearch: { enabled: true } })).status).toBe(200)
    const reenabled = await resolve('dsh-magpie-connector-test')
    expect(tools.executable(toolName, agent, reenabled)).toBeDefined()
    reenabled.dispose()

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

test('switches both DSH web providers, restores their overrides, and calls the active gateway', async () => {
  const gateway = await createGateway()
  const host = await mountRealHost()
  const context = host.ctx as unknown as { provide(name: string): void; set(name: string, value: unknown): void }
  const overrides: Record<string, string | undefined> = { searchProvider: 'deepseek-api', fetchProvider: 'http' }
  let revision = 0
  let native: WebSearchProvider | undefined
  let nativeFetch: WebFetchProvider | undefined
  context.provide('settings')
  context.set('settings', {
    writable: true,
    describe: () => [{ ns: 'web', value: { searchProvider: overrides.searchProvider ?? 'inherited-provider', fetchProvider: overrides.fetchProvider ?? 'http' }, user: { ...overrides }, revision }],
    mutate: async (ns: string, edits: SettingsPathOp[], expected: number) => {
      expect(ns).toBe('web')
      expect(expected).toBe(revision++)
      expect(edits.map(edit => edit.path)).toEqual([['searchProvider'], ['fetchProvider']])
      for (const edit of edits) overrides[String(edit.path[0])] = edit.op === 'set' ? String(edit.value) : undefined
    },
  })
  context.provide('web')
  context.set('web', {
    registerSearchProvider(provider: WebSearchProvider) { native = provider; return () => { native = undefined } },
    registerFetchProvider(provider: WebFetchProvider) { nativeFetch = provider; return () => { nativeFetch = undefined } },
  })
  const searchPath = '/mcp/magpie/web-search'
  try {
    gateway.handlers.set('GET /v1/models', json({ data: [{ id: 'test/model' }] }))
    gateway.handlers.set(`POST ${searchPath}`, (res, request) => {
      const { method, params } = request.body as { method: string; params?: { name: string } }
      const result = method === 'tools/list'
        ? { tools: [{ name: 'web_search', inputSchema: { properties: { count: { default: 7 }, allowed_domains: {}, recency_days: {} } } }, { name: 'web_fetch' }] }
        : { content: [{ type: 'text', text: params?.name === 'web_fetch'
          ? 'URL: https://example.com/final\nTitle: Official docs\n\nExample body\n\n[20 more characters: call web_fetch with offset=12 to read on]'
          : '1. Official docs — https://example.com/docs\nDescription\n\n[Alternate](https://example.com/other)' }] }
      return json({ jsonrpc: '2.0', id: 1, result })(res, request)
    })
    expect((await host.call('settings', { lines: [{ baseUrl: gateway.baseUrl, key: 'search-key' }] })).ok).toBe(true)
    const provider = await until(() => native, 'native web provider')
    const fetchProvider = await until(() => nativeFetch, 'native fetch provider')
    expect(provider.available()).toBe(false)
    expect(fetchProvider.available()).toBe(false)
    const info = await host.call('web-search')
    expect(await info.json()).toEqual({ status: 'ok', count: 7, fetch: true, scopes: ['allowed_domains', 'recency_days'] })
    expect(gateway.requests.find(request => request.path === searchPath)).toMatchObject({ headers: { authorization: 'Bearer search-key' }, body: { method: 'tools/list' } })
    const switched = await host.call('settings', { replaceDshSearch: true })
    expect((await switched.json()).dshSearch).toEqual({ selected: true, writable: true })
    expect(overrides).toEqual({ searchProvider: provider.id, fetchProvider: fetchProvider.id })
    expect(provider.available()).toBe(true)
    expect(fetchProvider.available()).toBe(true)
    expect((await provider.search({ query: 'docs' })).sources).toEqual([
      { title: 'Official docs', url: 'https://example.com/docs' }, { title: 'Alternate', url: 'https://example.com/other' },
    ])
    await expect(fetchProvider.fetch({ url: 'https://example.com/start' })).resolves.toEqual({
      url: 'https://example.com/final', statusCode: 200, body: { kind: 'text', content: 'Official docs\n\nExample body' }, truncated: true,
    })
    expect(gateway.requests.at(-1)).toMatchObject({ path: searchPath, headers: { authorization: 'Bearer search-key' }, body: {
      method: 'tools/call', params: { name: 'web_fetch', arguments: { url: 'https://example.com/start', max_chars: 100_000 } },
    } })
    expect((await host.call('settings', { webSearch: { enabled: false } })).ok).toBe(true)
    expect(overrides).toEqual({ searchProvider: 'deepseek-api', fetchProvider: 'http' })
    expect(provider.available()).toBe(false)
    expect(fetchProvider.available()).toBe(false)
    expect((await host.call('settings', { replaceDshSearch: true })).status).toBe(400)

    overrides.searchProvider = overrides.fetchProvider = undefined
    expect((await host.call('settings', { webSearch: { enabled: true }, replaceDshSearch: true })).ok).toBe(true)
    expect(overrides).toEqual({ searchProvider: provider.id, fetchProvider: fetchProvider.id })
    expect((await host.call('settings', { replaceDshSearch: false })).ok).toBe(true)
    expect(overrides).toEqual({ searchProvider: undefined, fetchProvider: undefined })
  } finally {
    await host.dispose()
    await gateway.close()
  }
})
