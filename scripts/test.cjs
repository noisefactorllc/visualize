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
// writable, persistent location some sandboxed runners (supervisor test gates,
// broker jobs) can see: their HOME is redirected to a per-run empty directory
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

// Restricted runners (supervisor test gates, the macOS host broker) permit
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

  const nodeRun = run('npm', ['run', 'test:node']);
  if (nodeRun.status !== 0) {
    process.exit(nodeRun.status || 1);
  }

  const browsersPath = ensureExecutableBrowser(installProc);
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

  const pwRun = run('npx', ['playwright', 'test'], pwEnv);
  process.exit(pwRun.status || 0);
}

function ensureExecutableBrowser(installProc) {
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
    const boundMs = 10 * 60 * 1000;
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
