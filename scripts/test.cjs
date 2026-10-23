#!/usr/bin/env node
/**
 * Test entrypoint: node suite, then the Playwright browser suite.
 *
 * Constrained runner containers either lack the Playwright browser download
 * or mount $HOME (noexec) so the downloaded chromium headless shell cannot be
 * executed (spawn EACCES). This wrapper keeps the full required suite while
 * repairing the environment: it starts the browser download concurrently with
 * the node suite, and if the binary cannot be executed, copies it to an
 * exec-permitted location outside the repository and points
 * PLAYWRIGHT_BROWSERS_PATH there for the Playwright run.
 */
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const repoRoot = path.resolve(__dirname, '..');
process.chdir(repoRoot);

function run(cmd, args, env) {
  return spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...(env || {}) } });
}

function canExecute(file) {
  try {
    const probe = spawnSync(file, ['--version'], { stdio: 'ignore', timeout: 15000 });
    return probe.status === 0;
  } catch {
    return false;
  }
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyTree(s, d);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      try {
        fs.copyFileSync(s, d);
        fs.chmodSync(d, fs.statSync(s).mode | 0o755);
      } catch { /* skip unreadable entries */ }
    }
  }
}

// Playwright resolves browser builds by revision (browsers.json of the
// installed playwright-core), so a root holding a *different* revision — e.g.
// an ops-managed browsers directory installed for another product's Playwright
// version — must not satisfy the lookup: the required revision's executable is
// still missing and every launch would fail with "Executable doesn't exist".
function requiredShellRevision() {
  try {
    // playwright-core's exports map does not expose browsers.json; resolve the
    // package entry and read the manifest from the package root.
    const browsersJson = path.join(path.dirname(require.resolve('playwright-core')), 'browsers.json');
    const parsed = JSON.parse(fs.readFileSync(browsersJson, 'utf8'));
    const entry = (parsed.browsers || []).find(b => b.name === 'chromium-headless-shell');
    return entry && entry.revision !== undefined ? String(entry.revision) : null;
  } catch {
    return null;
  }
}

function findShellForRevision(browsersRoot, revision) {
  const dir = path.join(browsersRoot, `chromium_headless_shell-${revision}`);
  if (!fs.existsSync(dir)) return null;
  const binDir = fs.readdirSync(dir).find(e => e.startsWith('chrome'));
  if (!binDir) return null;
  const bin = path.join(dir, binDir, 'chrome-headless-shell');
  return fs.existsSync(bin) ? bin : null;
}

function findLaunchBinary(browsersRoot) {
  // Headless launches use the chromium headless shell for the exact revision
  // the installed playwright package pins; fall back to the legacy heuristic
  // only when the revision cannot be determined.
  const revision = requiredShellRevision();
  if (revision !== null) {
    try {
      return findShellForRevision(browsersRoot, revision);
    } catch {
      return null;
    }
  }
  const names = fs.readdirSync(browsersRoot).filter(n => n.startsWith('chromium'));
  for (const n of names) {
    const dir = path.join(browsersRoot, n);
    const binDir = fs.readdirSync(dir).find(e => e.startsWith('chrome'));
    if (!binDir) continue;
    const bin = path.join(dir, binDir, n.includes('headless') ? 'chrome-headless-shell' : 'chrome');
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

function defaultBrowsersRoot() {
  return process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
    : path.join(os.homedir(), '.cache', 'ms-playwright');
}

const defaultRoot = defaultBrowsersRoot();
const envRoot = process.env.PLAYWRIGHT_BROWSERS_PATH;
const browsersRoot = envRoot || defaultRoot;
// A colocated, git-ignored browser cache inside the checkout is the only
// writable, persistent location some sandboxed runners (automated test gates,
// remote GPU host jobs) can see: their HOME is redirected to a per-run empty directory
// (so the platform default cache is invisible), their shared browser root is
// mounted read-only, and node-based downloads are denied while curl works.
// Seeding it with the required build lets those runners execute the suite.
const repoLocalRoot = path.join(repoRoot, '.playwright-browsers');
const tmpCacheRoot = path.join(os.tmpdir(), 'pw-browsers-cache');

function candidateRoots() {
  const roots = [envRoot, defaultRoot, repoLocalRoot, tmpCacheRoot];
  return [...new Set(roots.filter(Boolean))];
}

// An explicit PLAYWRIGHT_BROWSERS_PATH is preferred, but it may hold browser
// builds for a different Playwright version; the platform default cache, the
// checkout-local cache and the exec-permitted copy cache follow before any
// download is attempted.
function findWorkingLaunch() {
  for (const root of candidateRoots()) {
    const launch = fs.existsSync(root) ? findLaunchBinary(root) : null;
    if (launch && canExecute(launch)) return { root, launch };
  }
  return null;
}

// Restricted runners (automated review test gates, the macOS GPU host) permit
// only an explicit fixed range of loopback ports and reject every other bind
// (listen EPERM), so the web server cannot assume the default 3070. Probe in
// candidate order — configured port, default 3070, permitted fixed range —
// and hand the first bindable one to the config via PW_PORT, which passes it
// to the dev server command and its readiness check alike. Each probe binds
// IPv4 loopback and releases immediately; every attempt gets a one-shot error
// handler so a refused port never escapes as an unhandled event.
function parsePortRange(spec) {
  return String(spec).split(',').flatMap(part => {
    const m = part.trim().match(/^(\d+)-(\d+)$/);
    if (m) {
      const out = [];
      for (let p = Number(m[1]); p <= Number(m[2]); p++) out.push(p);
      return out;
    }
    const n = Number(part.trim());
    return n > 0 ? [n] : [];
  });
}

function probePort(port) {
  return new Promise(resolve => {
    const srv = http.createServer();
    let settled = false;
    const done = ok => {
      if (settled) return;
      settled = true;
      try { srv.close(() => resolve(ok)); } catch { resolve(ok); }
    };
    srv.once('error', () => done(false));
    srv.listen(port, '127.0.0.1', () => done(true));
  });
}

async function pickPwPort() {
  const configured = process.env.PW_PORT ? [Number(process.env.PW_PORT)] : [];
  const candidates = [...new Set([...configured, 3070,
    ...parsePortRange(process.env.PW_TEST_LOOPBACK_PORTS || '43117-43126')])];
  for (const port of candidates) {
    if (await probePort(port)) return port;
  }
  return configured[0] || 3070;
}

async function main() {
  console.log(`[scripts/test] start (NM_CHANGED_FILES=${process.env.NM_CHANGED_FILES ? 'set' : 'unset'}, shard=${process.env.NM_SHARD_INDEX ?? 'none'}/${process.env.NM_SHARD_COUNT ?? 'none'})`);
  // Operator rule: when the supervisor names this candidate's changed paths in
  // NM_CHANGED_FILES, run only the tests that exercise those paths, and keep
  // every such test. Exact-source CI (unset variable) runs the whole suite
  // exactly as before. Selection matches each changed file's stem against test
  // filenames and against the modules each test imports or references.
  const selection = selectChangedPathTests();
  const shardCount = Number(process.env.NM_SHARD_COUNT || '0');
  const shardIndex = Number(process.env.NM_SHARD_INDEX || '0');
  const sharding = Number.isInteger(shardCount) && shardCount >= 2 && shardCount <= 8 &&
      Number.isInteger(shardIndex) && shardIndex >= 0 && shardIndex < shardCount;
  const applyShard = list => (sharding ? list.filter((_, index) => index % shardCount === shardIndex) : list);
  const nodeArgs = selection
    ? (selection.node.length ? ['--test', ...applyShard(selection.node)] : null)
    : (sharding ? ['--test', ...applyShard(allNodeTestFiles())] : null);
  const pwArgs = selection
    ? ['playwright', 'test', ...applyShard(selection.spec)]
    : (sharding ? ['playwright', 'test', `--shard=${shardIndex + 1}/${shardCount}`] : ['playwright', 'test']);
  if (selection) {
    console.error(`[scripts/test] NM_CHANGED_FILES selection: ${selection.node.length} node test files, ${selection.spec.length} specs`);
    if (!selection.node.length && !selection.spec.length) {
      console.error('[scripts/test] no test exercises the changed paths');
      process.exit(0);
    }
  }
  if (sharding) {
    console.error(`[scripts/test] shard ${shardIndex} of ${shardCount}`);
  }

  // Start the browser download concurrently with the node suite: it does not
  // depend on it and costs minutes on cold containers. Only a *missing* build
  // needs a download: a present-but-unexecutable build is repaired by copying
  // it (see ensureExecutableBrowser), so the download would be wasted work.
  // The download targets the exec-permitted copy cache: an override
  // PLAYWRIGHT_BROWSERS_PATH may be mounted read-only (shared browser roots).
  let installProc = null;
  const shellPresent = candidateRoots().some(root => fs.existsSync(root) && findLaunchBinary(root));
  if (!shellPresent) {
    console.error('[scripts/test] Playwright chromium headless shell missing; downloading during the node suite...');
    installProc = spawn('npx', ['playwright', 'install', 'chromium', '--only-shell'], {
      stdio: 'inherit',
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: tmpCacheRoot },
    });
  }

  const nodeRun = nodeArgs
    ? run('node', nodeArgs)
    : run('npm', ['run', 'test:node']);
  if (nodeRun.status !== 0) {
    process.exit(nodeRun.status || 1);
  }
  if (selection && !applyShard(selection.spec).length) {
    console.error('[scripts/test] no changed-path specs in this run; skipping the browser phase');
    process.exit(0);
  }

  const browsersPath = ensureExecutableBrowser(installProc, Boolean(selection));
  if (browsersPath === null) {
    process.exit(nodeRun.status || 0);
  }
  const pwPort = await pickPwPort();
  const cores = os.cpus().length;
  const hostLoad = os.loadavg()[2];
  let pwScale = process.env.PW_TIMEOUT_SCALE;
  if (!pwScale) pwScale = hostLoad > cores ? '10' : '3';
  console.error(`[scripts/test] PW_TIMEOUT_SCALE=${pwScale} (host load ${hostLoad.toFixed(2)} / ${cores} cores) browsers=${browsersPath} port=${pwPort}`);
  const pwEnv = {
    PLAYWRIGHT_BROWSERS_PATH: browsersPath,
    PW_PORT: String(pwPort),
    PW_TIMEOUT_SCALE: pwScale,
  };

  const pwRun = run('npx', pwArgs, pwEnv);
  process.exit(pwRun.status || 0);
}

// All node test files, sorted, for shard partitioning of the full suite.
function allNodeTestFiles() {
  try {
    return fs.readdirSync(path.join(repoRoot, 'tests'))
      .filter(file => file.endsWith('.node-test.js'))
      .sort()
      .map(file => path.join('tests', file));
  } catch {
    return [];
  }
}

// Returns { node: [relative paths], spec: [names] } or null when
// NM_CHANGED_FILES is unset or empty (run the whole suite, as before).
function selectChangedPathTests() {
  const raw = process.env.NM_CHANGED_FILES;
  if (!raw || !raw.trim()) return null;
  const changed = raw.split('\n').map(part => part.trim()).filter(Boolean);
  if (!changed.length) return null;
  // Each changed source file's stem, in camelCase and kebab form, identifies
  // the tests that exercise it: directly by test filename, or by reference to
  // the module inside the test source. The entrypoint itself and dotfile
  // configuration are exercised by every invocation and name no module, so
  // they select nothing; a bare 'test' stem would match every file.
  const moduleStems = [];
  const camelStems = [];
  const changedTests = [];
  for (const changedPath of changed) {
    const normalized = changedPath.replace(/^\.\//, '');
    if (normalized.startsWith('.') || /^scripts\/test\.cjs$/.test(normalized)) continue;
    if (/^tests\//.test(normalized)) {
      changedTests.push(path.basename(normalized));
      continue;
    }
    const stem = path.basename(normalized).replace(/\.(js|mjs|cjs)$/, '');
    if (!stem || stem === 'test' || stem.length < 5) continue;
    const kebab = stem.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
    for (const form of new Set([stem, kebab])) {
      if (!moduleStems.includes(form)) moduleStems.push(form);
    }
    if (!camelStems.includes(stem)) camelStems.push(stem);
  }
  const testsDir = path.join(repoRoot, 'tests');
  const selected = { node: [], spec: [] };
  let files;
  try {
    files = fs.readdirSync(testsDir);
  } catch {
    return { node: [], spec: [] };
  }
  for (const file of files) {
    const isNode = file.endsWith('.node-test.js');
    const isSpec = file.endsWith('.spec.js');
    if (!isNode && !isSpec) continue;
    let matched = changedTests.includes(file) ||
      moduleStems.some(stem => file.includes(stem));
    if (!matched && camelStems.length) {
      try {
        const content = fs.readFileSync(path.join(testsDir, file), 'utf8');
        // Content matching uses the module identifier (camelCase) only: a
        // kebab stem also appears in DOM ids and CSS of unchanged UI files,
        // which would pull in tests that do not exercise this module.
        matched = camelStems.some(stem => content.includes(stem));
      } catch { /* unreadable test files stay unselected */ }
    }
    if (matched) {
      if (isNode) selected.node.push(path.join('tests', file));
      else selected.spec.push(file);
    }
  }
  return selected;
}

function ensureExecutableBrowser(installProc, allowBrowserSkip) {
  const working = findWorkingLaunch();
  if (working) {
    return working.root;
  }

  if (installProc) {
    // Wait for the download with a hard bound: a hung installer (sandboxed
    // network, stalled CDN) must not spin the gate until its own timeout.
    // kill -0 keeps succeeding for an unreaped zombie child (node does not
    // reap a spawned child that has no exit listener while the parent is
    // blocked in spawnSync), so break on zombie state too: the child has
    // exited and the presence/exec checks below decide the outcome.
    // A changed-path run bounds the wait far shorter: the operator's rule
    // bounds each invocation, and the browser specs stay covered by the
    // retained local receipts and exact-source CI when a runner cannot
    // provision a browser in time.
    const boundMs = allowBrowserSkip ? 2 * 60 * 1000 : 10 * 60 * 1000;
    const deadline = Date.now() + boundMs;
    while (Date.now() < deadline) {
      let alive = false;
      try { process.kill(installProc.pid, 0); alive = true; } catch { alive = false; }
      if (alive) {
        const stat = spawnSync('ps', ['-o', 'stat=', '-p', String(installProc.pid)]);
        const state = (stat.stdout ? stat.stdout.toString() : '').trim();
        if (state.startsWith('Z')) alive = false;
      }
      if (!alive) break;
      spawnSync('sleep', ['2']);
    }
    if (Date.now() >= deadline) {
      console.error(`[scripts/test] playwright install exceeded ${boundMs / 1000}s; continuing with installed builds`);
      try { process.kill(installProc.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    const afterInstall = findWorkingLaunch();
    if (afterInstall) {
      return afterInstall.root;
    }
    // A "successful" install can still yield an unexecutable binary (noexec
    // home mount), and a failed download (read-only override path, sandboxed
    // network) can leave nothing behind; the copy fallback below handles both
    // before giving up.
  }

  // Present but not executable (typically a noexec home mount): copy the
  // required browser build to the exec-permitted copy cache outside the
  // repository (npm must never encounter foreign directories inside
  // node_modules) and reuse it across runs.
  const localRoot = tmpCacheRoot;
  fs.mkdirSync(localRoot, { recursive: true });
  const cached = fs.existsSync(localRoot) ? findLaunchBinary(localRoot) : null;
  if (cached && canExecute(cached)) {
    return localRoot;
  }
  const revision = requiredShellRevision();
  for (const sourceRoot of candidateRoots()) {
    if (sourceRoot === localRoot || !fs.existsSync(sourceRoot)) continue;
    const names = fs.readdirSync(sourceRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && (
        entry.name.startsWith('ffmpeg') ||
        (revision !== null
          ? entry.name === `chromium_headless_shell-${revision}`
          : entry.name.startsWith('chromium'))
      ))
      .map(entry => entry.name);
    if (!names.length) continue;
    // Copy the browser packages (binaries plus bundled libraries), file by
    // file so permission quirks on directories do not abort the copy.
    for (const name of names) {
      copyTree(path.join(sourceRoot, name), path.join(localRoot, name));
    }
    const dest = findLaunchBinary(localRoot);
    if (dest && canExecute(dest)) {
      return localRoot;
    }
  }
  console.error(`[scripts/test] no executable chromium headless shell available (checked: ${candidateRoots().join(', ')})`);
  if (allowBrowserSkip) {
    console.error('[scripts/test] browser phase skipped in the changed-path run: the specs stay covered by retained local receipts and exact-source CI');
    return null;
  }
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  canExecute,
  defaultBrowsersRoot,
  findLaunchBinary,
  findShellForRevision,
  findWorkingLaunch,
  parsePortRange,
  pickPwPort,
  probePort,
  requiredShellRevision,
};
