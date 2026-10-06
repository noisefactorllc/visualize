// SPDX-License-Identifier: MIT
//
// A real sharing server for share specs: the sibling ../sharing checkout (or
// SHARING_SERVER) runs on a free local port with temporary storage, and a
// page's https://sharing.noisedeck.app requests are sent to it.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'

export const SHARING_ORIGIN = 'https://sharing.noisedeck.app'
export const sharingServerPath = resolve(process.env.SHARING_SERVER || '../sharing/server/index.js')
export const sharingServerAvailable = existsSync(sharingServerPath)

/** A solid-color 2x2 RGBA PNG file and its SHA-256 id. */
export function solidPng([red, green, blue]) {
    const chunk = (type, data) => {
        const body = Buffer.concat([Buffer.from(type), data])
        let crc = 0xffffffff
        for (const byte of body) {
            crc ^= byte
            for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
        }
        const length = Buffer.alloc(4), checksum = Buffer.alloc(4)
        length.writeUInt32BE(data.length)
        checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
        return Buffer.concat([length, body, checksum])
    }
    const header = Buffer.alloc(13)
    header.writeUInt32BE(2, 0)
    header.writeUInt32BE(2, 4)
    header[8] = 8
    header[9] = 6
    const row = [0, red, green, blue, 255, red, green, blue, 255]
    const bytes = Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(Buffer.from([...row, ...row]))),
        chunk('IEND', Buffer.alloc(0)),
    ])
    return { bytes, id: createHash('sha256').update(bytes).digest('hex') }
}

function freePort() {
    return new Promise((resolvePort, reject) => {
        const server = createServer()
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address()
            server.close(() => resolvePort(port))
        })
    })
}

/** Start the sharing server. Returns { url, dataDir, imagesDir, stop }. */
export async function startSharingServer() {
    const dataDir = await mkdtemp(join(tmpdir(), 'visualize-share-data-'))
    const imagesDir = await mkdtemp(join(tmpdir(), 'visualize-share-images-'))
    const port = await freePort()
    const url = `http://127.0.0.1:${port}`
    const child = spawn(process.execPath, [sharingServerPath], {
        cwd: resolve(sharingServerPath, '../..'),
        env: { ...process.env, PORT: String(port), BASE_URL: SHARING_ORIGIN, SHARING_DATA_DIR: dataDir, SHARING_IMAGES_DIR: imagesDir },
        stdio: ['ignore', 'ignore', 'inherit'],
    })
    const stop = async () => {
        if (child.exitCode === null) {
            const exited = new Promise(done => child.once('exit', done))
            child.kill('SIGTERM')
            await exited
        }
        await rm(dataDir, { recursive: true, force: true })
        await rm(imagesDir, { recursive: true, force: true })
    }
    for (let i = 0; i < 150; i++) {
        if (await fetch(`${url}/api/health`).then(r => r.ok).catch(() => false)) return { url, dataDir, imagesDir, stop }
        if (child.exitCode !== null) break
        await new Promise(done => setTimeout(done, 100))
    }
    await stop()
    throw new Error('the local sharing server did not start')
}

/** Upload images and share a DSL that names them, as a sharing app does. Returns the code. */
export async function seedComposition(server, { dsl, title, images = [] }) {
    for (const image of images) {
        const response = await fetch(`${server.url}/api/images`, {
            method: 'POST', headers: { 'content-type': 'image/png' }, body: image.bytes,
        })
        if (!response.ok) throw new Error(`image upload failed: ${response.status} ${await response.text()}`)
        if ((await response.json()).id !== image.id) throw new Error('the uploaded image id does not match its bytes')
    }
    const response = await fetch(`${server.url}/api/shorten`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dsl, title }),
    })
    const body = await response.json()
    if (!response.ok) throw new Error(`share failed: ${response.status} ${JSON.stringify(body)}`)
    return body.code
}

/**
 * Send the page's sharing.noisedeck.app requests to the local server, and
 * record every request the page sends and every sharing response it reads.
 */
export async function routeSharing(page, server, origin) {
    const traffic = { requests: [], responses: [] }
    page.on('request', request => traffic.requests.push({ url: request.url(), method: request.method(), body: request.postData() || '' }))
    await page.route(`${SHARING_ORIGIN}/**`, async route => {
        const url = new URL(route.request().url())
        const response = await route.fetch({ url: `${server.url}${url.pathname}${url.search}` })
        const body = await response.body()
        traffic.responses.push({ url: url.href, status: response.status(), type: response.headers()['content-type'] || '', body })
        await route.fulfill({ response, body, headers: { ...response.headers(), 'access-control-allow-origin': origin } })
    })
    return traffic
}

/** Image text: a data URL or base64 of an image. */
export const IMAGE_TEXT = /data:image|;base64,|dataUrl|iVBORw0KGgo/
