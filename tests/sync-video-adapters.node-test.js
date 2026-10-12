import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RgbaExportQueue, WebGPUExportQueue } from '../js/sync/bundle.js'

const DESCRIPTOR = Object.freeze({
    width: 64,
    height: 4,
    format: 'rgba8unorm',
    colorSpace: 'srgb',
    alphaMode: 'opaque',
    fps: 60,
})

// Deterministic packed RGBA frame; the seed keeps rows distinct.
function packedFrame(width, height, seed = 0) {
    const data = new Uint8Array(width * height * 4)
    for (let i = 0; i < data.length; i += 4) {
        data[i] = (i * 7 + seed) % 256
        data[i + 1] = (i * 13 + seed) % 256
        data[i + 2] = (i * 29 + seed) % 256
        data[i + 3] = 255
    }
    return data
}

function fakeGpuDevice() {
    return {
        limits: { maxBufferSize: 2 ** 31 },
        queue: { submit() {} },
        lost: { then() {} },
        createBuffer({ size }) {
            const backing = new Uint8Array(size)
            return {
                mapAsync: () => Promise.resolve(),
                getMappedRange: () => backing.buffer,
                unmap() {},
                destroy() {},
                __backing: backing,
            }
        },
        createCommandEncoder() {
            return {
                copyTextureToBuffer() {},
                finish: () => ({}),
            }
        },
        pushErrorScope() {},
        popErrorScope: () => Promise.resolve(null),
    }
}

// Fill a mapped readback with the GPU layout: bytesPerRow may exceed
// width * 4, leaving per-row padding bytes that must never leak into the
// delivered frame.
function fillReadback(slot, bytesPerRow, width, height, seed = 0) {
    const backing = slot.buffer.__backing
    for (let row = 0; row < height; row += 1) {
        for (let column = 0; column < width; column += 1) {
            const i = (row * width + column) * 4
            backing[row * bytesPerRow + column * 4] = (i * 7 + seed) % 256
            backing[row * bytesPerRow + column * 4 + 1] = (i * 13 + seed) % 256
            backing[row * bytesPerRow + column * 4 + 2] = (i * 29 + seed) % 256
            backing[row * bytesPerRow + column * 4 + 3] = 255
        }
    }
}

test('rgba queue copies a contiguous source in one block', () => {
    const queue = new RgbaExportQueue()
    queue.configure(DESCRIPTOR)
    const source = packedFrame(DESCRIPTOR.width, DESCRIPTOR.height, 3)
    let delivered = null
    assert.equal(queue.enqueue(
        { ...DESCRIPTOR, rowStride: DESCRIPTOR.width * 4, data: source },
        1, frame => { delivered = frame }, 7,
    ), true)
    assert.ok(delivered, 'contiguous enqueue must deliver synchronously')
    assert.equal(delivered.rowStride, DESCRIPTOR.width * 4)
    assert.deepEqual(new Uint8Array(delivered.data), source)
})

test('rgba queue drops padding from a padded source row by row', () => {
    const queue = new RgbaExportQueue()
    queue.configure(DESCRIPTOR)
    const width = DESCRIPTOR.width
    const height = DESCRIPTOR.height
    const rowStride = width * 4 + 16
    const packed = packedFrame(width, height, 5)
    const padded = new Uint8Array(rowStride * height)
    for (let row = 0; row < height; row += 1) {
        padded.set(packed.subarray(row * width * 4, (row + 1) * width * 4), row * rowStride)
    }
    let delivered = null
    assert.equal(queue.enqueue({ ...DESCRIPTOR, rowStride, data: padded }, 1, frame => { delivered = frame }, 7), true)
    assert.ok(delivered, 'padded enqueue must deliver synchronously')
    assert.deepEqual(new Uint8Array(delivered.data), packed)
})

// width 64: bytesPerRow = ceil(256 / 256) * 256 = 256 = packed stride, so the
// refreshed snapshot copies the whole mapped block in one set().
test('webgpu queue copies a contiguous readback block and swaps bgra', async () => {
    const device = fakeGpuDevice()
    const queue = new WebGPUExportQueue({ device })
    queue.configure(DESCRIPTOR)
    const texture = {
        width: DESCRIPTOR.width,
        height: DESCRIPTOR.height,
        dimension: '2d',
        depthOrArrayLayers: 1,
        sampleCount: 1,
        usage: 1,
        format: 'bgra8unorm',
    }
    const readback = packedFrame(DESCRIPTOR.width, DESCRIPTOR.height, 9)
    let delivered = null
    assert.equal(queue.enqueue(texture, 2, frame => { delivered = frame }, 11), true)
    fillReadback(queue._slots[0], DESCRIPTOR.width * 4, DESCRIPTOR.width, DESCRIPTOR.height, 9)
    // Both mapAsync and popErrorScope resolve immediately; a few microtask
    // ticks mark the slot ready for the real poll().
    for (let i = 0; i < 6; i += 1) await Promise.resolve()
    queue.poll()
    assert.ok(delivered, 'contiguous poll must deliver a frame')
    const out = new Uint8Array(delivered.data)
    // The queue swapped BGRA into RGBA: each red channel carries the readback's
    // blue and vice versa, green and alpha pass through.
    for (let i = 0; i < readback.length; i += 4) {
        assert.equal(out[i], readback[i + 2], `pixel ${i / 4} red from blue`)
        assert.equal(out[i + 2], readback[i], `pixel ${i / 4} blue from red`)
        assert.equal(out[i + 1], readback[i + 1], `pixel ${i / 4} green`)
        assert.equal(out[i + 3], readback[i + 3], `pixel ${i / 4} alpha`)
    }
})

// width 63: bytesPerRow = 256 > 252 = packed stride, so the row loop must
// still drop the padding bytes between rows.
test('webgpu queue drops padding on a padded readback and swaps bgra', async () => {
    const device = fakeGpuDevice()
    const descriptor = { ...DESCRIPTOR, width: 63 }
    const queue = new WebGPUExportQueue({ device })
    queue.configure(descriptor)
    const texture = {
        width: descriptor.width,
        height: descriptor.height,
        dimension: '2d',
        depthOrArrayLayers: 1,
        sampleCount: 1,
        usage: 1,
        format: 'bgra8unorm',
    }
    const bytesPerRow = Math.ceil(descriptor.width * 4 / 256) * 256
    assert.ok(bytesPerRow > descriptor.width * 4, 'width 63 must be padded')
    const readback = packedFrame(descriptor.width, descriptor.height, 13)
    let delivered = null
    assert.equal(queue.enqueue(texture, 3, frame => { delivered = frame }, 12), true)
    fillReadback(queue._slots[0], bytesPerRow, descriptor.width, descriptor.height, 13)
    for (let i = 0; i < 6; i += 1) await Promise.resolve()
    queue.poll()
    assert.ok(delivered, 'padded poll must deliver a frame')
    const out = new Uint8Array(delivered.data)
    for (let row = 0; row < descriptor.height; row += 1) {
        for (let column = 0; column < descriptor.width; column += 1) {
            const source = (row * descriptor.width + column) * 4
            const target = source
            assert.equal(out[target], readback[source + 2], `pixel ${row}x${column} red from blue`)
            assert.equal(out[target + 2], readback[source], `pixel ${row}x${column} blue from red`)
        }
    }
})
