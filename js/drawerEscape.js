// SPDX-License-Identifier: MIT
/**
 * Drawer escape priority and fullscreen keyboard lock management.
 *
 * Enforces strict VJ performance ergonomics:
 * When the visualizer is running in fullscreen mode on a stage or projector,
 * pressing Escape to dismiss a settings drawer, scenes drawer, or modal
 * must NEVER accidentally drop the visualizer out of fullscreen.
 *
 * Escape priority hierarchy:
 * 1. Open drawer (Settings or Scenes) is closed.
 *    - Calls e.preventDefault() and e.stopPropagation().
 *    - Fullscreen mode remains uninterrupted.
 * 2. Fullscreen mode is exited (only when all drawers and overlays are closed).
 *    - Calls e.preventDefault() and e.stopPropagation().
 *    - Releases any active keyboard lock.
 */

/**
 * Checks whether a drawer element is currently open (aria-hidden is "false").
 *
 * @param {Element|{getAttribute?: Function, isOpen?: Function}} el
 * @returns {boolean}
 */
export function isDrawerOpen(el) {
    if (!el) return false
    if (typeof el.isOpen === 'function') return Boolean(el.isOpen())
    return el.getAttribute?.('aria-hidden') === 'false'
}

/**
 * Handles Escape key events according to strict priority order.
 *
 * @param {Object} options
 * @param {Element|{getAttribute?: Function, isOpen?: Function}} [options.settingsDrawer]
 * @param {Function} [options.closeSettings]
 * @param {Element|{getAttribute?: Function, isOpen?: Function}} [options.scenesDrawer]
 * @param {Function} [options.closeScenesDrawer]
 * @param {boolean} [options.isFullscreen=false]
 * @param {Function} [options.exitFullscreen]
 * @param {KeyboardEvent|{preventDefault?: Function, stopPropagation?: Function}} [options.event]
 * @returns {'settings'|'scenes'|'fullscreen'|null}
 */
export function handleEscapeKey({
    settingsDrawer,
    closeSettings,
    scenesDrawer,
    closeScenesDrawer,
    isFullscreen = false,
    exitFullscreen,
    event,
} = {}) {
    // 1. Settings drawer has dismissal priority if open
    if (isDrawerOpen(settingsDrawer)) {
        event?.preventDefault?.()
        event?.stopPropagation?.()
        closeSettings?.()
        return 'settings'
    }

    // 2. Scenes drawer has dismissal priority if open
    if (isDrawerOpen(scenesDrawer)) {
        event?.preventDefault?.()
        event?.stopPropagation?.()
        closeScenesDrawer?.()
        return 'scenes'
    }

    // 3. Fullscreen exit only fires when no drawer is open
    if (isFullscreen) {
        event?.preventDefault?.()
        event?.stopPropagation?.()
        exitFullscreen?.()
        return 'fullscreen'
    }

    return null
}

/**
 * Locks the Escape key via the Keyboard Lock API when available (Chromium in fullscreen).
 * Prevents the browser from instantly dropping fullscreen before the application
 * can dismiss active drawers or overlays.
 *
 * @param {Navigator} [nav]
 * @returns {Promise<void>}
 */
export function lockFullscreenEscape(nav = (typeof navigator !== 'undefined' ? navigator : null)) {
    try {
        if (nav?.keyboard && typeof nav.keyboard.lock === 'function') {
            return nav.keyboard.lock(['Escape']).catch(() => {})
        }
    } catch {
        // Safe fallback in unsupported or non-secure contexts
    }
    return Promise.resolve()
}

/**
 * Releases any active keyboard lock on Escape.
 *
 * @param {Navigator} [nav]
 */
export function unlockFullscreenEscape(nav = (typeof navigator !== 'undefined' ? navigator : null)) {
    try {
        if (nav?.keyboard && typeof nav.keyboard.unlock === 'function') {
            nav.keyboard.unlock()
        }
    } catch {
        // Safe fallback
    }
}
