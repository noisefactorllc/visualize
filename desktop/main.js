const path = require('node:path')
const fs = require('node:fs')
const { app } = require('electron')
const { initShell } = require('@nf/desktop-shell')

const productConfig = require('./product.json')
const versionPin = require('./noisemaker.version.json')

const licensePublicKey = fs.readFileSync(
    path.join(__dirname, 'license-pub-v1.ed25519'),
    'utf8'
)

const APP_ROOT = app.isPackaged
    ? path.join(__dirname, 'app')
    : path.resolve(__dirname, '..')

// Vendor lives under APP_ROOT in both dev and packaged so the renderer's
// `app://<host>/vendor/...` URLs resolve consistently.
const VENDOR_ROOT = path.join(APP_ROOT, 'vendor', 'noisemaker', versionPin.version)

initShell({
    appRoot: APP_ROOT,
    productConfig: { ...productConfig, licensePublicKey },
    vendorRoot: VENDOR_ROOT,
})
