import api from './index.js';
export const {
  bzip2Decompress, lzwCompress, lzwDecompress,
  Bzip2Decompressor, LzwDecompressor, LzwCompressor,
  bzip2DecompressStream, lzwCompressStream, lzwDecompressStream,
  Bzip2FormatError, LzwFormatError, LzwConfigError,
} = api;
