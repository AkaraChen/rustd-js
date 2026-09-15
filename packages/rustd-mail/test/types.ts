import {
  MailError, MailHeader, MailAddress, MailMessage, AddressParser,
  readMessage, parseAddress, parseAddressList, parseDate,
  SmtpError, FeatureNotBuiltError, SmtpClient, SmtpDataWriter,
  plainAuth, loginAuth, cramMd5Auth, sendMail,
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
const auth = plainAuth({ username: 'u', password: 'p', host: 'localhost' });
const smtpErr: SmtpError = new SmtpError('535 no', { code: 535, command: 'AUTH', serverMessage: 'no' });
const feat: FeatureNotBuiltError = new FeatureNotBuiltError('smtp: STARTTLS handshake not built', { command: 'STARTTLS' });
void sendMail('127.0.0.1:25', auth, 'a@b.com', ['b@c.com'], 'Subject: x\r\n\r\nHi\r\n');
void SmtpClient.dial('127.0.0.1:25').then(async (c) => {
  await c.hello();
  await c.mail('a@b.com');
  await c.rcpt('b@c.com');
  const w: SmtpDataWriter = await c.data();
  await w.write('x');
  await w.close();
  await c.quit();
  loginAuth({ username: 'u', password: 'p', host: 'localhost' });
  cramMd5Auth('u', 's');
});
void [header, addr, list, date, msg, body, text, media, parsed, kind, MailAddress, smtpErr, feat];
// @ts-expect-error bytes require Uint8Array or string
readMessage(1);
// @ts-expect-error kind is a closed union
const badKind: MailError = new MailError('x', 'smtp');
// @ts-expect-error no async parse
parseAddress('a@b.com').then(() => {});
// @ts-expect-error address fields are readonly
addr.name = 'x';
