import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {CameraDO} from '../../src/camera-do.js';
import worker from '../../src/index.js';

// Actual SQLite for both DO storage and the D1 adapter; no SQL-pattern mocks.
export function durableBackend(overrides={}) {
  const db=new DatabaseSync(':memory:'),eventDb=new DatabaseSync(':memory:');
  const migrations=new URL('../../migrations/',import.meta.url);
  for(const name of readdirSync(migrations).filter(name=>/^\d+_.+\.sql$/.test(name)).sort())
    eventDb.exec(readFileSync(new URL(name,migrations),'utf8'));
  let alarm=null,active;const jobs=[],events=[];
  const storage={sql:{exec(sql,...args){const stmt=db.prepare(sql);
    const rows=stmt.columns().length?stmt.all(...args):(stmt.run(...args),[]);return{toArray:()=>rows};}},
    transactionSync(callback){db.exec('BEGIN IMMEDIATE');try{const result=callback();db.exec('COMMIT');return result;}
      catch(error){db.exec('ROLLBACK');throw error;}},sync:async()=>{},getAlarm:async()=>alarm,setAlarm:async when=>{alarm=when;}};
  const env={APP_ENV:'development',EVIDENCE_STORAGE:'pi',DB:{prepare:sql=>({bind:(...args)=>({
    first:async()=>eventDb.prepare(sql).get(...args)??null,
    all:async()=>({results:eventDb.prepare(sql).all(...args)}),
    run:async()=>({success:true,meta:{changes:eventDb.prepare(sql).run(...args).changes}})
  }),all:async()=>({results:eventDb.prepare(sql).all()})})},...overrides};
  env.CAMERA_DO={idFromName:id=>id,get:id=>{if(id!=='cam')throw new Error('unexpected fixture camera');return{fetch:request=>active.fetch(request)};}};
  const create=()=>active=new CameraDO({storage,waitUntil:promise=>jobs.push(promise),
    getWebSockets:()=>[{send:raw=>events.push(...[JSON.parse(raw)].flat())}]},env);
  create();
  const settle=async()=>{for(let i=0;i<jobs.length;i++)await jobs[i];};
  const request=(route,{body,headers={},method=body===undefined?'GET':'POST'}={})=>worker.fetch(new Request('https://worker'+route,
    {method,headers:{'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),env,{});
  return{db,eventDb,storage,env,create,settle,request,events,camera:()=>active,close:()=>{db.close();eventDb.close();}};
}
