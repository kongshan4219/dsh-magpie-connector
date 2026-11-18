import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-web'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { MagpieRuntime } from './host/runtime.js'
import { MagpieAdapter } from './host/adapter.js'
import { SettingsStore } from './host/settings.js'
import { registerRoutes } from './host/routes.js'
import { SpeedController } from './host/speed.js'
import { createDisposer } from './host/dispose.js'
import { createRouteRegistrar, type RouteRegistrar } from './host/registrar.js'
import { isMagpieRoute } from './host/catalog.js'
import { createNativeFetchProvider, createNativeSearchProvider, createWebSearchTool } from './host/web-search.js'
import { SearchSelection } from './host/search-selection.js'
export { MagpieRuntime, lineCredentialRefs, lineIdOfCredentialRef } from './host/runtime.js'
export { MagpieAdapter, mapUsage } from './host/adapter.js'
export { SettingsStore } from './host/settings.js'
export { GatewayTransport } from './host/transport.js'
export { createRouteRegistrar, type RouteRegistrar, type PublishResult } from './host/registrar.js'
export { TRANSPORT_ID, ownerKey, ownerLabel, routeOf, isMagpieRoute } from './host/catalog.js'
export const name = 'dsh-magpie-connector'
export const inject = ['llm', 'credentials']
export interface Config { home?: string }
export function apply(ctx: Context, config: Config = {}) {
  const home = config.home ?? process.env.DSH_HOME ?? resolve(homedir(), '.dsh')
  // Declared first, assigned below: the runtime's publish callback and the adapter reference each other.
  let adapter!: MagpieAdapter
  let registrar!: RouteRegistrar
  const runtime = new MagpieRuntime(ctx.credentials, new SettingsStore(resolve(home, 'plugins/dsh-magpie-connector/settings.json')), routes => registrar.publish(routes ?? runtime.routeSet()))
  const speed = new SpeedController()
  const searchSelection = new SearchSelection(runtime)
  adapter = new MagpieAdapter(runtime, ctx.get('attachments'), session => speed.get(session).tier === 'fast')
  registrar = createRouteRegistrar(ctx.llm, adapter)
  ctx.on('credentials/reference-updated', ref => runtime.invalidateCredential(ref))
  ctx.inject(['connection'], child => {
    child.effect(() => registerRoutes(child.connection.fetch, runtime, speed, undefined, undefined, undefined, searchSelection).dispose)
  })
  ctx.inject(['web', 'settings'], child => {
    const web = child.get('web')
    const settings = child.get('settings')
    if (!web || !settings || typeof web.registerFetchProvider !== 'function') return
    child.effect(() => searchSelection.bind(settings))
    child.effect(() => web.registerSearchProvider(createNativeSearchProvider(runtime, () => searchSelection.searchSelected)))
    child.effect(() => web.registerFetchProvider(createNativeFetchProvider(runtime, () => searchSelection.fetchSelected)))
    child.on('settings/document-updated', namespace => {
      if (namespace === 'web') searchSelection.read()
    })
  })
  ctx.inject(['tools'], child => {
    const tools = child.get('tools')
    if (typeof tools?.resolve === 'function') child.effect(() => tools.register(createWebSearchTool(runtime), {
      when: ({ modelSelection }) => isMagpieRoute(modelSelection.provider) && runtime.store.value.webSearch?.enabled !== false && !searchSelection.searchSelected,
    }))
  })
  const dispose = createDisposer(runtime, [() => registrar.dispose()])
  ctx.effect(() => dispose)
  void runtime.start().catch(() => {})
  return { runtime, adapter, routes: registrar }
}
