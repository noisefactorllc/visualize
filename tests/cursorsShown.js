// SPDX-License-Identifier: MIT
/**
 * The cursor shown at every point of a page's window: a 16px grid plus the
 * four corners. Returns one "element: cursor" entry for each element whose
 * computed cursor is not "none", so an empty list means the cursor is
 * hidden everywhere.
 */
export function cursorsShown(page) {
    return page.evaluate(() => {
        const shown = new Set()
        const xs = [0, innerWidth - 1]
        const ys = [0, innerHeight - 1]
        for (let x = 1; x < innerWidth; x += 16) xs.push(x)
        for (let y = 1; y < innerHeight; y += 16) ys.push(y)
        for (const y of ys) {
            for (const x of xs) {
                const el = document.elementFromPoint(x, y)
                const cursor = el ? getComputedStyle(el).cursor : 'no element'
                if (cursor !== 'none') {
                    shown.add(`${el?.tagName.toLowerCase()}#${el?.id}.${[...(el?.classList || [])].join('.')}: ${cursor}`)
                }
            }
        }
        return [...shown]
    })
}
