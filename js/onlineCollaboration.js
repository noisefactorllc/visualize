// SPDX-License-Identifier: MIT
/**
 * Visualize ↔ Seance online DSL collaboration.
 *
 * Visualize presents one composition as one Seance session with two documents:
 *   - deck:A is the SDK default document for single-editor app interop.
 *   - deck:B is the secondary explicit document.
 */

export const DEFAULT_SEANCE_URL = 'https://seance.noisefactor.io'
export const DEFAULT_SEANCE_SDK_URL = 'https://seance.noisefactor.io/sdk/0/index.js'

export const DECK_DOC_IDS = {
    A: 'deck:A',
    B: 'deck:B',
}

export function docIdForDeck(deckId) {
    return DECK_DOC_IDS[deckId] || deckId
}

export async function createVisualizeOnlineCollaboration(options) {
    const runtimeConfig = globalThis.__VISUALIZE_SEANCE_CONFIG__ || {}
    const sdkUrl = runtimeConfig.sdkUrl || options.sdkUrl || DEFAULT_SEANCE_SDK_URL
    const seanceUrl = runtimeConfig.seanceUrl || options.seanceUrl || DEFAULT_SEANCE_URL
    const controller = new VisualizeOnlineController({
        ...options,
        sdkUrl,
        seanceUrl,
        runtimeConfig,
    })
    controller.syncStatusUi()
    return controller
}

class VisualizeOnlineController {
    constructor({
        sdkUrl,
        seanceUrl,
        runtimeConfig = {},
        decks,
        editorForDeck,
        getDeckText,
        applyRemoteText,
        dialog,
        toast = () => {},
        location = globalThis.location,
        history = globalThis.history,
        clipboard = globalThis.navigator?.clipboard,
    }) {
        this.ready = true
        this.online = null
        this._onlinePromise = null
        this._boundEditors = false
        this.sdkUrl = sdkUrl
        this.seanceUrl = seanceUrl
        this.runtimeConfig = runtimeConfig
        this.decks = decks
        this.editorForDeck = editorForDeck
        this.getDeckText = getDeckText
        this.applyRemoteText = applyRemoteText
        this.dialog = dialog
        this.toast = toast
        this.location = location
        this.history = history
        this.clipboard = clipboard

        this._wireUi()
    }

    bindDeckEditors() {
        if (!this.online || this._boundEditors) return
        for (const deckId of ['A', 'B']) {
            const editor = this.editorForDeck(deckId)
            if (!editor) continue
            this.online.bindEditor({
                // Deck A omits an explicit docId so it binds through the
                // SDK's implicit default-doc mechanism: joining a session
                // created by a single-editor app (doc id "main") auto-adopts
                // that doc instead of staying pinned to the local "deck:A"
                // id, which never exists in those sessions.
                docId: deckId === 'A' ? undefined : DECK_DOC_IDS[deckId],
                editor,
                getText: () => String(editor.value ?? ''),
                setText: (text) => {
                    editor.value = String(text ?? '')
                },
                validateText: () => true,
                onRemoteText: (text, context) => {
                    this.applyRemoteText(deckId, text, context)
                },
            })
        }
        this._boundEditors = true
    }

    syncLocalDecks(source = 'sync') {
        if (!this.online) return
        for (const deckId of ['A', 'B']) {
            const text = this.getDeckText(deckId)
            this.updateLocalText(DECK_DOC_IDS[deckId], text, { source })
        }
    }

    updateLocalText(docId, text, meta = {}) {
        if (!this.online) return null
        return this.online.updateLocalText(docId, text, meta)
    }

    async takeOnline() {
        try {
            this._setBusy(true)
            await this._ensureOnline()
            this._closeActiveSession()
            await this.online.takeOnline(this._seedDocs())
            this._writeSessionToUrl(this.online.getSessionId())
            this.syncStatusUi()
            this.toast('online session ready')
        } catch (err) {
            console.error('[seance] take online failed', err)
            this.toast(`online failed: ${err?.message || err}`, 5000)
        } finally {
            this._setBusy(false)
        }
    }

    async joinSession(sessionId, { writeUrl = true } = {}) {
        const id = String(sessionId || '').trim()
        if (!id) return
        try {
            this._setBusy(true)
            await this._ensureOnline()
            this._closeActiveSession()
            await this.online.joinSession(id)
            if (writeUrl) this._writeSessionToUrl(id)
            this.syncStatusUi()
            this.toast(`joined online session ${id}`)
        } catch (err) {
            console.error('[seance] join failed', err)
            this.toast(`join failed: ${err?.message || err}`, 5000)
        } finally {
            this._setBusy(false)
        }
    }

    async joinFromUrlIfPresent() {
        const sessionId = this._readSessionFromUrl()
        if (!sessionId) return
        await this.joinSession(sessionId, { writeUrl: false })
    }

    goOffline() {
        this._closeActiveSession()
        this._writeSessionToUrl(null)
        this.syncStatusUi()
        this.toast('online session closed')
    }

    getSessionId() {
        return this.online?.getSessionId?.() || null
    }

    getStatus() {
        return this.online?.getStatus?.() || 'offline'
    }

    getShareUrl() {
        return this._writeSessionToUrlString(this.getSessionId())
    }

    syncStatusUi() {
        if (!this.dialog) return
        const status = this.getStatus()
        const onlineStatus = status === 'online' || status === 'readonly'
        const sessionId = this.getSessionId() || ''
        const shareUrl = onlineStatus ? this.getShareUrl() : ''

        // Drive the unified seance-dialog's internal view via its state; the
        // dialog is shown/hidden by its own trigger (the go-online toolbar
        // button), so never toggle its visibility here.
        this.dialog.state = onlineStatus ? 'online' : (status === 'connecting' ? 'connecting' : 'offline')
        this.dialog.sessionId = onlineStatus ? sessionId : ''
        this.dialog.sessionUrl = shareUrl
    }

    async _ensureOnline() {
        if (this.online) return this.online
        if (this._onlinePromise) return this._onlinePromise

        this._onlinePromise = import(this.sdkUrl)
            .then((sdk) => {
                this.online = sdk.createOnlineDslLayer({
                    seanceUrl: this.seanceUrl,
                    defaultDocId: DECK_DOC_IDS.A,
                    location: this.location,
                    publicAppUrl: this.location?.href,
                    ...(this.runtimeConfig.fetch ? { fetch: this.runtimeConfig.fetch } : {}),
                    ...(this.runtimeConfig.WebSocket ? { WebSocket: this.runtimeConfig.WebSocket } : {}),
                    ...(this.runtimeConfig.anonToken ? { anonToken: this.runtimeConfig.anonToken } : {}),
                    ...(this.runtimeConfig.connectionId ? { connectionId: this.runtimeConfig.connectionId } : {}),
                })
                this.online.on('status', () => this.syncStatusUi())
                this.online.on('snapshot', () => this.syncStatusUi())
                this.online.on('error', (err) => {
                    console.warn('[seance]', err?.message || err)
                    this.toast(`online: ${err?.message || err}`, 4200)
                })
                this.bindDeckEditors()
                this.syncLocalDecks('initial')
                this.syncStatusUi()
                return this.online
            })
            .catch((err) => {
                this._onlinePromise = null
                throw err
            })
        return this._onlinePromise
    }

    _wireUi() {
        // All collaboration intents now arrive from the single seance-dialog
        // as semantic events (was: separate button clicks + status-element
        // events spread across four distinct deps).
        const dialog = this.dialog
        dialog?.addEventListener('take-online', () => this.takeOnline())
        dialog?.addEventListener('join-session', (event) => {
            this.joinSession(event.detail?.sessionId)
        })
        dialog?.addEventListener('go-offline', () => this.goOffline())
        dialog?.addEventListener('copy-url', async (event) => {
            const url = event.detail?.sessionUrl || this.getShareUrl()
            if (!url) return
            try {
                await this.clipboard?.writeText?.(url)
                this.toast('online URL copied')
            } catch {
                this.toast(url, 6000)
            }
        })
    }

    _seedDocs() {
        return [
            {
                id: DECK_DOC_IDS.A,
                title: 'Visualize Deck A',
                kind: 'noisemaker-dsl',
                text: this.getDeckText('A'),
                default: true,
            },
            {
                id: DECK_DOC_IDS.B,
                title: 'Visualize Deck B',
                kind: 'noisemaker-dsl',
                text: this.getDeckText('B'),
                default: false,
            },
        ]
    }

    _writeSessionToUrl(sessionId) {
        const next = this._writeSessionToUrlString(sessionId)
        this.history?.replaceState?.(null, '', next)
    }

    _writeSessionToUrlString(sessionId) {
        const url = urlFrom(this.location)
        url.searchParams.delete('code')
        if (sessionId) {
            url.searchParams.set('seance', sessionId)
        } else {
            url.searchParams.delete('seance')
        }
        return url.toString()
    }

    _readSessionFromUrl() {
        return urlFrom(this.location).searchParams.get('seance')
    }

    _closeActiveSession() {
        if (!this.online) return
        if (this.online.getStatus?.() === 'offline' && !this.online.getSessionId?.()) return
        this.online.goOffline?.()
    }

    _setBusy(busy) {
        // No direct button deps anymore — the dialog owns its own DOM. Reach
        // the same two controls through their stable data-action hooks so a
        // rapid double-click can't fire takeOnline()/joinSession() twice
        // before the SDK's own 'status' events start flowing through
        // syncStatusUi() (which the dialog reflects via state="connecting").
        const takeControl = this.dialog?.querySelector?.('[data-action="take-online"]')
        const joinControl = this.dialog?.querySelector?.('[data-action="join"]')
        if (takeControl) takeControl.disabled = busy || this.getStatus() === 'online'
        if (joinControl) joinControl.disabled = busy
    }
}

function urlFrom(locationLike) {
    if (typeof locationLike === 'string') return new URL(locationLike, globalThis.location?.href || 'http://localhost/')
    if (locationLike instanceof URL) return new URL(locationLike.toString())
    if (locationLike?.href) return new URL(locationLike.href)
    return new URL(globalThis.location?.href || 'http://localhost/')
}
