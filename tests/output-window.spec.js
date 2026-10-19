// SPDX-License-Identifier: MIT
/**
 * Output window: when the browser blocks the pop-up, the app says so in
 * its own toast. It never opens a built-in browser dialog.
 */
import { test, expect } from '@playwright/test'
import { installHandfishLocal } from './handfishLocal.js'
const SCALE = Number(process.env.PW_TIMEOUT_SCALE || '1')

installHandfishLocal(test)

test('a blocked output pop-up shows a toast, not a browser dialog', async ({ page }) => {
    const dialogs = []
    page.on('dialog', async (dialog) => {
        dialogs.push(`${dialog.type()}: ${dialog.message()}`)
        await dialog.dismiss()
    })
    // A blocked pop-up: window.open returns null.
    await page.addInitScript(() => { window.open = () => null })

    await page.goto('/')
    await expect(page.locator('#toast')).toContainText('ready', { timeout: 30_000 * SCALE })

    await page.click('#output-window')
    await expect(page.locator('#toast')).toContainText('Output window blocked')
    await expect(page.locator('#toast')).toHaveClass(/show/)
    expect(dialogs).toEqual([])
})
