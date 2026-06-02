// SPDX-License-Identifier: MIT
/**
 * About dialog wiring (Handfish AboutDialog component).
 */

import { AboutDialog } from 'handfish'

const APP_VERSION = '0.1.0-SNAPSHOT'

const about = new AboutDialog({
    name: 'Visualize',
    version: APP_VERSION,
    logo: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" fill="currentColor" style="width:256px;height:256px;display:block"><g transform="translate(0,600) scale(0.1,-0.1)"><path d="M1020 4339 l0 -272 212 -326 c256 -396 714 -1101 1098 -1696 l285 -440 380 -2 380 -3 211 328 c189 292 851 1313 1055 1627 43 66 101 156 129 200 28 44 85 132 126 195 l74 115 0 273 0 272 -238 0 -239 0 -313 -497 c-904 -1435 -1183 -1874 -1187 -1870 -2 3 -339 535 -747 1183 l-744 1179 -241 3 -241 2 0 -271z"/><path d="M1710 4472 l0 -138 361 -524 c390 -567 381 -553 703 -1023 179 -260 221 -316 232 -305 7 7 297 427 646 933 l633 920 2 138 3 137 -239 0 -239 0 -29 -39 c-15 -22 -199 -299 -407 -616 l-379 -576 -270 408 c-148 224 -330 501 -405 615 l-137 208 -237 0 -238 0 0 -138z"/></g></svg>`,
    repo: 'noisefactorllc/visualize',
    ecosystem: `Visualize is a free tool by <a href="https://noisefactor.io/" target="_blank" rel="noopener">Noise Factor</a>, powered by the <a href="https://noisemaker.app/" target="_blank" rel="noopener">Noisemaker</a> open source engine.`,
})

// deployment-meta.json is written by the CI deploy pipeline (see
// scaffold static-site-release). It never exists in local dev, and
// the browser logs a 404 to the console that fails the smoke spec's
// strict error check. Skip the fetch outright on local hosts.
const isLocalDev = typeof window !== 'undefined' && (
    window.location.hostname === 'localhost'
    || window.location.hostname === '127.0.0.1'
    || window.location.protocol === 'file:'
)
if (!isLocalDev) {
    fetch('./deployment-meta.json', { cache: 'no-store' }).then(async (res) => {
        if (!res.ok) return
        const data = await res.json()
        const hash = data.git_hash?.trim().slice(0, 8) || 'LOCAL'
        const deployed = data.date ? new Date(data.date * 1000) : null
        about.setBuild({ hash, deployed })
    }).catch(() => {})
}

if (!(typeof window !== 'undefined' && window.electronAPI?.isElectron)) {
    about.setNoisemakerFromUrl('https://shaders.noisedeck.app/1/deployment-meta.json')
}

export { about as aboutDialog }
