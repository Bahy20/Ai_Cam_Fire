import {backup} from 'node:sqlite';
import {mkdir,cp,rename,stat,copyFile,rm} from 'node:fs/promises';
import {join} from 'node:path';

async function exists(path){try{await stat(path);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}

// Caller serializes snapshots. SQLite's backup API includes committed WAL rows.
export async function snapshotStore(store,destination) {
  await mkdir(destination,{recursive:true});
  const temporary=join(destination,'fireguard.next.sqlite');
  await rm(temporary,{force:true});
  await backup(store.db,temporary);
  if(store.evidenceDir && await exists(store.evidenceDir))
    await cp(store.evidenceDir,join(destination,'evidence'),{recursive:true,force:false,errorOnExist:false});
  await rename(temporary,join(destination,'fireguard.sqlite'));
}

export async function restoreStore(source,destination) {
  await mkdir(destination,{recursive:true});
  const saved=join(source,'fireguard.sqlite');
  if(!await exists(saved))return false;
  if(await exists(join(destination,'fireguard.sqlite')))throw new Error('restore_destination_not_empty');
  await copyFile(saved,join(destination,'fireguard.sqlite'));
  if(await exists(join(source,'evidence')))await cp(join(source,'evidence'),join(destination,'evidence'),{recursive:true});
  return true;
}
