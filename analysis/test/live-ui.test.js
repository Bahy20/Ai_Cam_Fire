import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
test('live page distinguishes processed frames, missing reports and historical warnings',()=>{
  const elements=new Map();const get=id=>{if(!elements.has(id))elements.set(id,{textContent:'',dataset:{},setAttribute(){}});return elements.get(id);};
  const context={document:{getElementById:get,createElement:()=>({getContext:()=>({})}),addEventListener(){}},window:{addEventListener(){}},
    setInterval:()=>0,setTimeout:()=>0,clearTimeout(){},fetch:async()=>({ok:false,json:async()=>({})}),Date};
  vm.createContext(context);vm.runInContext(readFileSync(new URL('../src/public/testing.js',import.meta.url),'utf8'),context);
  context.render('live',{detection:{smoke:'not_detected',fire:'not_detected'},
    priority:{level:'unknown',label:'Review required'},incident_history:{unresolved:true,smoke_confirmed:true},
    native_stream:{state:'listening',native_chunks:20,assessment_status:'not_reporting'},view:{status:'available_for_detection'}});
  assert.match(get('live-native').textContent,/processed/);
  assert.match(get('live-warning').textContent,/previous|Previous/);
  assert.match(get('live-warning').textContent,/report/);
  context.render('live',{priority:{level:'unknown',label:'Starting live analysis'},native_stream:{state:'connecting',startup_elapsed_ms:30000,assessment_status:'starting'}});
  assert.match(get('live-native').textContent,/30s elapsed/);
  assert.match(get('live-native').textContent,/keep the camera running/);
});
test('operator review requires confirmation and keeps the evidence version the user opened',async()=>{
  const elements=new Map();const get=id=>{if(!elements.has(id))elements.set(id,{textContent:'',dataset:{},setAttribute(){},value:'',checked:false});return elements.get(id);};
  const requests=[];const context={document:{getElementById:get,createElement:()=>({getContext:()=>({})}),addEventListener(){}},window:{addEventListener(){}},
    setInterval:()=>0,setTimeout:()=>0,clearTimeout(){},Date,fetch:async(path,options)=>{requests.push({path,options});return {ok:false,json:async()=>({error:'alert_updated_review_again'})};}};
  vm.createContext(context);vm.runInContext(readFileSync(new URL('../src/public/testing.js',import.meta.url),'utf8'),context);
  const result={session_id:'session',incident_id:'incident',incident_history:{model_hazard:true,reviewable:true,latest_hazard:{ts_ms:1000,description:'Smoke reported.'}}};
  context.render('live',result);assert.equal(get('review-open').hidden,false);get('review-open').onclick();
  context.render('live',{...result,incident_history:{...result.incident_history,latest_hazard:{ts_ms:2000}}});
  get('review-reason').value='false_alarm';await get('review-form').onsubmit({preventDefault(){}});
  assert.equal(requests.filter(r=>r.path.includes('/review')).length,0,'unchecked review cannot submit');
  get('review-confirm').checked=true;await get('review-form').onsubmit({preventDefault(){}});
  const sent=requests.find(r=>r.path.includes('/review'));assert.equal(JSON.parse(sent.options.body).last_hazard_ts_ms,1000);
  assert.match(get('review-status').textContent,/new|latest|changed/i);
});
test('live labels use server times, so a skewed browser clock cannot hide a current report; error codes read as messages',()=>{
  const elements=new Map();const get=id=>{if(!elements.has(id))elements.set(id,{textContent:'',dataset:{},setAttribute(){}});return elements.get(id);};
  const serverNow=Date.now();class Skewed extends Date{static now(){return serverNow+120000;}} // browser clock two minutes ahead
  const context={document:{getElementById:get,createElement:()=>({getContext:()=>({})}),addEventListener(){}},window:{addEventListener(){}},
    setInterval:()=>0,setTimeout:()=>0,clearTimeout(){},fetch:async()=>({ok:false,json:async()=>({})}),Date:Skewed};
  vm.createContext(context);vm.runInContext(readFileSync(new URL('../src/public/testing.js',import.meta.url),'utf8'),context);
  context.render('live',{emitted_at_ms:serverNow,priority:{level:'unknown'},native_stream:{state:'listening',assessment_status:'current',assessment_ts_ms:serverNow-1000,
    assessment:{flame:'present',smoke:'not_observed',burning_material:'not_observed',description:'A lighter flame.'}}});
  assert.match(get('live-native').textContent,/Flame: observed; smoke: not observed/);
  const describe=code=>vm.runInContext(`describe(${JSON.stringify(code)})`,context);
  assert.match(describe('video_too_large'),/250 MiB/);assert.match(describe('video_store_failed'),/could not save/);
  assert.match(describe('invalid_jpeg_or_dimensions'),/could not be read/);assert.match(describe('frame_reader_exited'),/Frame checking/);
  assert.equal(describe('some_new_code'),'some_new_code');
});
