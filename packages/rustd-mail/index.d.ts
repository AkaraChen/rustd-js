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
