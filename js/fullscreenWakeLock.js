// SPDX-License-Identifier: MIT
/**
 * Screen wake lock for the fullscreen main view.
 *
 * A set on a stage or projector can run for a long time with no keyboard or
 * mouse input, and canvas rendering does not keep the display awake, so the
 * operating system would start its screen saver or turn the display off over
 * a fullscreen set. While the document is fullscreen and visible, this holds a
 * Screen Wake Lock, and it releases the lock when fullscreen ends. The browser
 * drops the lock when the page is hidden, so the lock is requested again when
 * the page is visible again while still fullscreen. Where the API is missing
 * or the browser refuses the request, nothing else changes.
 */

/**
 * Keeps the screen awake while `doc` is fullscreen.
 *
 * @param {object} [options]
 * @param {Document} [options.doc]
 * @param {Navigator} [options.nav]
 * @returns {{ sync: () => Promise<void>, readonly held: boolean }}
 */
export function keepScreenAwakeInFullscreen({
    doc = (typeof document !== 'undefined' ? document : null),
    nav = (typeof navigator !== 'undefined' ? navigator : null),
} = {}) {
    let sentinel = null
    let requesting = false

    const wanted = () => !!doc?.fullscreenElement && doc.visibilityState === 'visible'

    async function acquire() {
        if (sentinel || requesting || typeof nav?.wakeLock?.request !== 'function') return
        requesting = true
        let lock = null
        try {
            lock = await nav.wakeLock.request('screen')
        } catch {
            // Refused (no permission, power saving, hidden page): no lock.
        }
        requesting = false
        if (!lock) return
        if (!wanted()) {
            lock.release?.()?.catch?.(() => {})
            return
        }
        sentinel = lock
        lock.addEventListener?.('release', () => {
            if (sentinel === lock) sentinel = null
        })
    }

    function release() {
        const lock = sentinel
        sentinel = null
        lock?.release?.()?.catch?.(() => {})
    }

    function sync() {
        if (wanted()) return acquire()
        release()
        return Promise.resolve()
    }

    doc?.addEventListener?.('fullscreenchange', sync)
    doc?.addEventListener?.('visibilitychange', sync)

    return {
        sync,
        get held() { return !!sentinel },
    }
}
