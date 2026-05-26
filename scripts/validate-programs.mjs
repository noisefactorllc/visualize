#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Compile-checks every entry in data/programs.json against the real
 * noisemaker shader bundle. Runs in a headless browser since the
 * compiler isn't a pure-Node module (it pulls effects from the CDN).
 *
 * Use this after running scripts/import-noiseblaster.mjs to find any
 * imported entries whose DSL doesn't survive the real compile path.
 * Failing entries are reported by code so you can either fix them or
 * remove them from programs.json.
 *
 * Reports total / passed / failed and a per-entry error summary.
 */
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 3119

const server = spawn('npx', ['http-server', '.', '-p', String(PORT), '-c-1', '-s'], {
    stdio: 'ignore',
    cwd: process.cwd(),
})

process.on('exit', () => { try { server.kill() } catch {} })
process.on('SIGINT', () => { try { server.kill() } catch {}; process.exit(130) })

async function waitForServer() {
    for (let i = 0; i < 30; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${PORT}/index.html`)
            if (res.ok) return
        } catch {}
        await sleep(200)
    }
    throw new Error(`server never came up on :${PORT}`)
}

async function main() {
    await waitForServer()
    const browser = await chromium.launch()
    const page = await browser.newPage()

    const errors = []
    page.on('pageerror', e => errors.push(e.message))

    await page.goto(`http://127.0.0.1:${PORT}/index.html`)
    await page.click('#boot-start')

    // Wait for the deck to be initialized — first program already loaded.
    await page.waitForFunction(() => {
        return window.__visualize?.decks?.A
            && document.getElementById('deck-a-name').textContent !== '—'
    }, { timeout: 60_000 })

    // Compile each program through the real deck.load() path.
    const summary = await page.evaluate(async () => {
        const programs = await fetch('data/programs.json').then(r => r.json())
        const deck = window.__visualize.decks.A
        const results = []
        for (const p of programs) {
            try {
                const res = await deck.load(p.dsl, p.title)
                results.push({
                    title: p.title,
                    code: p.source?.code ?? null,
                    ok: !!res.success,
                    error: res.success ? null : (res.error || 'unknown').slice(0, 240),
                })
            } catch (e) {
                results.push({
                    title: p.title,
                    code: p.source?.code ?? null,
                    ok: false,
                    error: String(e.message || e).slice(0, 240),
                })
            }
        }
        return results
    })

    await browser.close()
    server.kill()

    const passed = summary.filter(r => r.ok)
    const failed = summary.filter(r => !r.ok)
    console.log(`\nTotal:  ${summary.length}`)
    console.log(`Passed: ${passed.length}`)
    console.log(`Failed: ${failed.length}`)

    if (failed.length) {
        console.log('\nFailures:')
        for (const f of failed) {
            const tag = f.code ? `[${f.code}]` : '[native]'
            console.log(`  ${tag} ${f.title}`)
            console.log(`     → ${f.error}`)
        }
        process.exit(1)
    }
    process.exit(0)
}

main().catch(err => {
    console.error(err)
    server.kill()
    process.exit(1)
})
