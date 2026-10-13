// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs'
const legacy = JSON.parse(readFileSync(new URL('./fixtures/legacy-programs.json', import.meta.url)))

// Rebind and round-trip tests keep their known input programs independent of the catalog.
export async function routeLegacyPrograms(page) {
    await page.route('**/data/programs.json', async route => {
        const response = await route.fetch()
        const programs = await response.json()
        await route.fulfill({ response, json: [...programs, ...legacy] })
    })
}
