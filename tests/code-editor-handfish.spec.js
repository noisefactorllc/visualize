// SPDX-License-Identifier: MIT
import { test, expect } from '@playwright/test'
import { installHandfishLocal } from './handfishLocal.js'

installHandfishLocal(test)

test('deck editors use Handfish public editor APIs directly', async ({ page }) => {
    await page.goto('/')
    await page.click('#boot-start')

    await page.waitForFunction(() =>
        ['A', 'B'].every((deckId) => {
            const editor = document.querySelector(`.deck[data-deck="${deckId}"] code-editor`)
            return editor &&
                typeof editor.getTextarea === 'function' &&
                editor.getTextarea() &&
                typeof editor.setTokenizer === 'function' &&
                typeof editor.flashLines === 'function'
        }),
    null,
    { timeout: 30_000 })

    const states = await page.evaluate(() => {
        return ['A', 'B'].map((deckId) => {
            const editor = document.querySelector(`.deck[data-deck="${deckId}"] code-editor`)
            const textarea = editor.getTextarea()
            let forceRecompileCount = 0

            editor.addEventListener('forcerecompile', () => {
                forceRecompileCount += 1
            })
            textarea.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter',
                ctrlKey: true,
                bubbles: true,
                cancelable: true,
            }))

            return {
                deckId,
                hasFlashLines: typeof editor.flashLines === 'function',
                hasSetTokenizer: typeof editor.setTokenizer === 'function',
                appLocalEnhanced: Boolean(editor._polymorphicEnhanced),
                forceRecompileCount,
            }
        })
    })

    expect(states).toEqual([
        {
            deckId: 'A',
            hasFlashLines: true,
            hasSetTokenizer: true,
            appLocalEnhanced: false,
            forceRecompileCount: 1,
        },
        {
            deckId: 'B',
            hasFlashLines: true,
            hasSetTokenizer: true,
            appLocalEnhanced: false,
            forceRecompileCount: 1,
        },
    ])
})
