// SPDX-License-Identifier: MIT
/**
 * Handfish theme picker — list, apply, persist.
 *
 * Each theme is a CSS file at /0/styles/themes/{file}.css plus a
 * [data-theme="..."] attribute on <html>. We mount one <link> tag and
 * swap its href when the active theme changes; the attribute then
 * selects which selector block inside that file takes effect.
 *
 * Two files (neutral.css, gray.css, high-contrast.css) each define a
 * dark + light variant, so multiple THEMES entries can share a `file`.
 */

const CDN_BASE = 'https://handfish.noisefactor.io/0/styles/themes'
const LINK_ID = 'hf-theme-link'

export const THEMES = [
    { value: 'neutral-dark',        file: 'neutral',        label: 'Neutral · Dark' },
    { value: 'neutral-light',       file: 'neutral',        label: 'Neutral · Light' },
    { value: 'gray-dark',           file: 'gray',           label: 'Gray · Dark' },
    { value: 'gray-light',          file: 'gray',           label: 'Gray · Light' },
    { value: 'corporate',           file: 'corporate',      label: 'Corporate' },
    { value: 'high-contrast-dark',  file: 'high-contrast',  label: 'High Contrast · Dark' },
    { value: 'high-contrast-light', file: 'high-contrast',  label: 'High Contrast · Light' },
    { value: 'newspaper',           file: 'newspaper',      label: 'Newspaper' },
    { value: 'gothic',              file: 'gothic',         label: 'Gothic' },
    { value: 'terminal',            file: 'terminal',       label: 'Terminal' },
    { value: 'brutalist',           file: 'brutalist',      label: 'Brutalist' },
    { value: 'ocean',               file: 'ocean',          label: 'Ocean' },
    { value: 'dusk',                file: 'dusk',           label: 'Dusk' },
    { value: 'sunset',              file: 'sunset',         label: 'Sunset' },
    { value: 'earthy',              file: 'earthy',         label: 'Earthy' },
    { value: 'organic',             file: 'organic',        label: 'Organic' },
    { value: 'cyberpunk',           file: 'cyberpunk',      label: 'Cyberpunk' },
    { value: 'synthwave',           file: 'synthwave',      label: 'Synthwave' },
    { value: 'rave',                file: 'rave',           label: 'Rave' },
    { value: 'kawaii',              file: 'kawaii',         label: 'Kawaii' },
]

const VALID = new Set(THEMES.map(t => t.value))
const FILE_BY_VALUE = Object.fromEntries(THEMES.map(t => [t.value, t.file]))

function ensureLink() {
    let link = document.getElementById(LINK_ID)
    if (!link) {
        link = document.createElement('link')
        link.id = LINK_ID
        link.rel = 'stylesheet'
        document.head.appendChild(link)
    }
    return link
}

/** Apply a theme — swap the CSS link + set data-theme on <html>. */
export function applyTheme(value) {
    if (!VALID.has(value)) {
        console.warn(`[handfish-theme] unknown theme: ${value}`)
        return false
    }
    const file = FILE_BY_VALUE[value]
    const link = ensureLink()
    const wanted = `${CDN_BASE}/${file}.css`
    // setAttribute (not the .href property) so we get a literal href that
    // doesn't depend on the browser's URL normalization; we then compare via
    // getAttribute for the same reason. Some browsers normalize property
    // .href to an absolute URL that doesn't equal the string we just set,
    // which would skip the update.
    const current = link.getAttribute('href')
    if (current !== wanted) link.setAttribute('href', wanted)
    document.documentElement.setAttribute('data-theme', value)
    return true
}

/** Read the saved theme (or fall back), apply it, and return the value. */
export function applyStoredTheme({ storageKey, defaultTheme = 'neutral-dark' }) {
    let stored = null
    try { stored = localStorage.getItem(storageKey) } catch { /* private mode */ }
    const value = (stored && VALID.has(stored)) ? stored : defaultTheme
    applyTheme(value)
    return value
}

/** Persist + apply. Returns the applied value (or null on invalid input). */
export function setTheme(value, { storageKey }) {
    if (!applyTheme(value)) return null
    try { localStorage.setItem(storageKey, value) } catch { /* private mode */ }
    return value
}

/**
 * Mount a native <select> as the picker into a container. We use a native
 * select so the picker works without depending on handfish's component
 * bundle loading first (and so it survives any future bundle changes).
 *
 * Returns the select element so callers can sync external changes back
 * into the UI by setting `el.value = '…'`.
 */
export function mountThemePicker({ container, storageKey, defaultTheme = 'neutral-dark' }) {
    const value = applyStoredTheme({ storageKey, defaultTheme })

    const select = document.createElement('select')
    select.className = 'hf-theme-select'
    for (const t of THEMES) {
        const opt = document.createElement('option')
        opt.value = t.value
        opt.textContent = t.label
        if (t.value === value) opt.selected = true
        select.appendChild(opt)
    }
    select.addEventListener('change', () => {
        setTheme(select.value, { storageKey })
    })

    container.appendChild(select)
    return select
}
