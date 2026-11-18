// @vitest-environment jsdom
import { expect, test } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { MagpieSettings } from '../src/client/SettingsPage.js'
import { DEFAULT_WEB_SEARCH, type WebSearchSettings } from '../src/shared/web-search.js'
import { fakeApi, flush, ok, settingsView } from './client-support/fake-api.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

test('search settings save independently and open the management page on the configured host', async () => {
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  let webSearch = DEFAULT_WEB_SEARCH
  const view = () => settingsView({
    webSearch, activeLineId: 'a1b2c3d4',
    lines: [{ id: 'a1b2c3d4', baseUrl: 'https://gateway.example/proxy/v1' }],
  })
  const fake = fakeApi({
    'GET settings': () => ok(view()),
    'GET cards': () => ok({ status: 'ok', cards: [] }),
    'GET latency': () => ok({}),
    'POST settings': ({ body }) => {
      webSearch = { ...webSearch, ...(body as { webSearch: Partial<WebSearchSettings> }).webSearch }
      return ok(view())
    },
  })
  try {
    await act(async () => root.render(h(MagpieSettings, { api: fake.api } as never)))
    await flush()
    const panel = host.querySelector('[data-web-search]')!
    expect(panel.querySelector('a')?.href).toBe('https://gateway.example/proxy/?view=settings&tab=models')
    const count = panel.querySelector('select')!
    await act(async () => {
      count.value = '6'
      count.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const toggle = panel.querySelector<HTMLButtonElement>('[data-web-search-switch]')!
    await act(async () => toggle.click())
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(count.disabled).toBe(true)
    const input = panel.querySelector('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://admin.example/')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => panel.querySelector<HTMLButtonElement>('[data-web-search-save-url]')!.click())
    expect(panel.querySelector('a')?.href).toBe('https://admin.example/?view=settings&tab=models')
    expect(fake.calls.filter(call => call.method === 'POST').map(call => call.body)).toEqual([
      { webSearch: { count: 6 } }, { webSearch: { enabled: false } }, { webSearch: { adminUrl: 'https://admin.example/' } },
    ])
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
