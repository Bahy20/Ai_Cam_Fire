// TLS terminates at Modal's HTTPS/WSS proxy; this entrypoint is container-only.
import {buildServer} from './server.js';
import {restoreStore,snapshotStore} from './snapshot.js';

if(!process.env.MODAL_TASK_ID)throw new Error('Modal container required');
const active=process.env.FIREGUARD_DATA_DIR??'/tmp/fireguard';
const persistent='/persist';
await restoreStore(persistent,active);
let saving=Promise.resolve(),stopping=false;
const app=await buildServer({dataDir:active,beforeStoreClose:()=>save()});
await app.fireguard.frameReader.warmup();
if(!process.env.MINICPM_NATIVE_URL)await app.fireguard.analyzer.warmup();
const save=()=>{saving=saving.then(()=>snapshotStore(app.fireguard.store,persistent));return saving;};
const timer=setInterval(()=>{void save().catch(error=>{
  console.error('Snapshot failed:',error.message);process.exit(1);
});},5000);
timer.unref();
await app.listen({host:'0.0.0.0',port:8002});
console.log('FireGuard Modal analysis ready');
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{
  if(stopping)return;stopping=true;clearInterval(timer);
  void (async()=>{
    await app.close();
  })().then(()=>process.exit(0),error=>{console.error(error.message);process.exit(1);});
});
