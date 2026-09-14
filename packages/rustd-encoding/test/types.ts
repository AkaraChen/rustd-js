import {
  Base64Encoding, Base32Encoding, hexEncode, hexDecode, hexDump, ascii85Decode,
  binaryUvarint, binaryReadUvarint, binaryEncode, binarySizeOf, type BinarySchema,
  tryBinaryMarshaler, MaxVarintLen64, CorruptInputError, type ByteOrder,
  gobEncode, gobDecode, type GobType, GobEncoder, GobDecoder, GobTypeError,
} from 'rustd-encoding';
const b64: Base64Encoding = Base64Encoding.Std.strict().withPadding(null);
const raw: Uint8Array = b64.encode(new Uint8Array([1]));
const text: string = hexEncode(raw);
const decoded: Uint8Array = hexDecode(text);
const dump: string = hexDump(decoded);
const flush: Uint8Array = ascii85Decode('z', true);
const varint: Uint8Array = binaryUvarint(128n);
const read: { value: bigint; n: number } = binaryReadUvarint(varint);
const schema: BinarySchema = { kind: 'struct', fields: [{ name: 'n', type: { kind: 'uint32' } }] };
const size: number = binarySizeOf(schema);
const encoded: Uint8Array = binaryEncode(schema, { n: 1 }, 'le' satisfies ByteOrder);
const marshaled: Uint8Array | undefined = tryBinaryMarshaler({ toBinary: () => encoded });
const max: 10 = MaxVarintLen64;
const err: CorruptInputError = new CorruptInputError('x');
const hex32: Base32Encoding = Base32Encoding.Hex;
// @ts-expect-error strings are not bytes for encode
Base64Encoding.Std.encode('abc');
// @ts-expect-error ascii85 flush is required
ascii85Decode('z');
// @ts-expect-error uvarint is bigint
binaryUvarint(128);
const point: GobType = { kind: 'struct', name: 'Point', fields: [{ name: 'X', type: { kind: 'int' } }, { name: 'Y', type: { kind: 'int' } }] };
const gobbed: Uint8Array = gobEncode({ X: 1, Y: 2 }, point);
const back: unknown = gobDecode(gobbed, point);
const ge: GobEncoder = new GobEncoder();
const gd: GobDecoder = new GobDecoder({ maxTypeSize: 1n << 20n });
const gerr: GobTypeError = new GobTypeError('x');
void [flush, read, size, marshaled, max, err, hex32, back, ge, gd, gerr];
