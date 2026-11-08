'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { readConfig, parseBridges } = require('./manager.cjs');
const root = path.resolve(__dirname, '..');
const cfg = readConfig(root);
assert.equal(cfg.enabled, true, 'published Tor build must enable the local proxy by default');
assert.equal(cfg.tor.enabled, true, 'published Tor build must enable Tor by default');
assert.equal(cfg.tor.socksPort, 19050);
assert.equal(cfg.tor.exclusive, true, 'Tor must be the exclusive default route');
assert.equal(cfg.clientAuth.password, 'SET_A_LOCAL_PASSWORD', 'no private proxy password may be shipped');
const original = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8');
try {
  fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify({ enabled: false, listen: '127.0.0.1', port: 17890, clientAuth: { username: 'test', password: 'test' }, upstreams: [], tor: { enabled: true } }));
  const torCfg = readConfig(root);
  assert.equal(torCfg.enabled, true, 'enabling Tor should enable the local pool');
  assert.equal(torCfg.tor.exclusive, true, 'Tor route should be exclusive by default');
} finally { fs.writeFileSync(path.join(__dirname, 'config.json'), original); }
const good = parseBridges([
  'Bridge obfs4 192.0.2.10:443 0123456789ABCDEF0123456789ABCDEF01234567 cert=abc iat-mode=0',
  'Bridge 198.51.100.2:9001 0123456789ABCDEF0123456789ABCDEF01234567',
  'Bridge webtunnel [2001:db8::1]:443 0123456789ABCDEF0123456789ABCDEF01234567 url=https://example.invalid/ ver=0.0.1'
].join('\n'));
assert.equal(good.length, 3, 'supported bridge formats should be accepted');
const bad = parseBridges('ExitNodes {RU}\nSocksPort 0.0.0.0:9050\nBridge obfs4 192.0.2.10:443 0123456789ABCDEF0123456789ABCDEF01234567');
assert.equal(bad.length, 1, 'only Bridge lines should be accepted');
console.log('Tor enabled defaults, local credentials, and bridge feed validation: PASS');
