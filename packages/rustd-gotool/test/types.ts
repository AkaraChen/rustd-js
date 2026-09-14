import {
  versionCompare,
  versionIsValid,
  versionLang,
  TOKEN,
  SCAN_MODE,
  tokenLookup,
  tokenIsKeyword,
  tokenIsExported,
  tokenString,
  FileSet,
  Scanner,
  GoScanError,
} from '../index.js';
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
// @ts-expect-error versions are strings, not numbers
versionCompare(1, 2);
// @ts-expect-error IsValid takes a string
versionIsValid(1);
// @ts-expect-error Lang takes a string
versionLang(1);
// @ts-expect-error compare does not return boolean
const wrong: boolean = versionCompare('go1', 'go1.1');
void [cmp, ok, lang, tok, kw, exp, s, scanner, err, wrong];
