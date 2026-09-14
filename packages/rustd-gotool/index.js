'use strict';
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const name = 'rustd-gotool';
let platform = `${process.platform}-${process.arch}`;
if (process.platform === 'linux') {
  if (!process.report.getReport().header.glibcVersionRuntime) {
    throw new Error(`${name}: Linux musl is not supported`);
  }
  platform += '-gnu';
} else if (process.platform === 'win32') platform += '-msvc';
if (!['darwin-arm64', 'darwin-x64', 'linux-x64-gnu', 'linux-arm64-gnu', 'win32-x64-msvc'].includes(platform)) {
  throw new Error(`${name}: unsupported platform ${platform}`);
}
const local = join(__dirname, `${name}.${platform}.node`);
// Do not hide a broken local binary behind an optional-package fallback.
const binding = existsSync(local) ? require(local) : require(`${name}-${platform}`);

function versionString(value, label) {
  if (typeof value !== 'string') {
    throw new TypeError(`gotool: ${label} must be a string`);
  }
  return value;
}

function versionCompare(x, y) {
  return binding.versionCompare(versionString(x, 'x'), versionString(y, 'y'));
}
function versionIsValid(x) {
  return binding.versionIsValid(versionString(x, 'x'));
}
function versionLang(x) {
  return binding.versionLang(versionString(x, 'x'));
}

module.exports.versionCompare = versionCompare;
module.exports.versionIsValid = versionIsValid;
module.exports.versionLang = versionLang;
