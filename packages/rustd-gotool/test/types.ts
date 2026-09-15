import {
  versionCompare,
  versionIsValid,
  versionLang,
  GoConstValue,
  constMakeInt64,
  constMakeFromLiteral,
  constToInt,
  constToString,
  constFloat64Val,
  constCompare,
  constSign,
  constReal,
  constImag,
  constBitLen,
  constBinaryOp,
  constUnaryOp,
  constShift,
  TOKEN,
  SCAN_MODE,
  PARSE_MODE,
  tokenLookup,
  tokenIsKeyword,
  tokenIsExported,
  tokenString,
  FileSet,
  Scanner,
  GoScanError,
  parseFile,
  parseExpr,
  astFprint,
  astInspect,
  astIsExported,
  astNewIdent,
  GoParseError,
} from '../index.js';
const cv: GoConstValue = constMakeInt64(-42n);
const fromLit: GoConstValue = constMakeFromLiteral('0x10', TOKEN.INT, 0);
const fromFLit: GoConstValue = constMakeFromLiteral('1.5', TOKEN.FLOAT, 0);
const fromCLit: GoConstValue = constMakeFromLiteral("'a'", TOKEN.CHAR, 0);
const fromILit: GoConstValue = constMakeFromLiteral('1i', TOKEN.IMAG, 0);
const fromSLit: GoConstValue = constMakeFromLiteral('"foo"', TOKEN.STRING, 0);
const kind: GoConstValue['kind'] = cv.kind;
const [ival, iok]: [bigint, boolean] = constToInt(cv);
const [sval, sok]: [string, boolean] = constToString(cv);
const [fval, fok]: [number, boolean] = constFloat64Val(cv);
const icmp: number = constCompare(cv, constMakeInt64(0n));
const fcmp: number = constCompare(constBinaryOp(TOKEN.QUO, cv, constMakeInt64(2n)), cv);
const isign: number = constSign(cv);
const ireal: GoConstValue = constReal(fromILit);
const iimag: GoConstValue = constImag(fromILit);
const ibits: number = constBitLen(cv);
const badd: GoConstValue = constBinaryOp(TOKEN.ADD, cv, constMakeInt64(1n));
const fadd: GoConstValue = constBinaryOp(TOKEN.ADD, constBinaryOp(TOKEN.QUO, cv, constMakeInt64(2n)), cv);
const cadd: GoConstValue = constBinaryOp(TOKEN.ADD, fromILit, cv);
const cmul: GoConstValue = constBinaryOp(TOKEN.MUL, fromILit, fromILit);
const uxor: GoConstValue = constUnaryOp(TOKEN.XOR, cv, 8);
const fneg: GoConstValue = constUnaryOp(TOKEN.SUB, constBinaryOp(TOKEN.QUO, cv, constMakeInt64(2n)), 0);
const sshl: GoConstValue = constShift(TOKEN.SHL, cv, 1n);
const bstr: string = badd.toString();
const cmp: number = versionCompare('go1.21', 'go1.21.0');
const ok: boolean = versionIsValid('go1.21rc2');
const lang: string = versionLang('go1.21rc2');
const tok: number = tokenLookup('func');
const kw: boolean = tokenIsKeyword(TOKEN.FUNC);
const exp: boolean = tokenIsExported('Fmt');
const s: string = tokenString(TOKEN.ADD);
const fset = new FileSet();
const file = fset.addFile('p.go', -1, 10);
const scanner = new Scanner(file, new Uint8Array(10), null, SCAN_MODE.ScanComments);
const r = scanner.scan();
scanner.scanInto(r);
const err: GoScanError = new GoScanError({ filename: 'p.go', offset: 0, line: 1, column: 1 }, 'x');
const parseErr: GoParseError = new GoParseError(
  [{ filename: 'p.go', offset: 0, line: 1, column: 1, msg: 'x' }],
  null,
);
const parsed = parseFile(fset, 'p.go', new Uint8Array(10), PARSE_MODE.SkipObjectResolution);
const expr = parseExpr(new FileSet(), '1+2', PARSE_MODE.SkipObjectResolution);
const sink = { write(c: Uint8Array) { void c; } };
astFprint(sink, fset, parsed);
astInspect(parsed, (n) => n.nodeType !== 'Ident');
const id = astNewIdent('Fmt');
const exported: boolean = astIsExported(id.name);
// @ts-expect-error MakeInt64 takes bigint
constMakeInt64(1);
// @ts-expect-error MakeFromLiteral lit is a string
constMakeFromLiteral(1, TOKEN.INT, 0);
// @ts-expect-error StringVal operand is GoConstValue
constToString(1);
// @ts-expect-error Float64Val operand is GoConstValue
constFloat64Val(1);
// @ts-expect-error BinaryOp operands are GoConstValue
constBinaryOp(TOKEN.ADD, 1n, cv);
// @ts-expect-error UnaryOp operand is GoConstValue
constUnaryOp(TOKEN.XOR, 1n, 0);
// @ts-expect-error Shift count is bigint
constShift(TOKEN.SHL, cv, 1);
// @ts-expect-error versions are strings, not numbers
versionCompare(1, 2);
// @ts-expect-error IsValid takes a string
versionIsValid(1);
// @ts-expect-error Lang takes a string
versionLang(1);
// @ts-expect-error compare does not return boolean
const wrong: boolean = versionCompare('go1', 'go1.1');
void [cv, fromLit, fromFLit, fromCLit, fromILit, fromSLit, kind, ival, iok, sval, sok, fval, fok, icmp, fcmp, isign, ireal, iimag, ibits, badd, fadd, cadd, cmul, uxor, fneg, sshl, bstr, cmp, ok, lang, tok, kw, exp, s, scanner, err, parseErr, wrong, parsed, expr, id, exported];
