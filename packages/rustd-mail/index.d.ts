export type MailErrorKind = 'header' | 'address' | 'date' | 'syntax';

export class MailError extends Error {
  constructor(message: string, kind: MailErrorKind, options?: ErrorOptions);
  readonly code: 'MAIL';
  readonly kind: MailErrorKind;
}

export class MailHeader {
  constructor(init?: Record<string, string[]>);
  get(key: string): string;
  values(key: string): string[];
  set(key: string, value: string): void;
  date(): Date;
  setDate(d: Date): void;
  addressList(key: string): MailAddress[];
  keys(): string[];
}

export class MailAddress {
  constructor(name: string, address: string);
  readonly name: string;
  readonly address: string;
  toString(): string;
}

export class MailMessage {
  readonly header: MailHeader;
  readonly body: Uint8Array;
  readonly raw: Uint8Array;
  bodyText(): string;
  mediaType(): { type: string; params: Record<string, string> };
}

export function readMessage(input: Uint8Array | string): MailMessage;
export function parseAddress(s: string): MailAddress;
export function parseAddressList(s: string): MailAddress[];
export function parseDate(s: string): Date;

/** Uses the Go `net/mail` default RFC 2047 decoder (utf-8 / us-ascii / iso-8859-1). */
export class AddressParser {
  constructor();
  parse(s: string): MailAddress;
  parseList(s: string): MailAddress[];
}

export interface ServerInfo {
  name: string;
  tls: boolean;
  auth: string[];
}

export interface SmtpAuth {
  start(server: ServerInfo): { proto: string; initial: Uint8Array };
  next(fromServer: Uint8Array, more: boolean): Uint8Array | null;
}

export interface SmtpTlsOptions {
  /** SNI / certificate hostname. Defaults to the dial `host`. */
  serverName?: string;
  /** Verify the server certificate. Default true (Go `tls.Config` default). */
  rejectUnauthorized?: boolean;
  /** Extra trusted CA PEMs, used by tests and private CAs. */
  ca?: string | Buffer | Array<string | Buffer>;
}

export interface SmtpTlsConnectionState {
  protocol: string;
  authorized: boolean;
  serverName: string;
  cipher: { name: string; standardName: string; version: string } | null;
}

export interface SmtpDialOptions {
  /** Auth hostname, matching Go `smtp.NewClient(conn, host)`. Defaults to the host in `address`. */
  host?: string;
  /** Socket read/write timeout in ms. 0 waits forever (Go Dial). Default 30000. */
  timeoutMs?: number;
  /** Passed to `startTls` when `sendMail` sees a STARTTLS offer. */
  tls?: SmtpTlsOptions;
}

export class SmtpError extends Error {
  constructor(message: string, init?: { code?: number; command?: string; serverMessage?: string; cause?: unknown });
  readonly code: number;
  readonly command: string;
  readonly serverMessage: string;
  readonly permanent: boolean;
}

export class FeatureNotBuiltError extends SmtpError {}

export function plainAuth(opts: { identity?: string; username: string; password: string; host: string }): SmtpAuth;
export function loginAuth(opts: { username: string; password: string; host: string }): SmtpAuth;
export function cramMd5Auth(username: string, secret: string): SmtpAuth;

export class SmtpDataWriter {
  write(chunk: Uint8Array | string): Promise<void>;
  close(): Promise<void>;
}

export class SmtpClient {
  static dial(address: string, opts?: SmtpDialOptions): Promise<SmtpClient>;
  readonly serverInfo: ServerInfo;
  hello(localName?: string): Promise<void>;
  auth(a: SmtpAuth): Promise<void>;
  mail(from: string): Promise<void>;
  rcpt(to: string): Promise<void>;
  data(): Promise<SmtpDataWriter>;
  reset(): Promise<void>;
  noop(): Promise<void>;
  verify(addr: string): Promise<void>;
  extension(ext: string): boolean;
  extensionParams(ext: string): string;
  startTls(config?: SmtpTlsOptions): Promise<void>;
  tlsConnectionState(): SmtpTlsConnectionState | null;
  quit(): Promise<void>;
  close(): Promise<void>;
  abandon(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export function sendMail(
  address: string,
  auth: SmtpAuth | null,
  from: string,
  to: string[],
  msg: Uint8Array | string,
  opts?: SmtpDialOptions,
): Promise<void>;
