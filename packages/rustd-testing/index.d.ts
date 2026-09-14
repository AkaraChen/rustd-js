/** Marker on FatalError so `run()` can detect a swallowed throw. */
export const FATAL: unique symbol;

export class FatalError extends Error {
  readonly name: 'FatalError';
  readonly code: 'ERR_TESTING_FATAL';
  readonly [FATAL]: true;
}
export class SkipError extends Error {
  readonly name: 'SkipError';
  readonly code: 'ERR_TESTING_SKIP';
}
export class TestSetupError extends Error {
  readonly name: 'TestSetupError';
  readonly code: 'ERR_TESTING_SETUP';
}

/**
 * Go-shaped test handle. Create a root with `T.start`; use `run` for subtests.
 * `run()` is async — forgetting `await` loses the subtest report (a warning is emitted).
 */
export class T {
  /** Inactive handle. Prefer `T.start` so cleanup always runs. */
  constructor(name?: string);
  /** Root entry: runs `fn`, then LIFO cleanup. Returns whether the test passed. */
  static start(name: string, fn: (t: T) => void | Promise<void>): Promise<boolean>;
  /** Subtest. Always `await` this Promise; it is tagged `T.Run`. */
  run(name: string, fn: (t: T) => void | Promise<void>): Promise<boolean>;
  log(...args: unknown[]): void;
  logf(format: string, ...args: unknown[]): void;
  error(...args: unknown[]): void;
  errorf(format: string, ...args: unknown[]): void;
  fatal(...args: unknown[]): never;
  fatalf(format: string, ...args: unknown[]): never;
  skip(...args: unknown[]): void;
  skipf(format: string, ...args: unknown[]): void;
  fail(): void;
  failNow(): never;
  failed(): boolean;
  skipped(): boolean;
  cleanup(fn: () => void | Promise<void>): void;
  tempDir(): string;
  helper(): void;
  deadline(): [Date | null, boolean];
  context(): AbortSignal;
  setenv(key: string, value: string): void;
  chdir(dir: string): void;
  /** No-op besides a marker. Does not run the subtest concurrently. */
  parallel(): void;
  name(): string;
}
