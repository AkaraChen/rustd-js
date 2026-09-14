import api from './index.js';
export const { CryptoError, UnsupportedAlgorithmError, InsecureAlgorithmError, HashFinalizedError,
  createHash, hash, createHmac, hmacEqual, availableAlgos, fips140Enabled } = api;
