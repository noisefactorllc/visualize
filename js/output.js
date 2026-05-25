/**
 * OutputWindow — opens a separate browser window showing only the master
 * canvas, ideal for dragging onto a projector / second display.
 *
 * Strategy: the popup builds its own canvas and we copy the master canvas
 * into it via drawImage() in a rAF loop run from the main window. This
 * works across HTMLCanvasElements from different documents because
 * drawImage accepts any CanvasImageSource.
 *
 * captureStream / OffscreenCanvas would be cleaner but the popup
 * approach keeps the main window's recording stream intact and works
 * across browsers.
 */

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
  body.played .hint { opacity: 0; }
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

export class OutputWindow {
    constructor(sourceCanvas) {
        this.sourceCanvas = sourceCanvas
        this._win = null
        this._rafId = null
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
            alert('Output window blocked. Allow pop-ups for this site to use the secondary output.')
            return
        }
        w.document.open()
        w.document.write(POPUP_HTML)
        w.document.close()
        this._win = w

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
