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
}

export function syntaxParse(pattern: string, flags: number): SyntaxRegexp;
export function syntaxSimplify(pattern: string, flags: number): SyntaxRegexp;
export function flagsToString(flags: number): string;
