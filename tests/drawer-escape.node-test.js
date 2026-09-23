// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    isDrawerOpen,
    handleEscapeKey,
    lockFullscreenEscape,
    unlockFullscreenEscape
} from '../js/drawerEscape.js'

function createMockDrawer(isOpen = false) {
    let open = isOpen
    return {
        getAttribute(name) {
            if (name === 'aria-hidden') return open ? 'false' : 'true'
            return null
        },
        setAttribute(name, val) {
            if (name === 'aria-hidden') open = (val === 'false')
        },
        get isOpen() {
            return open
        },
        set isOpen(val) {
            open = Boolean(val)
        }
    }
}

function createMockEvent() {
    let prevented = false
    let stopped = false
    return {
        preventDefault() { prevented = true },
        stopPropagation() { stopped = true },
        get defaultPrevented() { return prevented },
        get propagationStopped() { return stopped }
    }
}

test('isDrawerOpen: accurately detects drawer state', () => {
    assert.equal(isDrawerOpen(null), false)
    assert.equal(isDrawerOpen(undefined), false)
    assert.equal(isDrawerOpen({}), false)

    const drawer = createMockDrawer(false)
    assert.equal(isDrawerOpen(drawer), false)

    drawer.isOpen = true
    assert.equal(isDrawerOpen(drawer), true)

    drawer.setAttribute('aria-hidden', 'true')
    assert.equal(isDrawerOpen(drawer), false)

    // Supports element with isOpen method
    const custom = { isOpen: () => true }
    assert.equal(isDrawerOpen(custom), true)
})

test('handleEscapeKey: Settings drawer open dismisses drawer without exiting fullscreen', () => {
    const settingsDrawer = createMockDrawer(true)
    const scenesDrawer = createMockDrawer(false)
    let settingsClosed = false
    let scenesClosed = false
    let fullscreenExited = false
    const event = createMockEvent()

    const action = handleEscapeKey({
        settingsDrawer,
        closeSettings: () => { settingsClosed = true; settingsDrawer.setAttribute('aria-hidden', 'true') },
        scenesDrawer,
        closeScenesDrawer: () => { scenesClosed = true },
        isFullscreen: true,
        exitFullscreen: () => { fullscreenExited = true },
        event
    })

    assert.equal(action, 'settings')
    assert.equal(settingsClosed, true)
    assert.equal(scenesClosed, false)
    assert.equal(fullscreenExited, false, 'Fullscreen must NOT exit when settings drawer is dismissed')
    assert.equal(event.defaultPrevented, true)
    assert.equal(event.propagationStopped, true)
})

test('handleEscapeKey: Scenes drawer open dismisses drawer without exiting fullscreen', () => {
    const settingsDrawer = createMockDrawer(false)
    const scenesDrawer = createMockDrawer(true)
    let settingsClosed = false
    let scenesClosed = false
    let fullscreenExited = false
    const event = createMockEvent()

    const action = handleEscapeKey({
        settingsDrawer,
        closeSettings: () => { settingsClosed = true },
        scenesDrawer,
        closeScenesDrawer: () => { scenesClosed = true; scenesDrawer.setAttribute('aria-hidden', 'true') },
        isFullscreen: true,
        exitFullscreen: () => { fullscreenExited = true },
        event
    })

    assert.equal(action, 'scenes')
    assert.equal(settingsClosed, false)
    assert.equal(scenesClosed, true)
    assert.equal(fullscreenExited, false, 'Fullscreen must NOT exit when scenes drawer is dismissed')
    assert.equal(event.defaultPrevented, true)
    assert.equal(event.propagationStopped, true)
})

test('handleEscapeKey: sequential Escape presses dismiss drawer first, then exit fullscreen', () => {
    const settingsDrawer = createMockDrawer(true)
    const scenesDrawer = createMockDrawer(false)
    let isFullscreen = true
    let fullscreenExited = false

    const closeSettings = () => settingsDrawer.setAttribute('aria-hidden', 'true')
    const closeScenesDrawer = () => scenesDrawer.setAttribute('aria-hidden', 'true')
    const exitFullscreen = () => { fullscreenExited = true; isFullscreen = false }

    // First Escape: dismisses Settings drawer
    const event1 = createMockEvent()
    const action1 = handleEscapeKey({
        settingsDrawer,
        closeSettings,
        scenesDrawer,
        closeScenesDrawer,
        isFullscreen,
        exitFullscreen,
        event: event1
    })

    assert.equal(action1, 'settings')
    assert.equal(isDrawerOpen(settingsDrawer), false)
    assert.equal(fullscreenExited, false)
    assert.equal(event1.defaultPrevented, true)

    // Second Escape: no drawers open, exits fullscreen
    const event2 = createMockEvent()
    const action2 = handleEscapeKey({
        settingsDrawer,
        closeSettings,
        scenesDrawer,
        closeScenesDrawer,
        isFullscreen,
        exitFullscreen,
        event: event2
    })

    assert.equal(action2, 'fullscreen')
    assert.equal(fullscreenExited, true)
    assert.equal(event2.defaultPrevented, true)

    // Third Escape: nothing active, returns null
    const event3 = createMockEvent()
    const action3 = handleEscapeKey({
        settingsDrawer,
        closeSettings,
        scenesDrawer,
        closeScenesDrawer,
        isFullscreen: false,
        exitFullscreen,
        event: event3
    })

    assert.equal(action3, null)
    assert.equal(event3.defaultPrevented, false)
})

test('handleEscapeKey: handles stacked drawers by dismissing Settings first, then Scenes, then Fullscreen', () => {
    const settingsDrawer = createMockDrawer(true)
    const scenesDrawer = createMockDrawer(true)
    let isFullscreen = true
    let fullscreenExited = false

    const closeSettings = () => settingsDrawer.setAttribute('aria-hidden', 'true')
    const closeScenesDrawer = () => scenesDrawer.setAttribute('aria-hidden', 'true')
    const exitFullscreen = () => { fullscreenExited = true; isFullscreen = false }

    // 1st press closes Settings
    const act1 = handleEscapeKey({
        settingsDrawer,
        closeSettings,
        scenesDrawer,
        closeScenesDrawer,
        isFullscreen,
        exitFullscreen
    })
    assert.equal(act1, 'settings')
    assert.equal(fullscreenExited, false)

    // 2nd press closes Scenes
    const act2 = handleEscapeKey({
        settingsDrawer,
        closeSettings,
        scenesDrawer,
        closeScenesDrawer,
        isFullscreen,
        exitFullscreen
    })
    assert.equal(act2, 'scenes')
    assert.equal(fullscreenExited, false)

    // 3rd press exits Fullscreen
    const act3 = handleEscapeKey({
        settingsDrawer,
        closeSettings,
        scenesDrawer,
        closeScenesDrawer,
        isFullscreen,
        exitFullscreen
    })
    assert.equal(act3, 'fullscreen')
    assert.equal(fullscreenExited, true)
})

test('handleEscapeKey: safe with omitted event object or partial callbacks', () => {
    const settingsDrawer = createMockDrawer(true)
    assert.doesNotThrow(() => {
        const action = handleEscapeKey({ settingsDrawer })
        assert.equal(action, 'settings')
    })
})

test('lockFullscreenEscape and unlockFullscreenEscape: controls navigator keyboard lock API', async () => {
    let lockedKeys = null
    let unlocked = false

    const mockNav = {
        keyboard: {
            lock: async (keys) => { lockedKeys = keys },
            unlock: () => { unlocked = true }
        }
    }

    await lockFullscreenEscape(mockNav)
    assert.deepEqual(lockedKeys, ['Escape'])

    unlockFullscreenEscape(mockNav)
    assert.equal(unlocked, true)

    // Safe when navigator or keyboard API is unavailable
    await assert.doesNotReject(async () => {
        await lockFullscreenEscape(null)
        await lockFullscreenEscape({})
        unlockFullscreenEscape(null)
        unlockFullscreenEscape({})
    })

    // Safe when lock rejects (e.g. permission denied or unsupported platform)
    const rejectingNav = {
        keyboard: {
            lock: async () => { throw new Error('Lock rejected') }
        }
    }
    await assert.doesNotReject(async () => {
        await lockFullscreenEscape(rejectingNav)
    })
})
