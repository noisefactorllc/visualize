// SPDX-License-Identifier: MIT
/**
 * MixerControls — renders the current mixer effect's non-driver
 * parameters as a noisedeck-style control panel below the main
 * canvas. Same idiom polymorphic uses (see polymorphic/public/js/
 * ui/effectControls.js) but specialized for our single-effect-at-a-
 * time mixer pipeline.
 *
 * For each entry in `effectDef.globals`:
 *   - skip `tex` (it's the deck-B surface, not user-editable)
 *   - skip the mixer's `driver` param (the crossfader owns that)
 *   - choose a widget by type:
 *       int with .choices            → <select-dropdown>
 *       int (no choices)             → <slider-value type=int>
 *       float                        → <slider-value type=float>
 *       (bool maps to a 2-choice int in mixer effects, so the
 *        select-dropdown branch handles it.)
 *   - on change: mixer.setOverride(paramName, value) — recompiles
 *     the pipeline (debounced) so the new value lands in the GLSL
 *     uniforms via the compiled DSL
 *
 * Honors `spec.ui.enabledBy` (e.g. split.position is disabled when
 * speed > 0) by toggling .control-disabled on the row whenever
 * dependent params change.
 *
 * Custom elements (slider-value, select-dropdown, toggle-switch)
 * come from the handfish ESM bundle, already loaded for the deck
 * DSL editor — no extra cost.
 */

import { getEffect } from '../noisemaker/bundle.js'

export class MixerControls {
    constructor(rootEl, mixer) {
        this.root = rootEl
        this.mixer = mixer
        this._currentMixerId = null
        this._rows = []        // [{paramName, el, spec}]
    }

    /**
     * Render the panel for `mixerId`. Idempotent — if called with
     * the same id, refreshes values without rebuilding the DOM. If
     * the id changes, tears down and rebuilds.
     */
    show(mixerId) {
        if (this._currentMixerId === mixerId) {
            this._refreshValues()
            return
        }
        this._currentMixerId = mixerId
        this._build(mixerId)
    }

    _build(mixerId) {
        this.root.innerHTML = ''
        this._rows = []

        const effectDef = getEffect(mixerId)
        if (!effectDef || !effectDef.globals) {
            this.root.hidden = true
            return
        }

        const mixerDesc = this.mixer.currentMixer
        const driver = mixerDesc?.driver

        for (const [paramName, spec] of Object.entries(effectDef.globals)) {
            if (paramName === driver) continue
            if (spec.type === 'surface') continue
            if (spec.type === 'volume' || spec.type === 'geometry') continue

            const row = this._buildRow(paramName, spec)
            if (row) {
                this.root.appendChild(row.el)
                this._rows.push(row)
            }
        }

        this.root.hidden = this._rows.length === 0
        this._refreshDisabledStates()
    }

    _buildRow(paramName, spec) {
        const row = document.createElement('div')
        row.className = 'mixer-control-row'
        row.dataset.paramKey = paramName

        const label = document.createElement('span')
        label.className = 'mixer-control-label'
        const labelText = spec.ui?.label || paramName
        label.textContent = labelText
        label.title = labelText      // tooltip surfaces ellipsis-truncated long labels

        let control
        const current = this.mixer.getOverride(paramName) ?? spec.default

        if (spec.choices && typeof spec.choices === 'object') {
            control = this._buildSelect(paramName, spec, current)
        } else if (spec.type === 'float' || spec.type === 'int') {
            control = this._buildSlider(paramName, spec, current)
        } else {
            // Unknown type — skip the row rather than render a broken control.
            return null
        }

        row.appendChild(label)
        row.appendChild(control.element)
        return { paramName, el: row, spec, control }
    }

    _buildSlider(paramName, spec, value) {
        const isInt = spec.type === 'int'
        const slider = document.createElement('slider-value')
        slider.min = spec.min ?? 0
        slider.max = spec.max ?? 1
        slider.step = spec.step ?? (isInt ? 1 : 0.01)
        slider.type = isInt ? 'int' : 'float'
        const v = (typeof value === 'number') ? value : (spec.default ?? slider.min)
        slider.value = v

        slider.addEventListener('input', () => {
            const numeric = isInt ? Math.round(Number(slider.value)) : Number(slider.value)
            this.mixer.setOverride(paramName, numeric)
            this._refreshDisabledStates()
        })

        return {
            element: slider,
            set: (v) => { if (typeof v === 'number') slider.value = v }
        }
    }

    _buildSelect(paramName, spec, value) {
        const select = document.createElement('select-dropdown')
        const options = []
        for (const [key, val] of Object.entries(spec.choices)) {
            if (key.endsWith(':')) continue
            options.push({ value: stringifyChoice(val), text: key })
        }
        select.setOptions(options)
        // Choice values may be strings (enum names) or ints. Whatever
        // got written into overrides is what we display.
        select.value = stringifyChoice(value ?? spec.default)

        select.addEventListener('change', () => {
            const raw = select.value
            // Look up the choice key whose value matches the dropdown
            // value, then store the *string key* in overrides so the
            // generated DSL reads `mode: mix` rather than `mode: 8`.
            const matched = Object.entries(spec.choices).find(
                ([k, v]) => stringifyChoice(v) === raw && !k.endsWith(':')
            )
            const dslValue = matched ? matched[0] : raw
            this.mixer.setOverride(paramName, dslValue)
            this._refreshDisabledStates()
        })

        return {
            element: select,
            set: (v) => { select.value = stringifyChoice(v) }
        }
    }

    /** Re-pull values from the mixer + write into existing widgets. */
    _refreshValues() {
        for (const row of this._rows) {
            const v = this.mixer.getOverride(row.paramName) ?? row.spec.default
            row.control.set?.(v)
        }
        this._refreshDisabledStates()
    }

    /**
     * Apply spec.ui.enabledBy across rows — e.g. split.position is
     * disabled when speed > 0 because the shader self-animates the
     * wipe instead of reading position.
     */
    _refreshDisabledStates() {
        for (const row of this._rows) {
            const dep = row.spec.ui?.enabledBy
            if (!dep) continue
            const depVal = this.mixer.getOverride(dep.param)
            const target = dep.eq ?? dep.value
            const enabled = looselyEqual(depVal, target)
            row.el.classList.toggle('mixer-control-disabled', !enabled)
        }
    }
}

function stringifyChoice(value) {
    if (typeof value === 'number') return String(value)
    return String(value ?? '')
}

function looselyEqual(a, b) {
    if (a == null || b == null) return a == b   // eslint-disable-line eqeqeq
    // Choice values can be either int or string-key; allow both.
    return String(a) === String(b) || Number(a) === Number(b)
}
