function policyObjects({ permissionsPolicy, featurePolicy }) {
    return [permissionsPolicy, featurePolicy].filter((value, index, values) => (
        value && values.indexOf(value) === index
    ))
}

function supportsFeature(policy, feature) {
    if (typeof policy?.features !== 'function') return false
    const features = policy.features()
    return Array.isArray(features) && features.includes(feature)
}

/**
 * Detect whether an embedding document explicitly blocks loopback access.
 * Unknown/experimental API shapes are deliberately not interpreted as denial.
 */
export function detectLoopbackPolicy({
    isEmbedded = false,
    permissionsPolicy = null,
    featurePolicy = null
} = {}) {
    if (!isEmbedded) return Object.freeze({ status: 'allowed', feature: null })

    try {
        const policies = policyObjects({ permissionsPolicy, featurePolicy })
        for (const feature of ['loopback-network', 'local-network-access']) {
            for (const policy of policies) {
                if (!supportsFeature(policy, feature)) continue
                if (typeof policy.allowsFeature !== 'function') {
                    return Object.freeze({ status: 'unknown', feature: null })
                }
                return Object.freeze({
                    status: policy.allowsFeature(feature) ? 'allowed' : 'blocked',
                    feature
                })
            }
        }
    } catch {
        // Permissions Policy remains experimental. Failure to inspect is not denial.
    }

    return Object.freeze({ status: 'unknown', feature: null })
}
