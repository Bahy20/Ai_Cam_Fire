import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';

const cookieName='__Host-fireguard-test';
const equal=(a,b)=>{const x=Buffer.from(a??''),y=Buffer.from(b??'');return x.length===y.length&&timingSafeEqual(x,y);};
// Incorrect codes allowed per fixed one-minute window: per client, plus a global backstop against many-address guessing.
const windowMs=60000,clientLimit=20,globalLimit=200,maxClients=10000;
export function testerAccess(app,{code,secret,origin,trustProxy=false,now=Date.now}){
  if(!code)return null;
  if(!origin||new URL(origin).protocol!=='https:')throw new Error('TESTER_PUBLIC_ORIGIN must be HTTPS');
  origin=new URL(origin).origin; // A trailing slash or path in the setting must not break the exact Origin match.
  const sign=body=>createHmac('sha256',secret).update(code+'\n'+body).digest('base64url');
  const read=request=>{
    const value=(request.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);
    if(!value||value.length>200)return null;
    const [id,expires,mac,...rest]=value.split('.');
    if(rest.length||!id||!/^[a-f0-9-]{36}$/.test(id)||!/^\d+$/.test(expires??'')||Number(expires)<=now()||!equal(mac,sign(id+'.'+expires)))return null;
    return {id,expires:Number(expires)};
  };
  const sameOrigin=request=>request.headers.origin===origin;
  // Behind a proxy (trustProxy) the client is the last X-Forwarded-For entry, the one the proxy appended; earlier
  // entries are client-supplied and would let anyone dodge the limit. It is length-capped, and the global ceiling
  // still bounds guessing if the proxy passes the header through unchanged.
  const clientOf=request=>trustProxy&&String(request.headers['x-forwarded-for']??'').split(',').at(-1).trim().slice(0,64)||request.ip;
  // Entries are appended with their window start and never refreshed in place, so Map order is start order:
  // expiry and the size cap both evict from the front.
  const failures=new Map();let globalFailures=0,globalStart=now();
  const limited=(client,t)=>{
    if(t-globalStart>=windowMs){globalStart=t;globalFailures=0;}
    for(const [key,entry] of failures){if(t-entry.start<windowMs)break;failures.delete(key);}
    if(t-(failures.get(client)?.start??t)>=windowMs)failures.delete(client); // Missed above only if the clock stepped back.
    return globalFailures>=globalLimit||(failures.get(client)?.count??0)>=clientLimit;
  };
  const fail=(client,t)=>{
    globalFailures++;let entry=failures.get(client);
    if(!entry){if(failures.size>=maxClients)failures.delete(failures.keys().next().value);failures.set(client,entry={start:t,count:0});}
    entry.count++;
  };
  const publicPaths=new Set(['/testing','/testing.js','/testing/login','/testing/session','/testing/logout']);
  const headers=reply=>reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff').header('X-Frame-Options','DENY');
  app.get('/testing',async(request,reply)=>headers(reply).header('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${origin.replace('https:','wss:')}; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'`)
    .header('Permissions-Policy','camera=(self), microphone=()').type('text/html').send(readFileSync(new URL('./public/testing.html',import.meta.url),'utf8')));
  app.get('/testing.js',async(request,reply)=>headers(reply).type('application/javascript').send(readFileSync(new URL('./public/testing.js',import.meta.url),'utf8')));
  app.post('/testing/login',{bodyLimit:4096},async(request,reply)=>{
    headers(reply);
    if(!sameOrigin(request))return reply.code(403).send({error:'same_origin_required'});
    const t=now(),client=clientOf(request);
    if(limited(client,t))return reply.code(429).send({error:'Too many incorrect codes. Try again in a minute.'});
    if(typeof request.body?.code!=='string'||!equal(request.body.code,code)){fail(client,t);return reply.code(401).send({error:'Incorrect tester code.'});}
    const existing=read(request),id=existing?.id??randomUUID(),expires=now()+24*60*60*1000,body=id+'.'+expires;
    return reply.header('Set-Cookie',`${cookieName}=${body}.${sign(body)}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=86400`).send({ok:true});
  });
  app.get('/testing/session',async(request,reply)=>{
    headers(reply);const session=read(request);return session?session:reply.code(401).send({error:'Sign in with the tester code.'});
  });
  app.post('/testing/logout',async(request,reply)=>{
    if(!sameOrigin(request))return reply.code(403).send({error:'same_origin_required'});
    return headers(reply).header('Set-Cookie',`${cookieName}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`).send({ok:true});
  });
  return {read,sameOrigin,isPublic:request=>publicPaths.has(request.url.split('?')[0])};
}
