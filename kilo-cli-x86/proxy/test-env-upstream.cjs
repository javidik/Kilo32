'use strict';
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const cfgPath = path.join(__dirname, 'config.json');
const original = fs.readFileSync(cfgPath, 'utf8');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
(async () => {
  const upstream = net.createServer(client => {
    let buf = Buffer.alloc(0), stage = 0;
    client.on('data', data => {
      buf = Buffer.concat([buf, data]);
      if (stage === 0 && buf.length >= 3) {
        if (buf[0] !== 5 || buf[1] !== 1) return client.destroy();
        client.write(Buffer.from([5, 0])); buf = buf.subarray(3); stage = 1;
      }
      if (stage === 1 && buf.length >= 7) {
        const atyp = buf[3], size = atyp === 1 ? 4 : atyp === 4 ? 16 : 1 + buf[4];
        if (buf.length < 4 + size + 2) return;
        client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
        buf = buf.subarray(4 + size + 2); stage = 2;
        if (buf.length) client.unshift(buf);
      }
    });
  });
  const upPort = await listen(upstream), poolPort = 17892;
  fs.writeFileSync(cfgPath, JSON.stringify({ enabled: false, listen: '127.0.0.1', port: poolPort, clientAuth: { username: 'envtest', password: 'testpass' }, upstreams: [] }));
  const child = spawn(process.execPath, [path.join(__dirname, 'server.cjs')], { env: { ...process.env, KILO_PROXY_UPSTREAMS: JSON.stringify([`socks5h://127.0.0.1:${upPort}`]) }, stdio: 'ignore' });
  try {
    await new Promise((resolve, reject) => {
      let tries = 0;
      const tick = setInterval(() => {
        const sock = net.connect(poolPort, '127.0.0.1', () => { clearInterval(tick); sock.destroy(); resolve(); });
        sock.on('error', () => { if (++tries > 40) { clearInterval(tick); reject(Error('pool did not start')); } });
      }, 100);
    });
    const response = await new Promise((resolve, reject) => {
      const sock = net.connect(poolPort, '127.0.0.1', () => sock.write(`CONNECT tor-route.test:443 HTTP/1.1\r\nHost: tor-route.test:443\r\nProxy-Authorization: Basic ${Buffer.from('envtest:testpass').toString('base64')}\r\n\r\n`));
      let data = '';
      sock.on('data', chunk => { data += chunk.toString('latin1'); if (data.includes('\r\n\r\n')) { sock.destroy(); resolve(data); } });
      sock.on('error', reject);
      setTimeout(() => reject(Error('CONNECT timeout')), 4000);
    });
    if (!response.startsWith('HTTP/1.1 200 Connection Established')) throw Error(`unexpected response: ${response}`);
    console.log('Runtime upstream injection (Tor SOCKS5h route) through local pool: PASS');
  } finally {
    child.kill(); upstream.close(); fs.writeFileSync(cfgPath, original);
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
