import { createHash, createHmac, hash, availableAlgos, fips140Enabled, CryptoError,
  HashFinalizedError, type Hash, type HashAlgo, type Mac } from 'rustd-crypto';
const h: Hash = createHash('sha512-224');
const output: Uint8Array = h.update('abc').digest();
const encoded: string = createHash('sha256').digest('base64url');
const clone: Hash = h.clone();
const mac: Mac = createHmac('sha256', output);
const legacy: Uint8Array = hash('md5', output, {allowLegacy:true});
const algos: readonly HashAlgo[] = availableAlgos();
const fips: false = fips140Enabled();
const error: CryptoError = new HashFinalizedError('finalized');
// @ts-expect-error: only actual algorithms are exposed
createHash('sha3-256');
// @ts-expect-error: wrong HMAC key type
createHmac('sha256','key');
// @ts-expect-error: no async API
createHash('sha256').then(() => {});
// @ts-expect-error: readonly metadata
h.size=12;
// @ts-expect-error: invalid encoding
h.digest('utf8');
// @ts-expect-error: legacy opt-in requires boolean
createHash('md5',{allowLegacy:1});
void [encoded,clone,mac,legacy,algos,fips,error];
