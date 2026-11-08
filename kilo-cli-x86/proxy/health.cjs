'use strict';
const path = require('node:path');
const { readConfig, waitForPort } = require('./manager.cjs');
(async () => {
  const cfg = readConfig(path.resolve(__dirname, '..'));
  if (!cfg.enabled) { console.log('Proxy adapter: disabled (default)'); return; }
  await waitForPort(cfg.parsedUrl.hostname, cfg.parsedUrl.port, cfg.startupTimeoutMs);
  console.log(`Proxy adapter: reachable at ${cfg.parsedUrl.hostname}:${cfg.parsedUrl.port}`);
})().catch(e => { console.error(e.message); process.exitCode = 1; });
