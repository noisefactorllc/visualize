import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const sdkDir = resolve(dirname(fileURLToPath(import.meta.url)), '../js/sync/sdk/0.1.5')
const EXPECTED_SDK_HASHES = Object.freeze({
    'browser/client.js': '873c5cb236d595cabf6a5f4b0299c2d1133682e2ef6fd81cb57fd5976dbd59b1',
    'browser/frame-sink.js': '362b55583b44c1f1d578fb8fd6348501fa9dc568d152f09afc56363402dd1eed',
    'browser/index.js': 'd51672680d2d8ab6861c7f4edf89a4c8e66b8b60fabe9193b1449d9986691b98',
    'browser/protocol.js': '764788789ad904ffafe873d3d1e0077747f13c1de3d33d8474b0a9740e32980b'
})

async function filesBelow(directory, prefix = '') {
    const entries = await readdir(resolve(directory, prefix), { withFileTypes: true })
    const files = []
    for (const entry of entries) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) files.push(...await filesBelow(directory, path))
        else files.push(path)
    }
    return files.sort()
}

test('vendored Sync browser SDK matches its pinned checksums', async () => {
    const sums = await readFile(resolve(sdkDir, 'SHA256SUMS'), 'utf8')
    const entries = sums.trim().split('\n').map(line => {
        const match = line.match(/^([a-f0-9]{64})  (.+)$/)
        assert.ok(match, `invalid SHA256SUMS line: ${line}`)
        return { expected: match[1], filename: match[2] }
    })

    assert.deepEqual(
        Object.fromEntries(entries.map(({ expected, filename }) => [filename, expected])),
        EXPECTED_SDK_HASHES
    )
    assert.deepEqual(
        await filesBelow(sdkDir),
        ['SHA256SUMS', ...Object.keys(EXPECTED_SDK_HASHES)].sort()
    )

    for (const [filename, expected] of Object.entries(EXPECTED_SDK_HASHES)) {
        const contents = await readFile(resolve(sdkDir, filename))
        const actual = createHash('sha256').update(contents).digest('hex')
        assert.equal(actual, expected, `${filename} checksum`)
    }
})


test('native audio SDK matches the reviewed immutable manifest', async () => {
    const directory = resolve(sdkDir, '../0.3.0')
    const manifest = await readFile(resolve(directory, 'SHA256SUMS'), 'utf8')
    assert.equal(createHash('sha256').update(manifest).digest('hex'), 'fb85d80c57b39a63839afe9d1e507ff8e03b719928132e25aba7cfb8c248ceaf')
    for (const line of manifest.trim().split('\n')) {
        const [expected, filename] = line.split('  ')
        assert.equal(createHash('sha256').update(await readFile(resolve(directory, filename))).digest('hex'), expected, filename)
    }
})

test('h264 browser SDK matches the reviewed immutable manifest', async () => {
    const directory = resolve(sdkDir, '../0.3.3')
    const manifest = await readFile(resolve(directory, 'SHA256SUMS'), 'utf8')
    assert.equal(createHash('sha256').update(manifest).digest('hex'), 'fcf3f1445e6c58caaf1fe8d7b92b8093450df03dfe1c12dae1dfffd253612ec0')
    const manifestFiles = []
    for (const line of manifest.trim().split('\n')) {
        const [expected, filename] = line.split('  ')
        manifestFiles.push(filename)
        assert.equal(createHash('sha256').update(await readFile(resolve(directory, filename))).digest('hex'), expected, filename)
    }
    assert.deepEqual(await filesBelow(directory), ['SHA256SUMS', ...manifestFiles].sort())
})
