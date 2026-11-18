// @vitest-environment jsdom
import { expect, test } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { MagpieSettings } from '../src/client/SettingsPage.js'
import { DEFAULT_WEB_SEARCH, type WebSearchSettings } from '../src/shared/web-search.js'
import { fakeApi, flush, ok, settingsView } from './client-support/fake-api.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

test('search settings load gateway defaults and toggle the native providers', async () => {
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  let webSearch = DEFAULT_WEB_SEARCH
  let selected = false
  const view = () => settingsView({
    webSearch, activeLineId: 'a1b2c3d4', dshSearch: { selected, writable: true },
    lines: [{ id: 'a1b2c3d4', baseUrl: 'https://gateway.example/proxy/v1' }],
  })
  const fake = fakeApi({
    'GET settings': () => ok(view()),
    'GET cards': () => ok({ status: 'ok', cards: [] }),
    'GET latency': () => ok({}),
    'GET web-search': () => ok({ status: 'ok', count: 7, fetch: true, scopes: ['allowed_domains'] }),
    'POST settings': ({ body }) => {
      const patch = body as { webSearch?: Partial<WebSearchSettings>; replaceDshSearch?: boolean }
      webSearch = { ...webSearch, ...patch.webSearch }
      selected = patch.replaceDshSearch ?? (webSearch.enabled && selected)
      return ok(view())
    },
  })
  try {
    await act(async () => root.render(h(MagpieSettings, { api: fake.api } as never)))
    await flush()
    const panel = host.querySelector('[data-web-search]')!
    expect(panel.querySelector('[data-gateway-search-count]')?.textContent).toContain('7')
    expect(panel.querySelector('input')).toBeNull()
    const count = panel.querySelector('select')!
    await act(async () => {
      count.value = '6'
      count.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const replace = panel.querySelector<HTMLButtonElement>('[data-web-search-replace]')!
    expect(replace.disabled).toBe(false)
    expect(replace.getAttribute('role')).toBe('switch')
    expect(replace.getAttribute('aria-checked')).toBe('false')
    await act(async () => replace.click())
    expect(replace.getAttribute('aria-checked')).toBe('true')
    expect(selected).toBe(true)
    await act(async () => replace.click())
    expect(replace.getAttribute('aria-checked')).toBe('false')
    await act(async () => replace.click())
    const toggle = panel.querySelector<HTMLButtonElement>('[data-web-search-switch]')!
    await act(async () => toggle.click())
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(count.disabled).toBe(true)
    expect(replace.disabled).toBe(true)
    expect(selected).toBe(false)
    expect(fake.calls.filter(call => call.method === 'POST').map(call => call.body)).toEqual([
      { webSearch: { count: 6 } }, { replaceDshSearch: true }, { replaceDshSearch: false }, { replaceDshSearch: true }, { webSearch: { enabled: false } },
    ])
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
