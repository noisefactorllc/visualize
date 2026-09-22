import { test, expect } from '@playwright/test'

test('two Sync camera decks upload owned pixels and stopping A leaves B live', async ({ page }) => {
    test.setTimeout(45_000)
    await page.goto('/')
    await page.click('#boot-start')
    await page.waitForFunction(() => window.__visualize?.mixer?.ready)
    await page.evaluate(async () => {
        const { DeckMedia } = await import('/js/deckMedia.js')
        const v = window.__visualize
        for (const deck of Object.values(v.decks)) {
            const result = await deck.load('search synth\nmedia().write(o0)\nrender(o0)', 'Camera Input')
            if (!result.success) throw new Error('Camera test program did not compile')
        }
        const state = window.cameraTest = { starts: 0, stops: 0, devices: [] }
        window.electronAPI = { syncCamera: {
            isAvailable: async () => true,
            subscribe(callback) {
                state.starts++
                state.deliver = callback
                return () => { state.stops++ }
            }
        } }
        navigator.mediaDevices.getUserMedia = async () => {
            const canvas = document.createElement('canvas')
            canvas.width = canvas.height = 2
            const stream = canvas.captureStream(30)
            const track = stream.getVideoTracks()[0]
            Object.defineProperty(track, 'label', { value: 'Sync Camera' })
            const paint = setInterval(() => canvas.getContext('2d').fillRect(0, 0, 2, 2), 16)
            const stop = track.stop.bind(track)
            track.stop = () => { clearInterval(paint); stop() }
            return stream
        }
        for (const deck of Object.values(v.decks)) {
            const media = new DeckMedia({ deck, onError: error => { state.error = error.message } })
            state.devices.push(media)
            await media.setCamera()
        }
        state.frame = (timestamp, red, green, blue) => {
            const bytes = new Uint8Array(16)
            for (let i = 0; i < bytes.length; i += 4) bytes.set([blue, green, red, 255], i)
            state.deliver({ presentationTimeUs: timestamp, width: 2, height: 2, buffer: bytes.buffer })
        }
        state.frame(1000, 255, 0, 0)
        state.frame(2000, 255, 0, 0)
        for (const media of state.devices) media.tick()
        state.sample = id => {
            const canvas = document.createElement('canvas')
            canvas.width = canvas.height = 1
            const ctx = canvas.getContext('2d')
            ctx.drawImage(v.decks[id].canvas, 0, 0, 1, 1)
            return [...ctx.getImageData(0, 0, 1, 1).data]
        }
    })
    await expect.poll(() => page.evaluate(() => window.cameraTest.sample('A'))).toEqual([255, 0, 0, 255])
    await expect.poll(() => page.evaluate(() => window.cameraTest.sample('B'))).toEqual([255, 0, 0, 255])
    await page.evaluate(async () => {
        const state = window.cameraTest
        await state.devices[0].stop()
        state.frame(3000, 0, 255, 0)
        state.devices[1].tick() // The previous red frame precedes the new green frame.
        await Promise.resolve()
        state.devices[1].tick()
    })
    await expect.poll(() => page.evaluate(() => window.cameraTest.sample('B'))).toEqual([0, 255, 0, 255])
    expect(await page.evaluate(() => ({ starts: window.cameraTest.starts, stops: window.cameraTest.stops, error: window.cameraTest.error })))
        .toEqual({ starts: 1, stops: 0, error: undefined })
    await page.evaluate(() => window.cameraTest.devices[1].stop())
    expect(await page.evaluate(() => window.cameraTest.stops)).toBe(1)
})
