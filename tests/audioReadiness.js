// SPDX-License-Identifier: MIT
export function audioReadinessSnapshot(audio = globalThis.__visualize?.audio) {
    if (!audio?.enabled || audio._audioContext?.state !== 'running') return false
    const meters = { ...audio.meters }
    const samples = audio._timeDomainData || []
    let squares = 0
    for (const value of samples) squares += ((value - 128) / 128) ** 2
    const rms = samples.length ? Math.sqrt(squares / samples.length) : 0
    if (!(meters.low > 0 || meters.mid > 0 || meters.high > 0)
        || !(rms > 0) || !(meters.vol > 0.1)) return false
    return { meters, rms }
}
