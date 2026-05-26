// SPDX-License-Identifier: MIT
import { defineConfig } from '@playwright/test'

export default defineConfig({
    testDir: './tests',
    timeout: 60_000,
    // These specs each spin up headless WebGL contexts and fetch the
    // shader bundle from a CDN; running them concurrently produces
    // GPU/bandwidth contention that flakes the audio ramp-up and the
    // boot-time program load. One worker keeps both runs honest.
    workers: 1,
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
