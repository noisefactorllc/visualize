// SPDX-License-Identifier: MIT
import { defineConfig } from '@playwright/test'

const port = Number(process.env.PW_PORT || 3070)
const host = process.env.PW_PORT ? '127.0.0.1' : 'localhost'
// Sandboxed runners (supervisor test gates, the macOS host broker) route all
// egress through an HTTP proxy and deny direct sockets: Chromium on macOS
// ignores proxy environment variables, so it must be told the proxy
// explicitly, or every CDN fetch (fonts, shaders, handfish, engine) fails
// with ERR_ACCESS_DENIED and each test burns its boot budget. The loopback
// dev server stays direct. Playwright's bypass list is comma-separated.
const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy || ''
const proxy = proxyServer
    ? {
        server: proxyServer,
        bypass: [...new Set([
            'localhost', '127.0.0.1',
            ...(process.env.NO_PROXY || '').split(',').map(s => s.trim()).filter(Boolean),
        ])].join(','),
    }
    : undefined

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
        baseURL: `http://${host}:${port}`,
        proxy,
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
            channel: process.env.PW_CHANNEL,
            args: [
                '--use-fake-ui-for-media-stream',
                '--use-fake-device-for-media-stream',
                ...(process.env.PW_GPU_ARGS ? process.env.PW_GPU_ARGS.split(' ') : []),
            ],
        },
    },
    webServer: {
        // Robust static server (survives aborted sockets under parallel
        // workers); http-server crashes on unhandled socket errors.
        command: `node scripts/dev-server.cjs ${port}`,
        port,
        reuseExistingServer: true,
        timeout: 30_000,
    },
})
