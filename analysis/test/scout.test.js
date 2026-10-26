import test from 'node:test';
import assert from 'node:assert/strict';

test('closing Scout aborts active inference and prevents queued calls',async()=>{
  let begun;const started=new Promise(resolve=>{begun=resolve;});let calls=0;
  const scout=new Scout({accountId:'account',token:'secret',fetchImpl:async(url,{signal})=>{
    calls++;begun();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }});
  const first=scout.analyze(frames),second=scout.analyze(frames);
  const settled=Promise.allSettled([first,second]);await started;
  scout.close();
  const results=await settled;
  assert.equal(calls,1);assert.ok(results.every(row=>row.status==='rejected'));
});
import { Scout } from '../src/scout.js';
const frames=[{frame_id:'frame-1',ts_ms:1,roles:['recent'],image_b64:'AQI='}];
test('direct Scout REST retains exact image schema and usage',async()=>{
  let request;
  const scout=new Scout({accountId:'account',token:'secret',fetchImpl:async(url,args)=>{
    request={url,args};return new Response(JSON.stringify({success:true,result:{response:'{"contract_version":3}',usage:{input_tokens:99}}}));
  }});
  const response=await scout.analyze(frames);
  assert.match(request.url,/accounts\/account\/ai\/run\/@cf\/meta\/llama-4-scout/);
  const body=JSON.parse(request.args.body);
  assert.equal(body.messages[0].content[1].image_url.url,'data:image/jpeg;base64,AQI=');
  assert.equal(body.response_format.type,'json_schema');assert.deepEqual(response.usage,{input_tokens:99});
  assert.equal(response.mode,'fresh');
});
test('concurrent requests serialize; rate limit is reported without retries',async()=>{
  let calls=0,active=0,max=0;
  const scout=new Scout({accountId:'account',token:'secret',fetchImpl:async()=>{
    calls++;active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,5));active--;
    return new Response('{}',{status:429});
  }});
  await Promise.allSettled([scout.analyze(frames),scout.analyze(frames)]);
  assert.equal(max,1);assert.equal(calls,1); // provider cooldown prevents a retry storm
});
test('missing credentials fail explicitly without a network request',async()=>{
  const scout=new Scout({});await assert.rejects(scout.analyze(frames),/scout_credentials_missing/);
});
test('scene refresh asks about scene evidence without the competing causal labels',async()=>{
  let body;
  const scout=new Scout({accountId:'account',token:'secret',fetchImpl:async(url,args)=>{
    body=JSON.parse(args.body);return Response.json({success:true,result:{response:'{}'}});
  }});
  await scout.analyze(frames,{purpose:'scene'});
  const allowed=body.response_format.json_schema.properties.observations.items.properties.kind.enum;
  assert.ok(allowed.includes('material_burning'));assert.ok(allowed.includes('flame_at_tool'));
  assert.ok(!allowed.includes('hand_near_fuel'));
  assert.match(body.messages[0].content[0].text,/Do not assume.*lighter/i);
  assert.ok(body.messages[0].content[0].text.length<4000);
});
test('scene refresh limits observations to the attached frames and forbids negated hazards',async()=>{
  let body;
  const scout=new Scout({accountId:'account',token:'secret',fetchImpl:async(url,args)=>{
    body=JSON.parse(args.body);return Response.json({success:true,result:{response:'{}'}});
  }});
  const sceneFrames=[0,1,2].map(i=>({frame_id:`frame-${i}`,ts_ms:i*1000,roles:['recent'],image_b64:'AQI='}));
  await scout.analyze(sceneFrames,{purpose:'scene'});
  assert.equal(body.response_format.json_schema.properties.observations.maxItems,3);
  assert.equal(body.response_format.json_schema.properties.tool_assertions.maxItems,3);
  assert.match(body.messages[0].content[0].text,/exactly 3 observations/i);
  assert.match(body.messages[0].content[0].text,/never.*absent.*material_burning/i);
  assert.match(body.messages[0].content[0].text,/object directly below the flame/i);
  assert.match(body.messages[0].content[0].text,/do not use the kind name as the description/i);
});
