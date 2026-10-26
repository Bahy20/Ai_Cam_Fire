import {backup} from 'node:sqlite';
import {mkdir,cp,rename,stat,copyFile,rm,readdir,rmdir,utimes} from 'node:fs/promises';
import {dirname,join,relative} from 'node:path';

async function exists(path){try{await stat(path);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
const missing=e=>{if(e.code!=='ENOENT')throw e;};

// Lists files (relative path -> stat) and directories. Entries the live store evicts mid-walk are skipped.
async function walk(root,skip=()=>false,base=root,out={files:new Map(),dirs:[]}) {
  let entries;try{entries=await readdir(root,{withFileTypes:true});}catch(e){missing(e);return out;}
  await Promise.all(entries.map(async entry=>{
    const path=join(root,entry.name),name=relative(base,path);
    if(entry.isDirectory()){out.dirs.push(name);await walk(path,skip,base,out);}
    else if(entry.isFile()&&!skip(entry.name))try{out.files.set(name,await stat(path));}catch(e){missing(e);}
  }));
  return out;
}

// Copies new or resized evidence and deletes what the store has evicted. Store writes are atomic, so in-flight
// `*.tmp` files are never copied; copies here are also atomic, so an interrupted snapshot is repaired next time.
async function mirrorEvidence(source,destination) {
  const [from,to]=await Promise.all([walk(source,name=>name.endsWith('.tmp')),walk(destination)]);
  for(const [name,info] of from.files) {
    if(to.files.get(name)?.size===info.size)continue;
    const target=join(destination,name),temporary=`${target}.tmp`;
    await mkdir(dirname(target),{recursive:true});
    try{await copyFile(join(source,name),temporary);}catch(e){missing(e);continue;} // evicted since listing
    await utimes(temporary,info.atime,info.mtime).catch(()=>{}); // keeps eviction age order after restore
    await rename(temporary,target);
  }
  const kept=new Set(from.dirs),emptied=new Set(to.dirs.filter(dir=>!kept.has(dir)));
  for(const name of to.files.keys()) if(!from.files.has(name)){await rm(join(destination,name),{force:true});emptied.add(dirname(name));}
  for(const dir of [...emptied].filter(dir=>dir!=='.').sort((a,b)=>b.length-a.length))
    await rmdir(join(destination,dir)).catch(()=>{}); // only when empty
}

// Caller serializes snapshots. SQLite's backup API includes committed WAL rows.
export async function snapshotStore(store,destination) {
  await mkdir(destination,{recursive:true});
  const temporary=join(destination,'fireguard.next.sqlite');
  await rm(temporary,{force:true});
  await backup(store.db,temporary);
  if(store.evidenceDir)await mirrorEvidence(store.evidenceDir,join(destination,'evidence'));
  await rename(temporary,join(destination,'fireguard.sqlite'));
}

export async function restoreStore(source,destination) {
  await mkdir(destination,{recursive:true});
  const saved=join(source,'fireguard.sqlite');
  if(!await exists(saved))return false;
  if(await exists(join(destination,'fireguard.sqlite')))throw new Error('restore_destination_not_empty');
  await copyFile(saved,join(destination,'fireguard.sqlite'));
  if(await exists(join(source,'evidence')))await cp(join(source,'evidence'),join(destination,'evidence'),
    {recursive:true,preserveTimestamps:true,filter:path=>!path.endsWith('.tmp')});
  return true;
}
