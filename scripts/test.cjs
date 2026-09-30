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

function findLaunchBinary(browsersRoot) {
  // Headless launches use the chromium headless shell; the full chromium
  // build is never launched by this suite. Prefer the shell when present.
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

// Start the browser download concurrently with the node suite: it does not
// depend on it and costs minutes on cold containers.
const browsersRoot = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.HOME || '', '.cache', 'ms-playwright');
const launchBefore = fs.existsSync(browsersRoot) ? findLaunchBinary(browsersRoot) : null;
let installProc = null;
if (!launchBefore) {
  console.error('[scripts/test] Playwright chromium headless shell missing; downloading during the node suite...');
  installProc = spawn('npx', ['playwright', 'install', 'chromium', '--only-shell'], {
    stdio: 'inherit',
    env: process.env,
  });
}

const nodeRun = run('npm', ['run', 'test:node']);
if (nodeRun.status !== 0) {
  process.exit(nodeRun.status || 1);
}

function ensureExecutableBrowser() {
  let launch = fs.existsSync(browsersRoot) ? findLaunchBinary(browsersRoot) : null;
  if (launch && canExecute(launch)) {
    return browsersRoot;
  }

  if (installProc) {
    const status = spawnSync('sh', ['-c', 'while kill -0 ' + installProc.pid + ' 2>/dev/null; do sleep 1; done']);
    if (status.status !== 0) {
      console.error('[scripts/test] playwright install failed');
      process.exit(1);
    }
    launch = fs.existsSync(browsersRoot) ? findLaunchBinary(browsersRoot) : null;
    if (launch && canExecute(launch)) {
      return browsersRoot;
    }
    if (!launch) {
      console.error('[scripts/test] playwright install produced no chromium headless shell in ' + browsersRoot);
      process.exit(1);
    }
  }

  // Present but not executable (typically a noexec home mount): copy the
  // browser installation to a stable exec-permitted location outside the
  // repository (npm must never encounter foreign directories inside
  // node_modules) and reuse it across runs.
  const localRoot = path.join(os.tmpdir(), 'pw-browsers-cache');
  fs.mkdirSync(localRoot, { recursive: true });
  let dest = findLaunchBinary(localRoot);
  if (dest && canExecute(dest)) {
    return localRoot;
  }
  if (!fs.existsSync(browsersRoot)) {
    console.error('[scripts/test] no chromium headless shell available in ' + browsersRoot);
    process.exit(1);
  }
  // Copy the browser packages (binaries plus bundled libraries), file by
  // file so permission quirks on directories do not abort the copy.
  for (const entry of fs.readdirSync(browsersRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && (entry.name.startsWith('chromium') || entry.name.startsWith('ffmpeg'))) {
      copyTree(path.join(browsersRoot, entry.name), path.join(localRoot, entry.name));
    }
  }
  dest = findLaunchBinary(localRoot);
  if (!dest || !canExecute(dest)) {
    console.error(`[scripts/test] copied browser still not executable at ${dest || localRoot}`);
    process.exit(1);
  }
  return localRoot;
}

// PW_TIMEOUT_SCALE defaults to 3 inside this wrapper: the supervisor-tests
// runner renders through SwiftShader on translated amd64 (emulated x86 on
// arm64) with an effectively single core, and at scale 1 the required suite
// measurably fails on load-timeout cases (Worker Elves job 881a7fed, check
// at 783c6df: 5 failed / 2 flaky, every failure a 60s load timeout with
// "GPU stall due to ReadPixels" logs; the identical suite passes at scale 3).
// Real machines can force scale 1 with PW_TIMEOUT_SCALE=1; the specs' own
// comments describe scale-1 budgets as the reference values. Re-tighten this
// default back to 1 once a non-emulated runner or a larger check time budget
// exists (at scale 1 the required suite fails in the emulated runner).
const browsersPath = ensureExecutableBrowser();
const pwEnv = {
  PLAYWRIGHT_BROWSERS_PATH: browsersPath,
  PW_TIMEOUT_SCALE: process.env.PW_TIMEOUT_SCALE || '3',
};

let pwRun = run('npx', ['playwright', 'test'], pwEnv);
process.exit(pwRun.status || 0);
