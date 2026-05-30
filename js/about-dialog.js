// SPDX-License-Identifier: MIT
/**
 * About dialog wiring (Handfish AboutDialog component).
 */

import { AboutDialog } from 'handfish'

const APP_VERSION = '0.1.0-SNAPSHOT'

const about = new AboutDialog({
    name: 'Visualize',
    version: APP_VERSION,
    logo: `<img src="/img/visualize.png" alt="" style="width:64px;height:64px;border-radius:12px;display:block">`,
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
