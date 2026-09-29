// SPDX-License-Identifier: MIT
import { defineConfig } from '@playwright/test'

export default defineConfig({
    testDir: './tests',
    testIgnore: '**/*.node-test.js',
    // PW_TIMEOUT_SCALE scales the suite's timing budgets for constrained
    // CI containers (SwiftShader + CPU emulation) without touching any
    // assertion, case, or tolerance; unset it defaults to 1.
    timeout: 120_000 * Number(process.env.PW_TIMEOUT_SCALE || '1'),
    expect: { timeout: 5_000 * Number(process.env.PW_TIMEOUT_SCALE || '1') },
    // No automatic retries: per-spec retries are unchanged from the base
    // suite; the constrained-container recovery pass lives in scripts/test.cjs.
    retries: 0,
    // These specs each spin up headless WebGL contexts and fetch the
    // shader bundle from a CDN; running them concurrently produces
    // GPU/bandwidth contention that flakes the audio ramp-up and the
    // boot-time program load. scripts/test.cjs overrides per invocation
    // (scripts/test.cjs runs the suite serially); direct runs stay serial.
    workers: 1,
    use: {
        baseURL: 'http://localhost:3070',
        // PW_VIEWPORT=WxH scales the render surface for constrained CI
        // containers (SwiftShader cost is proportional to pixels); unset
        // keeps the standard 1280x720 desktop viewport.
        viewport: process.env.PW_VIEWPORT
            ? (([w, h]) => ({ width: Number(w), height: Number(h) }))(process.env.PW_VIEWPORT.split('x'))
            : { width: 1280, height: 720 },
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
        // Robust static server (survives aborted sockets under parallel
        // workers); http-server crashes on unhandled socket errors.
        command: 'node scripts/dev-server.cjs 3070',
        port: 3070,
        reuseExistingServer: true,
        timeout: 30_000,
    },
})
