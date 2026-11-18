import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { WebFetchProvider, WebSearchProvider, WebSearchSource } from '@deepseek-ai/dsh-web'
import type { MagpieRuntime, Operation } from './runtime.js'
import { isSearchCount, MAX_SEARCH_RESULTS, type GatewaySearchView } from '../shared/web-search.js'

const WEB_TIMEOUT_MS = 60_000
const FETCH_CONTINUATION = /\r?\n\r?\n\[\d+ more characters: call web_fetch with offset=\d+ to read on\]\s*$/
export const MAGPIE_WEB_PROVIDER = 'magpie-web-search'
export const MAGPIE_FETCH_PROVIDER = 'magpie-web-fetch'

export function createWebSearchTool(runtime: MagpieRuntime): ToolDefinition {
  return {
    name: 'magpie_web_search',
    description: 'Search the public web using the configured Magpie gateway. Returns results with source links. Use for current information and cite the relevant links in your answer.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        count: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_RESULTS, description: 'Number of results. Omit to use the configured default.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, { signal }) {
      const input = args as { query?: unknown; count?: unknown } | undefined
      const query = typeof input?.query === 'string' ? input.query.trim() : ''
      if (!query) throw new Error('Magpie web search requires a non-empty query.')
      const requestedCount = input?.count
      if (requestedCount !== undefined && !isSearchCount(requestedCount)) {
        throw new Error(`Magpie web search count must be an integer between 1 and ${MAX_SEARCH_RESULTS}.`)
      }
      return search(runtime, query, signal, requestedCount)
    },
  }
}

function search(runtime: MagpieRuntime, query: string, signal?: AbortSignal, requestedCount?: number, maxResults?: number) {
  const configured = runtime.store.value.webSearch?.count
  const requested = requestedCount ?? (isSearchCount(configured) ? configured : undefined)
  const count = requested === undefined || maxResults === undefined ? requested : Math.min(requested, maxResults)
  return callWebTool(runtime, 'web search', (operation, deadline) => runtime.transport.searchWeb(operation, { query, ...(count === undefined ? {} : { count }) }, deadline), signal)
}

async function callWebTool(runtime: MagpieRuntime, capability: 'web search' | 'web fetch', request: (operation: Operation, signal: AbortSignal) => Promise<Response>, signal?: AbortSignal) {
  const label = `Magpie ${capability}`
  const deadline = AbortSignal.timeout(WEB_TIMEOUT_MS)
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
  let operation: Operation | undefined
  try {
    requestSignal.throwIfAborted()
    assertEnabled(runtime, label)
    operation = await runtime.beginOperation()
    requestSignal.throwIfAborted()
    assertEnabled(runtime, label)
    if (!operation.baseUrl || !operation.key) throw new Error(`Configure a Magpie gateway line before using ${capability}.`)
    const response = await request(operation, requestSignal)
    if (!response.ok) {
      await response.body?.cancel()
      const detail = response.status === 404 ? ' Check that the gateway or reverse proxy serves /mcp/magpie/web-search.' : ''
      throw new Error(`${label} returned HTTP ${response.status}.${detail}`)
    }
    const reply = await response.json() as {
      jsonrpc?: unknown
      id?: unknown
      error?: { message?: unknown }
      result?: { isError?: boolean; content?: { type?: unknown; text?: unknown }[] }
    } | null
    if (reply?.jsonrpc !== '2.0' || reply.id !== 1) throw new Error(`Invalid ${label} response.`)
    if (reply.error) throw new Error(typeof reply.error.message === 'string' ? reply.error.message : `${label} failed.`)
    const { content, isError } = reply.result ?? {}
    const result = Array.isArray(content) ? content.flatMap(item => item?.type === 'text' && typeof item.text === 'string' ? [item.text] : []).join('\n') : ''
    if (isError) throw new Error(result || `${label} failed.`)
    if (!result.trim()) throw new Error(`${label} returned no result text.`)
    return runtime.redact(result)
  } catch (error) {
    signal?.throwIfAborted()
    if (deadline.aborted) throw new Error(`${label} timed out after 60 seconds.`)
    throw new Error(runtime.redact(error instanceof Error ? error.message : String(error)).slice(0, 500))
  } finally {
    operation?.release()
  }
}

function assertEnabled(runtime: MagpieRuntime, label: string) {
  if (runtime.store.value.webSearch?.enabled === false) throw new Error(`${label} is disabled.`)
}

export function createNativeSearchProvider(runtime: MagpieRuntime, isSelected: () => boolean): WebSearchProvider {
  return {
    id: MAGPIE_WEB_PROVIDER,
    title: 'Magpie Web Search',
    // An unselected provider must not participate in DSH's automatic provider resolution.
    available: isSelected,
    async ready() { return runtime.store.value.webSearch?.enabled !== false },
    async search({ query, maxResults }, signal) {
      const content = await search(runtime, query, signal, undefined, maxResults)
      return { content, sources: searchSources(content), truncated: false }
    },
  }
}

export function createNativeFetchProvider(runtime: MagpieRuntime, isSelected: () => boolean): WebFetchProvider {
  return {
    id: MAGPIE_FETCH_PROVIDER,
    title: 'Magpie Web Fetch',
    available: isSelected,
    async ready() { return runtime.store.value.webSearch?.enabled !== false },
    async fetch({ url }, signal) {
      const target = publicWebUrl(url)
      if (!target) throw new Error('Magpie web fetch requires an HTTP(S) URL without credentials.')
      const result = await callWebTool(runtime, 'web fetch', (operation, requestSignal) => runtime.transport.fetchWeb(operation, target.href, requestSignal), signal)
      const match = /^URL: (\S+)\r?\n(?:Title: ([^\r\n]*)\r?\n)?\r?\n/.exec(result)
      const finalUrl = match?.[1] && publicWebUrl(match[1])
      const body = match ? result.slice(match[0].length) : result
      const truncated = FETCH_CONTINUATION.test(body)
      const content = body.replace(FETCH_CONTINUATION, '')
      // MCP returns rendered text and a redirect URL. HTTP failures arrive as tool errors.
      return {
        url: finalUrl ? finalUrl.href : target.href,
        statusCode: 200,
        body: { kind: 'text', content: match?.[2] ? `${match[2]}\n\n${content}` : content },
        truncated,
      }
    },
  }
}

function publicWebUrl(value: string): URL | undefined {
  try {
    const url = new URL(value)
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url
  } catch { /* Invalid URL. */ }
}

function searchSources(content: string): WebSearchSource[] {
  const sources = new Map<string, WebSearchSource>()
  // Search APIs render numbered `title — URL` rows. Model searchers may include Markdown links.
  for (const pattern of [/^\d+\. (.+?) — (https?:\/\/\S+)\s*$/gm, /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g]) {
    for (const [, title, href] of content.matchAll(pattern)) {
      const url = href && publicWebUrl(href)
      if (url && !sources.has(url.href)) sources.set(url.href, { url: url.href, ...(title ? { title } : {}) })
    }
  }
  return [...sources.values()]
}

export async function readGatewaySearch(runtime: MagpieRuntime): Promise<GatewaySearchView> {
  let operation: Operation | undefined
  try {
    operation = await runtime.beginOperation()
    if (!operation.baseUrl || !operation.key) return { status: 'unconfigured' }
    const response = await runtime.transport.listWebSearchTools(operation, AbortSignal.timeout(5000))
    if (!response.ok) {
      await response.body?.cancel()
      return { status: response.status === 401 || response.status === 403 ? 'forbidden' : response.status === 404 || response.status === 405 ? 'unavailable' : 'error' }
    }
    const reply = await response.json() as { jsonrpc?: unknown; id?: unknown; result?: { tools?: { name?: unknown; inputSchema?: { properties?: Record<string, unknown> } }[] } } | null
    const tools = reply?.result?.tools
    if (reply?.jsonrpc !== '2.0' || reply.id !== 1 || !Array.isArray(tools)) return { status: 'error' }
    const tool = tools.find(item => item?.name === 'web_search')
    if (!tool) return { status: 'unavailable' }
    const properties = tool.inputSchema?.properties
    const count = (properties?.count as { default?: unknown } | undefined)?.default
    const scopes = (['allowed_domains', 'blocked_domains', 'recency_days'] as const).filter(name => properties?.[name] !== undefined)
    return { status: 'ok', ...(isSearchCount(count) ? { count } : {}), fetch: tools.some(item => item?.name === 'web_fetch'), scopes }
  } catch { return { status: 'error' } }
  finally { operation?.release() }
}
