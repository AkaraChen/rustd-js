'use strict';
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { format } = require('node:util');

const FATAL = Symbol('FATAL');
class TestingError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = new.target.name;
    this.code = new.target.code;
  }
}
class FatalError extends TestingError {
  static code = 'ERR_TESTING_FATAL';
  constructor(message, options) {
    super(message, options);
    this[FATAL] = true;
  }
}
class SkipError extends TestingError { static code = 'ERR_TESTING_SKIP'; }
class TestSetupError extends TestingError { static code = 'ERR_TESTING_SETUP'; }

function isFatal(err) {
  return err instanceof FatalError || (err != null && err[FATAL] === true);
}
function isSkip(err) {
  return err instanceof SkipError;
}

class T {
  static start(name, fn) {
    if (typeof name !== 'string' || typeof fn !== 'function') {
      throw new TestSetupError('T.start(name, fn) requires a string name and a function');
    }
    return new T(name).#execute(fn);
  }

  constructor(name = '') {
    this.#name = String(name);
    this.#parent = null;
    this.#deadline = null;
    this.#controller = new AbortController();
    this.#active = false;
  }

  #name;
  #parent;
  #deadline;
  #controller;
  #active;
  #failed = false;
  #skipped = false;
  #parallel = false;
  #usedEnv = false;
  #usedChdir = false;
  #cleanups = [];
  #childFailed = false;

  name() { return this.#name; }
  failed() { return this.#failed || this.#childFailed; }
  skipped() { return this.#skipped; }
  helper() {}
  parallel() {
    this.#requireActive('parallel');
    if (this.#usedEnv || this.#usedChdir) {
      throw new TestSetupError('testing: test using t.setenv/t.chdir cannot use t.parallel');
    }
    this.#parallel = true;
  }
  deadline() {
    return this.#deadline instanceof Date ? [this.#deadline, true] : [null, false];
  }
  context() { return this.#controller.signal; }

  log(...args) { this.#write(format(...args)); }
  logf(fmt, ...args) { this.#write(format(String(fmt), ...args)); }
  error(...args) { this.log(...args); this.fail(); }
  errorf(fmt, ...args) { this.logf(fmt, ...args); this.fail(); }
  fatal(...args) { this.log(...args); this.failNow(); }
  fatalf(fmt, ...args) { this.logf(fmt, ...args); this.failNow(); }
  skip(...args) { if (args.length) this.log(...args); this.#skipNow(); }
  skipf(fmt, ...args) { this.logf(fmt, ...args); this.#skipNow(); }
  fail() {
    this.#requireActive('fail');
    this.#failed = true;
  }
  failNow() {
    this.fail();
    throw new FatalError(this.#name ? `${this.#name}: failNow` : 'failNow');
  }

  cleanup(fn) {
    this.#requireActive('cleanup');
    if (typeof fn !== 'function') throw new TestSetupError('cleanup requires a function');
    this.#cleanups.push(fn);
  }

  tempDir() {
    this.#requireActive('tempDir');
    const dir = mkdtempSync(join(tmpdir(), 'rustd-testing-'));
    this.cleanup(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  setenv(key, value) {
    this.#requireActive('setenv');
    if (this.#parallel) throw new TestSetupError('testing: test using t.parallel cannot use t.setenv');
    if (typeof key !== 'string' || key === '' || typeof value !== 'string') {
      throw new TestSetupError('setenv(key, value) requires strings');
    }
    this.#usedEnv = true;
    const had = Object.prototype.hasOwnProperty.call(process.env, key);
    const previous = process.env[key];
    process.env[key] = value;
    this.cleanup(() => {
      if (had) process.env[key] = previous;
      else delete process.env[key];
    });
  }

  chdir(dir) {
    this.#requireActive('chdir');
    if (this.#parallel) throw new TestSetupError('testing: test using t.parallel cannot use t.chdir');
    if (typeof dir !== 'string' || dir === '') throw new TestSetupError('chdir requires a directory path');
    this.#usedChdir = true;
    const previous = process.cwd();
    process.chdir(dir);
    this.cleanup(() => process.chdir(previous));
  }

  run(name, fn) {
    this.#requireActive('run');
    if (typeof name !== 'string' || typeof fn !== 'function') {
      throw new TestSetupError('run(name, fn) requires a string name and a function');
    }
    const child = new T(this.#name ? `${this.#name}/${name}` : name);
    child.#parent = this;
    child.#deadline = this.#deadline;
    const promise = child.#execute(fn).then((ok) => {
      if (child.failed()) this.#childFailed = true;
      return ok;
    });
    return tagRun(promise, JSON.stringify(name));
  }

  async #execute(fn) {
    this.#active = true;
    try {
      await fn(this);
    } catch (err) {
      if (isSkip(err)) this.#skipped = true;
      else if (isFatal(err)) this.#failed = true;
      else {
        this.#failed = true;
        this.#write(err && err.stack ? err.stack : format(err));
      }
    }
    await this.#runCleanups();
    return !this.failed();
  }

  async #runCleanups() {
    const fns = this.#cleanups;
    this.#cleanups = [];
    for (let i = fns.length - 1; i >= 0; i--) {
      try {
        await fns[i]();
      } catch (err) {
        this.#failed = true;
        this.#write(isFatal(err) ? `${this.#name}: failNow in cleanup` : (err && err.stack ? err.stack : format(err)));
      }
    }
    this.#active = false;
    if (!this.#controller.signal.aborted) this.#controller.abort();
  }

  #skipNow() {
    this.#requireActive('skip');
    this.#skipped = true;
    throw new SkipError(this.#name ? `${this.#name}: skip` : 'skip');
  }

  #requireActive(op) {
    if (!this.#active) throw new TestSetupError(`${op} called outside a running test`);
  }

  #write(message) {
    const text = String(message);
    const prefix = this.#name ? `${this.#name}: ` : '';
    process.stderr.write(`${prefix}${text}\n`);
  }
}

function tagRun(promise, label) {
  // Native `await` on a real Promise does not call `.then`, so a thenable is
  // required to tell "awaited" from "dropped".
  let observed = false;
  const mark = () => { observed = true; };
  const tagged = {
    then(onFulfilled, onRejected) {
      mark();
      return promise.then(onFulfilled, onRejected);
    },
    catch(onRejected) {
      mark();
      return promise.catch(onRejected);
    },
    finally(onFinally) {
      mark();
      return promise.finally(onFinally);
    },
  };
  Object.defineProperty(tagged, Symbol.toStringTag, { value: 'T.Run' });
  // `await thenable` attaches `.then` on the next microtask (PromiseResolve job).
  // Check one tick later so a same-turn `await t.run(...)` is not a false positive.
  queueMicrotask(() => {
    queueMicrotask(() => {
      if (!observed) {
        process.emitWarning(
          `rustd-testing: T.run(${label}) was not awaited; subtest results may be lost`,
          { code: 'RUSTD_TESTING_UNAWAITED_RUN', detail: 'Always await t.run(...)' },
        );
      }
    });
  });
  return tagged;
}

module.exports = {
  T, FATAL, FatalError, SkipError, TestSetupError,
};
