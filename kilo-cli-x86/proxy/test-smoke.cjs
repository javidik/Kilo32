'use strict';
const net=require('node:net'),fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'), config=path.join(__dirname,'config.json');
const original=fs.readFileSync(config,'utf8');
const listen=(server)=>new Promise(r=>server.listen(0,'127.0.0.1',()=>r(server.address().port)));
(async()=>{
 const upstream=net.createServer(client=>{let b=Buffer.alloc(0),stage=0;client.on('data',d=>{b=Buffer.concat([b,d]);if(stage===0&&b.length>=3){if(b[0]!==5||b[1]!==1) return client.destroy();client.write(Buffer.from([5,0]));b=b.subarray(3);stage=1;}if(stage===1&&b.length>=7){const atyp=b[3];let n=atyp===1?4:atyp===4?16:1+b[4];const total=4+n+2;if(b.length<total)return;client.write(Buffer.from([5,0,0,1,127,0,0,1,0,80]));b=b.subarray(total);stage=2;if(b.length)client.unshift(b);}});});
 const upPort=await listen(upstream);const poolPort=17891;
 fs.writeFileSync(config,JSON.stringify({enabled:true,listen:'127.0.0.1',port:poolPort,clientAuth:{username:'smoke',password:'testpass'},upstreams:[`socks5h://127.0.0.1:${upPort}`],startupTimeoutMs:5000,connectTimeoutMs:3000}));
 const child=spawn(process.execPath,[path.join(__dirname,'server.cjs')],{stdio:'ignore'});
 try{
  await new Promise((resolve,reject)=>{let n=0;const t=setInterval(()=>{const s=net.connect(poolPort,'127.0.0.1',()=>{clearInterval(t);s.destroy();resolve()});s.on('error',()=>{if(++n>40){clearInterval(t);reject(Error('pool startup timeout'));}})},100)});
  const result=await new Promise((resolve,reject)=>{const c=net.connect(poolPort,'127.0.0.1',()=>c.write(`CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: Basic ${Buffer.from('smoke:testpass').toString('base64')}\r\n\r\n`));let data='';c.on('data',d=>{data+=d.toString('latin1');if(data.includes('\r\n\r\n')){c.destroy();resolve(data)}});c.on('error',reject);setTimeout(()=>reject(Error('client timeout')),4000)});
  if(!result.startsWith('HTTP/1.1 200 Connection Established'))throw Error('unexpected CONNECT result: '+result);
  console.log('Local authenticated CONNECT through SOCKS5h upstream: PASS');
  const denied=await new Promise((resolve,reject)=>{const c=net.connect(poolPort,'127.0.0.1',()=>c.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n'));let d='';c.on('data',x=>{d+=x.toString();if(d.includes('\r\n\r\n')){c.destroy();resolve(d)}});c.on('error',reject)});
  if(!denied.startsWith('HTTP/1.1 407'))throw Error('unauthenticated client was not rejected');
  console.log('Local Basic auth rejection: PASS');
 }finally{child.kill();upstream.close();fs.writeFileSync(config,original)}
})().catch(e=>{console.error(e);process.exitCode=1});
