import { test, expect } from '@playwright/test'
import { launchApp, type RunningApp } from './app'

let running: RunningApp

test.beforeAll(async () => {
  running = await launchApp()
})

test.afterAll(async () => {
  await running?.close()
})

test('opens on a fresh profile without errors', async () => {
  const { page, errors } = running
  await expect(page.getByText('Calendars', { exact: true }).first()).toBeVisible()
  expect(errors).toEqual([])
})

test('keeps account credentials out of the renderer', async () => {
  const keys = await running.page.evaluate(async () => Object.keys(await window.xrncal.settings.getAll()))
  expect(keys).toContain('timeFormat')
  expect(keys.some((k) => k.startsWith('token:'))).toBe(false)
})

test('finds an event without its accents, edits it in its own zone, and recolours it', async () => {
  const { page } = running
  // 13:00Z on 15 January: 08:00 in New York, 20:00 here (UTC+7).
  const id = await page.evaluate(async () => {
    const created = await window.xrncal.events.create({
      calendarId: 'calendar-local-default',
      title: 'Họp phụ huynh New York',
      dtStartUtc: '2026-01-15T13:00:00.000Z',
      dtEndUtc: '2026-01-15T14:00:00.000Z',
      tzid: 'America/New_York'
    })
    return created.id
  })

  // The shortcut, not the header's Search button: the header auto-hides 150 ms
  // after load, and clicking into it raced its slide-in and out.
  await page.keyboard.press('Control+k')
  await page.getByPlaceholder(/Search events by title/).fill('hop phu')
  await page.getByText('Họp phụ huynh New York').first().click()

  const startRow = page.locator('div.group', { hasText: 'Start' }).first()
  await expect(startRow.getByRole('textbox')).toHaveValue('08:00')
  const zoneRow = page.locator('div.group', { hasText: 'Time zone' }).first()
  await expect(zoneRow).toContainText('America/New York')
  await expect(zoneRow).toContainText('20:00')

  // Same clock time, another zone: 08:00 in Bangkok (UTC+7) is 01:00Z.
  await zoneRow.locator('button[aria-haspopup="listbox"]').click()
  await page.getByPlaceholder('Search…').fill('Bangkok')
  await page.getByRole('button', { name: /Asia\/Bangkok/ }).click()
  await page.getByRole('button', { name: 'Tomato' }).click()
  await page.keyboard.press('Control+Enter')

  await expect
    .poll(async () => page.evaluate(async (eventId) => (await window.xrncal.events.getById(eventId))?.event, id))
    .toMatchObject({ dtStartUtc: '2026-01-15T01:00:00.000Z', tzid: 'Asia/Bangkok', color: '#d50000' })
})
