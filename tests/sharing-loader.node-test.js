// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { fileInlineImages } from '../js/sharingLoader.js'
import { solidPng } from './sharingLocal.js'

// The image tools the app imports from sharing.noisedeck.app, from the
// sibling sharing checkout (or PORTABLE_IMAGES_MODULE).
const toolsPath = resolve(process.env.PORTABLE_IMAGES_MODULE || '../sharing/public/js/portableImages.js')
const skip = existsSync(toolsPath) ? false : `needs the image tools at ${toolsPath} (set PORTABLE_IMAGES_MODULE)`
const loadTools = () => import(pathToFileURL(toolsPath).href)

// Fixtures: images given inline, as a program written before image files would.
const dataUrl = image => `data:image/png;base64,${image.bytes.toString('base64')}`
const program = (...urls) => `search synth\n${urls.map((url, index) => `media(url: "${url}").write(o${index})`).join('\n')}\nrender(o0)`

test('a program without inline images is returned as it is, without reading the tools', async () => {
    const tools = new Proxy({}, { get: () => { throw new Error('must not use the image tools') } })
    for (const dsl of [program('image:abc'), 'noise().write(o0)', undefined]) {
        assert.deepEqual(await fileInlineImages(dsl, tools), { dsl, images: [] })
    }
})

test('each inline image becomes a Blob image file named by the SHA-256 of its bytes', { skip }, async () => {
    const tools = await loadTools()
    const red = solidPng([255, 0, 0]), green = solidPng([0, 255, 0])
    const url = 'https://example.com/a.png'
    const filed = await fileInlineImages(program(dataUrl(red), url, dataUrl(green), dataUrl(red)), tools)
    assert.equal(filed.dsl, program(`image:${red.id}`, url, `image:${green.id}`, `image:${red.id}`))
    assert.deepEqual(filed.images.map(image => image.id), [red.id, green.id], 'one file per image')
    for (const [image, source] of [[filed.images[0], red], [filed.images[1], green]]) {
        assert.ok(image.blob instanceof Blob)
        assert.equal('dataUrl' in image, false)
        assert.equal(image.blob.type, 'image/png')
        assert.deepEqual(Buffer.from(await image.blob.arrayBuffer()), source.bytes)
        assert.deepEqual([image.mimeType, image.width, image.height], ['image/png', 2, 2])
    }
})

test('an inline image that is not an image fails, or with skipInvalid loses its URL', { skip }, async () => {
    const tools = await loadTools()
    const red = solidPng([255, 0, 0])
    const invalid = 'data:image/png;base64,AAAA'
    await assert.rejects(fileInlineImages(program(invalid), tools), /Invalid image/)
    const warn = console.warn
    console.warn = () => {}
    try {
        const filed = await fileInlineImages(program(invalid, dataUrl(red)), tools, { skipInvalid: true })
        assert.equal(filed.dsl, 'search synth\nmedia().write(o0)\n' + `media(url: "image:${red.id}").write(o1)\nrender(o0)`)
        assert.deepEqual(filed.images.map(image => image.id), [red.id])
    } finally { console.warn = warn }
})
