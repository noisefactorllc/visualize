// SPDX-License-Identifier: MIT
/**
 * Screen wake lock for the fullscreen main view and output window.
 *
 * A set on a stage or projector can run for a long time with no keyboard or
 * mouse input, and canvas rendering does not keep the display awake, so the
 * operating system would start its screen saver or turn the display off over
 * a fullscreen set. While a document is fullscreen and visible, this holds a
 * Screen Wake Lock for that document, and it releases the lock when
 * fullscreen ends. The browser drops the lock when the page is hidden, so the
 * lock is requested again when the page is visible again while still
 * fullscreen. Where the API is missing or the browser refuses the request,
 * nothing else changes.
 */

/**
 * Keeps the screen awake while `doc` is fullscreen. Pass the document's own
 * navigator: a lock belongs to the document whose navigator requested it.
 *
 * @param {object} [options]
 * @param {Document} [options.doc]
 * @param {Navigator} [options.nav]
 * @returns {{ sync: () => Promise<void>, dispose: () => void, readonly held: boolean }}
 */
export function keepScreenAwakeInFullscreen({
    doc = (typeof document !== 'undefined' ? document : null),
    nav = (typeof navigator !== 'undefined' ? navigator : null),
} = {}) {
    let sentinel = null
    let requesting = false
    let disposed = false

    const wanted = () => !disposed && !!doc?.fullscreenElement && doc.visibilityState === 'visible'

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

    // Stops following `doc` and releases any lock, including one that arrives later.
    function dispose() {
        disposed = true
        doc?.removeEventListener?.('fullscreenchange', sync)
        doc?.removeEventListener?.('visibilitychange', sync)
        release()
    }

    doc?.addEventListener?.('fullscreenchange', sync)
    doc?.addEventListener?.('visibilitychange', sync)

    return {
        sync,
        dispose,
        get held() { return !!sentinel },
    }
}
