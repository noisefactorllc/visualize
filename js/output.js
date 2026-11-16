/**
 * OutputWindow — opens a separate browser window showing only the main
 * canvas, ideal for dragging onto a projector / second display.
 *
 * Strategy: the popup builds its own canvas and we copy the main canvas
 * into it via drawImage() on the popup's own animation frames. This
 * works across HTMLCanvasElements from different documents because
 * drawImage accepts any CanvasImageSource.
 *
 * captureStream / OffscreenCanvas would be cleaner but the popup
 * approach keeps the main window's recording stream intact and works
 * across browsers.
 */

// XSS gate: POPUP_HTML is written via document.write into a freshly-opened
// window and contains an inline <script>. It MUST remain a static string
// — never interpolate user input, deck DSL, program titles, or anything
// dynamic into this template, or you create a self-XSS vector. If you
// need to pass data to the popup, do it via postMessage AFTER load.
const POPUP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Visualize — Output</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #000; overflow: hidden; cursor: none; }
  canvas { width: 100vw; height: 100vh; object-fit: contain; display: block; }
  .hint {
    position: fixed; bottom: 8px; right: 12px;
    color: rgba(255,255,255,0.3); font-family: monospace; font-size: 11px;
    pointer-events: none; transition: opacity 1s ease 3s; opacity: 1;
  }
  body.played .hint { animation: hint-fade 1s ease 3s forwards; }
  @keyframes hint-fade { to { opacity: 0; } }
</style>
</head>
<body class="played">
<canvas id="out"></canvas>
<div class="hint">drag to projector · press F for fullscreen · close to detach</div>
<script>
  const out = document.getElementById('out');
  const ctx = out.getContext('2d');
  let stopped = false;
  function fit() {
    out.width = window.innerWidth;
    out.height = window.innerHeight;
  }
  fit();
  window.addEventListener('resize', fit);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'f' || e.key === 'F') {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
      else document.exitFullscreen?.();
    }
  });
  window._visualizeOutput = {
    draw(source) {
      if (stopped) return;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, out.width, out.height);
      if (!source) return;
      const sw = source.width || source.videoWidth || 1280;
      const sh = source.height || source.videoHeight || 720;
      const ar = sw / sh;
      const cw = out.width;
      const ch = out.height;
      let dw, dh, dx, dy;
      if (cw / ch > ar) {
        dh = ch;
        dw = ch * ar;
      } else {
        dw = cw;
        dh = cw / ar;
      }
      dx = (cw - dw) / 2;
      dy = (ch - dh) / 2;
      try { ctx.drawImage(source, dx, dy, dw, dh); } catch {}
    },
    stop() { stopped = true; }
  };
</script>
</body>
</html>`

/**
 * While the output window is on screen and the main window is hidden
 * (minimized, or on another Space behind a fullscreen output window), the
 * browser runs none of the main window's animation frames. The decks, the
 * mixer and the main compositor all draw on those frames, so the output
 * window would keep copying one unchanging main canvas. The router takes
 * over the main window's requestAnimationFrame: while the main window is
 * visible, its own frames run every callback as before; while it is hidden
 * and the output window is visible, the output window's frames run them.
 */
const frameRouters = new WeakMap()

export function frameRouter(main) {
    const existing = frameRouters.get(main)
    if (existing) return existing
    const request = main.requestAnimationFrame.bind(main)
    const cancel = main.cancelAnimationFrame.bind(main)
    const callbacks = new Map()
    // Ids above any the browser hands out for this document, so a frame
    // requested before the router existed is still cancelled natively.
    let nextId = 0x40000000
    let output = null
    let mainFrame = 0
    let outputFrame = null

    const outputVisible = () => {
        try {
            return !!output && !output.closed && output.document.visibilityState === 'visible'
        } catch {
            return false
        }
    }
    const run = (time) => {
        if (mainFrame) {
            cancel(mainFrame)
            mainFrame = 0
        }
        if (outputFrame) {
            try { outputFrame.win.cancelAnimationFrame(outputFrame.id) } catch {}
            outputFrame = null
        }
        const due = [...callbacks.values()]
        callbacks.clear()
        for (const callback of due) {
            try {
                callback(time)
            } catch (error) {
                if (main.reportError) main.reportError(error)
                else main.setTimeout(() => { throw error })
            }
        }
    }
    const schedule = () => {
        if (!callbacks.size) return
        if (!mainFrame) {
            mainFrame = request((time) => {
                mainFrame = 0
                run(time)
            })
        }
        if (!outputFrame && main.document.visibilityState === 'hidden' && outputVisible()) {
            const win = output
            // The output window's frame times count from its own time origin.
            const offset = win.performance.timeOrigin - main.performance.timeOrigin
            const id = win.requestAnimationFrame((time) => {
                outputFrame = null
                run(time + offset)
            })
            outputFrame = { win, id }
        }
    }

    main.requestAnimationFrame = function requestAnimationFrame(callback) {
        if (typeof callback !== 'function') return request(callback)
        const id = nextId++
        callbacks.set(id, callback)
        schedule()
        return id
    }
    main.cancelAnimationFrame = function cancelAnimationFrame(id) {
        if (!callbacks.delete(id)) cancel(id)
    }
    main.document.addEventListener('visibilitychange', schedule)

    const router = {
        attach(win) {
            output = win
            win.document.addEventListener('visibilitychange', schedule)
            schedule()
        },
        detach(win) {
            if (output !== win) return
            output = null
            if (outputFrame?.win === win) {
                try { win.cancelAnimationFrame(outputFrame.id) } catch {}
                outputFrame = null
            }
        },
    }
    frameRouters.set(main, router)
    return router
}

export class OutputWindow {
    constructor(sourceCanvas, { onWarning } = {}) {
        this.sourceCanvas = sourceCanvas
        this._win = null
        this._rafId = null
        this._onWarning = onWarning || (() => {})
    }

    get isOpen() {
        return !!this._win && !this._win.closed
    }

    open() {
        if (this.isOpen) {
            this._win.focus()
            return
        }
        const w = window.open('', 'visualize-output', 'width=1280,height=720,popup=yes')
        if (!w) {
            this._onWarning('Output window blocked. Allow pop-ups for this site to use the secondary output.')
            return
        }
        w.document.open()
        w.document.write(POPUP_HTML)
        w.document.close()
        this._win = w
        // Keep the main window's frames running while only this window is on screen.
        this._frames = frameRouter(window)
        this._frames.attach(w)

        // Capture the popup's rAF/cancelAnimationFrame bound to the popup
        // window — calling them unbound (e.g. `this._win.requestAnimationFrame(tick)`)
        // throws `Illegal invocation` in strict mode.
        const popupWin = this._win
        const raf = popupWin.requestAnimationFrame
            ? popupWin.requestAnimationFrame.bind(popupWin)
            : window.requestAnimationFrame.bind(window)
        this._cancel = popupWin.cancelAnimationFrame
            ? popupWin.cancelAnimationFrame.bind(popupWin)
            : window.cancelAnimationFrame.bind(window)

        const tick = () => {
            if (!this.isOpen) {
                this._rafId = null
                return
            }
            try {
                this._win._visualizeOutput?.draw(this.sourceCanvas)
            } catch {}
            this._rafId = raf(tick)
        }
        // Defer one tick so the popup's script has time to attach
        setTimeout(tick, 50)
    }

    close() {
        if (this._rafId && this._cancel) {
            try { this._cancel(this._rafId) } catch {}
        }
        this._rafId = null
        this._cancel = null
        if (this._win) this._frames?.detach(this._win)
        if (this._win && !this._win.closed) {
            try { this._win._visualizeOutput?.stop() } catch {}
            this._win.close()
        }
        this._win = null
    }

    toggle() {
        if (this.isOpen) this.close()
        else this.open()
    }
}
