'use strict';
// Kilo CLI proxy launcher.
//
// Flags recognised by this launcher (consumed BEFORE kilo-main.mjs sees its argv):
//   --proxy       Force-enable the bundled Tor proxy pool (sets proxy.enabled
//                 and proxy.tor.enabled to true in proxy/config.json at runtime).
//   --no-proxy    Force-disable the proxy pool (proxy.enabled = false), even if
//                 config.json has it enabled. Useful when the local Tor pool is
//                 not needed (e.g. on a clean network).
//   --proxy-debug Verbose Tor + proxy pool logging (KILO_LOG_LEVEL=debug + the
//                 launcher prints the chosen config).
//
// Any other arguments are forwarded to kilo-main.mjs unchanged. If neither
// --proxy nor --no-proxy is passed, the launcher uses whatever is in
// proxy/config.json (default behaviour of the original launcher).
//
// When the proxy pool is enabled, the launcher sets HTTP_PROXY / HTTPS_PROXY
// environment variables BEFORE spawning kilo-main.mjs, so every outbound HTTP
// request Kilo makes goes through the local Tor-terminated pool on
// 127.0.0.1:17890.
const path = require('node:path');
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const argv = process.argv.slice(2);

// Detect launcher-specific flags. They are removed from argv before forwarding.
const wantProxy = argv.includes('--proxy');
const wantNoProxy = argv.includes('--no-proxy');
const wantDebug = argv.includes('--proxy-debug');
const forwardArgv = argv.filter(a => a !== '--proxy' && a !== '--no-proxy' && a !== '--proxy-debug');

if (wantProxy && wantNoProxy) {
  console.error('[kilo-proxy] --proxy and --no-proxy are mutually exclusive');
  process.exitCode = 64;
  return; // unreachable in CJS top-level, but documents intent
}

const root = path.resolve(__dirname, '..');
const configPath = path.join(root, 'proxy', 'config.json');

// Apply runtime overrides on top of config.json. We load the file, flip the
// flags, and write a transient copy that manager.cjs will read. The original
// config.json is NOT modified on disk, so the user's settings are preserved.
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  console.error(`[kilo-proxy] failed to read proxy/config.json: ${e.message}`);
  process.exitCode = 65;
  return;
}

if (wantProxy) {
  cfg.enabled = true;
  cfg.tor = cfg.tor || {};
  cfg.tor.enabled = true;
  if (wantDebug) console.error('[kilo-proxy] --proxy: forcing proxy.enabled + tor.enabled = true');
} else if (wantNoProxy) {
  cfg.enabled = false;
  cfg.tor = cfg.tor || {};
  cfg.tor.enabled = false;
  if (wantDebug) console.error('[kilo-proxy] --no-proxy: forcing proxy.enabled + tor.enabled = false');
} else if (wantDebug) {
  console.error(`[kilo-proxy] config.json as-is: enabled=${cfg.enabled} tor.enabled=${cfg.tor && cfg.tor.enabled}`);
}

// If the user disabled the proxy, we can skip the pool entirely and just run
// kilo-main.mjs directly. This keeps the no-proxy path fast (no Tor bootstrap).
if (!cfg.enabled) {
  if (wantDebug) console.error('[kilo-proxy] disabled — running kilo-main.mjs directly');
  const node = process.execPath;
  const main = path.join(root, 'kilo-main.mjs');
  const child = spawn(node, ['--require', path.join(root, 'node-bun-compat.cjs'), main, ...forwardArgv], {
    cwd: process.cwd(),
    env: { ...process.env, ...(wantDebug ? { KILO_LOG_LEVEL: 'debug' } : {}) },
    stdio: 'inherit',
    windowsHide: false
  });
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => {
      if (stopping) return; stopping = true;
      if (!child.killed) child.kill(sig);
    });
  }
  child.once('error', e => { console.error(`[kilo] ${e.message}`); process.exitCode = 1; });
  child.once('exit', (code, signal) => { process.exitCode = code === null ? (signal ? 1 : 0) : code; });
  return;
}

// Proxy is enabled. Write the (possibly overridden) config to a transient
// file that manager.cjs reads, then start the pool.
const transientPath = path.join(root, 'proxy', 'config.runtime.json');
try {
  fs.writeFileSync(transientPath, JSON.stringify(cfg, null, 2));
} catch (e) {
  console.error(`[kilo-proxy] failed to write config.runtime.json: ${e.message}`);
  process.exitCode = 73;
  return;
}

// Make manager read the runtime config. The simplest approach is to set an
// environment variable; manager.cjs checks it.
process.env.KILO_PROXY_CONFIG = transientPath;

const { start } = require('./manager.cjs');

(async () => {
  let proxyChild, torChild, refreshTimer, stopTor;
  try {
    ({ child: proxyChild, torChild, timer: refreshTimer, stopTor } = await start(root));
  } catch (e) {
    console.error(`[kilo-proxy] ${e.message}`);
    // Clean up the transient config so we don't leave stale state.
    try { fs.unlinkSync(transientPath); } catch {}
    process.exitCode = 78;
    return;
  }
  const node = process.execPath;
  const main = path.join(root, 'kilo-main.mjs');
  const child = spawn(node, ['--require', path.join(root, 'node-bun-compat.cjs'), main, ...forwardArgv], {
    cwd: process.cwd(),
    env: { ...process.env, ...(wantDebug ? { KILO_LOG_LEVEL: 'debug' } : {}) },
    stdio: 'inherit',
    windowsHide: false
  });
  let stopping = false;
  const stopProxy = () => {
    if (refreshTimer) clearInterval(refreshTimer);
    if (proxyChild && !proxyChild.killed) proxyChild.kill();
    if (stopTor) stopTor();
    else if (torChild && !torChild.killed) torChild.kill();
    try { fs.unlinkSync(transientPath); } catch {}
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => {
      if (stopping) return; stopping = true;
      if (!child.killed) child.kill(sig);
      stopProxy();
    });
  }
  child.once('error', e => { console.error(`[kilo] ${e.message}`); stopProxy(); process.exitCode = 1; });
  child.once('exit', (code, signal) => {
    stopProxy();
    process.exitCode = code === null ? (signal ? 1 : 0) : code;
  });
})().catch(e => {
  console.error(`[kilo-proxy] ${e.stack || e.message}`);
  try { fs.unlinkSync(transientPath); } catch {}
  process.exitCode = 1;
});
