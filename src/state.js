import { createWasmCrypto } from './wasm-crypto.js';

// ===== دوال هاش مساعدة =====
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function sha384Hex(text) {
  const buf = await crypto.subtle.digest('SHA-384', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function sha512Hex(text) {
  const buf = await crypto.subtle.digest('SHA-512', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

export class PepperState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.wasm = null;
    this.pepperReady = false;
    this.pepperExpires = 0;
    this.bootstrapNonce = null;
    this.bootstrapPromise = null;
    this.pepperPromise = null;

    this.state.blockConcurrencyWhile(async () => {
      const cached = await this.state.storage.get(['bootstrapNonce', 'pepperExpires', 'pepperReady']);
      this.bootstrapNonce = cached.get('bootstrapNonce') || null;
      this.pepperReady    = cached.get('pepperReady') || false;
      this.pepperExpires  = cached.get('pepperExpires') || 0;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const op = url.pathname.slice(1);

    try {
      if (op === 'health') {
        return Response.json({
          pepper_cached: this.pepperReady && Date.now() < this.pepperExpires,
          bootstrap_nonce: this.bootstrapNonce ? 'cached' : 'none'
        });
      }

      if (op === 'ensure') {
        await this.ensurePepper();
        return Response.json({ ok: true });
      }

      if (op === 'resolve' && request.method === 'POST') {
        const { path } = await request.json();
        const data = await this.resolvePath(path);
        return Response.json({ ok: true, data });
      }

      return new Response('not found', { status: 404 });
    } catch (error) {
      return Response.json({ ok: false, error: error.message }, { status: 502 });
    }
  }

  browserHeaders() {
    return {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/137 Safari/537.36',
      Origin: this.env.VIDUKI_ORIGIN,
      Referer: `${this.env.VIDUKI_ORIGIN}/`,
      'Accept-Language': 'en-US,en;q=0.9'
    };
  }

  async getJson(path, options = {}) {
    const base = this.env.VIDUKI_API_BASE;
    const res = await fetch(base + path, {
      ...options,
      headers: { ...this.browserHeaders(), Accept: 'application/json', ...(options.headers || {}) }
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(`upstream ${path} returned non-JSON (${res.status})`); }
    if (!res.ok) throw new Error(`upstream ${path} failed (${res.status})`);
    return data;
  }

  // ===== Altcha: يدعم SHA-256/384/512 و HMAC-SHA256 =====
  async solveAltcha(challenge) {
    const algorithm = String(challenge.algorithm || 'SHA-256').toUpperCase();
    const target    = String(challenge.challenge).toLowerCase();
    const salt      = String(challenge.salt);
    const max       = Number(challenge.maxnumber ?? 50000);
    const keyPrefix = String(challenge.keyPrefix ?? '');
    const keySuffix = String(challenge.keySuffix ?? '');
    const signature = challenge.signature || '';

    for (let number = 0; number <= max; number++) {
      const input = `${salt}${number}${keyPrefix}${keySuffix}`;
      let digest;

      if (algorithm === 'SHA-256') {
        digest = await sha256Hex(input);
      } else if (algorithm === 'SHA-384') {
        digest = await sha384Hex(input);
      } else if (algorithm === 'SHA-512') {
        digest = await sha512Hex(input);
      } else if (algorithm === 'HMAC-SHA256') {
        digest = await hmacSha256Hex(signature, input);
      } else if (algorithm === 'HMAC-SHA384') {
        // نادر لكن ممكن
        const enc = new TextEncoder();
        const key = await crypto.subtle.importKey(
          'raw', enc.encode(signature),
          { name: 'HMAC', hash: 'SHA-384' },
          false, ['sign']
        );
        const sig = await crypto.subtle.sign('HMAC', key, enc.encode(input));
        digest = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
      } else {
        throw new Error(`unsupported altcha algorithm: ${algorithm}`);
      }

      if (digest === target) {
        const payload = {
          algorithm: challenge.algorithm,
          challenge: challenge.challenge,
          number,
          salt,
          signature: challenge.signature,
          took: 0
        };
        return btoa(JSON.stringify(payload));
      }
    }

    throw new Error(`Altcha solution not found (algorithm=${algorithm}, max=${max})`);
  }

  async freshNonce() {
    if (this.bootstrapPromise) return this.bootstrapPromise;
    this.bootstrapPromise = (async () => {
      const challenge = await this.getJson('/altcha-challenge');
      const solution = await this.solveAltcha(challenge);
      const data = await this.getJson('/bootstrap', { headers: { 'X-Altcha': solution } });
      if (!data?.n || !/^[0-9a-f]{32}$/i.test(data.n)) throw new Error('invalid bootstrap nonce');
      this.bootstrapNonce = data.n;
      this.pepperReady = false;
      this.pepperExpires = 0;
      await this.state.storage.put({
        bootstrapNonce: this.bootstrapNonce,
        pepperReady: false,
        pepperExpires: 0
      });
      return this.bootstrapNonce;
    })().finally(() => { this.bootstrapPromise = null; });
    return this.bootstrapPromise;
  }

  async ensurePepper() {
    if (this.pepperReady && Date.now() < this.pepperExpires) return;
    if (this.pepperPromise) return this.pepperPromise;
    this.pepperPromise = (async () => {
      if (!this.wasm) this.wasm = createWasmCrypto();
      const nonce = this.bootstrapNonce || await this.freshNonce();
      const challenge = await this.getJson('/altcha-challenge');
      const solution = await this.solveAltcha(challenge);
      const envelope = await this.getJson('/pepper-key', {
        headers: { 'X-Nonce': nonce, 'X-Altcha': solution }
      });
      if (envelope?.v !== 1) throw new Error('invalid pepper envelope');
      this.wasm.reset();
      if (!this.wasm.decryptPepper({
        nonce, bucket: envelope.bucket, iv: envelope.iv, ct: envelope.ct, tag: envelope.tag
      })) throw new Error('pepper decrypt failed');
      this.pepperReady = true;
      this.pepperExpires = Date.now() + 4 * 60 * 1000;
      await this.state.storage.put({
        pepperReady: true,
        pepperExpires: this.pepperExpires
      });
    })().catch(async (error) => {
      this.bootstrapNonce = null;
      this.pepperReady = false;
      await this.state.storage.deleteAll();
      throw error;
    }).finally(() => { this.pepperPromise = null; });
    return this.pepperPromise;
  }

  async resolvePath(path) {
    await this.ensurePepper();
    const clientNonce = randomHex(16);
    const requestId = randomHex(16);
    const envelope = await this.getJson(path, {
      headers: {
        'X-Nonce': this.bootstrapNonce,
        'X-Client-Nonce': clientNonce,
        'X-Request-Id': requestId
      }
    });
    if (envelope?.v !== 1) throw new Error('invalid encrypted envelope');
    const clear = this.wasm.decryptEnvelope({
      clientNonce,
      serverNonce: envelope.sn,
      tb: envelope.tb,
      requestId,
      iv2: envelope.iv2,
      wk: envelope.wk,
      tag2: envelope.tag2,
      iv1: envelope.iv1,
      ct: envelope.ct,
      tag1: envelope.tag1
    });
    if (!clear) throw new Error('response decrypt failed');
    return JSON.parse(new TextDecoder().decode(clear));
  }
}
