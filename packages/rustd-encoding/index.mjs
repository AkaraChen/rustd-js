import api from './index.js';
export const {
  EncodingError, CorruptInputError, InvalidByteError, HexLengthError, BufferTooShortError, VarintOverflowError, GobTypeError,
  Base64Encoding, Base32Encoding,
  hexEncode, hexDecode, hexAppendEncode, hexAppendDecode, hexEncodedLen, hexDecodedLen, hexDump, hexDumper,
  ascii85Encode, ascii85EncodeToString, ascii85Decode, ascii85MaxEncodedLen,
  binaryReadUvarint, binaryReadVarint, binaryPutUvarint, binaryPutVarint,
  binaryAppendUvarint, binaryAppendVarint, binaryUvarint,
  binarySizeOf, binaryEncode, binaryDecode,
  MaxVarintLen16, MaxVarintLen32, MaxVarintLen64,
  tryBinaryMarshaler, tryTextMarshaler,
  GobEncoder, GobDecoder, gobRegisterName, gobEncode, gobDecode,
} = api;
