// SPDX-License-Identifier: MIT
//
// Regression test for Sync's top-level document contract
// (sync docs/developers.md "Pair from a user action", browser/README.md):
// the application's own server must serve
// `Permissions-Policy: loopback-network=(self)` on every response, so the
// SDK's loopback-network permission query reflects this origin instead of
// dead-ending on an undelegated feature. scripts/dev-server.cjs is the
// application's own server — the documented `npm run dev` local-dev server
// and the Playwright webServer — so it carries the header on success and
// error responses alike (200, 403, 404, and the recovery-path 500).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import http from 'node:http'

const require = createRequire(import.meta.url)
// Bind the same permitted loopback ports the test entrypoint itself uses:
// restricted runners reject every bind outside their fixed range, so an
// ephemeral port-0 bind EPERMs there and the server never listens.
const { parsePortRange, probePort } = require('../scripts/test.cjs')

function request(port, urlPath, method = 'GET') {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port, path: urlPath, method },
            res => {
                const body = []
                res.on('data', chunk => body.push(chunk))
                res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }))
            }
        )
        req.on('error', reject)
        req.end()
    })
}

let sharedPort = null

async function bindablePort() {
    if (sharedPort !== null && await probePort(sharedPort)) return sharedPort
    const candidates = [...new Set([
        ...(process.env.PW_PORT ? [Number(process.env.PW_PORT)] : []),
        3070,
        ...parsePortRange(process.env.PW_TEST_LOOPBACK_PORTS || '43117-43126')
    ])]
    for (const port of candidates) {
        if (await probePort(port)) {
            sharedPort = port
            return port
        }
    }
    return null
}

async function startServer(root, port) {
    const child = spawn(process.execPath, [path.join('scripts', 'dev-server.cjs'), String(port), root], {
        cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
        stdio: ['ignore', 'pipe', 'inherit']
    })
    // A bounded wait keeps a bind failure (EPERM on an exhausted permitted
    // range) a visible failure instead of a hung suite.
    let output = ''
    const reported = new Promise(resolve => child.stdout.on('data', data => {
        output += String(data)
        if (/http:\/\/localhost:\d+/.test(output)) resolve(output)
    }))
    const bound = await Promise.race([
        reported,
        new Promise((_, reject) => setTimeout(() => reject(new Error(
            `dev-server reported no port within 15s; output: ${output}`
        )), 15000).unref())
    ])
    const match = /http:\/\/localhost:(\d+)/.exec(bound)
    assert.ok(match, `dev-server must report its bound port, got: ${output}`)
    return { child, port: Number(match[1]) }
}

test('dev-server serves the Sync loopback-network policy on the app document', async t => {
    const port = await bindablePort()
    if (!port) return t.skip('no bindable loopback port in the permitted range')
    const root = await mkdtemp(path.join(tmpdir(), 'dev-server-root-'))
    try {
        await writeFile(path.join(root, 'index.html'), '<!doctype html>')
        const { child, port: bound } = await startServer(root, port)
        try {
            const page = await request(bound, '/')
            assert.equal(page.status, 200)
            assert.equal(page.headers['permissions-policy'], 'loopback-network=(self)')
        } finally {
            child.kill()
            await once(child, 'exit')
        }
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})

test('dev-server serves the Sync loopback-network policy on error responses', async t => {
    const port = await bindablePort()
    if (!port) return t.skip('no bindable loopback port in the permitted range')
    const root = await mkdtemp(path.join(tmpdir(), 'dev-server-root-'))
    try {
        const { child, port: bound } = await startServer(root, port)
        try {
            const missing = await request(bound, '/missing-file.js')
            assert.equal(missing.status, 404)
            assert.equal(missing.headers['permissions-policy'], 'loopback-network=(self)')
        } finally {
            child.kill()
            await once(child, 'exit')
        }
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})

test('dev-server serves the Sync loopback-network policy on the recovery 500', async t => {
    const port = await bindablePort()
    if (!port) return t.skip('no bindable loopback port in the permitted range')
    const root = await mkdtemp(path.join(tmpdir(), 'dev-server-root-'))
    try {
        const { child, port: bound } = await startServer(root, port)
        try {
            // An invalid percent-escape throws in the handler's URL decode,
            // exercising the catch-path 500 response.
            const broken = await request(bound, '/%')
            assert.equal(broken.status, 500)
            assert.equal(broken.headers['permissions-policy'], 'loopback-network=(self)')
        } finally {
            child.kill()
            await once(child, 'exit')
        }
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})

test('the documented npm run dev serves the app through the header-carrying server', () => {
    const pkg = require('../package.json')
    assert.match(pkg.scripts.dev, /dev-server\.cjs/)
})