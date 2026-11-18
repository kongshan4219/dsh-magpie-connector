export const MAX_SEARCH_RESULTS = 20

export interface WebSearchSettings {
  enabled: boolean
  count: number | null
}

export const DEFAULT_WEB_SEARCH: WebSearchSettings = { enabled: true, count: null }

export interface DshSearchSelection {
  selected: boolean
  writable: boolean
}

export interface GatewaySearchView {
  status: 'ok' | 'unconfigured' | 'unavailable' | 'forbidden' | 'error'
  count?: number
  fetch?: boolean
  scopes?: ('allowed_domains' | 'blocked_domains' | 'recency_days')[]
}

export const isSearchCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_SEARCH_RESULTS
