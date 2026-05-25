// SPDX-License-Identifier: MIT
import { defineConfig } from '@playwright/test'

export default defineConfig({
    testDir: './tests',
    timeout: 60_000,
    use: {
        baseURL: 'http://localhost:3070',
    },
    webServer: {
        command: 'npx http-server . -p 3070 -c-1',
        port: 3070,
        reuseExistingServer: true,
        timeout: 30_000,
    },
})
