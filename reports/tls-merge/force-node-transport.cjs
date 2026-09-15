// Diagnostic only: exercise the Windows transport branch on a Unix host.
// This does not substitute for the real Windows matrix job.
const Module = require('node:module');
const fs = require('node:fs');
const original = Module._extensions['.js'];
Module._extensions['.js'] = function (mod, filename) {
  if (filename.endsWith('/packages/rustd-mail/index.js')) {
    const source = fs.readFileSync(filename, 'utf8');
    const needle = "if (process.platform === 'win32') {";
    if (source.split(needle).length !== 2) throw new Error('Expected one transport selector');
    mod._compile(source.replace(needle, 'if (true) {'), filename);
  } else original(mod, filename);
};
