const implementation = require('minimatch-modern')

function callable(api) {
  const match = api.minimatch || api
  class Minimatch extends api.Minimatch {
    constructor(...args) {
      super(...args)
      for (const pattern of this.set) {
        for (const part of pattern) {
          if (part && typeof part === 'object' && typeof part.test === 'function') {
            part._glob = part.pattern
            part[Symbol.match] = value => part.test(value) ? [value] : null
          }
        }
      }
    }
    static defaults(options) {
      return callable(api.defaults(options)).Minimatch
    }
  }
  return Object.assign((...args) => match(...args), match, api, {
    Minimatch,
    defaults: options => callable(api.defaults(options)),
  })
}

const compat = callable(implementation)
module.exports = compat
// Static assignments expose the named API to native ESM consumers.
module.exports.minimatch = compat
module.exports.Minimatch = compat.Minimatch
module.exports.filter = compat.filter
module.exports.defaults = compat.defaults
module.exports.braceExpand = compat.braceExpand
module.exports.match = compat.match
module.exports.GLOBSTAR = compat.GLOBSTAR
module.exports.sep = compat.sep
module.exports.escape = compat.escape
module.exports.unescape = compat.unescape
