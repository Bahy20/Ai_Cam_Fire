// Shared, runtime-independent confirmation logic. Gaps are never negatives.
export const confirmationHit = (frame, tier) => frame[tier] ?? (frame.dets ?? []).some(
  d => d.cls === 'fire' && d.conf >= (tier === 'strong' ? .25 : .08));
export const detectedFrame = frame => frame.detected ?? (frame.dets ?? []).length > 0;
export function confirmationDecision(window, alert) {
  const recent=window.slice(-12);
  const strong12=recent.filter(f=>confirmationHit(f,'strong')).length;
  const any12=recent.filter(f=>confirmationHit(f,'any')).length;
  const any24=window.filter(f=>confirmationHit(f,'any')).length;
  return {strong12,any12,any24,
    clear:window.length>=8 && window.slice(-8).every(f=>!detectedFrame(f)),
    confirm:strong12>=5 || (alert==='watch' && window.length>=24 && any24>=8),
    watch:strong12>=2 || any12>=2, idle:alert==='watch' && any12===0 && any24===0};
}
export class DetectionLifecycle {
  constructor(saved={}) { this.alert=saved.alert??'idle'; this.lastTs=null; this.window=[]; }
  gap() {this.window=[]; if(this.alert!=='confirmed') this.alert='idle';}
  accept(observation) {
    const ts=observation.ts_ms;
    if(this.lastTs!==null && ts<=this.lastTs) return {accepted:false};
    if(this.lastTs!==null && ts-this.lastTs>2000) this.gap();
    this.lastTs=ts;
    this.window.push({ts,dets:observation.detections});
    this.window=this.window.slice(-24);
    const decision=confirmationDecision(this.window,this.alert);
    let transition=null;
    if(this.alert==='confirmed') {
      if(decision.clear) {this.alert='idle';this.window=[];transition='cleared';}
    } else if(decision.confirm) {this.alert='confirmed';transition='confirmed';}
    else if(decision.watch) this.alert='watch';
    else if(decision.idle) this.alert='idle';
    return {...decision,accepted:true,transition,alert:this.alert};
  }
}
