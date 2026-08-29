import { deriveSyncOutputView } from './syncOutput.js'

function requireElement(documentObject, id) {
    const element = documentObject.getElementById(id)
    if (!element) throw new Error(`Sync output dialog is missing #${id}`)
    return element
}

function afterBrowserPaint(windowObject) {
    return new Promise((resolve) => {
        windowObject.requestAnimationFrame(() => {
            windowObject.requestAnimationFrame(resolve)
        })
    })
}

function shouldCheckOnOpen(state) {
    return state?.status === 'idle' || state?.status === 'unavailable' ||
        (state?.status === 'error' && state?.error?.code === 'SYNC_UNAVAILABLE')
}

export function createSyncOutputDialog({
    controller,
    document: documentObject = globalThis.document,
    window: windowObject = globalThis.window,
    afterPaint = () => afterBrowserPaint(windowObject)
} = {}) {
    if (!controller || typeof controller.subscribe !== 'function') {
        throw new TypeError('controller must expose subscribe(listener)')
    }

    const dialog = requireElement(documentObject, 'sync-output-dialog')
    const openButton = requireElement(documentObject, 'sync-output-open')
    const closeButton = requireElement(documentObject, 'sync-output-close')
    const nameInput = requireElement(documentObject, 'sync-output-name')
    const stateText = requireElement(documentObject, 'sync-output-state')
    const liveBadge = requireElement(documentObject, 'sync-output-live')
    const providerText = requireElement(documentObject, 'sync-output-provider')
    const formatText = requireElement(documentObject, 'sync-output-format')
    const sentText = requireElement(documentObject, 'sync-output-sent')
    const gpuBusyText = requireElement(documentObject, 'sync-output-gpu-busy')
    const networkText = requireElement(documentObject, 'sync-output-network')
    const failedText = requireElement(documentObject, 'sync-output-failed')
    const statusText = requireElement(documentObject, 'sync-output-status')
    const connectNotice = requireElement(documentObject, 'sync-output-connect-notice')
    const actionButton = requireElement(documentObject, 'sync-output-action')

    let state = controller.state || {}
    let pendingConnect = false
    let destroyed = false

    const render = () => {
        const view = deriveSyncOutputView(state)
        dialog.dataset.tone = view.live ? 'live' : (state.error ? 'error' : 'neutral')
        stateText.textContent = view.stateLabel
        liveBadge.hidden = !view.live
        providerText.textContent = view.provider
        formatText.textContent = view.format
        sentText.textContent = String(view.counters.sent)
        gpuBusyText.textContent = String(view.counters.gpuBusy)
        networkText.textContent = String(view.counters.network)
        failedText.textContent = String(view.counters.failed)
        statusText.textContent = view.status
        nameInput.disabled = view.nameDisabled || pendingConnect
        if (state.senderName && nameInput.value !== state.senderName) {
            nameInput.value = state.senderName
        }
        nameInput.setAttribute(
            'aria-invalid',
            state.error?.code === 'SYNC_INVALID_SENDER_NAME' ? 'true' : 'false'
        )
        connectNotice.hidden = !pendingConnect
        actionButton.textContent = pendingConnect ? 'Connecting…' : view.action.label
        actionButton.disabled = pendingConnect || view.action.disabled
        actionButton.dataset.action = pendingConnect ? 'connecting' : view.action.kind
    }

    const runAction = async () => {
        const { action } = deriveSyncOutputView(state)
        try {
            switch (action.kind) {
            case 'check':
                await controller.checkAvailability()
                break
            case 'connect':
                pendingConnect = true
                render()
                await afterPaint()
                await controller.connect()
                break
            case 'start':
                await controller.start(nameInput.value)
                break
            case 'stop':
                await controller.stop()
                break
            }
        } catch {
            // Controller state owns the actionable error shown in the dialog.
        } finally {
            pendingConnect = false
            render()
        }
    }

    const open = () => {
        if (destroyed) return
        if (!dialog.open) dialog.showModal()
        render()
        nameInput.focus()
        if (shouldCheckOnOpen(state)) {
            void controller.checkAvailability().catch(() => {})
        }
    }
    const close = () => {
        if (dialog.open) dialog.close()
    }
    const handleBackdropClick = (event) => {
        if (event.target === dialog) close()
    }
    const handleNameKeydown = (event) => {
        if (event.key === 'Enter' && !actionButton.disabled) {
            event.preventDefault()
            void runAction()
        }
    }

    openButton.addEventListener('click', open)
    closeButton.addEventListener('click', close)
    dialog.addEventListener('click', handleBackdropClick)
    actionButton.addEventListener('click', runAction)
    nameInput.addEventListener('keydown', handleNameKeydown)
    const unsubscribe = controller.subscribe((nextState) => {
        state = nextState || {}
        render()
    })

    render()
    return Object.freeze({
        open,
        close,
        destroy() {
            if (destroyed) return
            destroyed = true
            unsubscribe()
            openButton.removeEventListener('click', open)
            closeButton.removeEventListener('click', close)
            dialog.removeEventListener('click', handleBackdropClick)
            actionButton.removeEventListener('click', runAction)
            nameInput.removeEventListener('keydown', handleNameKeydown)
            close()
        }
    })
}
