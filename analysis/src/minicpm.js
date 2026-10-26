import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export const MINICPM_MODEL='openbmb/MiniCPM-o-4_5';
export const MINICPM_REVISION='d59117d19ddb8a28a62f1b5f4e3b34ac48d510a4';
const root=fileURLToPath(new URL('../../',import.meta.url));
const presence=new Set(['present','not_observed','uncertain']);
const relations=new Set(['at_tool_tip','separate','not_observed','uncertain']);
const keys=['frame_id','flame','smoke','burning_material','lighter','flame_relation','occlusion','description'].sort().join(',');
const invalid=()=>{throw new Error('minicpm_invalid_response');};

export function toInvestigation(value,frames){
  if(!value || Object.keys(value).join(',')!=='frames' || !Array.isArray(value.frames) || value.frames.length!==frames.length ||
    !frames.length || frames.length>3 || new Set(frames.map(f=>f.frame_id)).size!==frames.length)invalid();
  const observations=[],tool_assertions=[];
  for(let i=0;i<frames.length;i++){
    const row=value.frames[i];
    if(!row || Object.keys(row).sort().join(',')!==keys || row.frame_id!==frames[i].frame_id ||
      !['flame','smoke','burning_material','lighter','occlusion'].every(k=>presence.has(row[k])) || !relations.has(row.flame_relation) ||
      typeof row.description!=='string' || !row.description.trim() || [...row.description].length>300)invalid();
    if(row.flame_relation==='at_tool_tip' && (row.lighter!=='present' || row.flame!=='present') ||
       row.flame_relation==='separate' && row.flame!=='present')invalid();
    const kind=row.burning_material==='present'?'material_burning':row.smoke==='present'?'smoke_visible':
      row.flame==='present'?(row.lighter==='present' && row.flame_relation==='at_tool_tip'?'flame_at_tool':'flame_visible'):'unknown';
    observations.push({frame_ids:[row.frame_id],kind,description:row.description});
    if(row.flame==='present' && row.lighter==='present' && row.flame_relation==='at_tool_tip')tool_assertions.push({
      frame_id:row.frame_id,candidate_id:null,tool_type:'lighter',flame_relation:'at_tool_tip',
      secondary_burning:row.burning_material,smoke:row.smoke,occlusion:row.occlusion});
  }
  return {contract_version:3,observations,tool_assertions,scene_assertions:[],
    hypothesis:{ignition_source:'unknown',ignition_tool:'unknown',fuel_type:'unknown',confidence:'low',action_frame_ids:[],ignition_frame_id:null}};
}

export class MiniCPM {
  constructor({requestImpl,python=process.env.FIREGUARD_PYTHON??resolve(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python')}={}){
    Object.assign(this,{requestImpl,python});this.model=MINICPM_MODEL;this.source='modal';this.sceneOnly=true;
    this.tail=Promise.resolve();this.shutdown=new AbortController();this.child=null;this.pending=null;this.nextId=0;
  }
  get configured(){return !this.shutdown.signal.aborted;}
  close(){this.shutdown.abort(new Error('minicpm_stopped'));this.child?.kill();}
  request(args,{signal}){
    if(this.requestImpl)return this.requestImpl(args,{signal});
    if(!this.child){
      const child=this.child=spawn(this.python,[resolve(root,'analysis/minicpm_client.py')],{cwd:root,stdio:['pipe','pipe','pipe'],windowsHide:true});
      const fail=()=>{if(this.child!==child)return;this.pending?.reject(new Error('minicpm_bridge_unavailable'));this.pending=null;this.child=null;};
      this.child.on('error',fail);this.child.on('exit',fail);this.child.stdin.on('error',fail);
      this.child.stderr.resume();
      createInterface({input:this.child.stdout}).on('line',line=>{
        if(this.child!==child)return;
        const p=this.pending;if(!p)return;
        try{if(line.length>256*1024)throw new Error();const value=JSON.parse(line);if(value.id!==p.id)return;
          value.error?p.reject(new Error(value.error)):p.resolve(value.result);
        }catch{p.reject(new Error('minicpm_bridge_protocol_error'));}
      });
    }
    return new Promise((resolve,reject)=>{
      const id=++this.nextId;
      const abort=()=>{const child=this.child;this.child=null;child?.kill();finish(reject,new Error(this.shutdown.signal.aborted?'minicpm_stopped':signal.reason?.message==='minicpm_job_superseded'?'minicpm_job_superseded':'minicpm_timeout'));};
      const finish=(fn,value)=>{signal.removeEventListener('abort',abort);if(this.pending?.id===id)this.pending=null;fn(value);};
      this.pending={id,resolve:v=>finish(resolve,v),reject:e=>finish(reject,e)};
      signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted){abort();return;}
      this.child.stdin.write(JSON.stringify({id,...args})+'\n');
    });
  }
  warmup(){return this.request({op:'warmup',timeout_ms:175000},{signal:AbortSignal.any([this.shutdown.signal,AbortSignal.timeout(180000)])});}
  analyze(frames,{shouldRun=()=>true,timeout=30000}={}){
    const call=this.tail.then(async()=>{
      if(this.shutdown.signal.aborted)throw new Error('minicpm_stopped');
      if(!shouldRun())throw new Error('minicpm_job_superseded');
      const started=Date.now();
      const superseded=new AbortController();
      const watch=setInterval(()=>{if(!shouldRun())superseded.abort(new Error('minicpm_job_superseded'));},100);
      let result;
      try{result=await this.request({op:'analyze',timeout_ms:Math.max(1000,timeout-1000),frames:frames.map(({frame_id,image_b64})=>({frame_id,image_b64}))},
        {signal:AbortSignal.any([this.shutdown.signal,superseded.signal,AbortSignal.timeout(timeout)])});}
      finally{clearInterval(watch);}
      if(result.validation_error){const error=new Error('minicpm_invalid_response');error.raw=result.raw;throw error;}
      return {raw:toInvestigation(result.assessment,frames),assessment:result.assessment,provider_raw:result.raw,usage:result.usage??null,
        model:MINICPM_MODEL,revision:MINICPM_REVISION,source:'modal',mode:'fresh',elapsed_ms:Date.now()-started};
    });
    this.tail=call.catch(()=>{});return call;
  }
}
