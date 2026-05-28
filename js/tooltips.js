// SPDX-License-Identifier: MIT
/**
 * Tooltip glue for handfish.
 *
 * Handfish's tooltip system reads `data-title` (with fallback to
 * `aria-label`) from elements that carry the `.tooltip` class.
 * Native `title=` attributes are ignored.
 *
 * This module provides:
 *
 *  - setupTooltips()        — boot-time: registers handfish's hover/
 *                             focus handlers and migrates the static
 *                             markup's existing `title=` attrs over.
 *  - migrateBelow(root)     — convert any [title] in a subtree (call
 *                             after rendering a batch of dynamic
 *                             content like library cards).
 *  - setTooltip(el, text)   — for code that builds elements
 *                             imperatively; sets data-title + .tooltip,
 *                             or clears both when text is empty.
 *
 * Native `title=` is removed during migration so the browser doesn't
 * also pop its own (delayed, unstyled) tooltip on top of handfish's.
 */
import { initializeTooltips } from 'handfish'

export function setupTooltips() {
    initializeTooltips()
    migrateBelow(document.body)
}

export function migrateBelow(root) {
    if (!root) return
    if (root.nodeType === 1 && root.hasAttribute('title')) _migrate(root)
    if (root.querySelectorAll) {
        for (const el of root.querySelectorAll('[title]')) _migrate(el)
    }
}

export function setTooltip(el, text) {
    if (!el) return
    if (text == null || text === '') {
        delete el.dataset.title
        el.classList.remove('tooltip')
        return
    }
    el.dataset.title = String(text)
    el.classList.add('tooltip')
    if (el.hasAttribute('title')) el.removeAttribute('title')
}

function _migrate(el) {
    const text = el.getAttribute('title')
    if (!text) return
    el.dataset.title = text
    el.removeAttribute('title')
    el.classList.add('tooltip')
}
