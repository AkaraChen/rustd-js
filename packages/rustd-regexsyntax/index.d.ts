export const OP: {
  readonly NoMatch: 1;
  readonly EmptyMatch: 2;
  readonly Literal: 3;
  readonly CharClass: 4;
  readonly AnyCharNotNL: 5;
  readonly AnyChar: 6;
  readonly BeginLine: 7;
  readonly EndLine: 8;
  readonly BeginText: 9;
  readonly EndText: 10;
  readonly WordBoundary: 11;
  readonly NoWordBoundary: 12;
  readonly Capture: 13;
  readonly Star: 14;
  readonly Plus: 15;
  readonly Quest: 16;
  readonly Repeat: 17;
  readonly Concat: 18;
  readonly Alternate: 19;
};

export const INST_OP: {
  readonly Alt: 0;
  readonly AltMatch: 1;
  readonly Capture: 2;
  readonly EmptyWidth: 3;
  readonly Match: 4;
  readonly Fail: 5;
  readonly Nop: 6;
  readonly Rune: 7;
  readonly Rune1: 8;
  readonly RuneAny: 9;
  readonly RuneAnyNotNL: 10;
};

export const EMPTY_OP: {
  readonly BeginLine: 1;
  readonly EndLine: 2;
  readonly BeginText: 4;
  readonly EndText: 8;
  readonly WordBoundary: 16;
  readonly NoWordBoundary: 32;
};

export interface Inst {
  op: number;
  out: number;
  arg: number;
  rune: number[];
}

export interface Prog {
  dump: string;
  start: number;
  numCap: number;
  inst: Inst[];
}

export const FLAGS: {
  readonly FoldCase: number;
  readonly Literal: number;
  readonly ClassNL: number;
  readonly DotNL: number;
  readonly OneLine: number;
  readonly NonGreedy: number;
  readonly PerlX: number;
  readonly UnicodeGroups: number;
  readonly WasDollar: number;
  readonly Simple: number;
  readonly MatchNL: number;
  readonly Perl: number;
  readonly POSIX: number;
};

export class SyntaxError extends Error {
  constructor(message: string, code: string, expr: string, options?: ErrorOptions);
  readonly code: string;
  readonly expr: string;
}

export class SyntaxRegexp {
  readonly op: number;
  readonly flags: number;
  readonly sub: SyntaxRegexp[];
  readonly sub0: SyntaxRegexp[];
  readonly rune: number[];
  readonly min: number;
  readonly max: number;
  readonly cap: number;
  readonly name: string;
  toString(): string;
  dump(): string;
  toJson(): object;
  maxCap(): number;
  capNames(): string[];
  equal(other: SyntaxRegexp): boolean;
  simplify(): SyntaxRegexp;
  compile(): Prog;
}

export function syntaxParse(pattern: string, flags: number): SyntaxRegexp;
export function syntaxSimplify(pattern: string, flags: number): SyntaxRegexp;
export function syntaxCompile(pattern: string, flags: number): Prog;
export function emptyOpContext(before: number, after: number): number;
export function isWordChar(r: number): boolean;
export function flagsToString(flags: number): string;
