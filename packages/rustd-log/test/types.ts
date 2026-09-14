import {
  Logger, SlogLogger, newLogger, newLoggerDefault, newTextHandler, newJsonHandler,
  L, LEVEL, KIND, int, string, duration, uint64, Record, LevelVar, BadKeyError,
  sinkFd, type Level, type Handler, type Attr,
} from 'rustd-log';
const log: Logger = newLogger(sinkFd(2), 'p', L.StdFlags);
log.print('x');
const h: Handler = newTextHandler(sinkFd(2), { level: LEVEL.Info, addSource: false });
const slog: SlogLogger = newLoggerDefault(h);
const jsonH: Handler = newJsonHandler(sinkFd(2), { level: new LevelVar(-4) });
slog.info('m', 'k', 1);
const a: Attr = int('n', 1);
const r: Record = new Record(new Date(), LEVEL.Warn, 'm', 0n);
r.addAttrs(a, string('s', 'x'), duration('d', 1_500_000_000n), uint64('u', 1n << 63n));
const lv: Level = LEVEL.Error;
const err: BadKeyError = new BadKeyError('bad');
// @ts-expect-error Level is a number, not a string union
const badLevel: 'info' = LEVEL.Info;
// @ts-expect-error classic Logger is not a slog logger
const mix: SlogLogger = log;
// @ts-expect-error duration is bigint nanoseconds
duration('d', 1.5);
void [jsonH, lv, err, KIND.String];
