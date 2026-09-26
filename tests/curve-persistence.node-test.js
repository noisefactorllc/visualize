// SPDX-License-Identifier: MIT
// Crossfade curve validation + persistence regression tests.
//
// Covers parseCrossfadeCurve (the guard behind #automix-curve
// persistence in app.js), markup agreement between the persisted
// curve list and the dropdown options, and tooltip presence on the
// curve control per the Handfish design system.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
    parseCrossfadeCurve,
    CROSSFADE_CURVES,
    CROSSFADE_DEFAULT_CURVE
} from '../js/crossfader.js'

const ROOT = resolve(import.meta.dirname, '..')

test('parseCrossfadeCurve accepts all valid curve names', () => {
    for (const name of CROSSFADE_CURVES) {
        assert.equal(parseCrossfadeCurve(name), name)
    }
})

test('parseCrossfadeCurve normalizes case and surrounding whitespace', () => {
    assert.equal(parseCrossfadeCurve('  SHARP '), 'sharp')
    assert.equal(parseCrossfadeCurve('Dipped'), 'dipped')
    assert.equal(parseCrossfadeCurve('Cut'), 'cut')
    assert.equal(parseCrossfadeCurve('LINEAR'), 'linear')
})

test('parseCrossfadeCurve falls back to default on invalid names', () => {
    assert.equal(parseCrossfadeCurve('sine'), CROSSFADE_DEFAULT_CURVE)
    assert.equal(parseCrossfadeCurve(''), CROSSFADE_DEFAULT_CURVE)
    assert.equal(parseCrossfadeCurve('dipped '), 'dipped')
})

test('parseCrossfadeCurve rejects non-string input', () => {
    assert.equal(parseCrossfadeCurve(null), CROSSFADE_DEFAULT_CURVE)
    assert.equal(parseCrossfadeCurve(undefined), CROSSFADE_DEFAULT_CURVE)
    assert.equal(parseCrossfadeCurve(42), CROSSFADE_DEFAULT_CURVE)
    assert.equal(parseCrossfadeCurve({ curve: 'linear' }), CROSSFADE_DEFAULT_CURVE)
    assert.equal(parseCrossfadeCurve(true), CROSSFADE_DEFAULT_CURVE)
})

test('parseCrossfadeCurve honours a custom default curve', () => {
    assert.equal(parseCrossfadeCurve('bogus', { defaultCurve: 'linear' }), 'linear')
    assert.equal(parseCrossfadeCurve(null, { defaultCurve: 'cut' }), 'cut')
    assert.equal(parseCrossfadeCurve('sharp', { defaultCurve: 'cut' }), 'sharp')
})

test('default curve is itself a valid curve name', () => {
    assert.ok(CROSSFADE_CURVES.includes(CROSSFADE_DEFAULT_CURVE))
})

test('#automix-curve dropdown options exactly match the valid curve list', () => {
    const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8')
    const m = html.match(/<select-dropdown id="automix-curve"[\s\S]*?<\/select-dropdown>/)
    assert.ok(m, 'automix-curve dropdown exists in index.html')
    const values = Array.from(m[0].matchAll(/<option value="([^"]+)"/g), (x) => x[1])
    assert.deepEqual(values.sort(), [...CROSSFADE_CURVES].sort())
})

test('#automix-curve carries Handfish tooltip markup', () => {
    const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8')
    const m = html.match(/<select-dropdown id="automix-curve"[^>]*>/)
    assert.ok(m, 'automix-curve dropdown exists in index.html')
    const tag = m[0]
    assert.ok(/class="[^"]*\btooltip\b[^"]*"/.test(tag), 'tooltip class present')
    assert.ok(/data-title="[^"]+"/.test(tag), 'data-title present')
})

test('persisted-curve storage payload shape is validated end-to-end', () => {
    // Mirrors app.js loadCurvePrefs: JSON.parse of a stored payload,
    // then parseCrossfadeCurve on the .curve field (possibly null).
    const stored = JSON.stringify({ curve: 'sharp' })
    const parsed = JSON.parse(stored || 'null')
    assert.equal(parseCrossfadeCurve(parsed && parsed.curve), 'sharp')

    const corrupt = 'not json'
    let failed = false
    try {
        JSON.parse(corrupt)
    } catch {
        failed = true
    }
    assert.ok(failed, 'corrupt storage payloads throw and are discarded by the caller')

    const empty = JSON.parse('null')
    assert.equal(parseCrossfadeCurve(empty && empty.curve), 'dipped')
})