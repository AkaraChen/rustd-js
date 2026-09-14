import {
  Adler32, Crc32, Crc32Table, Crc64, Crc64Table, Fnv32, Fnv32a, Fnv64, Fnv64a, Fnv128, Fnv128a,
} from '../index.mjs';

const hex = data => Buffer.from(data).toString('hex');
const chunks = [1, 3, 7, 64, 1024];
function feed(create, data) {
  const h = create();
  for (let offset = 0, i = 0; offset < data.length; i++) {
    const n = Math.min(chunks[i] ?? data.length, data.length - offset);
    h.update(data.subarray(offset, offset + n));
    offset += n;
  }
  return hex(h.digest());
}
const oneshot = {
  adler32: data => hex(new Adler32().update(data).digest()),
  'crc32-ieee': data => hex(new Crc32().update(data).digest()),
  'crc32-castagnoli': data => hex(new Crc32(new Crc32Table('castagnoli')).update(data).digest()),
  'crc32-koopman': data => hex(new Crc32(new Crc32Table('koopman')).update(data).digest()),
  'crc32-custom': data => hex(new Crc32(new Crc32Table(0xa833982b)).update(data).digest()),
  'crc64-iso': data => hex(new Crc64(new Crc64Table('iso')).update(data).digest()),
  'crc64-ecma': data => hex(new Crc64(new Crc64Table('ecma')).update(data).digest()),
  fnv32: data => hex(new Fnv32().update(data).digest()),
  fnv32a: data => hex(new Fnv32a().update(data).digest()),
  fnv64: data => hex(new Fnv64().update(data).digest()),
  fnv64a: data => hex(new Fnv64a().update(data).digest()),
  fnv128: data => hex(new Fnv128().update(data).digest()),
  fnv128a: data => hex(new Fnv128a().update(data).digest()),
};
const ctors = {
  adler32: () => new Adler32(),
  'crc32-ieee': () => new Crc32(),
  'crc32-castagnoli': () => new Crc32(new Crc32Table('castagnoli')),
  'crc32-koopman': () => new Crc32(new Crc32Table('koopman')),
  'crc32-custom': () => new Crc32(new Crc32Table(0xa833982b)),
  'crc64-iso': () => new Crc64(new Crc64Table('iso')),
  'crc64-ecma': () => new Crc64(new Crc64Table('ecma')),
  fnv32: () => new Fnv32(),
  fnv32a: () => new Fnv32a(),
  fnv64: () => new Fnv64(),
  fnv64a: () => new Fnv64a(),
  fnv128: () => new Fnv128(),
  fnv128a: () => new Fnv128a(),
};
export function evaluate(data, incremental) {
  const out = {};
  for (const [name, fn] of Object.entries(oneshot)) {
    out[name] = incremental ? feed(ctors[name], data) : fn(data);
  }
  return out;
}
