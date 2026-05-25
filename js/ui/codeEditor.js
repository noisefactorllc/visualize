/**
 * Code Editor Styling and Polymorphic Enhancements
 *
 * The <code-editor> custom element itself is registered by the handfish
 * bundle (imported in embed.js). This module:
 *  - Injects polymorphic-specific CSS (transparent code background, gutter
 *    colors, .hl-* fallbacks, eval-flash animation)
 *  - Exports enhanceCodeEditor(el) which adds polymorphic-only behavior
 *    on top of handfish's element: a flashLines() method and a
 *    Cmd/Ctrl+Shift+Enter / Alt+Enter → 'forceevalblock' keybinding
 *    that handfish does not provide.
 */

const CODE_EDITOR_STYLES_ID = 'code-editor-styles'
if (!document.getElementById(CODE_EDITOR_STYLES_ID)) {
    const styleEl = document.createElement('style')
    styleEl.id = CODE_EDITOR_STYLES_ID
    styleEl.textContent = `
        code-editor {
            display: block;
            position: relative;
            font-family: var(--code-editor-font, 'Noto Sans Mono', 'Noto Sans Mono Blank');
            font-size: var(--code-editor-font-size, 0.875rem);
            line-height: var(--code-editor-line-height, 1.6);
            overflow: hidden;
        }

        /* Line numbers gutter */
        code-editor .code-editor-gutter {
            position: absolute;
            top: 0;
            left: 0;
            width: var(--code-editor-gutter-width, 3em);
            pointer-events: none;
            user-select: none;
            text-align: right;
            padding-right: 0.5em;
            box-sizing: border-box;
            color: var(--code-editor-line-number-color, #aaa);
            background: var(--code-editor-gutter-bg, rgba(0, 0, 0, 0.5));
            font: inherit;
            line-height: inherit;
            will-change: transform;
            z-index: 1;
            opacity: 0.5;
        }

        code-editor .code-editor-gutter .line-number {
            display: block;
            box-sizing: border-box;
        }

        code-editor .code-editor-textarea {
            position: absolute;
            top: 0;
            bottom: 0;
            left: var(--code-editor-gutter-width, 3em);
            right: 0;
            margin: 0;
            padding: 0;
            background: transparent;
            border: none !important;
            outline: none !important;
            box-shadow: none !important;
            resize: none;
            font: inherit;
            line-height: inherit;
            letter-spacing: inherit;
            word-spacing: inherit;
            color: transparent;
            caret-color: var(--code-editor-caret-color, #fff);
            white-space: pre-wrap;
            overflow-wrap: break-word;
            word-break: break-word;
            box-sizing: border-box;
            -webkit-appearance: none;
            appearance: none;
            overflow-y: auto;
            overflow-x: hidden;
            scrollbar-width: none;
            -ms-overflow-style: none;
            z-index: 3;
        }

        code-editor .code-editor-textarea::-webkit-scrollbar {
            width: 0;
            height: 0;
            display: none;
        }

        /* Selection styling - more visible with contrasting colors */
        code-editor .code-editor-textarea::selection {
            background: var(--code-editor-selection-bg, #667eea);
            color: var(--code-editor-selection-fg, #fff);
        }

        code-editor .code-editor-textarea::-moz-selection {
            background: var(--code-editor-selection-bg, #667eea);
            color: var(--code-editor-selection-fg, #fff);
        }

        /* Display layer - positioned behind textarea for syntax highlighting */
        code-editor .code-editor-display {
            position: absolute;
            top: 0;
            left: var(--code-editor-gutter-width, 3em);
            right: 0;
            pointer-events: none;
            white-space: pre-wrap;
            overflow-wrap: break-word;
            word-break: break-word;
            font: inherit;
            line-height: inherit;
            letter-spacing: inherit;
            word-spacing: inherit;
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            will-change: transform;
            z-index: 2;
        }

        code-editor .code-editor-display .code-line {
            display: block;
            background: var(--code-editor-bg, transparent);
            -webkit-box-decoration-break: clone;
            box-decoration-break: clone;
        }

        code-editor .code-editor-display .code-segment {
            background: var(--text-bg-color, rgba(0, 0, 0, 0.75));
            color: #e3e3e3;
            padding: 0.1em 0;
            border-radius: 2px;
        }

        /* Focus state - subtle outline for accessibility */
        code-editor:focus-within {
            outline: 1px solid var(--code-editor-focus-outline, transparent);
        }

        /* Syntax highlighting colors */
        code-editor .hl-comment {
            color: var(--hl-comment, #6a737d);
            font-style: italic;
        }

        code-editor .hl-string {
            color: var(--hl-string, #9ecbff);
        }

        code-editor .hl-number {
            color: var(--hl-number, #79b8ff);
        }

        code-editor .hl-color {
            color: var(--hl-color, #ffab70);
        }

        code-editor .hl-boolean {
            color: var(--hl-boolean, #ff7b72);
        }

        code-editor .hl-null {
            color: var(--hl-null, #ff7b72);
        }

        code-editor .hl-function {
            color: var(--hl-function, #d2a8ff);
        }

        code-editor .hl-parameter {
            color: var(--hl-parameter, #ffa657);
        }

        code-editor .hl-output {
            color: var(--hl-output, #7ee787);
            font-weight: 600;
        }

        code-editor .hl-punctuation {
            color: var(--hl-punctuation, #e0e0e0);
        }

        code-editor .hl-operator {
            color: var(--hl-operator, #ff7b72);
        }

        code-editor .hl-identifier {
            color: var(--hl-identifier, #e0e0e0);
        }

        /* Selection highlight overlay */
        code-editor .code-editor-selection-highlight {
            position: absolute;
            inset: 0;
            pointer-events: none;
            z-index: 0;
            overflow: hidden;
        }

        /* Eval flash overlay (briefly highlights the evaluated lines) */
        code-editor .code-editor-flash {
            position: absolute;
            left: var(--code-editor-gutter-width, 3em);
            right: 0;
            pointer-events: none;
            z-index: 4;
            background: linear-gradient(
                90deg,
                color-mix(in srgb, var(--flash-color, #a5b8ff) 35%, transparent) 0%,
                color-mix(in srgb, var(--flash-color, #a5b8ff) 12%, transparent) 100%
            );
            border-left: 2px solid var(--flash-color, #a5b8ff);
            border-radius: 1px;
            opacity: 0;
            animation: code-editor-flash 0.55s ease-out forwards;
        }
        code-editor .code-editor-flash.error {
            --flash-color: #ff7b72;
        }
        @keyframes code-editor-flash {
            0% { opacity: 0; transform: translateX(-4px); }
            12% { opacity: 1; transform: translateX(0); }
            100% { opacity: 0; }
        }
    `
    document.head.appendChild(styleEl)
}

/**
 * Add polymorphic-specific behavior to a handfish <code-editor> element:
 * a flashLines() method and a 'forceevalblock' event on
 * Cmd/Ctrl+Shift+Enter or Alt+Enter (handfish handles plain Cmd/Ctrl+Enter
 * → 'forcerecompile' on its own).
 *
 * Idempotent: safe to call multiple times on the same element.
 *
 * @param {HTMLElement} el - the <code-editor> element
 */
export function enhanceCodeEditor(el) {
    if (!el || el._polymorphicEnhanced) return
    el._polymorphicEnhanced = true

    el.flashLines = function flashLines(startLine, endLine, options = {}) {
        const display = this.querySelector('.code-editor-display')
        if (!display) return
        const codeLines = display.querySelectorAll('.code-line')
        if (codeLines.length === 0) return
        const a = Math.max(0, startLine - 1)
        const b = Math.min(codeLines.length - 1, endLine - 1)
        if (a > b) return
        const top = codeLines[a].offsetTop
        const bottom = codeLines[b].offsetTop + codeLines[b].offsetHeight

        const flash = document.createElement('div')
        flash.className = 'code-editor-flash' + (options.error ? ' error' : '')
        flash.style.top = `${top}px`
        flash.style.height = `${bottom - top}px`
        const ta = typeof this.getTextarea === 'function' ? this.getTextarea() : null
        const scrollTop = ta?.scrollTop ?? 0
        flash.style.transform = `translateY(${-scrollTop}px)`
        this.appendChild(flash)
        flash.addEventListener('animationend', () => flash.remove(), { once: true })
        setTimeout(() => flash.remove(), 1000)
    }

    // Cmd/Ctrl+Shift+Enter or Alt+Enter → 'forceevalblock'.
    // Capture phase + stopImmediatePropagation so handfish's bubble-phase
    // handler on the same textarea doesn't ALSO fire 'forcerecompile' for
    // the Cmd/Ctrl+Shift+Enter case (handfish's check matches any
    // Cmd/Ctrl+Enter regardless of Shift).
    const textarea = typeof el.getTextarea === 'function' ? el.getTextarea() : null
    if (textarea) {
        textarea.addEventListener('keydown', (e) => {
            const mod = e.ctrlKey || e.metaKey
            if (e.key === 'Enter' && ((mod && e.shiftKey) || (e.altKey && !mod))) {
                e.preventDefault()
                e.stopImmediatePropagation()
                el.dispatchEvent(new CustomEvent('forceevalblock', {
                    bubbles: true,
                    composed: true
                }))
            }
        }, true)
    }
}
