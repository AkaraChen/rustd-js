/** Compare Go toolchain versions. Invalid strings (including "") compare equal and less than valid ones. */
export function versionCompare(x: string, y: string): number;
export function versionIsValid(x: string): boolean;
/** Language version, e.g. "go1.21rc2" → "go1.21". Invalid input → "". */
export function versionLang(x: string): string;

/** Opaque `go/constant.Value` (issue #28). Int via constMakeInt64 / constBinaryOp. */
export class GoConstValue {
  readonly kind: 'Bool' | 'String' | 'Int' | 'Float' | 'Complex' | 'Unknown';
  /** `constant.Value.String()` for Int; `"unknown"` for Unknown. */
  toString(): string;
}
export function constMakeInt64(v: bigint): GoConstValue;
/** Go `MakeBool`. */
export function constMakeBool(v: boolean): GoConstValue;
/** Go `MakeFromLiteral` for INT/FLOAT/IMAG/CHAR/STRING. Invalid lit → Unknown. CHAR is Int. IMAG is Complex. STRING is Unquote. `prec` must be 0. */
export function constMakeFromLiteral(lit: string, tok: number, prec: number): GoConstValue;
export function constToInt(v: GoConstValue): [bigint, boolean];
/** Go `BoolVal`. Bool → `[b, true]`; Unknown → `[false, true]`; other kinds panic in Go → `[false, false]`. */
export function constBoolVal(v: GoConstValue): [boolean, boolean];
/** Go `StringVal`. String → unquoted text; Int/Float/Complex would panic → `["", false]`; Unknown → `["", true]`. */
export function constToString(v: GoConstValue): [string, boolean];
/** Go `Float64Val` for Int/Float/Unknown. Bits match IEEE-754; Unknown is `[0, false]`. Complex panics in Go → `[0, false]`. */
export function constFloat64Val(v: GoConstValue): [number, boolean];
/** Int/Float ordering via Go `Compare` (`big.Rat.Cmp`): -1 / 0 / 1. Throws on Unknown. */
export function constCompare(x: GoConstValue, y: GoConstValue): number;
export function constSign(v: GoConstValue): number;
/** Go `Real`. Complex returns the stored re (IMAG real is Int 0); Unknown/Int/Float return `x`. */
export function constReal(v: GoConstValue): GoConstValue;
/** Go `Imag`. Int/Float → Int 0; Complex returns the stored im; Unknown → Unknown. */
export function constImag(v: GoConstValue): GoConstValue;
export function constBitLen(v: GoConstValue): number;
/**
 * Int ADD/SUB/MUL/QUO/REM/AND/OR/XOR/AND_NOT.
 * Float (and mixed Int/Float) ADD/SUB/MUL/QUO.
 * Complex (and mixed Int/Float/Complex) ADD/SUB/MUL/QUO via Go's component formula.
 * Bool LAND/LOR. Unknown operand → Unknown.
 * QUO of Ints is Float (`n` / `n/d` ExactString). Integer-valued Float stays Float.
 * QUO/REM by zero (including Complex 0+0i) → Unknown. REM/AND/OR/XOR/AND_NOT on Float/Complex throw.
 * Mixed Bool+numeric LAND/LOR throw (Go `match` would duplicate the Bool; we reject).
 */
export function constBinaryOp(op: number, x: GoConstValue, y: GoConstValue): GoConstValue;
/**
 * Int ADD/SUB/XOR. Float ADD/SUB (identity / Neg via `big.Rat`).
 * Bool NOT. XOR requires Int. `prec` is Go XOR width in bits; 0 = unlimited.
 */
export function constUnaryOp(op: number, y: GoConstValue, prec: number): GoConstValue;
/** Int SHL/SHR. `s` is a non-negative bigint count (Go `uint`). */
export function constShift(op: number, x: GoConstValue, s: bigint): GoConstValue;

export const TOKEN: {
  readonly ILLEGAL: number;
  readonly EOF: number;
  readonly COMMENT: number;
  readonly IDENT: number;
  readonly INT: number;
  readonly FLOAT: number;
  readonly IMAG: number;
  readonly CHAR: number;
  readonly STRING: number;
  readonly ADD: number;
  readonly SUB: number;
  readonly MUL: number;
  readonly QUO: number;
  readonly REM: number;
  readonly AND: number;
  readonly OR: number;
  readonly XOR: number;
  readonly SHL: number;
  readonly SHR: number;
  readonly AND_NOT: number;
  readonly ADD_ASSIGN: number;
  readonly SUB_ASSIGN: number;
  readonly MUL_ASSIGN: number;
  readonly QUO_ASSIGN: number;
  readonly REM_ASSIGN: number;
  readonly AND_ASSIGN: number;
  readonly OR_ASSIGN: number;
  readonly XOR_ASSIGN: number;
  readonly SHL_ASSIGN: number;
  readonly SHR_ASSIGN: number;
  readonly AND_NOT_ASSIGN: number;
  readonly LAND: number;
  readonly LOR: number;
  readonly ARROW: number;
  readonly INC: number;
  readonly DEC: number;
  readonly EQL: number;
  readonly LSS: number;
  readonly GTR: number;
  readonly ASSIGN: number;
  readonly NOT: number;
  readonly NEQ: number;
  readonly LEQ: number;
  readonly GEQ: number;
  readonly DEFINE: number;
  readonly ELLIPSIS: number;
  readonly LPAREN: number;
  readonly LBRACK: number;
  readonly LBRACE: number;
  readonly COMMA: number;
  readonly PERIOD: number;
  readonly RPAREN: number;
  readonly RBRACK: number;
  readonly RBRACE: number;
  readonly SEMICOLON: number;
  readonly COLON: number;
  readonly BREAK: number;
  readonly CASE: number;
  readonly CHAN: number;
  readonly CONST: number;
  readonly CONTINUE: number;
  readonly DEFAULT: number;
  readonly DEFER: number;
  readonly ELSE: number;
  readonly FALLTHROUGH: number;
  readonly FOR: number;
  readonly FUNC: number;
  readonly GO: number;
  readonly GOTO: number;
  readonly IF: number;
  readonly IMPORT: number;
  readonly INTERFACE: number;
  readonly MAP: number;
  readonly PACKAGE: number;
  readonly RANGE: number;
  readonly RETURN: number;
  readonly SELECT: number;
  readonly STRUCT: number;
  readonly SWITCH: number;
  readonly TYPE: number;
  readonly VAR: number;
  readonly TILDE: number;
};

export function tokenLookup(ident: string): number;
export function tokenIsKeyword(tok: number): boolean;
export function tokenIsExported(name: string): boolean;
export function tokenString(tok: number): string;

export interface GoPosition {
  filename: string;
  offset: number;
  line: number;
  column: number;
}

export class FileSet {
  addFile(filename: string, base: number, size: number): GoFile;
  position(pos: number): GoPosition;
  positionFor(pos: number, adjusted: boolean): GoPosition;
  base(): number;
  iterate(cb: (f: GoFile) => boolean | void): void;
}

export class GoFile {
  name(): string;
  base(): number;
  size(): number;
  lineCount(): number;
  lineStart(line: number): number;
  offset(p: number): number;
  position(p: number): GoPosition;
  positionFor(p: number, adjusted: boolean): GoPosition;
  addLine(offset: number): void;
  mergeLine(line: number): void;
  setLines(lines: number[]): void;
  lines(): number[];
}

export interface ScanResult {
  pos: number;
  tok: number;
  lit: string;
}

export class Scanner {
  constructor(
    file: GoFile,
    src: Uint8Array,
    errorHandler: ((pos: GoPosition, msg: string) => void) | null,
    mode: number,
  );
  init(
    file: GoFile,
    src: Uint8Array,
    errorHandler: ((pos: GoPosition, msg: string) => void) | null,
    mode: number,
  ): Scanner;
  scan(): ScanResult;
  scanInto(out: ScanResult): ScanResult;
  error(pos: number, msg: string): void;
  readonly errorCount: number;
}

export const SCAN_MODE: { readonly ScanComments: number };
export const PARSE_MODE: {
  readonly PackageClauseOnly: number;
  readonly ImportsOnly: number;
  readonly ParseComments: number;
  readonly SkipObjectResolution: number;
  readonly AllErrors: number;
};

export class GoScanError extends Error {
  constructor(pos: GoPosition, msg: string);
  readonly pos: GoPosition;
  readonly msg: string;
}

export class UnsupportedFeatureError extends Error {
  constructor(message: string);
}

export interface GoParseErrorItem {
  filename: string;
  offset: number;
  line: number;
  column: number;
  msg: string;
}

export class GoParseError extends Error {
  constructor(list: GoParseErrorItem[], partialFile: GoAstFile | GoAstExpr | null, message?: string);
  readonly list: GoParseErrorItem[];
  readonly partialFile: GoAstFile | GoAstExpr | null;
}

export interface GoAstNode {
  nodeType: string;
  pos: number;
  end: number;
}

export interface GoIdent extends GoAstNode {
  nodeType: 'Ident';
  name: string;
}

export interface GoComment extends GoAstNode {
  nodeType: 'Comment';
  slash: number;
  text: string;
}

export interface GoCommentGroup extends GoAstNode {
  nodeType: 'CommentGroup';
  list: GoComment[];
}

export interface GoBasicLit extends GoAstNode {
  nodeType: 'BasicLit';
  valuePos: number;
  kind: number;
  value: string;
}

export interface GoImportSpec extends GoAstNode {
  nodeType: 'ImportSpec';
  doc: GoCommentGroup | null;
  name: GoIdent | null;
  path: GoBasicLit;
  comment: GoCommentGroup | null;
  endPos: number;
}

export interface GoAstFile extends GoAstNode {
  nodeType: 'File';
  name: GoIdent;
  decls: GoAstDecl[] | null;
  imports: GoImportSpec[] | null;
  comments: GoCommentGroup[] | null;
  doc: GoCommentGroup | null;
  package: number;
  fileStart: number;
  fileEnd: number;
  unresolved: GoIdent[] | null;
}

export type GoAstExpr = GoAstNode;
export type GoAstDecl = GoAstNode;

export interface ByteSink {
  write(chunk: Uint8Array): unknown;
}

export function parseFile(
  fset: FileSet,
  filename: string,
  src: Uint8Array | null,
  mode?: number,
): GoAstFile;
export function parseExpr(fset: FileSet, expr: string, mode?: number): GoAstExpr;
export function astFprint(out: ByteSink, fset: FileSet, node: GoAstNode): void;
export function astInspect(node: GoAstNode, f: (n: GoAstNode) => boolean | void): void;
export function astIsExported(name: string): boolean;
export function astNewIdent(name: string): GoIdent;
