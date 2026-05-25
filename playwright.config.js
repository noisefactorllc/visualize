// SPDX-License-Identifier: MIT
import { defineConfig } from '@playwright/test'

export default defineConfig({
    testDir: './tests',
    timeout: 60_000,
    use: {
        baseURL: 'http://localhost:3070',
        // Fake audio + video devices so the audio spec can exercise the
        // real getUserMedia / AudioContext / Analyser path against a
        // deterministic synthetic mic. --use-fake-ui-for-media-stream
        // auto-grants permission so we don't hang on the OS prompt.
        launchOptions: {
            args: [
                '--use-fake-ui-for-media-stream',
                '--use-fake-device-for-media-stream',
            ],
        },
    },
    webServer: {
        command: 'npx http-server . -p 3070 -c-1',
        port: 3070,
        reuseExistingServer: true,
        timeout: 30_000,
    },
})
