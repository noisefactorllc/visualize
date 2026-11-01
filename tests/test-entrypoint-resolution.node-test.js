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

// planNodePhase: a bounded run (a changed-path selection, or the shard
// partitioning of the full suite) must never widen. A shard can empty a
// nonempty selection; the run must then skip the node phase instead of
// running `node --test` with no paths, which discovers and runs every
// node test file.
test('planNodePhase keeps every bounded run inside its selected node files', () => {
    const { planNodePhase } = require('../scripts/test.cjs')
    const allFiles = ['tests/a.node-test.js', 'tests/b.node-test.js', 'tests/c.node-test.js']
    // Unset variables: the whole-suite path is unchanged (main runs npm run test:node).
    assert.deepEqual(
        planNodePhase({ selection: null, sharding: false, shardCount: 0, shardIndex: 0, allFiles }),
        { nodeArgs: null, skip: false })
    // A selection runs exactly its own node files under sharding.
    assert.deepEqual(
        planNodePhase({
            selection: { node: ['tests/a.node-test.js', 'tests/b.node-test.js'], spec: ['x.spec.js'] },
            sharding: true, shardCount: 2, shardIndex: 0, allFiles
        }),
        { nodeArgs: ['--test', 'tests/a.node-test.js'], skip: false })
    // The regression case: shard 1 of 2 empties a one-file selection.
    assert.deepEqual(
        planNodePhase({
            selection: { node: ['tests/a.node-test.js'], spec: ['x.spec.js'] },
            sharding: true, shardCount: 2, shardIndex: 1, allFiles
        }),
        { nodeArgs: null, skip: true })
    // A selection that names no node files at all also skips.
    assert.deepEqual(
        planNodePhase({
            selection: { node: [], spec: ['x.spec.js'] },
            sharding: false, shardCount: 0, shardIndex: 0, allFiles
        }),
        { nodeArgs: null, skip: true })
    // A full-suite shard with no files skips instead of running everything.
    assert.deepEqual(
        planNodePhase({ selection: null, sharding: true, shardCount: 2, shardIndex: 1, allFiles: ['tests/a.node-test.js'] }),
        { nodeArgs: null, skip: true })
    // A full-suite shard with files runs exactly those files.
    assert.deepEqual(
        planNodePhase({ selection: null, sharding: true, shardCount: 3, shardIndex: 2, allFiles }),
        { nodeArgs: ['--test', 'tests/c.node-test.js'], skip: false })
})

// gpuHeadedLaunch: the GPU-backed browser phase must stay inert wherever the
// capability is missing, and wrap with xvfb-run only when a display server and
// a real GPU are both present. The controls put fake tools on a scratch PATH
// so the probe never depends on the runner's real hardware.
async function fakeToolDir(names, gpuListing) {
    const { chmod, writeFile } = await import('node:fs/promises')
    const dir = await mkdtemp(path.join(tmpdir(), 'fake-tools-'))
    for (const name of names) {
        const body = name === 'nvidia-smi' && gpuListing
            ? `#!/bin/sh\necho "${gpuListing}"\n`
            : '#!/bin/sh\nexit 0\n'
        const file = path.join(dir, name)
        await writeFile(file, body)
        await chmod(file, 0o755)
    }
    return dir
}

test('gpuHeadedLaunch returns null on opt-out, missing tools, and a GPU-less probe', async () => {
    const { gpuHeadedLaunch } = require('../scripts/test.cjs')
    if (process.platform !== 'linux') return // the wrap exists for Linux only
    const previousPath = process.env.PATH
    const previousOpt = process.env.PW_GPU_HEADED
    try {
        process.env.PW_GPU_HEADED = '0'
        assert.equal(gpuHeadedLaunch(), null, 'PW_GPU_HEADED=0 must opt out')
        delete process.env.PW_GPU_HEADED
        assert.equal('PW_GPU_HEADED' in process.env, false, 'the unset case must be modeled')
        process.env.PATH = await fakeToolDir([])
        assert.equal(gpuHeadedLaunch(), null, 'no xvfb-run/nvidia-smi must stay inert')
        process.env.PATH = await fakeToolDir(['xvfb-run'])
        assert.equal(gpuHeadedLaunch(), null, 'a display server without a GPU probe must stay inert')
        process.env.PATH = await fakeToolDir(['xvfb-run', 'nvidia-smi'])
        assert.equal(gpuHeadedLaunch(), null, 'a probe that lists no GPU must stay inert')
        process.env.PATH = await fakeToolDir(['xvfb-run', 'nvidia-smi'], 'GPU 0: Fake')
        assert.deepEqual(gpuHeadedLaunch(), { wrap: 'xvfb-run', wrapArgs: ['-a'] },
            'a display server plus a GPU probe must enable the wrap')
    } finally {
        process.env.PATH = previousPath
        if (previousOpt === undefined) delete process.env.PW_GPU_HEADED
        else process.env.PW_GPU_HEADED = previousOpt
    }
})

// selectChangedPathTests: a desktop change must select the desktop node
// tests even though they live outside tests/ (the stem scan above sees only
// that directory), and a desktop path must feed no stems into the root
// tests/ scan. A tests/ change keeps the exact prior selection.
test('changed desktop paths select the desktop node tests and no root tests', () => {
    const { selectChangedPathTests } = require('../scripts/test.cjs')
    const previous = process.env.NM_CHANGED_FILES
    try {
        process.env.NM_CHANGED_FILES = [
            'desktop/compat/minimatch-compat/index.cjs',
            'desktop/compat/minimatch-compat/package.json',
            'desktop/test/minimatch-compat.test.cjs',
            'desktop/package.json',
            'desktop/package-lock.json',
            'desktop/.npmrc',
        ].join('\n')
        const selection = selectChangedPathTests()
        assert.ok(selection.node.includes('desktop/test/minimatch-compat.test.cjs'),
            `desktop test not selected: ${JSON.stringify(selection.node)}`)
        assert.ok(selection.node.every(file => file.startsWith('desktop/')),
            `a desktop change must not select root tests: ${JSON.stringify(selection.node)}`)
        assert.deepEqual(selection.spec, [])
        process.env.NM_CHANGED_FILES = 'tests/audio-readiness.node-test.js'
        const rootSelection = selectChangedPathTests()
        assert.deepEqual(rootSelection.node, ['tests/audio-readiness.node-test.js'])
        assert.ok(rootSelection.node.every(file => file.startsWith('tests/')),
            `a tests/ change must not select desktop tests: ${JSON.stringify(rootSelection.node)}`)
    } finally {
        if (previous === undefined) delete process.env.NM_CHANGED_FILES
        else process.env.NM_CHANGED_FILES = previous
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
