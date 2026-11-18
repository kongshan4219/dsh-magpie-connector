export const MAX_SEARCH_RESULTS = 20

export interface WebSearchSettings {
  enabled: boolean
  count: number | null
  adminUrl: string
}

export const DEFAULT_WEB_SEARCH: WebSearchSettings = { enabled: true, count: null, adminUrl: '' }

export const isSearchCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_SEARCH_RESULTS

export function normalizeSearchAdminUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid webSearch.adminUrl')
  if (!value.trim()) return ''
  const url = new URL(value.trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid webSearch.adminUrl')
  url.search = ''
  url.hash = ''
  return url.href
}

/** Use the active API line's origin and reverse-proxy prefix when the GUI URL is unset. */
export function searchAdminLink(adminUrl: string, activeBaseUrl?: string): string | undefined {
  try {
    const base = normalizeSearchAdminUrl(adminUrl)
    if (!base && !activeBaseUrl) return undefined
    const url = new URL(base || normalizeSearchAdminUrl(activeBaseUrl))
    if (!base) url.pathname = url.pathname.replace(/\/v\d+\/?$/, '/')
    url.search = new URLSearchParams({ view: 'settings', tab: 'models' }).toString()
    return url.href
  } catch { return undefined }
}
