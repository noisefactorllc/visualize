// SPDX-License-Identifier: MIT
import { defineConfig } from '@playwright/test'

export default defineConfig({
    testDir: './tests',
    timeout: 60_000,
    use: {
        baseURL: 'http://localhost:3007',
    },
    webServer: {
        command: 'npx http-server . -p 3007 -c-1',
        port: 3007,
        reuseExistingServer: true,
        timeout: 30_000,
    },
})
