import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const sdkDir = resolve(dirname(fileURLToPath(import.meta.url)), '../js/sync/sdk/0.1.3')
const EXPECTED_SDK_HASHES = Object.freeze({
    'browser/client.js': '9973ef141ef227683a6851cbc8dfef9ecbcaaa42638c3b5652a5f5bdab25987c',
    'browser/frame-sink.js': 'd048850d32dc08e16fc9e573254c4fd8412e5247268073f1d8e00c3da1b0cb7d',
    'browser/index.js': 'd51672680d2d8ab6861c7f4edf89a4c8e66b8b60fabe9193b1449d9986691b98',
    'browser/protocol.js': 'dda9dadb1cf4bb1d44d28d63f5c3779a651cfe7d62295b1a5e0bc329972f8105'
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
