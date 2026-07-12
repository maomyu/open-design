// 微信视频号视频解密（用微信官方 WASM 模块生成 ISAAC-64 密钥流 → reverse → XOR 前128KB）。
// 用法: node wx_decrypt.js <加密输入文件> <decode_key> <解密输出文件>
const fs = require('fs');
const path = require('path');

const [encIn, decodeKeyStr, out] = process.argv.slice(2);
if (!encIn || !decodeKeyStr || !out) { console.error('args: <in> <decode_key> <out>'); process.exit(1); }
const vendorDir = path.join(__dirname, '..', 'vendor', 'wxdecode');
const KEYSTREAM_SIZE = 131072;

// glue 是为 Web Worker 编译的（ENVIRONMENT_IS_WORKER=true），在 Node 里伪造最小 worker 环境
globalThis.self = globalThis;
globalThis.self.location = { href: 'file://' + vendorDir + '/' };
globalThis.importScripts = function () {};
globalThis.document = undefined;
globalThis.VTS_WASM_URL = path.join(vendorDir, 'wasm_video_decode.wasm');  // 有 wasmBinary 时不实际使用

// WASM 回调：读堆上密钥流 → reverse（关键）→ 存全局
globalThis.wasm_isaac_generate = function (ptr, size) {
  const heap = globalThis.Module.HEAPU8;
  const arr = Uint8Array.from(heap.subarray(ptr, ptr + size));
  arr.reverse();
  globalThis.__keystream = Buffer.from(arr);
};

function tryKey(keyVal) {
  const d = new globalThis.Module.WxIsaac64(keyVal);
  d.generate(KEYSTREAM_SIZE);
  d.delete();
  return globalThis.__keystream;
}

globalThis.Module = {
  wasmBinary: fs.readFileSync(path.join(vendorDir, 'wasm_video_decode.wasm')),
  onRuntimeInitialized: function () {
    try {
      const enc = fs.readFileSync(encIn);
      // 先试 Number，失败再试 BigInt
      let ks, ok = false;
      for (const kv of [String(decodeKeyStr)]) {   // WxIsaac64 构造函数收 std::string
        try { ks = tryKey(kv); } catch (e) { continue; }
        const n = Math.min(KEYSTREAM_SIZE, enc.length, ks.length);
        const dec = Buffer.from(enc);
        for (let i = 0; i < n; i++) dec[i] = enc[i] ^ ks[i];
        if (dec.toString('utf8', 4, 8) === 'ftyp') {
          fs.writeFileSync(out, dec);
          console.log('OK ' + dec.length);
          ok = true; break;
        }
      }
      if (!ok) { console.error('FAIL no ftyp'); process.exit(2); }
      process.exit(0);
    } catch (e) { console.error('ERR ' + (e && e.stack || e)); process.exit(3); }
  }
};

const src = fs.readFileSync(path.join(vendorDir, 'wasm_video_decode.js'), 'utf8');
(0, eval)(src);   // 间接 eval：全局作用域运行，glue 的 var Module 会沿用我们注入的 Module
