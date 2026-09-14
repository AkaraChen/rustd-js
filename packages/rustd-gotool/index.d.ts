/** Compare Go toolchain versions. Invalid strings (including "") compare equal and less than valid ones. */
export function versionCompare(x: string, y: string): number;
export function versionIsValid(x: string): boolean;
/** Language version, e.g. "go1.21rc2" → "go1.21". Invalid input → "". */
export function versionLang(x: string): string;
