export const MAX_MESSAGE=2*1024*1024;
export function encodeFrame(meta,jpeg) {
  const header=Buffer.from(JSON.stringify(meta));const size=Buffer.alloc(4);size.writeUInt32BE(header.length);
  return Buffer.concat([size,header,jpeg]);
}
export function decodeFrame(bytes) {
  const data=Buffer.from(bytes);
  if(data.length<8 || data.length>MAX_MESSAGE)throw new Error('frame_size');
  const n=data.readUInt32BE();if(n<2 || n>4096 || n+8>data.length)throw new Error('frame_header');
  let meta;try{meta=JSON.parse(data.subarray(4,4+n).toString('utf8'));}catch{throw new Error('frame_metadata');}
  if(!meta || Object.keys(meta).sort().join(',')!=='sequence,session_id,ts_ms' ||
     typeof meta.session_id!=='string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(meta.session_id) ||
     !Number.isSafeInteger(meta.sequence) || meta.sequence<1 || !Number.isSafeInteger(meta.ts_ms) || meta.ts_ms<0)
    throw new Error('frame_metadata');
  const jpeg=data.subarray(4+n);
  if(jpeg[0]!==255 || jpeg[1]!==216 || jpeg.at(-2)!==255 || jpeg.at(-1)!==217)throw new Error('frame_jpeg');
  return {...meta,jpeg};
}
