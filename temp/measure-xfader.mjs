import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto('http://localhost:3007')
await page.click('#boot-start')
await page.waitForSelector('#crossfader', { timeout: 10000 })
await page.waitForTimeout(500)

const box = await page.$eval('#crossfader', el => {
    const r = el.getBoundingClientRect()
    return {
        width: Math.round(r.width * 100) / 100,
        height: Math.round(r.height * 100) / 100,
        x: Math.round(r.x * 100) / 100,
        y: Math.round(r.y * 100) / 100,
    }
})

const computed = await page.$eval('#crossfader', el => {
    const s = getComputedStyle(el)
    return {
        height: s.height,
        width: s.width,
        margin: s.margin,
        padding: s.padding,
    }
})

console.log(JSON.stringify({ box, computed }, null, 2))
await browser.close()
