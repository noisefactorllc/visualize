export function createSyncCredentialStore() {
    let current
    return Object.freeze({
        current() {
            return current
        },
        publish(token) {
            if (typeof token !== 'string' || token.length === 0) {
                throw new TypeError('Sync credential must be a nonempty string')
            }
            current = Object.freeze({ token })
            return current
        },
        clear(credential) {
            if (!credential || credential !== current) return false
            current = undefined
            return true
        }
    })
}

export const syncCredentialStore = createSyncCredentialStore()
