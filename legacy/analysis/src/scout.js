import { buildInvestigationPromptV3,buildInvestigationGenerationSchemaV3 } from '../../worker/src/investigation.js';
import { LIMITS } from './priority.js';
export const SCOUT_MODEL='@cf/meta/llama-4-scout-17b-16e-instruct';
const sceneKinds=['flame_at_tool','flame_visible','material_burning','smoke_visible','unknown'];
export function scenePrompt(frames) {
  return `Inspect these ${frames.length} chronological images separately. Do not assume an object is a lighter. Return only one complete JSON object matching the supplied schema. Return exactly ${frames.length} observations: one observation for each image, in image order, with only that image's frame_id. Do not repeat or enumerate all kinds for an image.
For each image, look at the object directly below the flame and where the flame starts. In the observation description, name that visible object and explain the contact between it and the flame in 8 to 25 words. Do not use the kind name as the description. Judge every frame independently, including the last frame; a tool that remains visible must not become an unidentified flame merely because the flame is bright.
Choose the single most important VISIBLE finding per image: material_burning when separate material visibly burns; smoke_visible when smoke is visible; flame_at_tool when a handheld lighter is identifiable and its flame starts at its tip; flame_visible only when flame is visible but no identifiable tool contact or burning material is visible; unknown when none is supported or the view is unclear. Secondary burning or smoke takes precedence over a lighter. Never describe absent material as material_burning or absent smoke as smoke_visible. Never use a negative statement as a positive observation. Do not copy one image's finding to another.
For each flame_at_tool observation, add exactly one tool_assertions row with the same frame_id. Use candidate_id null, tool_type lighter, flame_relation at_tool_tip. For every tool row, assess the whole image: secondary_burning, smoke, and occlusion are present, not_observed, or uncertain. not_observed means not visible, not proven absent. If there is separate burning, smoke, or uncertainty, report it; never force a contained label. Do not create a tool row when the lighter-tip flame is not visible. scene_assertions must be empty because no fixed source zones are supplied.
hypothesis must stay {"ignition_source":"unknown","ignition_tool":"unknown","fuel_type":"unknown","confidence":"low","action_frame_ids":[],"ignition_frame_id":null}. Report only visual evidence; never output risk, urgency, safety, or instructions.
Image order and exact frame IDs: ${JSON.stringify(frames.map((f,i)=>({image_index:i+1,frame_id:f.frame_id,ts_ms:f.ts_ms})))}`;
}

export class Scout {
  constructor({accountId=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN,
    fetchImpl=fetch,timeout=LIMITS.timeout}={}) {
    Object.assign(this,{accountId,token,fetchImpl,timeout});this.tail=Promise.resolve();this.cooldownUntil=0;this.shutdown=new AbortController();
  }
  close(){this.shutdown.abort();}
  get configured(){return Boolean(this.accountId && this.token);}
  analyze(frames,{shouldRun=()=>true,purpose='cause',timeout=this.timeout}={}) {
    const call=this.tail.then(async()=>{
      if(this.shutdown.signal.aborted)throw new Error('scout_stopped');
      if(!this.configured) throw new Error('scout_credentials_missing');
      if(!shouldRun())throw new Error('scout_job_superseded');
      if(Date.now()<this.cooldownUntil)throw new Error('scout_provider_cooldown');
      const started=Date.now();
      const schema=buildInvestigationGenerationSchemaV3(frames);
      if(purpose==='scene') {
        schema.properties.observations.items.properties.kind.enum=sceneKinds;
        schema.properties.observations.minItems=frames.length;
        schema.properties.observations.maxItems=frames.length;
        schema.properties.tool_assertions.maxItems=frames.length;
      }
      const body={messages:[{role:'user',content:[{type:'text',text:purpose==='scene'?scenePrompt(frames):buildInvestigationPromptV3(frames)},
        ...frames.map(f=>({type:'image_url',image_url:{url:`data:image/jpeg;base64,${f.image_b64}`}}))]}],
        response_format:{type:'json_schema',json_schema:schema},
        max_tokens:purpose==='scene'?1024:1536,temperature:.1,stream:false};
      let response;
      try {response=await this.fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.accountId)}/ai/run/${SCOUT_MODEL}`,
        {method:'POST',headers:{Authorization:`Bearer ${this.token}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.any([AbortSignal.timeout(timeout),this.shutdown.signal])});}
      catch(e){throw new Error(this.shutdown.signal.aborted?'scout_stopped':e.name==='TimeoutError'||e.name==='AbortError'?'scout_timeout':'scout_network_error');}
      if(!response.ok) {
        this.cooldownUntil=Date.now()+60000;
        await response.body?.cancel();throw new Error(`scout_http_${response.status}`);
      }
      const reader=response.body.getReader();const chunks=[];let bytes=0;
      try {for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.length;
        if(bytes>256*1024){await reader.cancel();throw new Error('scout_response_too_large');}chunks.push(value);}}
      finally{reader.releaseLock();}
      let payload;try{payload=JSON.parse(Buffer.concat(chunks).toString());}catch{throw new Error('scout_invalid_envelope');}
      if(payload.success===false || !payload.result)throw new Error('scout_provider_failure');
      return {raw:payload.result.response??payload.result,usage:payload.result.usage??null,
        model:SCOUT_MODEL,mode:'fresh',elapsed_ms:Date.now()-started};
    });
    this.tail=call.catch(()=>{});return call;
  }
}
