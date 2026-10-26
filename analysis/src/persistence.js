import {writeFile} from 'node:fs/promises';

export const MAX_SNAPSHOT_FAILURES=5;
export const COMMIT_MARKER='commit-requested';

// Serializes store snapshots. A timer tick is skipped (not queued) while one runs; a critical request during a run
// gets exactly one follow-up. Only a run of consecutive failures stops the process, so a transient volume error
// cannot take live analysis down. After a critical save, the marker asks modal_app.py to commit the volume now; when
// that save fails, the request stays pending and the next save to succeed (tick or critical) writes the marker.
export function snapshotScheduler({snapshot,marker,exit=code=>process.exit(code),log=console.error,maxFailures=MAX_SNAPSHOT_FAILURES}) {
  let running=null,again=false,pendingCritical=false,failures=0;
  const attempt=async critical=>{
    pendingCritical||=critical; // set as the save starts, so a tick already running cannot claim a later change
    try{await snapshot();}
    catch(error){
      failures++;log(`Snapshot failed (${failures}/${maxFailures} consecutive):`,error?.message??error);
      if(failures>=maxFailures)exit(1);return;
    }
    failures=0;
    if(pendingCritical&&marker){pendingCritical=false;await writeFile(marker,'').catch(error=>log('Volume commit request failed:',error.message));}
  };
  const start=critical=>{running=attempt(critical).finally(()=>{running=null;if(again){again=false;start(true);}});return running;};
  const idle=async()=>{while(running)await running;};
  return {
    tick:()=>running?null:start(false),
    critical:()=>{if(running){again=true;return running;}return start(true);},
    idle,
    // Shutdown: wait out queued work, then one last save whose failure reaches the caller. A critical request made
    // during that save may postdate it, so it gets one more such save. No marker: modal_app.py commits after Node exits.
    async flush(){
      const final=async()=>{while(running)await running;running=Promise.resolve().then(snapshot);try{await running;}finally{running=null;}};
      await final();if(again){again=false;await final();}
    },
    get failures(){return failures;},
  };
}
