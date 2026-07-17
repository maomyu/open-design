const fs=require('fs'), vm=require('vm'), path=require('path');
const encFile=process.argv[2], decodeKey=process.argv[3], outFile=process.argv[4];
const DIR=__dirname;
const wasmBytes=fs.readFileSync(path.join(DIR,'wasm_video_decode.wasm'));
let keystream=null;
global.wasm_isaac_generate=(ptr,len)=>{ keystream=Buffer.from(global.Module.HEAPU8.subarray(ptr,ptr+len)); };
global.VTS_WASM_URL='file:///w.wasm'; global.self=global; global.window=global;
global.location={href:'file:///',protocol:'file:'}; global.navigator={userAgent:'node'};
global.document={createElement:()=>({}),getElementsByTagName:()=>[],currentScript:{src:''}};
global.performance=global.performance||{now:()=>Date.now()};
global.Module={
  instantiateWasm:(imp,cb)=>{ WebAssembly.instantiate(wasmBytes,imp).then(r=>cb(r.instance,r.module)); return {}; },
  onRuntimeInitialized:()=>{
    try{
      const enc=fs.readFileSync(encFile);
      const d=new global.Module.WxIsaac64(String(decodeKey)); d.generate(131072); if(d.delete)d.delete();
      const ks=Buffer.from(keystream).reverse(); const out=Buffer.from(enc);
      const n=Math.min(131072,out.length); for(let i=0;i<n;i++) out[i]^=ks[i];
      fs.writeFileSync(outFile,out);
      console.log(JSON.stringify({ok:true,bytes:out.length,ftyp:out.slice(4,8).toString()==='ftyp'}));
    }catch(e){ console.log(JSON.stringify({error:String(e.message||e)})); }
    process.exit(0);
  }, print:()=>{},printErr:()=>{},
};
vm.runInThisContext(fs.readFileSync(path.join(DIR,'wasm_video_decode.js'),'utf8'));
setTimeout(()=>{console.log(JSON.stringify({error:'timeout'}));process.exit(1);},15000);
