import net from 'node:net';

export function lastCode(reply) {
  const lines = String(reply).replace(/\n+$/g, '').split('\n');
  const last = lines[lines.length - 1] ?? '';
  return last.slice(0, 3);
}

function sendReply(sock, reply) {
  for (const line of String(reply).split('\n')) {
    if (line === '') continue;
    sock.write(`${line}\r\n`);
  }
}

export function withFakeSmtp(script, fn) {
  const { banner, replies } = script;
  const chunks = [];
  let closed;
  const closedBytes = new Promise((resolve) => {
    closed = resolve;
  });
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      sendReply(sock, banner);
      let i = 0;
      let buf = Buffer.alloc(0);
      let mode = 'cmd';
      sock.setTimeout(8000);
      sock.on('timeout', () => sock.destroy());
      sock.on('data', (d) => {
        chunks.push(d);
        buf = Buffer.concat([buf, d]);
        while (buf.length > 0) {
          if (mode === 'data') {
            const idx = buf.indexOf('\r\n.\r\n');
            if (idx === -1) return;
            buf = buf.subarray(idx + 5);
            mode = 'cmd';
            if (i < replies.length) sendReply(sock, replies[i++]);
            continue;
          }
          const nl = buf.indexOf('\n');
          if (nl === -1) return;
          buf = buf.subarray(nl + 1);
          if (i >= replies.length) continue;
          const reply = replies[i++];
          sendReply(sock, reply);
          if (lastCode(reply) === '354') mode = 'data';
        }
      });
      sock.on('close', () => closed(Buffer.concat(chunks)));
      sock.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address();
      try {
        await fn(`127.0.0.1:${port}`);
        const bytes = await Promise.race([
          closedBytes,
          new Promise((_, rej) => setTimeout(() => rej(new Error('fake smtp: client did not close')), 8000)),
        ]);
        resolve(bytes);
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
    server.on('error', reject);
  });
}
