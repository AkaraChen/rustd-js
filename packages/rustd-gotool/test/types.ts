import { versionCompare, versionIsValid, versionLang } from '../index.js';
const cmp: number = versionCompare('go1.21', 'go1.21.0');
const ok: boolean = versionIsValid('go1.21rc2');
const lang: string = versionLang('go1.21rc2');
// @ts-expect-error versions are strings, not numbers
versionCompare(1, 2);
// @ts-expect-error IsValid takes a string
versionIsValid(1);
// @ts-expect-error Lang takes a string
versionLang(1);
// @ts-expect-error compare does not return boolean
const wrong: boolean = versionCompare('go1', 'go1.1');
void [cmp, ok, lang, wrong];
