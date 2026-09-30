import wasmModule from '../makima.a0d5c2ffd2859979.wasm';

const MANIFEST = {
  alloc: '_gGry', reset: '_kuez', writeByte: '_0SGL', readByte: '_4vLu',
  decryptPepper: '_iUeM', decryptEnvelope: '_kGtw', dropPepper: '_aL0s'
};

function bytesFromHex(value, name) {
  if (typeof value !== 'string' || value.length % 2 || !/^[0-9a-f]+$/i.test(value))
    throw new Error(`invalid hex field: ${name}`);
  return Uint8Array.from(value.match(/../g), x => parseInt(x, 16));
}

function int64be(value) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, BigInt(value), false);
  return out;
}

export function createWasmCrypto() {
  const instance = new WebAssembly.Instance(wasmModule, {
    env: { abort() { throw new Error('WASM abort'); } }
  });
  const e = instance.exports;

  function put(data) {
    const ptr = e[MANIFEST.alloc](data.length);
    for (let i = 0; i < data.length; i++) e[MANIFEST.writeByte](ptr, i, data[i]);
    return { ptr, len: data.length };
  }

  function get(ptr, len) {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = e[MANIFEST.readByte](ptr, i);
    return out;
  }

  return {
    reset() { e[MANIFEST.reset](); },
    dropPepper() { e[MANIFEST.dropPepper](); },

    decryptPepper({ nonce, bucket, iv, ct, tag }) {
      const a = put(bytesFromHex(nonce, 'nonce'));
      const b = put(int64be(bucket));
      const c = put(bytesFromHex(iv, 'iv'));
      const d = put(bytesFromHex(ct, 'ct'));
      const f = put(bytesFromHex(tag, 'tag'));
      const result = e[MANIFEST.decryptPepper](
        a.ptr, a.len, b.ptr, b.len, c.ptr, c.len, d.ptr, d.len, f.ptr, f.len
      );
      return e[MANIFEST.readByte](result, 0) === 0;
    },

    decryptEnvelope({ clientNonce, serverNonce, tb, requestId, iv2, wk, tag2, iv1, ct, tag1 }) {
      const a   = put(bytesFromHex(clientNonce, 'clientNonce'));
      const b   = put(bytesFromHex(serverNonce, 'serverNonce'));
      const tbp = put(int64be(tb));
      const d   = put(bytesFromHex(requestId, 'requestId'));
      const e2  = put(bytesFromHex(iv2, 'iv2'));
      const f   = put(bytesFromHex(wk, 'wk'));
      const g   = put(bytesFromHex(tag2, 'tag2'));
      const h   = put(bytesFromHex(iv1, 'iv1'));
      const i   = put(bytesFromHex(ct, 'ct'));
      const j   = put(bytesFromHex(tag1, 'tag1'));
      const out = e[MANIFEST.alloc](bytesFromHex(ct, 'ct').length);
      const length = e[MANIFEST.decryptEnvelope](
        a.ptr, a.len, b.ptr, b.len, tbp.ptr, 8, d.ptr, d.len,
        e2.ptr, e2.len, f.ptr, f.len, g.ptr, g.len,
        h.ptr, h.len, i.ptr, i.len, j.ptr, j.len, out
      );
      return length > 0 ? get(out, length) : null;
    }
  };
}