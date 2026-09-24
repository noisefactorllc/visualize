/**
 * User Effects — portable-effect import, persistence, and engine
 * registration.
 *
 * Visualize accepts portable effect packages (zip containing
 * `definition.json` + `glsl/*.glsl` + optional `wgsl/*.wgsl` + optional
 * `help.md`) produced by the noisefactor portable framework. Imported
 * effects are stored in IndexedDB so they survive reloads, registered
 * with the noisemaker runtime under the `user` namespace, and surfaced
 * in the library's "user" section.
 *
 * Architecturally this mirrors noisedeck's app/js/features/userEffects.js
 * but trimmed for visualize: only the portable (definition.json) path
 * is supported — visualize is a player, not an authoring tool, so we
 * never need the legacy definition.js + blob-URL ES module dance that
 * noisedeck uses for in-app effect authoring.
 *
 * Engine integration: a parsed effect is shaped into the format the
 * engine's `CanvasRenderer.registerEffectsFromBundle` expects (a fake
 * one-effect bundle), which then takes care of the full registration
 * dance (registerEffect under 4 aliases, registerOp, choice enums,
 * starter-op flagging, and renderer._loadedEffects caching so the
 * compiler's loadEffects() doesn't try to fetch user effects from the
 * CDN).
 */

import { clearCache as clearThumbnailCache } from './thumbnailCache.js'

let _Effect = null
let _unregisterEffect = null

async function loadBundle() {
    if (_Effect && _unregisterEffect) {
        return { Effect: _Effect, unregisterEffect: _unregisterEffect }
    }
    const mod = await import('./noisemaker/bundle.js')
    _Effect = mod.Effect
    _unregisterEffect = mod.unregisterEffect
    return { Effect: _Effect, unregisterEffect: _unregisterEffect }
}

export function setBundleDependencies(deps = {}) {
    if (deps.Effect) _Effect = deps.Effect
    if (deps.unregisterEffect) _unregisterEffect = deps.unregisterEffect
}

const DB_NAME = 'visualize-user-effects'
const DB_VERSION = 1
const EFFECTS_STORE = 'effects'

const USER_NAMESPACE = 'user'

const MAX_PACKAGE_SIZE = 30 * 1024 * 1024               // 30MB zip package limit
const MAX_TOTAL_UNCOMPRESSED_SIZE = 50 * 1024 * 1024    // 50MB uncompressed total limit
const MAX_FILE_SIZE = 20 * 1024 * 1024                  // 20MB individual file limit

/**
 * Determine whether an error is caused by storage quota exhaustion across
 * Chrome, Firefox, Safari, and other browsers/runtimes.
 */
export function isQuotaExceededError(err) {
    if (!err) return false
    if (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true
    if (err.code === 22 || err.code === 1014) return true
    const msg = String(err.message || err).toLowerCase()
    if (
        (msg.includes('quota') && !msg.includes('quotat')) ||
        msg.includes('storage limit') ||
        msg.includes('disk is full') ||
        msg.includes('database is full')
    ) {
        return true
    }
    if (err.cause && isQuotaExceededError(err.cause)) return true
    return false
}

const PIPELINE_INPUT_TOKENS = new Set([
    'inputTex', 'inputTex3d', 'src',
    'o0', 'o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7',
])

// macOS Finder "Compress" adds an __MACOSX/ tree of AppleDouble sidecar
// files (e.g. __MACOSX/effect/._definition.json) plus .DS_Store. Their
// names share the same suffixes as real entries, so without this guard a
// sidecar can hijack definition.json detection or be read in as a shader.
function isJunkZipEntry(path) {
    const base = path.slice(path.lastIndexOf('/') + 1)
    return path.includes('__MACOSX/') || base.startsWith('._') || base === '.DS_Store'
}

class UserEffectsManager {
    constructor(options = {}) {
        this._db = options.db || null
        this._dbName = options.dbName || DB_NAME
        this._dbVersion = options.dbVersion || DB_VERSION
        this._clearThumbnailCache = options.clearThumbnailCache || clearThumbnailCache
        this._loadedIds = new Set()        // effect IDs we've registered this session
        this._renderers = new Set()        // strong refs — we iterate them on delete to flush _loadedEffects
        this._listeners = new Set()        // 'change' subscribers — settings UI re-renders, library re-renders
        this._openPromise = null
    }

    // ── IndexedDB ────────────────────────────────────────────────────

    async _openDB() {
        if (this._db) return this._db
        if (this._openPromise) return this._openPromise
        if (typeof indexedDB === 'undefined') {
            throw new Error('IndexedDB is not supported in this environment')
        }
        this._openPromise = new Promise((resolve, reject) => {
            let req
            try {
                req = indexedDB.open(this._dbName, this._dbVersion)
            } catch (err) {
                this._openPromise = null
                if (isQuotaExceededError(err)) {
                    const qErr = new Error('storage quota exceeded: unable to open user effects database')
                    qErr.name = 'QuotaExceededError'
                    qErr.code = 22
                    qErr.cause = err
                    return reject(qErr)
                }
                return reject(err)
            }
            req.onerror = () => {
                this._openPromise = null
                const err = req.error
                if (isQuotaExceededError(err)) {
                    const qErr = new Error('storage quota exceeded: unable to open user effects database')
                    qErr.name = 'QuotaExceededError'
                    qErr.code = 22
                    qErr.cause = err
                    return reject(qErr)
                }
                reject(err || new Error('failed to open user effects database'))
            }
            req.onblocked = () => {
                console.warn('[userEffects] indexedDB open blocked by other tabs')
            }
            req.onsuccess = () => {
                this._openPromise = null
                this._db = req.result
                resolve(this._db)
            }
            req.onupgradeneeded = (e) => {
                const db = e.target.result
                if (!db.objectStoreNames.contains(EFFECTS_STORE)) {
                    const store = db.createObjectStore(EFFECTS_STORE, { keyPath: 'id' })
                    store.createIndex('name', 'name', { unique: false })
                    store.createIndex('uploadedAt', 'uploadedAt', { unique: false })
                }
            }
        })
        return this._openPromise
    }

    /** Read every stored record. Records: { id, name, files, uploadedAt }. */
    async getAll() {
        const db = await this._openDB()
        return new Promise((resolve, reject) => {
            try {
                const tx = db.transaction(EFFECTS_STORE, 'readonly')
                const store = tx.objectStore(EFFECTS_STORE)
                const req = store.getAll()
                req.onsuccess = () => resolve(req.result || [])
                req.onerror = () => reject(req.error || tx.error)
                tx.onerror = () => reject(tx.error || req.error)
                tx.onabort = () => reject(tx.error || req.error || new DOMException('Transaction aborted', 'AbortError'))
            } catch (err) {
                reject(err)
            }
        })
    }

    async _get(id) {
        const db = await this._openDB()
        return new Promise((resolve, reject) => {
            try {
                const tx = db.transaction(EFFECTS_STORE, 'readonly')
                const store = tx.objectStore(EFFECTS_STORE)
                const req = store.get(id)
                req.onsuccess = () => resolve(req.result || null)
                req.onerror = () => reject(req.error || tx.error)
                tx.onerror = () => reject(tx.error || req.error)
                tx.onabort = () => reject(tx.error || req.error || new DOMException('Transaction aborted', 'AbortError'))
            } catch (err) {
                reject(err)
            }
        })
    }

    async _put(record) {
        const db = await this._openDB()
        return new Promise((resolve, reject) => {
            try {
                const tx = db.transaction(EFFECTS_STORE, 'readwrite')
                const store = tx.objectStore(EFFECTS_STORE)
                const req = store.put(record)
                req.onerror = () => {}
                tx.oncomplete = () => resolve()
                tx.onerror = () => reject(tx.error || req.error)
                tx.onabort = () => reject(tx.error || req.error || new DOMException('Transaction aborted', 'AbortError'))
            } catch (err) {
                reject(err)
            }
        })
    }

    _createQuotaError(name, cause) {
        const msg = `storage quota exceeded: effect package "${name}" is too large for available browser storage. Delete unused effects or free disk space to import.`
        const err = new Error(msg)
        err.name = 'QuotaExceededError'
        err.code = 22
        if (cause) err.cause = cause
        return err
    }

    /**
     * Write an effect to IndexedDB with quota self-healing recovery.
     * If storage quota is exhausted, evicts the ephemeral thumbnail cache
     * and retries once before failing with an actionable QuotaExceededError.
     */
    async _putWithQuotaRecovery(record) {
        try {
            await this._put(record)
        } catch (err) {
            if (isQuotaExceededError(err)) {
                console.warn(`[userEffects] storage quota exceeded while saving "${record.name}", evicting thumbnail cache...`)
                let cacheCleared = false
                try {
                    await this._clearThumbnailCache()
                    cacheCleared = true
                } catch (cleanErr) {
                    console.warn('[userEffects] failed to clear thumbnail cache:', cleanErr)
                }

                if (cacheCleared) {
                    try {
                        await this._put(record)
                        console.info(`[userEffects] successfully saved "${record.name}" after evicting thumbnail cache`)
                        return
                    } catch (retryErr) {
                        if (isQuotaExceededError(retryErr)) {
                            throw this._createQuotaError(record.name, retryErr)
                        }
                        throw retryErr
                    }
                }

                throw this._createQuotaError(record.name, err)
            }
            throw err
        }
    }

    async _remove(id) {
        const db = await this._openDB()
        return new Promise((resolve, reject) => {
            try {
                const tx = db.transaction(EFFECTS_STORE, 'readwrite')
                const store = tx.objectStore(EFFECTS_STORE)
                const req = store.delete(id)
                req.onerror = () => {}
                tx.oncomplete = () => resolve()
                tx.onerror = () => reject(tx.error || req.error)
                tx.onabort = () => reject(tx.error || req.error || new DOMException('Transaction aborted', 'AbortError'))
            } catch (err) {
                reject(err)
            }
        })
    }

    // ── Change broadcasting ──────────────────────────────────────────

    onChange(fn) {
        this._listeners.add(fn)
        return () => this._listeners.delete(fn)
    }

    _emitChange() {
        for (const fn of this._listeners) {
            try { fn() } catch (err) { console.error('[userEffects] listener error:', err) }
        }
    }

    // ── ZIP processing ───────────────────────────────────────────────

    /**
     * Parse a zip Blob/File and return { name, files }. `files` keys
     * are paths relative to the effect directory (e.g.
     * "definition.json", "glsl/main.glsl"). Throws on missing
     * definition.json or missing GLSL, or if file/package size limits
     * are exceeded.
     */
    async processZip(zipBlob) {
        if (!zipBlob) throw new Error('no zip file provided')
        if (typeof zipBlob.size === 'number' && zipBlob.size > MAX_PACKAGE_SIZE) {
            throw new Error(`package exceeds maximum size limit (${Math.round(MAX_PACKAGE_SIZE / (1024 * 1024))}MB)`)
        }

        const JSZipCtor = await loadJSZip()
        const zip = await JSZipCtor.loadAsync(zipBlob)
        const files = {}

        // Find definition.json — accept it at the root or one directory
        // deep so packaged zips with a top-level effect/ folder work as
        // well as flat zips.
        let basePath = ''
        let definitionPath = null
        for (const path of Object.keys(zip.files)) {
            if (zip.files[path].dir) continue
            if (isJunkZipEntry(path)) continue
            // Match at a path boundary so a stray "mydefinition.json" isn't
            // mistaken for the real file.
            if (path === 'definition.json' || path.endsWith('/definition.json')) {
                definitionPath = path
                basePath = path.replace(/definition\.json$/, '')
                break
            }
        }
        if (!definitionPath) {
            throw new Error('zip must contain a definition.json file')
        }

        let hasGlsl = false
        let totalUncompressedSize = 0

        for (const [path, entry] of Object.entries(zip.files)) {
            if (entry.dir) continue
            if (isJunkZipEntry(path)) continue
            if (basePath && !path.startsWith(basePath)) continue
            const rel = basePath ? path.slice(basePath.length) : path
            const isShader = rel.startsWith('glsl/') || rel.startsWith('wgsl/')
            const isDef = rel === 'definition.json'
            const isHelp = rel === 'help.md'
            if (!isShader && !isDef && !isHelp) continue

            // Guard against zip bomb decompression before extracting
            if (typeof entry._data?.uncompressedSize === 'number') {
                if (entry._data.uncompressedSize > MAX_FILE_SIZE) {
                    throw new Error(`file "${rel}" exceeds maximum size limit (${Math.round(MAX_FILE_SIZE / (1024 * 1024))}MB)`)
                }
                if (totalUncompressedSize + entry._data.uncompressedSize > MAX_TOTAL_UNCOMPRESSED_SIZE) {
                    throw new Error(`uncompressed package files exceed maximum size limit (${Math.round(MAX_TOTAL_UNCOMPRESSED_SIZE / (1024 * 1024))}MB)`)
                }
            }

            const text = await entry.async('text')
            const byteSize = typeof Buffer !== 'undefined'
                ? Buffer.byteLength(text, 'utf8')
                : (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : text.length)
            if (byteSize > MAX_FILE_SIZE) {
                throw new Error(`file "${rel}" exceeds maximum size limit (${Math.round(MAX_FILE_SIZE / (1024 * 1024))}MB)`)
            }
            totalUncompressedSize += byteSize
            if (totalUncompressedSize > MAX_TOTAL_UNCOMPRESSED_SIZE) {
                throw new Error(`uncompressed package files exceed maximum size limit (${Math.round(MAX_TOTAL_UNCOMPRESSED_SIZE / (1024 * 1024))}MB)`)
            }

            files[rel] = text
            if (rel.startsWith('glsl/') && rel.endsWith('.glsl')) hasGlsl = true
        }

        if (!files['definition.json']) throw new Error('could not read definition.json from zip')
        if (!hasGlsl) throw new Error('zip must contain at least one .glsl shader under glsl/')

        const def = JSON.parse(files['definition.json'])
        const name = def.func || def.name
        if (!name) throw new Error('definition.json must specify "func" or "name"')

        return { name, files }
    }

    // ── Effect construction ──────────────────────────────────────────

    /**
     * Collect shaders from `files` into the engine's expected shape:
     *   { <programName>: { glsl: '...', wgsl: '...' } }
     */
    _collectShaders(files) {
        const shaders = {}
        for (const [path, content] of Object.entries(files)) {
            if (path.startsWith('glsl/') && path.endsWith('.glsl')) {
                const name = path.slice(5, -5)
                if (!shaders[name]) shaders[name] = {}
                shaders[name].glsl = content
            } else if (path.startsWith('wgsl/') && path.endsWith('.wgsl')) {
                const name = path.slice(5, -5)
                if (!shaders[name]) shaders[name] = {}
                shaders[name].wgsl = content
            }
        }
        return shaders
    }

    /**
     * Build a runtime Effect instance from a stored record.
     * The Effect class brings lifecycle hooks (asyncInit, onInit, etc.)
     * that the compiler probes for via prototype check — a plain object
     * trips the `effectDef.asyncInit === Effect.prototype.asyncInit`
     * guard with "t.asyncInit is not a function".
     */
    _buildInstance(definition, shaders, EffectClass = _Effect) {
        if (!EffectClass) {
            throw new Error('Effect class is not loaded')
        }
        const instance = new EffectClass({
            name: definition.name || definition.func,
            namespace: USER_NAMESPACE,
            func: definition.func || definition.name,
            description: definition.description || '',
            tags: definition.tags || ['user'],
            globals: definition.globals || {},
            passes: definition.passes || [],
            textures: definition.textures,
            uniformLayout: definition.uniformLayout,
            uniformLayouts: definition.uniformLayouts,
            defaultProgram: definition.defaultProgram,
        })
        instance.shaders = shaders
        // The engine's Effect constructor doesn't copy defaultProgram onto the
        // instance (it's passed above but ignored), so set it explicitly.
        // buildDslSource() prefers an author-curated demo program over a
        // synthesized one — without this the stored field is dropped and every
        // user effect falls back to synthesized DSL in the library.
        if (definition.defaultProgram) instance.defaultProgram = definition.defaultProgram
        return instance
    }

    /**
     * Engine's registerStarterOpForEffect uses the canvas-side
     * isStarterEffect helper, which inspects pass inputs. We replicate
     * the same logic for the deduping fall-through in serialize-only
     * paths (e.g. dslSourceBuilder uses it through bundle).
     */
    static isStarterFromDefinition(definition) {
        const passes = definition?.passes || []
        if (passes.length === 0) return true
        for (const pass of passes) {
            if (!pass.inputs) continue
            const vals = Object.values(pass.inputs)
            if (vals.some(v => PIPELINE_INPUT_TOKENS.has(v))) return false
        }
        return true
    }

    /**
     * Register one stored record with the engine via the renderer's
     * registerEffectsFromBundle (which calls into
     * registerEffectWithRuntime under the hood and caches in the
     * renderer's _loadedEffects so the compiler won't try to fetch
     * this effect from the CDN).
     */
    async _registerWithRenderer(renderer, record) {
        const { Effect: EffectClass } = await loadBundle()
        const def = JSON.parse(record.files['definition.json'])
        const shaders = this._collectShaders(record.files)
        const instance = this._buildInstance(def, shaders, EffectClass)
        const effectName = def.func || def.name
        renderer.registerEffectsFromBundle({
            namespace: USER_NAMESPACE,
            effects: { [effectName]: instance },
        })
        this._loadedIds.add(`${USER_NAMESPACE}/${effectName}`)
        this._renderers.add(renderer)
    }

    /**
     * Pull a user effect out of the runtime: drop every alias from the
     * engine's effect registry, and evict it from each renderer's
     * loaded-effects cache so the next compile that references it
     * fails fast (rather than rendering against the stale instance).
     */
    async _unregisterFromRuntime(id) {
        const [, effectName] = id.split('/')
        if (!effectName) return

        let unregister
        try {
            const bundle = await loadBundle()
            unregister = bundle.unregisterEffect
        } catch {
            unregister = _unregisterEffect
        }

        // Mirror the 4 aliases CanvasRenderer.registerEffectWithRuntime
        // installs (line 1163-1166 of canvas.js): func, namespace.func,
        // namespace/name, namespace.name. With the portable contract
        // (func === name) the last two collapse to the same key, but
        // unregister is idempotent so doubling up is harmless.
        const aliases = [
            effectName,
            `${USER_NAMESPACE}.${effectName}`,
            `${USER_NAMESPACE}/${effectName}`,
            `${USER_NAMESPACE}.${effectName}`,
        ]
        for (const key of aliases) {
            try { unregister?.(key) } catch { /* engine may throw if absent */ }
        }
        for (const renderer of this._renderers) {
            renderer._loadedEffects?.delete(id)
        }
    }

    // ── Public API ───────────────────────────────────────────────────

    /**
     * Load + register every stored user effect with the given renderer.
     * Idempotent per (renderer, id). Call this once at boot before the
     * library populates so the user effects participate in
     * defaultPrograms' getAllEffects() scan.
     */
    async initialize(renderer) {
        if (!renderer) throw new Error('initialize requires a renderer')
        if (this._renderers.has(renderer)) return
        const records = await this.getAll()
        for (const rec of records) {
            try {
                await this._registerWithRenderer(renderer, rec)
            } catch (err) {
                console.error(`[userEffects] failed to register ${rec.id}:`, err)
            }
        }
        this._renderers.add(renderer)
    }

    /** Same shape returned by initialize, exposed for UI listing. */
    async listInstalled() {
        const records = await this.getAll()
        return records
            .map(r => ({ id: r.id, name: r.name, uploadedAt: r.uploadedAt }))
            .sort((a, b) => a.name.localeCompare(b.name))
    }

    /**
     * Install a fresh effect from a zip blob. Validates, dedupes by id,
     * persists to IndexedDB with quota self-healing recovery, registers
     * with the renderer immediately so the operator can use it without a
     * reload, and emits 'change'.
     *
     * Returns { id, name } on success. Throws on duplicate, invalid, or
     * quota exceeded package.
     */
    async uploadFromZip(zipBlob, renderer) {
        if (!zipBlob) throw new Error('no zip file provided')
        if (typeof zipBlob.size === 'number' && zipBlob.size > MAX_PACKAGE_SIZE) {
            throw new Error(`package exceeds maximum size limit (${Math.round(MAX_PACKAGE_SIZE / (1024 * 1024))}MB)`)
        }
        const { name, files } = await this.processZip(zipBlob)
        const id = `${USER_NAMESPACE}/${name}`

        const existing = await this._get(id)
        if (existing) {
            throw new Error(`effect "${name}" is already installed — delete it first to replace`)
        }

        const record = { id, name, files, uploadedAt: Date.now() }
        await this._putWithQuotaRecovery(record)
        if (renderer) {
            try {
                await this._registerWithRenderer(renderer, record)
            } catch (regErr) {
                await this._remove(id).catch(() => {})
                throw regErr
            }
        }
        this._emitChange()
        return { id, name }
    }

    /**
     * Install an effect from a raw payload — used by the share-loader
     * path where the composition API returned the effect inline. The
     * payload shape matches sharing.noisedeck.app's `effects[]` items:
     *
     *   { name, func, namespace, description, tags, globals, passes,
     *     shaders: { <programName>: { glsl, wgsl } }, help? }
     *
     * Persists by reconstructing the same files map the zip path would
     * produce so a later reload boots back to the same state via
     * initialize().
     */
    async uploadFromPayload(payload, renderer) {
        if (!payload || typeof payload !== 'object') {
            throw new Error('invalid effect payload')
        }
        const name = payload.func || payload.name
        if (!name) throw new Error('effect payload missing func/name')

        const definition = {
            name: payload.name || name,
            func: name,
            namespace: USER_NAMESPACE,
            description: payload.description || '',
            tags: payload.tags || ['user'],
            globals: payload.globals || {},
            passes: payload.passes || [],
            // Preserve textures: the zip path keeps them (raw definition.json)
            // and _buildInstance forwards them to the runtime. Dropping them
            // here installs a broken instance — particle/points effects key
            // their channels off textures — and persists it to IndexedDB, so
            // the same effect imported via ?code= would diverge from the zip.
            ...(payload.textures ? { textures: payload.textures } : {}),
            ...(payload.uniformLayout ? { uniformLayout: payload.uniformLayout } : {}),
            ...(payload.uniformLayouts ? { uniformLayouts: payload.uniformLayouts } : {}),
            ...(payload.defaultProgram ? { defaultProgram: payload.defaultProgram } : {}),
        }

        const defJson = JSON.stringify(definition, null, 2)
        const defByteLen = typeof Buffer !== 'undefined'
            ? Buffer.byteLength(defJson, 'utf8')
            : (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(defJson).length : defJson.length)
        if (defByteLen > MAX_FILE_SIZE) {
            throw new Error(`definition.json exceeds maximum size limit (${Math.round(MAX_FILE_SIZE / (1024 * 1024))}MB)`)
        }

        const files = { 'definition.json': defJson }
        let totalPayloadSize = defByteLen

        const shaders = payload.shaders || {}
        for (const [programName, prog] of Object.entries(shaders)) {
            if (prog.glsl) {
                const byteLen = typeof Buffer !== 'undefined'
                    ? Buffer.byteLength(prog.glsl, 'utf8')
                    : (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(prog.glsl).length : prog.glsl.length)
                if (byteLen > MAX_FILE_SIZE) {
                    throw new Error(`shader "${programName}.glsl" exceeds maximum size limit`)
                }
                totalPayloadSize += byteLen
                files[`glsl/${programName}.glsl`] = prog.glsl
            }
            if (prog.wgsl) {
                const byteLen = typeof Buffer !== 'undefined'
                    ? Buffer.byteLength(prog.wgsl, 'utf8')
                    : (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(prog.wgsl).length : prog.wgsl.length)
                if (byteLen > MAX_FILE_SIZE) {
                    throw new Error(`shader "${programName}.wgsl" exceeds maximum size limit`)
                }
                totalPayloadSize += byteLen
                files[`wgsl/${programName}.wgsl`] = prog.wgsl
            }
        }

        if (payload.help) {
            const helpByteLen = typeof Buffer !== 'undefined'
                ? Buffer.byteLength(payload.help, 'utf8')
                : (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(payload.help).length : payload.help.length)
            if (helpByteLen > MAX_FILE_SIZE) {
                throw new Error(`help.md exceeds maximum size limit (${Math.round(MAX_FILE_SIZE / (1024 * 1024))}MB)`)
            }
            totalPayloadSize += helpByteLen
            files['help.md'] = payload.help
        }

        if (totalPayloadSize > MAX_TOTAL_UNCOMPRESSED_SIZE) {
            throw new Error(`uncompressed effect payload exceeds maximum size limit (${Math.round(MAX_TOTAL_UNCOMPRESSED_SIZE / (1024 * 1024))}MB)`)
        }

        const id = `${USER_NAMESPACE}/${name}`
        const existing = await this._get(id)
        if (existing) {
            // Share-loader path: silently skip duplicates so re-loading
            // a shared composition that bundles effects we've already
            // installed isn't a hard error.
            if (renderer && !this._loadedIds.has(id)) {
                try {
                    await this._registerWithRenderer(renderer, existing)
                } catch (regErr) {
                    console.warn(`[userEffects] failed to register existing effect "${id}" with renderer:`, regErr)
                }
            }
            return { id, name, alreadyInstalled: true }
        }

        const record = { id, name, files, uploadedAt: Date.now() }
        await this._putWithQuotaRecovery(record)
        if (renderer) {
            try {
                await this._registerWithRenderer(renderer, record)
            } catch (regErr) {
                await this._remove(id).catch(() => {})
                throw regErr
            }
        }
        this._emitChange()
        return { id, name }
    }

    /**
     * Delete an installed effect: removes from IndexedDB AND from the
     * engine's runtime registry (via unregisterEffect across all 4
     * alias keys) and each renderer's loaded-effects cache. Programs
     * that reference the deleted effect will fail to compile from now
     * on with a clean "unknown function" error rather than rendering
     * against a stale instance.
     */
    async deleteEffect(id) {
        const existed = await this._get(id)
        if (!existed) return false
        await this._remove(id)
        await this._unregisterFromRuntime(id)
        this._loadedIds.delete(id)
        this._emitChange()
        return true
    }
}

// JSZip is vendored as a non-module global at js/lib/jszip.min.js (same
// pattern as noisedeck). Load it lazily on first import so cold boots
// don't pay the ~100KB cost if the user never opens the importer.
let _jszipPromise = null
function loadJSZip() {
    if (typeof globalThis !== 'undefined' && globalThis.JSZip) return Promise.resolve(globalThis.JSZip)
    if (_jszipPromise) return _jszipPromise
    _jszipPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script')
        script.src = 'js/lib/jszip.min.js'
        script.onload = () => {
            if (window.JSZip) resolve(window.JSZip)
            else reject(new Error('jszip loaded but global JSZip is undefined'))
        }
        script.onerror = () => reject(new Error('failed to load jszip.min.js'))
        document.head.appendChild(script)
    })
    return _jszipPromise
}

let _manager = null
export function getUserEffectsManager() {
    if (!_manager) _manager = new UserEffectsManager()
    return _manager
}

export {
    UserEffectsManager,
    USER_NAMESPACE,
    DB_NAME,
    DB_VERSION,
    EFFECTS_STORE,
    MAX_PACKAGE_SIZE,
    MAX_TOTAL_UNCOMPRESSED_SIZE,
    MAX_FILE_SIZE,
}

