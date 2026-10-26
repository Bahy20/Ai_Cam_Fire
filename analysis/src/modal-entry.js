// TLS terminates at Modal's HTTPS/WSS proxy; this entrypoint is container-only.
import {join} from 'node:path';
import {buildServer} from './server.js';
import {restoreStore,snapshotStore} from './snapshot.js';
import {snapshotScheduler,COMMIT_MARKER} from './persistence.js';

if(!process.env.MODAL_TASK_ID)throw new Error('Modal container required');
const active=process.env.FIREGUARD_DATA_DIR??'/tmp/fireguard';
const persistent='/persist';
await restoreStore(persistent,active);
let stopping=false,app;
// Alert-state changes snapshot at once and ask modal_app.py (via the marker) to commit the volume without waiting.
const snapshots=snapshotScheduler({snapshot:()=>snapshotStore(app.fireguard.store,persistent),marker:join(active,COMMIT_MARKER)});
app=await buildServer({dataDir:active,beforeStoreClose:()=>snapshots.flush(),onCriticalChange:()=>snapshots.critical()});
await app.fireguard.frameReader.warmup();
if(!process.env.MINICPM_NATIVE_URL)await app.fireguard.analyzer.warmup();
const timer=setInterval(()=>{void snapshots.tick();},5000);
timer.unref();
await app.listen({host:'0.0.0.0',port:8002});
console.log('FireGuard Modal analysis ready');
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{
  if(stopping)return;stopping=true;clearInterval(timer);
  void (async()=>{
    await app.close();
  })().then(()=>process.exit(0),error=>{console.error(error.message);process.exit(1);});
});
