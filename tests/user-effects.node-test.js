import assert from 'node:assert/strict'
import test from 'node:test'
import {
    UserEffectsManager,
    isQuotaExceededError,
    MAX_PACKAGE_SIZE,
    MAX_TOTAL_UNCOMPRESSED_SIZE,
    MAX_FILE_SIZE,
    USER_NAMESPACE,
    DB_NAME,
    EFFECTS_STORE,
} from '../js/userEffects.js'

test('isQuotaExceededError detects DOMException QuotaExceededError', () => {
    const err = new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    assert.equal(isQuotaExceededError(err), true)
})

test('isQuotaExceededError detects legacy code 22', () => {
    const err = { code: 22, name: 'UnknownError', message: 'Storage error' }
    assert.equal(isQuotaExceededError(err), true)
})

test('isQuotaExceededError detects Firefox NS_ERROR_DOM_QUOTA_REACHED and code 1014', () => {
    const errNamed = { name: 'NS_ERROR_DOM_QUOTA_REACHED', message: 'Quota reached' }
    assert.equal(isQuotaExceededError(errNamed), true)

    const errCoded = { code: 1014, name: 'NS_ERROR', message: 'Persistent storage limit reached' }
    assert.equal(isQuotaExceededError(errCoded), true)
})

test('isQuotaExceededError detects message heuristics (quota, storage limit, disk is full)', () => {
    assert.equal(isQuotaExceededError(new Error('Exceeded the quota')), true)
    assert.equal(isQuotaExceededError(new Error('Storage limit exceeded for origin')), true)
    assert.equal(isQuotaExceededError(new Error('The disk is full')), true)
    assert.equal(isQuotaExceededError(new Error('Database is full')), true)
    assert.equal(isQuotaExceededError({ message: 'QuotaExceededError' }), true)
})

test('isQuotaExceededError detects nested error cause', () => {
    const rootErr = new DOMException('Quota exceeded', 'QuotaExceededError')
    const wrappedErr = new Error('Failed to save effect', { cause: rootErr })
    assert.equal(isQuotaExceededError(wrappedErr), true)
})

test('isQuotaExceededError returns false for non-quota errors and non-objects', () => {
    assert.equal(isQuotaExceededError(null), false)
    assert.equal(isQuotaExceededError(undefined), false)
    assert.equal(isQuotaExceededError(new TypeError('Invalid argument')), false)
    assert.equal(isQuotaExceededError(new DOMException('Transaction aborted', 'AbortError')), false)
    assert.equal(isQuotaExceededError(new Error('Network timeout')), false)
    assert.equal(isQuotaExceededError({}), false)
})

test('size limit constants match Handfish platform specifications', () => {
    assert.equal(MAX_PACKAGE_SIZE, 30 * 1024 * 1024, 'MAX_PACKAGE_SIZE must be 30MB')
    assert.equal(MAX_TOTAL_UNCOMPRESSED_SIZE, 50 * 1024 * 1024, 'MAX_TOTAL_UNCOMPRESSED_SIZE must be 50MB')
    assert.equal(MAX_FILE_SIZE, 20 * 1024 * 1024, 'MAX_FILE_SIZE must be 20MB')
    assert.equal(USER_NAMESPACE, 'user')
    assert.equal(DB_NAME, 'visualize-user-effects')
    assert.equal(EFFECTS_STORE, 'effects')
})

test('uploadFromZip rejects missing blob or oversized package before opening zip', async () => {
    const mgr = new UserEffectsManager()

    await assert.rejects(
        () => mgr.uploadFromZip(null),
        /no zip file provided/
    )

    const oversizedBlob = { size: MAX_PACKAGE_SIZE + 1024 }
    await assert.rejects(
        () => mgr.uploadFromZip(oversizedBlob),
        /package exceeds maximum size limit \(30MB\)/
    )
})

test('uploadFromPayload validates payload size limits and required fields', async () => {
    const mgr = new UserEffectsManager()

    await assert.rejects(
        () => mgr.uploadFromPayload(null),
        /invalid effect payload/
    )

    await assert.rejects(
        () => mgr.uploadFromPayload({}),
        /effect payload missing func\/name/
    )

    // Shader exceeding MAX_FILE_SIZE
    const hugeShader = 'x'.repeat(MAX_FILE_SIZE + 10)
    await assert.rejects(
        () => mgr.uploadFromPayload({
            name: 'hugeFx',
            shaders: { main: { glsl: hugeShader } },
        }),
        /shader "main.glsl" exceeds maximum size limit/
    )
})

test('_putWithQuotaRecovery succeeds normally when storage is available', async () => {
    let putCalls = 0
    let cacheCleared = false

    const mgr = new UserEffectsManager({
        clearThumbnailCache: async () => { cacheCleared = true },
    })
    mgr._put = async () => {
        putCalls++
    }

    await mgr._putWithQuotaRecovery({ id: 'user/testFx', name: 'testFx' })
    assert.equal(putCalls, 1)
    assert.equal(cacheCleared, false, 'Thumbnail cache should not be cleared on normal put')
})

test('_putWithQuotaRecovery evicts thumbnail cache and retries when quota exceeded', async () => {
    let putCalls = 0
    let cacheCleared = false

    const mgr = new UserEffectsManager({
        clearThumbnailCache: async () => { cacheCleared = true },
    })
    mgr._put = async () => {
        putCalls++
        if (putCalls === 1) {
            const quotaErr = new DOMException('The quota has been exceeded.', 'QuotaExceededError')
            throw quotaErr
        }
        // Second attempt succeeds
    }

    await mgr._putWithQuotaRecovery({ id: 'user/retryFx', name: 'retryFx' })
    assert.equal(putCalls, 2, 'Should retry put after clearing cache')
    assert.equal(cacheCleared, true, 'Thumbnail cache must be cleared when quota exceeded')
})

test('_putWithQuotaRecovery throws formatted QuotaExceededError when retry also fails', async () => {
    let putCalls = 0
    let cacheCleared = false

    const mgr = new UserEffectsManager({
        clearThumbnailCache: async () => { cacheCleared = true },
    })
    mgr._put = async () => {
        putCalls++
        const quotaErr = new DOMException('The quota has been exceeded.', 'QuotaExceededError')
        throw quotaErr
    }

    await assert.rejects(
        () => mgr._putWithQuotaRecovery({ id: 'user/failFx', name: 'failFx' }),
        (err) => {
            assert.equal(err.name, 'QuotaExceededError')
            assert.equal(err.code, 22)
            assert.match(err.message, /storage quota exceeded: effect package "failFx" is too large/)
            assert.match(err.message, /Delete unused effects or free disk space/)
            assert.ok(err.cause, 'Cause should be preserved')
            return true
        }
    )
    assert.equal(putCalls, 2)
    assert.equal(cacheCleared, true)
})

test('_putWithQuotaRecovery immediately re-throws non-quota errors without clearing cache', async () => {
    let putCalls = 0
    let cacheCleared = false

    const mgr = new UserEffectsManager({
        clearThumbnailCache: async () => { cacheCleared = true },
    })
    mgr._put = async () => {
        putCalls++
        throw new DOMException('Constraint failed', 'ConstraintError')
    }

    await assert.rejects(
        () => mgr._putWithQuotaRecovery({ id: 'user/constraintFx', name: 'constraintFx' }),
        (err) => {
            assert.equal(err.name, 'ConstraintError')
            return true
        }
    )
    assert.equal(putCalls, 1, 'Should not retry on non-quota errors')
    assert.equal(cacheCleared, false, 'Thumbnail cache should not be cleared on non-quota errors')
})

test('uploadFromPayload maintains atomic isolation when storage fails', async () => {
    const mgr = new UserEffectsManager({
        clearThumbnailCache: async () => {},
    })
    mgr._get = async () => null
    mgr._put = async () => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError')
    }

    let changeEmitted = false
    mgr.onChange(() => { changeEmitted = true })

    const fakeRenderer = {
        registerEffectsFromBundle: () => {
            assert.fail('Renderer should not be called when put fails')
        },
    }

    await assert.rejects(
        () => mgr.uploadFromPayload({ name: 'atomicFx', shaders: {} }, fakeRenderer),
        /storage quota exceeded/
    )

    assert.equal(changeEmitted, false, 'Change event must not be emitted on failed put')
    assert.equal(mgr._loadedIds.has('user/atomicFx'), false, 'Failed effect must not be marked as loaded')
})

test('IDB transactions handle abort and error events cleanly', async () => {
    // Mock IDB store and transaction
    const makeMockDB = (shouldAbort, shouldError) => ({
        transaction: () => {
            const listeners = {}
            const tx = {
                objectStore: () => ({
                    put: () => {
                        const req = {}
                        setTimeout(() => {
                            if (shouldError) {
                                tx.error = new DOMException('Disk write error', 'QuotaExceededError')
                                tx.onerror?.()
                            } else if (shouldAbort) {
                                tx.error = new DOMException('Transaction aborted', 'AbortError')
                                tx.onabort?.()
                            } else {
                                tx.oncomplete?.()
                            }
                        }, 0)
                        return req
                    },
                }),
                oncomplete: null,
                onerror: null,
                onabort: null,
                error: null,
            }
            return tx
        },
    })

    const mgrAbort = new UserEffectsManager()
    mgrAbort._openDB = async () => makeMockDB(true, false)
    await assert.rejects(
        () => mgrAbort._put({ id: 'user/abortFx' }),
        /Transaction aborted/
    )

    const mgrError = new UserEffectsManager()
    mgrError._openDB = async () => makeMockDB(false, true)
    await assert.rejects(
        () => mgrError._put({ id: 'user/errorFx' }),
        /Disk write error/
    )
})

test('uploadFromPayload handles already-installed duplicate gracefully even if renderer registration throws', async () => {
    const mgr = new UserEffectsManager()
    const existingRecord = { id: 'user/dupFx', name: 'dupFx', files: { 'definition.json': '{}' } }
    mgr._get = async (id) => (id === 'user/dupFx' ? existingRecord : null)
    mgr._registerWithRenderer = async () => {
        throw new Error('Corrupted shader bundle compilation error')
    }

    const fakeRenderer = {}
    const result = await mgr.uploadFromPayload({ name: 'dupFx', shaders: {} }, fakeRenderer)
    assert.deepEqual(result, { id: 'user/dupFx', name: 'dupFx', alreadyInstalled: true })
})

test('uploadFromPayload enforces byte-length limits on multi-byte UTF-8 shaders', async () => {
    const mgr = new UserEffectsManager()
    // 3-byte unicode character repeated so character count is < 20M but byte size > 20MB
    // 7 million 3-byte chars = 21,000,000 bytes > MAX_FILE_SIZE (20,971,520 bytes)
    const multiByteChar = '€' // 3 bytes in UTF-8
    const hugeMultiByteShader = multiByteChar.repeat(7 * 1024 * 1024)

    await assert.rejects(
        () => mgr.uploadFromPayload({
            name: 'unicodeBomb',
            shaders: { main: { glsl: hugeMultiByteShader } },
        }),
        /shader "main.glsl" exceeds maximum size limit/
    )
})

test('isQuotaExceededError does not falsely match words containing quota such as quotation', () => {
    assert.equal(isQuotaExceededError(new Error('SyntaxError: unterminated string quotation')), false)
    assert.equal(isQuotaExceededError(new Error('description quotation mark missing')), false)
    assert.equal(isQuotaExceededError(new Error('storage quota exceeded')), true)
    assert.equal(isQuotaExceededError(new Error('Disk quotas exhausted')), true)
})

test('uploadFromPayload validates definition and help size limits', async () => {
    const mgr = new UserEffectsManager()
    const hugeString = 'a'.repeat(21 * 1024 * 1024)

    await assert.rejects(
        () => mgr.uploadFromPayload({
            name: 'bigHelp',
            help: hugeString,
        }),
        /help\.md exceeds maximum size limit/
    )

    await assert.rejects(
        () => mgr.uploadFromPayload({
            name: 'bigDef',
            description: hugeString,
        }),
        /definition\.json exceeds maximum size limit/
    )
})

test('uploadFromPayload rolls back IndexedDB record if renderer registration throws', async () => {
    const mgr = new UserEffectsManager()
    mgr._get = async () => null
    let putRecord = null
    let removedId = null
    mgr._put = async (rec) => { putRecord = rec }
    mgr._remove = async (id) => { removedId = id }

    const fakeRenderer = {}
    mgr._registerWithRenderer = async () => {
        throw new Error('WebGL compile error in registered effect')
    }

    await assert.rejects(
        () => mgr.uploadFromPayload({ name: 'failCompile', shaders: {} }, fakeRenderer),
        /WebGL compile error/
    )

    assert.equal(putRecord?.name, 'failCompile')
    assert.equal(removedId, 'user/failCompile', 'Record must be removed from storage on renderer registration error')
})

test('UserEffectsManager._openDB memoizes in-flight connection promise', async () => {
    let openCount = 0
    const fakeIDB = {
        open: () => {
            openCount++
            const req = {}
            setTimeout(() => {
                req.result = { objectStoreNames: { contains: () => true }, close: () => {} }
                req.onsuccess?.()
            }, 10)
            return req
        },
    }

    const mgr = new UserEffectsManager()
    // Trigger two concurrent _openDB calls before the first resolves
    const [p1, p2] = await (async () => {
        // Temporarily assign global indexedDB
        const orig = globalThis.indexedDB
        globalThis.indexedDB = fakeIDB
        try {
            return [mgr._openDB(), mgr._openDB()]
        } finally {
            globalThis.indexedDB = orig
        }
    })()

    const [db1, db2] = await Promise.all([p1, p2])
    assert.equal(db1, db2)
    assert.equal(openCount, 1, 'indexedDB.open must only be called once when open requests are concurrent')
})
