import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { MagpieRuntime, Operation } from './runtime.js'
import { isSearchCount, MAX_SEARCH_RESULTS } from '../shared/web-search.js'

const SEARCH_TIMEOUT_MS = 60_000

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
      if (runtime.store.value.webSearch?.enabled === false) throw new Error('Magpie web search is disabled.')

      const deadline = AbortSignal.timeout(SEARCH_TIMEOUT_MS)
      const searchSignal = AbortSignal.any([signal, deadline])
      let operation: Operation | undefined
      try {
        searchSignal.throwIfAborted()
        operation = await runtime.beginOperation()
        searchSignal.throwIfAborted()
        const preferences = runtime.store.value.webSearch
        if (preferences?.enabled === false) throw new Error('Magpie web search is disabled.')
        if (!operation.baseUrl || !operation.key) throw new Error('Configure a Magpie gateway line before searching.')
        const count = requestedCount ?? (isSearchCount(preferences?.count) ? preferences.count : undefined)
        const response = await runtime.transport.searchWeb(operation, { query, ...(count === undefined ? {} : { count }) }, searchSignal)
        if (!response.ok) {
          await response.body?.cancel()
          const detail = response.status === 404 ? ' Check that the gateway or reverse proxy serves /mcp/magpie/web-search.' : ''
          throw new Error(`Magpie web search returned HTTP ${response.status}.${detail}`)
        }
        const reply = await response.json() as {
          jsonrpc?: unknown
          id?: unknown
          error?: { message?: unknown }
          result?: { isError?: boolean; content?: { type?: unknown; text?: unknown }[] }
        } | null
        if (reply?.jsonrpc !== '2.0' || reply.id !== 1) throw new Error('Invalid Magpie web search response.')
        if (reply.error) throw new Error(typeof reply.error.message === 'string' ? reply.error.message : 'Magpie web search failed.')
        const { content, isError } = reply.result ?? {}
        const result = Array.isArray(content) ? content.flatMap(item => item?.type === 'text' && typeof item.text === 'string' ? [item.text] : []).join('\n') : ''
        if (isError) throw new Error(result || 'Magpie web search failed.')
        if (!result.trim()) throw new Error('Magpie web search returned no result text.')
        return runtime.redact(result)
      } catch (error) {
        signal.throwIfAborted()
        if (deadline.aborted) throw new Error('Magpie web search timed out after 60 seconds.')
        throw new Error(runtime.redact(error instanceof Error ? error.message : String(error)).slice(0, 500))
      } finally {
        operation?.release()
      }
    },
  }
}
