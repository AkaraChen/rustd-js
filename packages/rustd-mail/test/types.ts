import {
  MailError, MailHeader, MailAddress, MailMessage, AddressParser,
  readMessage, parseAddress, parseAddressList, parseDate,
} from '../index.js';

const header: MailHeader = new MailHeader({ From: ['a@b.com'] });
const addr: MailAddress = parseAddress('A <a@b.com>');
const list: MailAddress[] = parseAddressList('a@b.com, b@c.com');
const date: Date = parseDate('Fri, 21 Nov 1997 09:55:06 -0600');
const msg: MailMessage = readMessage('From: a@b.com\n\nHi');
const body: Uint8Array = msg.body;
const text: string = msg.bodyText();
const media: { type: string; params: Record<string, string> } = msg.mediaType();
const parsed: MailAddress = new AddressParser().parse('a@b.com');
header.setDate(date);
const err: MailError = new MailError('mail: x', 'header');
const kind: 'header' | 'address' | 'date' | 'syntax' = err.kind;
void [header, addr, list, date, msg, body, text, media, parsed, kind, MailAddress];
// @ts-expect-error bytes require Uint8Array or string
readMessage(1);
// @ts-expect-error kind is a closed union
const badKind: MailError = new MailError('x', 'smtp');
// @ts-expect-error no async parse
parseAddress('a@b.com').then(() => {});
// @ts-expect-error address fields are readonly
addr.name = 'x';
