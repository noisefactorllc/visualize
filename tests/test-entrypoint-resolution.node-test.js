// SPDX-License-Identifier: MIT
//
// Regression tests for the test entrypoint's browser resolution
// (scripts/test.cjs): Playwright resolves the chromium headless shell by the
// exact revision pinned in the installed playwright-core's browsers.json, so
// a PLAYWRIGHT_BROWSERS_ROOT holding builds for a different Playwright version
// (an ops-managed browsers directory, another product's cache) must NOT
// satisfy the lookup — every launch would fail with "Executable doesn't
// exist" — and the entrypoint must fall back to the platform default cache.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const {
    BUILDS,
    buildForChannel,
    canExecute,
    defaultBrowsersRoot,
    findChromiumForRevision,
    findLaunchBinary,
    findShellForRevision,
    parsePortRange,
    pickPwPort,
    probePort,
    requiredRevision,
    requiredShellRevision
} = require('../scripts/test.cjs')
const { chromium } = require('playwright-core')
const SHELL = BUILDS['chromium-headless-shell']

// A browsers root holding a full Chromium build of `revision`, with the
// executable at the path playwright-core expects inside the build.
async function fakeChromiumRoot(revision) {
    const root = await mkdtemp(path.join(tmpdir(), 'pw-root-'))
    const parts = chromium.executablePath().split(path.sep)
    const inBuild = parts.slice(parts.findIndex(part => /^chromium-\d+$/.test(part)) + 1)
    const bin = path.join(root, `chromium-${revision}`, ...inBuild)
    await mkdir(path.dirname(bin), { recursive: true })
    await writeFile(bin, '#!/bin/sh\n')
    return { root, bin }
}

async function fakeShellRoot(revision) {
    const root = await mkdtemp(path.join(tmpdir(), 'pw-root-'))
    const binDir = path.join(root, `chromium_headless_shell-${revision}`, 'chrome-headless-shell-testarch')
    await mkdir(binDir, { recursive: true })
    const bin = path.join(binDir, 'chrome-headless-shell')
    await writeFile(bin, '#!/bin/sh\n')
    return { root, bin }
}

test('the required headless shell revision comes from the installed playwright-core', () => {
    const revision = requiredShellRevision()
    assert.ok(revision && /^\d+$/.test(revision), `unexpected revision: ${revision}`)
})

test('a root with only a different browser revision does not satisfy the lookup', async () => {
    const revision = requiredShellRevision()
    const stale = await fakeShellRoot('9999')
    try {
        assert.equal(findShellForRevision(stale.root, revision), null)
        assert.equal(findShellForRevision(stale.root, '9999'), stale.bin)
        assert.equal(findLaunchBinary(stale.root, SHELL), null,
            'a wrong-revision shell must not be accepted as the launch binary')
    } finally {
        await rm(stale.root, { recursive: true, force: true })
    }
})

test('the required revision resolves wherever it is installed', async () => {
    const revision = requiredShellRevision()
    const right = await fakeShellRoot(revision)
    try {
        assert.equal(findShellForRevision(right.root, revision), right.bin)
        assert.equal(findLaunchBinary(right.root, SHELL), right.bin)
    } finally {
        await rm(right.root, { recursive: true, force: true })
    }
})

test('full Chromium is the default build, and PW_CHANNEL picks another', () => {
    assert.equal(buildForChannel(undefined), BUILDS.chromium)
    assert.equal(buildForChannel(''), BUILDS.chromium)
    assert.equal(buildForChannel('chromium'), BUILDS.chromium)
    assert.equal(buildForChannel('chromium-headless-shell'), SHELL)
    // Browsers Playwright does not download keep the headless shell provisioning.
    assert.equal(buildForChannel('chrome'), SHELL)
    assert.deepEqual(BUILDS.chromium.installArgs, ['chromium', '--no-shell'])
    assert.deepEqual(SHELL.installArgs, ['chromium', '--only-shell'])
})

test('the required full Chromium revision resolves, and another revision does not', async () => {
    const revision = requiredRevision('chromium')
    assert.ok(revision && /^\d+$/.test(revision), `unexpected revision: ${revision}`)
    const right = await fakeChromiumRoot(revision)
    const stale = await fakeChromiumRoot('9999')
    try {
        assert.equal(findChromiumForRevision(right.root, revision), right.bin)
        assert.equal(findLaunchBinary(right.root, BUILDS.chromium), right.bin)
        assert.equal(findLaunchBinary(stale.root, BUILDS.chromium), null,
            'a wrong-revision Chromium must not be accepted as the launch binary')
        // A root with only the headless shell does not satisfy a full Chromium launch.
        const shellOnly = await fakeShellRoot(requiredShellRevision())
        try {
            assert.equal(findLaunchBinary(shellOnly.root, BUILDS.chromium), null)
        } finally {
            await rm(shellOnly.root, { recursive: true, force: true })
        }
    } finally {
        await rm(right.root, { recursive: true, force: true })
        await rm(stale.root, { recursive: true, force: true })
    }
})

test('canExecute probes the binary and defaultBrowsersRoot targets the platform cache', () => {
    assert.equal(typeof canExecute, 'function')
    assert.ok(defaultBrowsersRoot().endsWith('ms-playwright'))
})

test('parsePortRange expands ranges and drops malformed entries', () => {
    assert.deepEqual(parsePortRange('43117-43119'), [43117, 43118, 43119])
    assert.deepEqual(parsePortRange('43117, 43125-43126, junk, 0'), [43117, 43125, 43126])
    assert.deepEqual(parsePortRange(''), [])
})

test('a bindable loopback port probes open and an occupied one falls through', async () => {
    const held = await acquireHoldablePort()
    if (!held) return // sandbox permits no loopback bind at all
    try {
        assert.equal(await probePort(held.port), false, 'an occupied loopback port must not probe as bindable')
        await new Promise(resolve => held.holder.close(resolve))
        assert.equal(await probePort(held.port), true, 'a released loopback port must probe as bindable')
    } finally {
        await new Promise(resolve => { try { held.holder.close(resolve) } catch { resolve() } })
    }
})

test('pickPwPort skips an occupied configured port and takes the permitted range', async () => {
    const held = await acquireHoldablePort()
    if (!held) return // sandbox permits no loopback bind at all
    const previous = process.env.PW_PORT
    try {
        process.env.PW_PORT = String(held.port)
        const port = await pickPwPort()
        assert.notEqual(port, held.port, 'an occupied PW_PORT must fall through')
        assert.ok(port === 3070 || (port >= 43117 && port <= 43126),
            `the fallthrough must land on 3070 or the permitted range, got ${port}`)
    } finally {
        if (previous === undefined) delete process.env.PW_PORT
        else process.env.PW_PORT = previous
        await new Promise(resolve => { try { held.holder.close(resolve) } catch { resolve() } })
    }
})

// Hold one loopback port for the negative controls. Sandboxed runners forbid
// ephemeral listen(0) outright (EPERM); there the helper binds an explicit
// permitted-range port instead (probed free first), and returns null when no
// bind is allowed at all so the controls skip rather than fail.
async function acquireHoldablePort() {
    const net = await import('node:net')
    const holder = net.createServer()
    const ephemeral = await new Promise(resolve => {
        holder.once('error', () => resolve(null))
        holder.listen(0, '127.0.0.1', () => resolve(holder.address().port))
    })
    if (ephemeral !== null) return { holder, port: ephemeral }
    for (const port of parsePortRange('43117-43126')) {
        if (!(await probePort(port))) continue
        const bound = await new Promise(resolve => {
            holder.once('error', () => resolve(false))
            holder.listen(port, '127.0.0.1', () => resolve(true))
        })
        if (bound) return { holder, port }
    }
    holder.close()
    return null
}
