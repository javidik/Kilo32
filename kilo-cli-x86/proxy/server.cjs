'use strict';
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const cfgPath = path.join(__dirname, 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const listenHost = cfg.listen || '127.0.0.1';
const listenPort = Number(cfg.port || 17890);
const auth = cfg.clientAuth || {};
if (!auth.username || !auth.password) throw new Error('proxy.clientAuth username/password are required');
const expectedAuth = 'Basic ' + Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
const upstreamList = process.env.KILO_PROXY_UPSTREAMS ? JSON.parse(process.env.KILO_PROXY_UPSTREAMS) : (cfg.upstreams || []);
const upstreams = upstreamList.map((value, i) => {
  const u = new URL(value);
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(u.protocol) || !u.hostname || !u.port) throw new Error(`Invalid upstream URL at index ${i}`);
  const user = decodeURIComponent(u.username || '');
  const pass = decodeURIComponent(u.password || '');
  const token = user || pass ? 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') : null;
  return { scheme:u.protocol.slice(0,-1), host:u.hostname, port:Number(u.port), authorization:token, failures:0, blockedUntil:0 };
});
if ((cfg.enabled || process.env.KILO_PROXY_UPSTREAMS) && !upstreams.length) throw new Error('Proxy pool is empty: add an upstream URL or enable bundled Tor');
let cursor = 0;
const cooldown = Number(cfg.cooldownSeconds || 15), maxCooldown = Number(cfg.maxCooldownSeconds || 300);
const log = (s) => console.error(`[kilo-proxy] ${s}`);
function candidates() {
  const now=Date.now(), ordered=[];
  for(let n=0;n<upstreams.length;n++) ordered.push(upstreams[(cursor+n)%upstreams.length]);
  cursor=(cursor+1)%upstreams.length;
  ordered.sort((a,b)=>Number(!a.scheme.startsWith('socks5'))-Number(!b.scheme.startsWith('socks5')));
  const ready=ordered.filter(x=>x.blockedUntil<=now);
  return ready.length?ready:ordered;
}
function failed(u, err) { u.failures++; u.blockedUntil=Date.now()+Math.min(maxCooldown,cooldown*2**(u.failures-1))*1000; log(`upstream ${u.host}:${u.port} failed (${err && err.code || err && err.message || 'error'}); cooling down`); }
function succeeded(u) { u.failures=0; u.blockedUntil=0; }
function connectSocket(host,port,secure=false) { return new Promise((resolve,reject)=>{const s=secure?tls.connect({host,port,servername:host},()=>resolve(s)):net.connect({host,port},()=>resolve(s));s.once('error',reject);s.setTimeout(Number(cfg.connectTimeoutMs||6000),()=>s.destroy(new Error('connect timeout')));}); }
function readHead(s, max=65536) { return new Promise((resolve,reject)=>{let data=Buffer.alloc(0);const onData=b=>{data=Buffer.concat([data,b]);if(data.length>max){cleanup();reject(new Error('header too large'));return;}const i=data.indexOf('\r\n\r\n');if(i>=0){cleanup();resolve([data.subarray(0,i+4),data.subarray(i+4)]);}};const onErr=e=>{cleanup();reject(e)};const cleanup=()=>{s.removeListener('data',onData);s.removeListener('error',onErr);};s.on('data',onData);s.once('error',onErr);}); }
function socksConnect(s,host,port) { return new Promise((resolve,reject)=>{let stage=0,buf=Buffer.alloc(0);const cleanup=()=>{s.removeListener('data',onData);s.removeListener('error',onErr)};const onErr=e=>{cleanup();reject(e)};const onData=d=>{buf=Buffer.concat([buf,d]);try{if(stage===0){if(buf.length<2)return;if(buf[0]!==5||buf[1]!==0)throw Error('SOCKS5 no-auth method rejected');buf=buf.subarray(2);let addr;const ip=net.isIP(host);if(ip===4)addr=Buffer.concat([Buffer.from([1]),Buffer.from(host.split('.').map(Number))]);else if(ip===6){const words=host.split(':');const expanded=[];for(let i=0;i<words.length;i++){if(words[i]===''){const missing=8-(words.filter(Boolean).length);expanded.push(...Array(missing).fill('0'));}else expanded.push(words[i]);}addr=Buffer.concat([Buffer.from([4]),...expanded.slice(0,8).map(w=>{const n=parseInt(w||'0',16);return Buffer.from([n>>8,n&255]);})]);}else{const h=Buffer.from(host);if(h.length>255)throw Error('hostname too long');addr=Buffer.concat([Buffer.from([3,h.length]),h]);}s.write(Buffer.concat([Buffer.from([5,1,0]),addr,Buffer.from([port>>8,port&255])]));stage=1;}if(stage===1){if(buf.length<5)return; if(buf[0]!==5||buf[1]!==0)throw Error('SOCKS5 connect rejected');let need=buf[3]===1?4:buf[3]===4?16:buf[3]===3?1+buf[4]:0;if(!need)throw Error('invalid SOCKS5 address type');const total=4+need+2;if(buf.length<total)return;cleanup();s.setTimeout(0);resolve(buf.subarray(total));}}catch(e){cleanup();reject(e)}};s.on('data',onData);s.once('error',onErr);s.write(Buffer.from([5,1,0]));}); }
async function upstreamTunnel(u,host,port) { let s=await connectSocket(u.host,u.port,u.scheme==='https'); if(u.scheme.startsWith('socks5')){const extra=await socksConnect(s,host,port);return {s,extra};} const target=`${host.includes(':')?'['+host+']':host}:${port}`;const lines=[`CONNECT ${target} HTTP/1.1`,`Host: ${target}`,'Proxy-Connection: Keep-Alive'];if(u.authorization)lines.push(`Proxy-Authorization: ${u.authorization}`);s.write(lines.join('\r\n')+'\r\n\r\n');const [head,extra]=await readHead(s);const status=Number((head.toString('latin1').split('\r\n')[0].split(' ')[1]));if(status<200||status>=300)throw Error(`upstream CONNECT status ${status}`);s.setTimeout(0);return {s,extra}; }
function relay(a,b,initial=Buffer.alloc(0)){a.setTimeout(0);b.setTimeout(0);if(initial.length)b.write(initial);a.pipe(b);b.pipe(a);const close=()=>{a.destroy();b.destroy()};a.on('error',close);b.on('error',close);a.on('close',()=>b.destroy());b.on('close',()=>a.destroy());}
function parseTarget(req){const [method,target]=req.split(' ');if(method.toUpperCase()==='CONNECT'){const i=target.lastIndexOf(':');if(i<1)throw Error('invalid CONNECT target');return [method,target.slice(0,i).replace(/^\[|\]$/g,''),Number(target.slice(i+1)),true];}const u=new URL(target);return [method,u.hostname,Number(u.port||(u.protocol==='https:'?443:80)),false];}
async function handle(client){client.setTimeout(Number(cfg.clientTimeoutMs||30000));let head,initialData;try{[head,initialData]=await readHead(client);}catch(e){client.destroy();return;}const lines=head.toString('latin1').split('\r\n');const request=lines.shift();const headers=lines.filter(Boolean);const supplied=headers.find(x=>/^proxy-authorization:/i.test(x));const got=supplied?supplied.slice(supplied.indexOf(':')+1).trim():'';if(got.length!==expectedAuth.length||!crypto.timingSafeEqual(Buffer.from(got),Buffer.from(expectedAuth))){client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="kilo"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');return;}let method,host,port,isConnect;try{[method,host,port,isConnect]=parseTarget(request);if(!host||!Number.isInteger(port)||port<1||port>65535)throw Error('invalid target');}catch(e){client.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');return;}
const filtered=headers.filter(x=>!/^proxy-(authorization|connection):/i.test(x));
for(const u of candidates()){let remote;try{if(isConnect){const t=await upstreamTunnel(u,host,port);remote=t.s;succeeded(u);client.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: KiloProxyPool\r\n\r\n');relay(client,remote,Buffer.concat([t.extra,initialData]));log(`CONNECT served by ${u.host}:${u.port}`);return;}else{const t=await upstreamTunnel(u,host,port);remote=t.s;const parsed=new URL(request.split(' ')[1]);const pathAndQuery=parsed.pathname+parsed.search;const out=[`${method} ${pathAndQuery||'/'} HTTP/1.1`,...filtered];remote.write(out.join('\r\n')+'\r\n\r\n');if(initialData.length)remote.write(initialData);succeeded(u);if(t.extra.length)client.write(t.extra);relay(client,remote);return;}}catch(e){failed(u,e);if(remote)remote.destroy();}}
client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');}
const server=net.createServer(s=>handle(s).catch(e=>{log(`request failed: ${e.message}`);s.destroy();}));server.on('error',e=>{log(`listener error: ${e.message}`);process.exitCode=1;});server.listen(listenPort,listenHost,()=>log(`listening on ${listenHost}:${listenPort}; upstreams=${upstreams.length}`));
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>server.close(()=>process.exit(0)));
