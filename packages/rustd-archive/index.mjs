import api from './index.js';
export const {
  ArchiveError, TarFormatError, ZipFormatError,
  tarCreate, tarExtract, zipCreate, zipExtract,
  TarWriter, TarReader, ZipWriter, ZipReader,
} = api;
