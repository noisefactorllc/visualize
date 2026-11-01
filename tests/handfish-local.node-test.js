import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { routeHandfishLocal } from './handfishLocal.js'

test('Handfish routing uses published assets by default and local assets only when selected', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'handfish-test-assets-'))
    const previous = { cwd: process.cwd(), local: process.env.HANDFISH_LOCAL, dist: process.env.HANDFISH_DIST }
    try {
        const app = path.join(root, 'app')
        const stale = path.join(root, 'handfish', 'dist')
        const selected = path.join(root, 'selected')
        await fs.mkdir(app, { recursive: true })
        await fs.mkdir(stale, { recursive: true })
        await fs.mkdir(selected)
        await fs.writeFile(path.join(stale, 'handfish.esm.min.js'), 'stale sibling')
        await fs.writeFile(path.join(selected, 'handfish.esm.min.js'), 'selected asset')
        process.chdir(app)
        delete process.env.HANDFISH_LOCAL
        delete process.env.HANDFISH_DIST
        const handlers = []
        const page = { route: async (pattern, handler) => handlers.push({ pattern, handler }) }
        await routeHandfishLocal(page)
        assert.equal(handlers.length, 0, 'an implicit sibling must not replace the published dependency')
        for (const variable of ['HANDFISH_LOCAL', 'HANDFISH_DIST']) {
            process.env[variable] = selected
            await routeHandfishLocal(page)
            const { pattern, handler } = handlers.at(-1)
            assert.equal(pattern, 'https://handfish.noisefactor.io/0/**')
            let response
            await handler({ request: () => ({ url: () => 'https://handfish.noisefactor.io/0/handfish.esm.min.js' }), fulfill: async value => { response = value } })
            assert.equal(response.status, 200)
            assert.equal(response.body.toString(), 'selected asset')
            delete process.env[variable]
        }
    } finally {
        process.chdir(previous.cwd)
        for (const [variable, value] of [['HANDFISH_LOCAL', previous.local], ['HANDFISH_DIST', previous.dist]]) {
            if (value === undefined) delete process.env[variable]
            else process.env[variable] = value
        }
        await fs.rm(root, { recursive: true, force: true })
    }
})
