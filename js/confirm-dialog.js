// SPDX-License-Identifier: MIT
/**
 * In-app confirmation for destructive actions. Drives the
 * #confirm-dialog element in index.html, a native <dialog> styled by
 * handfish's dialogs.css (.hf-dialog). Built-in browser dialogs
 * (alert / confirm / prompt) are banned in every product.
 */

/**
 * Ask the user to confirm an action.
 *
 * Cancel holds the focus when the dialog opens, so Enter or Space alone
 * never confirms. Escape and cancel both resolve false.
 *
 * @param {Object} options
 * @param {string} options.title
 * @param {string} options.message
 * @param {string} [options.confirmLabel='delete']
 * @returns {Promise<boolean>} true when the user confirms
 */
export function confirmAction({ title, message, confirmLabel = 'delete' }) {
    const dialog = document.getElementById('confirm-dialog')
    if (!dialog || dialog.open) return Promise.resolve(false)
    document.getElementById('confirm-dialog-title').textContent = title
    document.getElementById('confirm-dialog-message').textContent = message
    document.getElementById('confirm-dialog-confirm').textContent = confirmLabel
    dialog.returnValue = ''
    return new Promise((resolve) => {
        dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true })
        dialog.showModal()
    })
}

// Keys typed in the dialog stay out of the app's global shortcuts (Space
// toggles automix, digits toggle FX). Escape still reaches the app's
// handler, which closes the topmost open dialog.
document.getElementById('confirm-dialog')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') e.stopPropagation()
})
