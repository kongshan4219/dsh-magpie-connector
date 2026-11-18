import type { SettingsForms, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type { DshSearchSelection } from '../shared/web-search.js'
import type { MagpieRuntime } from './runtime.js'
import { MAGPIE_WEB_PROVIDER, MAGPIE_FETCH_PROVIDER } from './web-search.js'

type DshSettings = Pick<SettingsForms, 'describe' | 'mutate' | 'writable'>
const namespace = 'web'
const providers = [
  { field: 'searchProvider', id: MAGPIE_WEB_PROVIDER, snapshot: 'webSearchPreviousProvider' },
  { field: 'fetchProvider', id: MAGPIE_FETCH_PROVIDER, snapshot: 'webFetchPreviousProvider' },
] as const

function providerId(value: unknown, field: typeof providers[number]['field']): string | undefined {
  const id = (value as Partial<Record<typeof field, unknown>> | null)?.[field]
  return typeof id === 'string' ? id : undefined
}

/** The DSH web configuration owns both native tool provider selections. */
export class SearchSelection {
  private settings: DshSettings | undefined
  searchSelected = false
  fetchSelected = false

  constructor(private readonly runtime: MagpieRuntime) {}

  bind(settings: DshSettings) {
    this.settings = settings
    this.read()
    return () => { this.settings = undefined; this.searchSelected = this.fetchSelected = false }
  }

  private entry() {
    const entry = this.settings?.describe({ redactSecrets: true }).find(descriptor => descriptor.ns === namespace)
    this.searchSelected = providerId(entry?.value, 'searchProvider') === MAGPIE_WEB_PROVIDER
    this.fetchSelected = providerId(entry?.value, 'fetchProvider') === MAGPIE_FETCH_PROVIDER
    return entry
  }

  read(): DshSearchSelection {
    const entry = this.entry()
    return { selected: this.searchSelected && this.fetchSelected, writable: !!entry && this.settings?.writable === true }
  }

  async select(next: boolean) {
    const settings = this.settings
    const entry = this.entry()
    const changed = providers.filter(({ field, id }) => (providerId(entry?.value, field) === id) !== next)
    if (!changed.length) return
    if (!settings?.writable || !entry) throw new Error('DSH web provider settings are unavailable.')

    const edits: SettingsPathOp[] = []
    const snapshots: Partial<Record<typeof providers[number]['snapshot'], string | null>> = {}
    for (const { field, id, snapshot } of changed) {
      const path = [field]
      if (next) {
        snapshots[snapshot] = providerId(entry.user, field) ?? null
        edits.push({ op: 'set', path, value: id })
      } else {
        const previous = this.runtime.store.value[snapshot]
        edits.push(typeof previous === 'string' && previous !== id
          ? { op: 'set', path, value: previous } : { op: 'unset', path })
      }
    }
    if (next) {
      this.runtime.writeSettings(snapshots)
    }
    await settings.mutate(namespace, edits, entry.revision)
    // The live settings event also picks up edits made in DSH's own settings page.
    this.read()
  }
}
