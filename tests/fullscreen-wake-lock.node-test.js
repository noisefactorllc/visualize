// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import test from 'node:test'
import { keepScreenAwakeInFullscreen } from '../js/fullscreenWakeLock.js'

function createDoc() {
    const doc = new EventTarget()
    doc.fullscreenElement = null
    doc.visibilityState = 'visible'
    doc.setFullscreen = (on) => {
        doc.fullscreenElement = on ? {} : null
        doc.dispatchEvent(new Event('fullscreenchange'))
    }
    return doc
}

function createSentinel() {
    const sentinel = new EventTarget()
    sentinel.released = false
    sentinel.release = async () => {
        if (sentinel.released) return
        sentinel.released = true
        sentinel.dispatchEvent(new Event('release'))
    }
    return sentinel
}

// A wake lock API whose requests resolve or reject only when the test says so.
function createDeferredNav() {
    const pending = []
    const nav = {
        wakeLock: {
            request(type) {
                return new Promise((resolve, reject) => pending.push({ type, resolve, reject }))
            },
        },
    }
    return { nav, pending }
}

const settle = () => new Promise(resolve => setImmediate(resolve))

test('a lock that arrives after fullscreen ended is released at once', async () => {
    const doc = createDoc()
    const { nav, pending } = createDeferredNav()
    const wake = keepScreenAwakeInFullscreen({ doc, nav })

    doc.setFullscreen(true)
    doc.setFullscreen(false)
    assert.equal(pending.length, 1)
    const sentinel = createSentinel()
    pending[0].resolve(sentinel)
    await settle()

    assert.equal(sentinel.released, true)
    assert.equal(wake.held, false)
})

test('a refused request leaves no lock and is requested again on the next fullscreen', async () => {
    const doc = createDoc()
    const { nav, pending } = createDeferredNav()
    const wake = keepScreenAwakeInFullscreen({ doc, nav })

    doc.setFullscreen(true)
    pending[0].reject(new DOMException('refused', 'NotAllowedError'))
    await settle()
    assert.equal(wake.held, false)

    doc.setFullscreen(false)
    doc.setFullscreen(true)
    assert.equal(pending.length, 2)
    pending[1].resolve(createSentinel())
    await settle()
    assert.equal(wake.held, true)
})

test('only one request is made while one is pending', async () => {
    const doc = createDoc()
    const { nav, pending } = createDeferredNav()
    keepScreenAwakeInFullscreen({ doc, nav })

    doc.setFullscreen(true)
    doc.dispatchEvent(new Event('visibilitychange'))
    doc.dispatchEvent(new Event('fullscreenchange'))
    assert.deepEqual(pending.map(p => p.type), ['screen'])
})

test('a hidden page makes no request until it is visible again', async () => {
    const doc = createDoc()
    const { nav, pending } = createDeferredNav()
    keepScreenAwakeInFullscreen({ doc, nav })

    doc.visibilityState = 'hidden'
    doc.setFullscreen(true)
    assert.equal(pending.length, 0)

    doc.visibilityState = 'visible'
    doc.dispatchEvent(new Event('visibilitychange'))
    assert.equal(pending.length, 1)
})

test('without the wake lock API fullscreen changes do nothing', async () => {
    const doc = createDoc()
    const wake = keepScreenAwakeInFullscreen({ doc, nav: {} })

    doc.setFullscreen(true)
    await settle()
    assert.equal(wake.held, false)
    doc.setFullscreen(false)
    assert.equal(wake.held, false)
})

test('dispose releases the held lock and stops following the document', async () => {
    const doc = createDoc()
    const { nav, pending } = createDeferredNav()
    const wake = keepScreenAwakeInFullscreen({ doc, nav })

    doc.setFullscreen(true)
    const sentinel = createSentinel()
    pending[0].resolve(sentinel)
    await settle()
    assert.equal(wake.held, true)

    wake.dispose()
    assert.equal(sentinel.released, true)
    assert.equal(wake.held, false)
    doc.setFullscreen(false)
    doc.setFullscreen(true)
    assert.equal(pending.length, 1)
})

test('a lock that arrives after dispose is released at once', async () => {
    const doc = createDoc()
    const { nav, pending } = createDeferredNav()
    const wake = keepScreenAwakeInFullscreen({ doc, nav })

    doc.setFullscreen(true)
    wake.dispose()
    const sentinel = createSentinel()
    pending[0].resolve(sentinel)
    await settle()

    assert.equal(sentinel.released, true)
    assert.equal(wake.held, false)
})
