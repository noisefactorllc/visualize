#!/usr/bin/env node
/**
 * Downloads pinned Noisemaker engine + effect bundles to <repo>/vendor/noisemaker/<v>/.
 * Writes SHA256SUMS for app-launch integrity verification.
 */
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

const REPO_ROOT = path.resolve(__dirname, '..')
const PIN_PATH = path.join(REPO_ROOT, 'desktop', 'noisemaker.version.json')

async function main() {
    const pin = JSON.parse(await fs.readFile(PIN_PATH, 'utf8'))
    const { version, baseUrl } = pin
    const versionUrl = `${baseUrl}/${version}`
    const destRoot = path.join(REPO_ROOT, 'vendor', 'noisemaker', version)
    const effectsDest = path.join(destRoot, 'effects')
    await fs.mkdir(effectsDest, { recursive: true })

    const checksums = []

    async function download(url, destPath) {
        const resp = await fetch(url)
        if (!resp.ok) throw new Error(`Failed ${resp.status}: ${url}`)
        const buf = Buffer.from(await resp.arrayBuffer())
        await fs.mkdir(path.dirname(destPath), { recursive: true })
        await fs.writeFile(destPath, buf)
        const hash = crypto.createHash('sha256').update(buf).digest('hex')
        checksums.push(`${hash}  ${path.relative(destRoot, destPath).split(path.sep).join('/')}`)
    }

    console.log(`Fetching Noisemaker ${version} from ${versionUrl}`)

    await download(
        `${versionUrl}/noisemaker-shaders-core.esm.min.js`,
        path.join(destRoot, 'noisemaker-shaders-core.esm.min.js')
    )

    const manifestResp = await fetch(`${versionUrl}/effects/manifest.json`)
    if (!manifestResp.ok) throw new Error(`Manifest fetch failed: ${manifestResp.status}`)
    const manifestText = await manifestResp.text()
    const manifest = JSON.parse(manifestText)

    const effectIds = Object.keys(manifest)
    console.log(`Downloading ${effectIds.length} effect bundles...`)
    for (const id of effectIds) {
        const rel = `${id}.js`
        await download(`${versionUrl}/effects/${rel}`, path.join(effectsDest, rel))
    }

    const manifestDest = path.join(effectsDest, 'manifest.json')
    await fs.writeFile(manifestDest, manifestText)
    const manifestHash = crypto.createHash('sha256').update(manifestText).digest('hex')
    checksums.push(`${manifestHash}  effects/manifest.json`)

    const sumsPath = path.join(destRoot, 'SHA256SUMS')
    await fs.writeFile(sumsPath, checksums.join('\n') + '\n')
    console.log(`Wrote ${checksums.length} checksums to ${sumsPath}`)
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
