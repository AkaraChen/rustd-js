import { OP, FLAGS, syntaxParse, syntaxSimplify, flagsToString, SyntaxRegexp } from '../index.js';

const re: SyntaxRegexp = syntaxParse('a(b)', FLAGS.Perl);
const op: number = re.op;
const dump: string = re.dump();
const printed: string = re.toString();
const names: string[] = re.capNames();
const simple: SyntaxRegexp = re.simplify();
const simple2: SyntaxRegexp = syntaxSimplify('a{2,}', FLAGS.Perl);
const flagText: string = flagsToString(FLAGS.Perl | FLAGS.FoldCase);
const n: number = OP.Literal + FLAGS.Perl;

// @ts-expect-error pattern must be a string
syntaxParse(1, FLAGS.Perl);
// @ts-expect-error flags must be a number
syntaxParse('a', 'perl');
// @ts-expect-error dump is a string
const wrong: number = dump;
void op;
void printed;
void names;
void simple;
void simple2;
void flagText;
void n;
void wrong;
