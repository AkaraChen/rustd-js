import { T, FATAL, FatalError, SkipError, TestSetupError } from '../index.js';

const ok: Promise<boolean> = T.start('root', async (t: T) => {
  const nested: Promise<boolean> = t.run('sub', (inner) => {
    inner.log('hi');
    inner.logf('%s %d', 'n', 1);
    inner.helper();
    inner.parallel();
    const [deadline, hasDeadline]: [Date | null, boolean] = inner.deadline();
    const signal: AbortSignal = inner.context();
    const dir: string = inner.tempDir();
    inner.setenv('RUSTD_TESTING_TYPECHECK', dir);
    inner.chdir(dir);
    inner.cleanup(() => {});
    inner.fail();
    const failed: boolean = inner.failed();
    const skipped: boolean = inner.skipped();
    const name: string = inner.name();
    void deadline;
    void hasDeadline;
    void signal;
    void failed;
    void skipped;
    void name;
  });
  void nested;
});
void ok;

const fatal: FatalError = new FatalError('x');
const skip: SkipError = new SkipError('x');
const setup: TestSetupError = new TestSetupError('x');
const marked: true = fatal[FATAL];
void skip;
void setup;
void marked;

// @ts-expect-error run() returns Promise<boolean>, not void.
const bad: void = T.start('x', () => {});
// @ts-expect-error name must be a string.
T.start(1, () => {});
// @ts-expect-error FATAL is a unique symbol, not a string.
const notString: string = FATAL;
