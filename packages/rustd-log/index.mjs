import api from './index.js';
export const {
  L, LEVEL, KIND, TIME_KEY, LEVEL_KEY, MESSAGE_KEY, SOURCE_KEY, FACILITY, SEVERITY,
  LogError, BadKeyError, FatalError, PanicError, MessageTooLongError, UnsupportedPlatformError, SyslogError,
  Logger, newLogger, print, println, printf, fatal, panic, output, setOutput, setFlags, setPrefix, writer, sinkFd, sinkFile,
  Value, Attr, any, bool, duration, float64, int, int64, string, time, uint64, group, groupAttrs,
  Record, LevelVar, SlogLogger, newTextHandler, newJsonHandler, newLoggerDefault, newLogLogger,
  defaultLogger, setDefault, debug, info, warn, error, log, logAttrs,
  SyslogWriter, syslogNew, syslogDial,
  setClock, formatSlogCase, formatLogCase, formatSyslogCase, attrFromDto,
} = api;
