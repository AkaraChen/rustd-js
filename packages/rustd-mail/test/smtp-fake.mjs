import net from 'node:net';
import tls from 'node:tls';

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

function attachParser(sock, state) {
  sock.on('data', (d) => {
    if (state.upgrading) return;
    state.chunks.push(d);
    state.buf = Buffer.concat([state.buf, d]);
    drain(sock, state);
  });
  sock.on('error', () => {});
  sock.on('close', () => {
    if (state.upgrading || state.tlsAttached && sock !== state.sock) return;
    if (!state.closedDone) {
      state.closedDone = true;
      state.closed(Buffer.concat(state.chunks));
    }
  });
}

function drain(sock, state) {
  const { replies } = state;
  while (state.buf.length > 0) {
    if (state.mode === 'data') {
      const idx = state.buf.indexOf('\r\n.\r\n');
      if (idx === -1) return;
      state.buf = state.buf.subarray(idx + 5);
      state.mode = 'cmd';
      if (state.i < replies.length) sendReply(sock, replies[state.i++]);
      continue;
    }
    const nl = state.buf.indexOf('\n');
    if (nl === -1) return;
    state.buf = state.buf.subarray(nl + 1);
    if (state.i >= replies.length) continue;
    const reply = replies[state.i++];
    sendReply(sock, reply);
    if (state.hangupAfter && lastCode(reply) === state.hangupAfter) {
      sock.destroy();
      return;
    }
    if (lastCode(reply) === '354') state.mode = 'data';
    if (state.tlsOpt && !state.implicitTls && lastCode(reply) === '220') {
      state.upgrading = true;
      sock.removeAllListeners('data');
      const tlsSock = new tls.TLSSocket(sock, {
        isServer: true,
        secureContext: tls.createSecureContext({
          cert: state.tlsOpt.cert,
          key: state.tlsOpt.key,
        }),
      });
      state.sock = tlsSock;
      state.tlsAttached = true;
      tlsSock.on('secure', () => {
        state.upgrading = false;
        attachParser(tlsSock, state);
        if (state.buf.length) drain(tlsSock, state);
      });
      tlsSock.on('error', () => {});
      return;
    }
  }
}

export function withFakeSmtp(script, fn) {
  const { banner, replies, tls: tlsOpt, hangupAfter, implicitTls } = script;
  const state = {
    replies,
    tlsOpt,
    hangupAfter,
    implicitTls: !!implicitTls,
    chunks: [],
    buf: Buffer.alloc(0),
    mode: 'cmd',
    i: 0,
    upgrading: false,
    closedDone: false,
    tlsAttached: false,
    closed: null,
  };
  const closedBytes = new Promise((resolve) => {
    state.closed = resolve;
  });
  return new Promise((resolve, reject) => {
    const onConn = (sock) => {
      sock.setTimeout(8000);
      sock.on('timeout', () => sock.destroy());
      sendReply(sock, banner);
      attachParser(sock, state);
    };
    const server = implicitTls
      ? tls.createServer({ cert: tlsOpt.cert, key: tlsOpt.key }, onConn)
      : net.createServer(onConn);
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
