import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, hash, createHmac, hmacEqual, availableAlgos, fips140Enabled,
  CryptoError, HashFinalizedError, InsecureAlgorithmError, UnsupportedAlgorithmError } from '../index.mjs';
import { createHash as nodeHash, createHmac as nodeHmac, randomBytes } from 'node:crypto';
const hex = data => Buffer.from(data).toString('hex');
const legacy = { allowLegacy: true };

test('FIPS SHA vectors, RFC 1321 MD5 and RFC 4231 HMAC vectors', () => {
  const vectors = {
    md5: '900150983cd24fb0d6963f7d28e17f72',
    sha1: 'a9993e364706816aba3e25717850c26c9cd0d89d',
    sha224: '23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7',
    sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    sha384: 'cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7',
    sha512: 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
    'sha512-224': '4634270f707b6a54daae7530460842e20e37ed265ceee9a43e8924aa',
    'sha512-256': '53048e2681941ef99b2e29b76b4c7dabe4c2d0c634fc6d46e0e2f13107e7af23',
  };
  for (const [algo, expected] of Object.entries(vectors)) assert.equal(hex(hash(algo, 'abc', legacy)), expected, algo);
  assert.equal(hex(createHmac('sha256', new Uint8Array(20).fill(0x0b)).update('Hi There').digest()),
    'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
  assert.equal(hex(createHmac('sha256', new Uint8Array(131).fill(0xaa))
    .update('Test Using Larger Than Block-Size Key - Hash Key First').digest()),
    '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54');
});

test('sum, clone, reset, UTF-8, encodings and finalization are independent', () => {
  for (const algo of availableAlgos()) {
    const h = createHash(algo, legacy).update('你好\0');
    assert.equal(h.size, hash(algo, '', legacy).length);
    assert.equal(h.blockSize, ['md5','sha1','sha224','sha256'].includes(algo) ? 64 : 128);
    const prefix = new Uint8Array([1, 2]);
    const snapshot = h.sum(prefix);
    assert.equal(hex(snapshot), '0102' + hex(hash(algo, '你好\0', legacy)));
    snapshot.fill(0); assert.deepEqual(prefix, new Uint8Array([1, 2]));
    const fork = h.clone();
    assert.equal(h.update('a'), h);
    assert.equal(h.digest('hex'), hex(hash(algo, '你好\0a', legacy)));
    assert.equal(fork.update('b').digest('hex'), hex(hash(algo, '你好\0b', legacy)));
    for (const operation of [() => h.digest(), () => h.update(''), () => h.sum(), () => h.clone()]) {
      assert.throws(operation, e => e instanceof HashFinalizedError && e instanceof CryptoError && e.code === 'ERR_CRYPTO_HASH_FINALIZED' && e.cause instanceof Error);
    }
    h.reset(); assert.equal(h.digest('hex'), hex(hash(algo, '', legacy)));
    for (const enc of ['base64','base64url']) assert.equal(createHash(algo, legacy).update('abc').digest(enc), Buffer.from(hash(algo,'abc',legacy)).toString(enc));
    const unfinalized = createHash(algo, legacy);
    assert.throws(() => unfinalized.digest('utf8'), TypeError);
    assert.equal(unfinalized.update('abc').digest('hex'), hex(hash(algo,'abc',legacy)));
  }
});

test('HMAC retains keyed state, not original key bytes, and resets after digest', () => {
  for (const algo of availableAlgos()) for (const length of [0,20,64,128,131,1024]) {
    const key = new Uint8Array(length).fill(7);
    const expected = nodeHmac(algo, key).update('hello!').digest('hex');
    const h = createHmac(algo, key, legacy).update('hello'); key.fill(0);
    assert.equal(h.size, hash(algo,'',legacy).length);
    const prefix = new Uint8Array([42]);
    assert.equal(hex(h.sum(prefix)), '2a' + nodeHmac(algo, new Uint8Array(length).fill(7)).update('hello').digest('hex'));
    assert.equal(h.update('!'),h); assert.equal(hex(h.digest()),expected);
    assert.throws(()=>h.digest(),HashFinalizedError); assert.throws(()=>h.update(''),HashFinalizedError); assert.throws(()=>h.sum(),HashFinalizedError);
    h.reset(); assert.equal(hex(h.update('hello!').digest()),expected);
  }
});

test('legacy defaults reject and opt-in remains local; invalid algorithms and inputs reject', () => {
  for (const algo of ['md5','sha1']) {
    for (const make of [() => createHash(algo), () => hash(algo,''), () => createHmac(algo,new Uint8Array())]) assert.throws(make,InsecureAlgorithmError);
    hash(algo,'',legacy);
    assert.throws(()=>createHash(algo),InsecureAlgorithmError);
  }
  for (const algo of ['sha3-256','__proto__','toString',{},null]) assert.throws(()=>createHash(algo),UnsupportedAlgorithmError);
  for (const value of [null,{},[],new Uint16Array(2),new DataView(new ArrayBuffer(2))]) {
    assert.throws(()=>createHash('sha256').update(value),TypeError);
    assert.throws(()=>createHmac('sha256',value),TypeError);
  }
  assert.throws(()=>createHash('md5',{allowLegacy:'true'}),TypeError);
  assert.throws(()=>createHash('sha256').squeeze(10),UnsupportedAlgorithmError);
  assert.equal(fips140Enabled(),false);
  assert.ok(Object.isFrozen(availableAlgos()));
});

test('typed-array offsets, output ownership and native MAC comparison', () => {
  const data = new Uint8Array([99,1,2,3,88]);
  assert.equal(hex(hash('sha256',data.subarray(1,4))),nodeHash('sha256').update(new Uint8Array([1,2,3])).digest('hex'));
  const h = createHash('sha256').update(data); const before = h.sum(); data.fill(0);
  assert.equal(hex(h.digest()),hex(before));
  assert.equal(hmacEqual(new Uint8Array(),new Uint8Array()),true);
  for (const [a,b,expected] of [[[1,2],[1,2],true],[[1,2],[1,3],false],[[1],[1,0],false],[[0],[],false]]) {
    assert.equal(hmacEqual(new Uint8Array(a),new Uint8Array(b)),expected);
  }
});

test('1 MiB random input: all eight required chunk sizes, every Hash and HMAC', () => {
  const data = randomBytes(1 << 20);
  for (const algo of availableAlgos()) {
    const expected = nodeHash(algo).update(data).digest('hex');
    const key = randomBytes(131); const macExpected = nodeHmac(algo,key).update(data).digest('hex');
    for (const chunk of [1,2,3,7,64,4096,65536,data.length]) {
      const h = createHash(algo,legacy); const m = createHmac(algo,key,legacy);
      for (let i=0;i<data.length;i+=chunk) { const part=data.subarray(i,i+chunk); h.update(part); m.update(part); }
      assert.equal(hex(h.digest()),expected,`${algo} chunk ${chunk}`);
      assert.equal(hex(m.digest()),macExpected,`HMAC ${algo} chunk ${chunk}`);
    }
  }
});
