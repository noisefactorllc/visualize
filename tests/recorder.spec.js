// SPDX-License-Identifier: MIT
/**
 * Recorder: a recording stopped before the browser captured any video holds
 * no data. No file is saved for it, and the app says so in its own toast.
 * It never opens a built-in browser dialog.
 */
import { test, expect } from '@playwright/test'
import { installHandfishLocal } from './handfishLocal.js'
const SCALE = Number(process.env.PW_TIMEOUT_SCALE || '1')

installHandfishLocal(test)

test('a recording stopped at once says it was too short to save and saves no file', async ({ page }) => {
    const downloads = []
    page.on('download', download => downloads.push(download.suggestedFilename()))
    const dialogs = []
    page.on('dialog', async (dialog) => {
        dialogs.push(`${dialog.type()}: ${dialog.message()}`)
        await dialog.dismiss()
    })

    await page.goto('/')
    await expect(page.locator('#toast')).toContainText('ready', { timeout: 30_000 * SCALE })

    // Start and stop with the record button in one task, before the
    // browser's MediaRecorder can capture a frame.
    await page.evaluate(() => {
        const button = document.getElementById('record-toggle')
        button.click()
        button.click()
    })
    await expect(page.locator('#toast')).toHaveText('recording too short to save')
    await expect(page.locator('#toast')).toHaveClass(/show/)
    await expect(page.locator('#record-toggle')).toHaveAttribute('data-state', 'off')
    // A saved recording downloads in the same task that ends it; give its
    // download event time to arrive before checking that none did.
    await page.waitForTimeout(1000)
    expect(downloads).toEqual([])
    expect(dialogs).toEqual([])
})
