const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const matcher = require('minimatch')

test('preserves the callable and named matcher APIs used by desktop dependencies', () => {
  assert.equal(typeof matcher, 'function')
  assert.equal(matcher('main.js', '*.js'), true)
  assert.equal(matcher.minimatch('main.js', '*.json'), false)
  assert.deepEqual(matcher.match(['main.js', 'package.json'], '*.js'), ['main.js'])
  assert.deepEqual(['main.js', 'package.json'].filter(matcher.filter('*.js')), ['main.js'])
  assert.deepEqual(matcher.braceExpand('*.{js,json}'), ['*.js', '*.json'])
  assert.equal(matcher.defaults({ nocase: true })('MAIN.JS', '*.js'), true)
  assert.equal(new matcher.Minimatch('*.js').match('main.js'), true)
  assert.equal(new (matcher.Minimatch.defaults({ nocase: true }))('*.js').match('MAIN.JS'), true)
})

test('preserves desktop packaging patterns and matching options', () => {
  const files = ['main.js', '.hidden.js', 'package.json', 'nested/index.js', 'nested/data.txt', 'node_modules/dep/index.js']
  const cases = [
    ['**/*.js', {}, ['main.js', 'nested/index.js', 'node_modules/dep/index.js']],
    ['**/*.js', { dot: true }, ['main.js', '.hidden.js', 'nested/index.js', 'node_modules/dep/index.js']],
    ['**/*.{js,json}', {}, ['main.js', 'package.json', 'nested/index.js', 'node_modules/dep/index.js']],
    ['*.js', { matchBase: true }, ['main.js', 'nested/index.js', 'node_modules/dep/index.js']],
    ['!node_modules/**', { dot: true }, ['main.js', '.hidden.js', 'package.json', 'nested/index.js', 'nested/data.txt']],
  ]
  for (const [pattern, options, expected] of cases) {
    assert.deepEqual(files.filter(file => matcher(file, pattern, options)), expected, pattern)
  }
})

test('bounds globparts amplification using the upstream security limit', () => {
  const match = new matcher.Minimatch('a/**/../b/**/../c/**/../d/**/../e/**/../f', {
    optimizationLevel: 2,
    braceExpandMax: 4,
  })
  assert.ok(match.globParts.length <= 4, `expanded to ${match.globParts.length} parts`)
})

test('legacy glob, directory comparison and ASAR packaging use the patched matcher', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minimatch-packaging-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const input = path.join(root, 'input')
  const copy = path.join(root, 'copy')
  await fs.mkdir(path.join(input, 'nested'), { recursive: true })
  await fs.writeFile(path.join(input, 'main.js'), 'module.exports = 1\n')
  await fs.writeFile(path.join(input, '.hidden.js'), 'module.exports = 3\n')
  await fs.writeFile(path.join(input, 'nested', 'binding.node'), 'native-payload')
  await fs.writeFile(path.join(input, 'package.json'), '{"main":"main.js"}')
  await fs.cp(input, copy, { recursive: true })
  const { createRequire } = require('node:module')
  for (const consumer of ['glob', 'filelist', 'dir-compare', '@electron/asar', '@electron/universal', 'app-builder-lib']) {
    const resolved = createRequire(require.resolve(consumer))('minimatch')
    assert.equal(typeof resolved, 'function', `${consumer} resolves the patched callable adapter`)
    assert.ok(new resolved.Minimatch('a/**/../b/**/../c/**/../d/**/../e/**/../f', { optimizationLevel: 2, braceExpandMax: 4 }).globParts.length <= 4, `${consumer} enforces amplification limit`)
  }
  const glob = require('glob')
  assert.deepEqual(glob.sync('**/*.js', { cwd: input }), ['main.js'])
  assert.deepEqual(glob.sync('**/*.js', { cwd: input, dot: true }).sort(), ['.hidden.js', 'main.js'])
  assert.deepEqual(glob.sync('**/.hidden.js', { cwd: input }), ['.hidden.js'])
  const { FileMatcher } = require('app-builder-lib/out/fileMatcher')
  const included = new FileMatcher(input, copy, value => value, ['**/*.js']).createFilter()
  const excluded = new FileMatcher(input, copy, value => value, ['**/*.js', '!**/.hidden.js']).createFilter()
  const hidden = path.join(input, '.hidden.js')
  const hiddenStat = await fs.stat(hidden)
  assert.equal(included(hidden, hiddenStat), true)
  assert.equal(excluded(hidden, hiddenStat), false)
  const compare = require('dir-compare')
  assert.equal(compare.compareSync(input, copy, { compareContent: true, includeFilter: '*.js' }).same, true)
  await fs.writeFile(path.join(copy, 'main.js'), 'module.exports = 2\n')
  assert.equal(compare.compareSync(input, copy, { compareContent: true, includeFilter: '*.js' }).same, false)
  const asar = require('@electron/asar')
  const archive = path.join(root, 'app.asar')
  await asar.createPackageWithOptions(input, archive, { unpack: '**/*.node' })
  assert.equal(asar.extractFile(archive, 'main.js').toString(), 'module.exports = 1\n')
  assert.equal(await fs.readFile(`${archive}.unpacked/nested/binding.node`, 'utf8'), 'native-payload')
})


test('native ESM consumers receive named minimatch exports', async () => {
  const { minimatch, Minimatch, match } = await import('minimatch')
  assert.equal(minimatch('main.js', '*.js'), true)
  assert.equal(new Minimatch('*.js').match('main.js'), true)
  assert.deepEqual(match(['main.js', 'package.json'], '*.js'), ['main.js'])
  const universal = await import('@electron/universal')
  assert.equal(typeof universal.makeUniversalApp, 'function')
})
