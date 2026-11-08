'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { URL } = require('node:url');

function readConfig(root) {
  // FIX: launcher.cjs writes a transient config to KILO_PROXY_CONFIG when the
  // user passes --proxy or --no-proxy. Fall back to proxy/config.json.
  const file = process.env.KILO_PROXY_CONFIG && fs.existsSync(process.env.KILO_PROXY_CONFIG)
    ? process.env.KILO_PROXY_CONFIG
    : path.join(root, 'proxy', 'config.json');
  if (!fs.existsSync(file)) return { enabled: false, tor: { enabled: false } };
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.tor = cfg.tor || { enabled: false };
  const torOn = cfg.tor.enabled === true;
  const enabled = cfg.enabled === true || torOn;
  if (!enabled) return { ...cfg, enabled: false, tor: cfg.tor };
  const port = Number(cfg.port || 17890), host = cfg.listen || '127.0.0.1';
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !['127.0.0.1', '::1', 'localhost'].includes(host)) throw Error('proxy listen must be localhost and port 1024..65535');
  if (!cfg.clientAuth || !cfg.clientAuth.username || !cfg.clientAuth.password) throw Error('proxy.clientAuth username/password are required');
  if (!Array.isArray(cfg.upstreams)) throw Error('proxy.upstreams must be an array');
  for (const item of cfg.upstreams) {
    const u = new URL(item);
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(u.protocol) || !u.hostname || !u.port) throw Error('Invalid upstream URL; use http(s):// or socks5(h):// host:port');
  }
  if (!cfg.upstreams.length && !torOn) throw Error('proxy.upstreams must contain at least one upstream URL, or enable tor');
  const timeout = Number(cfg.startupTimeoutMs || 12000);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 60000) throw Error('startupTimeoutMs must be between 1000 and 60000');
  if (torOn) {
    cfg.tor.socksPort = Number(cfg.tor.socksPort || 19050);
    cfg.tor.bootstrapTimeoutMs = Number(cfg.tor.bootstrapTimeoutMs || 240000);
    if (!Number.isInteger(cfg.tor.socksPort) || cfg.tor.socksPort < 1024 || cfg.tor.socksPort > 65535 || cfg.tor.socksPort === port) throw Error('tor.socksPort must be a free port between 1024 and 65535 and differ from proxy.port');
    cfg.tor.exclusive = cfg.tor.exclusive !== false;
    if (!Array.isArray(cfg.tor.bridges)) cfg.tor.bridges = [];
    if (cfg.tor.bridgeFeedUrl && new URL(cfg.tor.bridgeFeedUrl).protocol !== 'https:') throw Error('tor.bridgeFeedUrl must use HTTPS');
  }
  return { ...cfg, enabled, listen: host, port, startupTimeoutMs: timeout };
}
function waitForPort(host, port, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const s = net.connect({ host, port }); let done = false;
      s.setTimeout(700);
      s.once('connect', () => { done = true; s.destroy(); resolve(); });
      const retry = () => { if (done) return; s.destroy(); if (Date.now() - start >= timeoutMs) return reject(Error(`listener did not become ready at ${host}:${port}`)); setTimeout(attempt, 200); };
      s.once('error', retry); s.once('timeout', retry);
    };
    attempt();
  });
}
function quote(value) { return `"${String(value).replace(/\\/g, '/').replace(/"/g, '\\"')}"`; }
// FIX: accept bridge lines both with and without the leading 'Bridge ' prefix.
// Public feeds (scriptzteam/Tor-Bridges-Collector, etc.) publish lines as
// 'obfs4 IP:port FINGERPRINT cert=...' (no prefix). Tor's torrc requires
// 'Bridge obfs4 IP:port ...'. Normalise here so callers always get the
// prefixed form, and keep the same validation regex as before.
function parseBridges(text) {
  const BRIDGE_LINE = /^(?:Bridge\s+)?((?:obfs4|snowflake|webtunnel|meek_lite)\s+)?(?:\[[0-9a-f:]+\]|[a-z0-9.-]+):\d+(?:\s+\S+){0,8}$/i;
  return String(text).split(/\r?\n/)
    .map(x => x.trim())
    .filter(x => x && !x.startsWith('#'))
    .filter(x => BRIDGE_LINE.test(x) && !/[\r\n]/.test(x))
    .map(x => x.startsWith('Bridge ') ? x : `Bridge ${x}`)
    .slice(0, 200);
}
async function updateBridges(root, cfg, force = false) {
  const url = cfg.tor.bridgeFeedUrl;
  const file = path.join(root, 'proxy', 'tor', 'data', 'bridge-cache.json');
  if (!url) return { lines: [], changed: false };
  let cached = { updatedAt: 0, lines: [] };
  try { cached = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (!force && Date.now() - Number(cached.updatedAt || 0) < 7 * 86400000) return { lines: parseBridges((cached.lines || []).join('\n')), changed: false };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Kilo-Tor-Bridge-Updater/1.0', 'Accept': 'text/plain' } });
    if (!res.ok) throw Error(`bridge feed HTTP ${res.status}`);
    const body = await res.text();
    if (body.length > 5 * 1024 * 1024) throw Error('bridge feed exceeds 5 MiB'); // FIX: feeds like scriptzteam publish ~7000 bridges (~1.2 MiB); allow up to 5 MiB for safety
    const lines = parseBridges(body);
    if (!lines.length) throw Error('bridge feed contains no supported Bridge lines');
    // FIX: deduplicate by transport+host+port+fingerprint so Tor does not
    // complain about "conflict with the already registered bridge" when the
    // same line appears multiple times in the feed (scriptzteam feed has
    // hundreds of duplicates across IP and IPv6 forms).
    const seen = new Set();
    const dedup = [];
    for (const line of lines) {
      const parts = line.replace(/^Bridge\s+/, '').split(/\s+/);
      const transport = parts[0] || '';
      const hostPort = parts[1] || '';
      const fingerprint = parts[2] || '';
      const key = `${transport}|${hostPort}|${fingerprint}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      dedup.push(line);
    }
    // FIX: shuffle and cap to 60 — Tor's torrc accepts many bridges, but each
    // adds a TLS handshake during bootstrap. 60 keeps startup reasonable
    // while leaving plenty of failover candidates if some are censored.
    const shuffled = dedup
      .map(value => ({ value, sort: Math.random() }))
      .sort((a, b) => a.sort - b.sort)
      .map(x => x.value)
      .slice(0, 60);
    const changed = JSON.stringify(shuffled) !== JSON.stringify(cached.lines || []);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ updatedAt: Date.now(), lines: shuffled, fullCount: lines.length }, null, 2));
    fs.renameSync(tmp, file);
    console.error(`[kilo-tor] bridge feed refreshed; ${lines.length} parsed → ${shuffled.length} selected${changed ? ' (changed)' : ''}`);
    return { lines: shuffled, changed };
  } catch (e) {
    console.error(`[kilo-tor] bridge refresh skipped: ${e.message}; keeping last known list`);
    return { lines: parseBridges((cached.lines || []).join('\n')), changed: false };
  }
}

// FIX: bootstrap-aware restart. When Tor fails to bootstrap within its
// timeout (or exits early), the most common cause is that the cached
// bridge list contains dead/censored entries. This helper forces a
// fresh fetch (ignoring the 7-day cache) and restarts Tor with the new
// list. Caller passes the current tor object so we can kill the old
// child cleanly before starting a new one.
async function restartTorWithFreshBridges(root, cfg, tor) {
  if (!cfg.tor || !cfg.tor.enabled) return tor;
  console.error('[kilo-tor] bootstrap failed — forcing bridge refresh and retry');
  // Stop the old Tor child.
  if (tor && tor.child && !tor.child.killed) {
    try { tor.child.kill(); } catch {}
    try { await new Promise(resolve => tor.child.once('exit', resolve)); } catch {}
  }
  // Force a fresh fetch (cache ignored).
  const upd = await updateBridges(root, cfg, true);
  const next = startTor(root, cfg, upd.lines);
  await next.ready;
  await waitForPort('127.0.0.1', cfg.tor.socksPort, 10000);
  console.error(`[kilo-tor] retry ready with ${upd.lines.length} bridges`);
  return next;
}
function writeTorrc(root, cfg, bridges) {
  const dir = path.join(root, 'proxy', 'tor');
  const data = path.join(dir, 'data');
  const exe = path.join(dir, 'tor', 'tor.exe');
  const lyrebird = path.join(dir, 'tor', 'pluggable_transports', 'lyrebird.exe');
  const conjure = path.join(dir, 'tor', 'pluggable_transports', 'conjure-client.exe');
  if (!fs.existsSync(exe)) throw Error('Bundled Tor binary is missing: proxy/tor/tor/tor.exe');
  fs.mkdirSync(data, { recursive: true });
  const lines = [
    `DataDirectory ${quote(data)}`,
    `SocksPort 127.0.0.1:${cfg.tor.socksPort}`,
    'SocksPolicy accept 127.0.0.1',
    'ClientOnly 1',
    'AvoidDiskWrites 1',
    'SafeLogging 1',
    'Log notice stdout',
    `GeoIPFile ${quote(path.join(data, 'geoip'))}`,
    `GeoIPv6File ${quote(path.join(data, 'geoip6'))}`
  ];
  if (fs.existsSync(lyrebird)) lines.push(`ClientTransportPlugin obfs4,snowflake,webtunnel exec ${quote(lyrebird)}`);
  if (fs.existsSync(conjure)) lines.push(`ClientTransportPlugin conjure exec ${quote(conjure)}`);
  const all = [...(cfg.tor.bridges || []), ...bridges].map(x => String(x).trim()).filter(x => /^Bridge\s+(?:(?:obfs4|snowflake|webtunnel)\s+)?(?:\[[0-9a-f:]+\]|[a-z0-9.-]+):\d+(?:\s+\S+)?(?:\s+\S+)*$/i.test(x) && !/[\r\n]/.test(x));
  const unique = [...new Set(all)];
  if (unique.length) { lines.push('UseBridges 1', ...unique); }
  else lines.push('UseBridges 0');
  const file = path.join(dir, 'torrc.generated');
  fs.writeFileSync(file, `${lines.join('\r\n')}\r\n`);
  return { exe, file, dir };
}
function startTor(root, cfg, bridges) {
  const info = writeTorrc(root, cfg, bridges);
  const child = spawn(info.exe, ['-f', info.file], { cwd: info.dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', spawnError = null;
  const observe = chunk => {
    const value = chunk.toString();
    if (/Bootstrapped 100%/.test(value)) output += '\nBOOTSTRAPPED\n';
    const matches = value.match(/\[(?:notice|warn|err)\][^\r\n]*/gi) || [];
    for (const line of matches) console.error(`[kilo-tor] ${line.slice(0, 400)}`);
  };
  child.stdout.on('data', observe); child.stderr.on('data', observe);
  child.once('error', e => { spawnError = e; console.error(`[kilo-tor] process error: ${e.message}`); });
  const ready = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(); };
    const timer = setTimeout(() => finish(Error('Tor bootstrap timed out')), cfg.tor.bootstrapTimeoutMs);
    const poll = () => {
      if (spawnError) return finish(spawnError);
      if (child.exitCode !== null || child.signalCode !== null) return finish(Error(`Tor exited before bootstrap (code=${child.exitCode}, signal=${child.signalCode})`));
      if (output.includes('BOOTSTRAPPED')) return finish();
      setTimeout(poll, 250);
    };
    poll();
  });
  return { child, ready, info };
}
async function start(root) {
  const cfg = readConfig(root);
  if (!cfg.enabled) return { cfg, child: null, torChild: null };
  let tor = null, timer = null, child = null;
  try {
    let bridges = [];
    if (cfg.tor.enabled) {
      const update = await updateBridges(root, cfg);
      bridges = update.lines;
      tor = startTor(root, cfg, bridges);
      // FIX: on bootstrap failure, force-refresh bridges and retry once.
      // If the retry also fails, the original error propagates to the caller
      // (launcher.cjs prints it and exits with code 78).
      try {
        await tor.ready;
        await waitForPort('127.0.0.1', cfg.tor.socksPort, 10000);
      } catch (bootstrapErr) {
        console.error(`[kilo-tor] first bootstrap failed (${bootstrapErr.message}); will retry with fresh bridges once`);
        try {
          tor = await restartTorWithFreshBridges(root, cfg, tor);
        } catch (retryErr) {
          console.error(`[kilo-tor] retry also failed: ${retryErr.message}`);
          throw retryErr;
        }
      }
      console.error(`[kilo-tor] ready at 127.0.0.1:${cfg.tor.socksPort}`);
    }
    const torUpstream = `socks5h://127.0.0.1:${cfg.tor.socksPort}`;
    const upstreams = cfg.tor.enabled && cfg.tor.exclusive ? [torUpstream] : [...cfg.upstreams, ...(cfg.tor.enabled ? [torUpstream] : [])];
    const env = { ...process.env, KILO_PROXY_UPSTREAMS: JSON.stringify(upstreams) };
    child = spawn(process.execPath, [path.join(root, 'proxy', 'server.cjs')], { cwd: root, env, stdio: 'ignore', windowsHide: true });
    child.once('error', e => console.error(`[kilo-proxy] ${e.message}`));
    try { await waitForPort(cfg.listen, cfg.port, cfg.startupTimeoutMs); }
    catch (e) { if (!child.killed) child.kill(); throw e; }
    const proxyUrl = `http://${encodeURIComponent(cfg.clientAuth.username)}:${encodeURIComponent(cfg.clientAuth.password)}@${cfg.listen}:${cfg.port}`;
    process.env.HTTP_PROXY = proxyUrl; process.env.HTTPS_PROXY = proxyUrl; process.env.http_proxy = proxyUrl; process.env.https_proxy = proxyUrl;
    process.env.NODE_USE_ENV_PROXY = '1'; process.env.NO_PROXY = cfg.noProxy || 'localhost,127.0.0.1,::1'; process.env.no_proxy = process.env.NO_PROXY;
    console.error(`[kilo-proxy] local pool ready at ${cfg.listen}:${cfg.port}; upstream count=${upstreams.length}; tor=${cfg.tor.enabled ? 'enabled' : 'disabled'}`);
    if (cfg.tor.enabled && cfg.tor.bridgeFeedUrl) {
      let activeBridges = bridges;
      timer = setInterval(async () => {
        try {
          const upd = await updateBridges(root, cfg);
          if (!upd.changed || !tor) return;
          console.error('[kilo-tor] bridge list changed; restarting Tor to apply the weekly update');
          const old = tor.child;
          if (old && !old.killed) { old.kill(); await new Promise(resolve => old.once('exit', resolve)); }
          const next = startTor(root, cfg, upd.lines);
          try {
            await next.ready;
            await waitForPort('127.0.0.1', cfg.tor.socksPort, 10000);
            tor = next; activeBridges = upd.lines;
            console.error('[kilo-tor] weekly bridge update applied; Tor is ready');
          } catch (err) {
            if (!next.child.killed) next.child.kill();
            console.error(`[kilo-tor] updated bridge list failed; restoring previous list: ${err.message}`);
            tor = startTor(root, cfg, activeBridges);
            await tor.ready;
            await waitForPort('127.0.0.1', cfg.tor.socksPort, 10000);
          }
        } catch (err) { console.error(`[kilo-tor] scheduled bridge refresh failed: ${err.message}`); }
      }, 6 * 60 * 60 * 1000);
      timer.unref();
    }
    return { cfg, child, torChild: tor && tor.child, timer, stopTor: () => { if (tor && tor.child && !tor.child.killed) tor.child.kill(); } };
  } catch (e) {
    if (child && !child.killed) child.kill();
    if (tor && tor.child && !tor.child.killed) tor.child.kill();
    throw e;
  }
}
module.exports = { readConfig, waitForPort, start, parseBridges, updateBridges, restartTorWithFreshBridges };
