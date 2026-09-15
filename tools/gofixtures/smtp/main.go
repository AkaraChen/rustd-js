// Go 1.24 net/smtp client-byte dump against a scripted fake server.
package main

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/smtp"
	"os"
	"runtime"
	"strings"
	"time"
)

type Case struct {
	ID        string   `json:"id"`
	Kind      string   `json:"kind"`
	Banner    string   `json:"banner"`
	Replies   []string `json:"replies"`
	ClientHex string   `json:"clientHex"`
	TLS       bool     `json:"tls,omitempty"`
	Error     string   `json:"error,omitempty"`
}

type Packet struct {
	Package string `json:"package"`
	Go      string `json:"go"`
	Cases   []Case `json:"cases"`
}

type recConn struct {
	net.Conn
	buf *bytes.Buffer
}

func (c *recConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if n > 0 {
		c.buf.Write(p[:n])
	}
	return n, err
}

func writeReply(bw *bufio.Writer, reply string) {
	for _, line := range strings.Split(reply, "\n") {
		if line == "" {
			continue
		}
		bw.WriteString(line)
		bw.WriteString("\r\n")
	}
	bw.Flush()
}

func lastCode(reply string) string {
	lines := strings.Split(strings.TrimRight(reply, "\n"), "\n")
	last := lines[len(lines)-1]
	if len(last) >= 3 {
		return last[:3]
	}
	return ""
}

func serverTLS() *tls.Config {
	cert, err := tls.LoadX509KeyPair("cert.pem", "key.pem")
	if err != nil {
		panic(err)
	}
	return &tls.Config{Certificates: []tls.Certificate{cert}}
}

func clientTLS() *tls.Config {
	pem, err := os.ReadFile("cert.pem")
	if err != nil {
		panic(err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		panic("no cert")
	}
	return &tls.Config{ServerName: "127.0.0.1", RootCAs: pool, MinVersion: tls.VersionTLS12}
}

func serveScript(conn net.Conn, raw net.Conn, rec *bytes.Buffer, banner string, replies []string, useTLS bool) {
	_ = conn.SetDeadline(time.Now().Add(8 * time.Second))
	br := bufio.NewReader(conn)
	bw := bufio.NewWriter(conn)
	writeReply(bw, banner)
	i := 0
	upgraded := false
	for i < len(replies) {
		if _, err := br.ReadString('\n'); err != nil {
			return
		}
		reply := replies[i]
		i++
		writeReply(bw, reply)
		if useTLS && !upgraded && lastCode(reply) == "220" {
			tlsConn := tls.Server(raw, serverTLS())
			_ = tlsConn.SetDeadline(time.Now().Add(8 * time.Second))
			if err := tlsConn.Handshake(); err != nil {
				return
			}
			conn = &recConn{Conn: tlsConn, buf: rec}
			br = bufio.NewReader(conn)
			bw = bufio.NewWriter(conn)
			upgraded = true
		}
		if lastCode(reply) == "354" {
			for {
				line, err := br.ReadString('\n')
				if err != nil {
					return
				}
				if strings.TrimRight(line, "\r\n") == "." {
					break
				}
			}
			if i < len(replies) {
				writeReply(bw, replies[i])
				i++
			}
		}
		if lastCode(reply) == "221" {
			io.Copy(io.Discard, br)
			return
		}
	}
	io.Copy(io.Discard, br)
}

func runCase(banner string, replies []string, useTLS bool, fn func(addr string) error) (client []byte, clientErr error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	defer ln.Close()
	done := make(chan []byte, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			done <- nil
			return
		}
		buf := &bytes.Buffer{}
		rc := &recConn{Conn: conn, buf: buf}
		serveScript(rc, conn, buf, banner, replies, useTLS)
		rc.Close()
		done <- buf.Bytes()
	}()
	errCh := make(chan error, 1)
	go func() { errCh <- fn(ln.Addr().String()) }()
	select {
	case err = <-errCh:
	case <-time.After(8 * time.Second):
		ln.Close()
		err = fmt.Errorf("client timeout")
	}
	select {
	case client = <-done:
	case <-time.After(3 * time.Second):
		return client, fmt.Errorf("timeout waiting for fake server: %v", err)
	}
	return client, err
}

func msgCRLF(s string) []byte {
	return []byte(strings.ReplaceAll(s, "\n", "\r\n"))
}

func main() {
	clientID := flag.String("client", "", "run one Go net/smtp case against -addr (no dump)")
	addrFlag := flag.String("addr", "", "SMTP server address for -client")
	flag.Parse()

	dotMsg := "From: user@gmail.com\nTo: golang-nuts@googlegroups.com\nSubject: Hooray for Go\n\nLine 1\n.Leading dot line .\nGoodbye."
	sendMsg := "From: test@example.com\nTo: other@example.com\nSubject: SendMail test\n\nSendMail is working for me.\n"
	lfMsg := "From: a@b.com\nTo: c@d.com\n\nhello\n.world\nmixed\r\nline\n"

	specs := []struct {
		id      string
		kind    string
		banner  string
		replies []string
		tls     bool
		fn      func(addr string) error
	}{
		{
			id:     "sendMail-ehlo-fail",
			kind:   "sendMail",
			banner: "220 hello world",
			replies: []string{
				"502 EH?",
				"250 mx.google.com at your service",
				"250 Sender ok",
				"250 Receiver ok",
				"354 Go ahead",
				"250 Data ok",
				"221 Goodbye",
			},
			fn: func(addr string) error {
				return smtp.SendMail(addr, nil, "test@example.com", []string{"other@example.com"}, msgCRLF(sendMsg))
			},
		},
		{
			id:     "sendMail-ehlo-8bitmime",
			kind:   "sendMail",
			banner: "220 hello world",
			replies: []string{
				"250-mx.google.com at your service\n250-SIZE 35651584\n250 8BITMIME",
				"250 Sender ok",
				"250 Receiver ok",
				"354 Go ahead",
				"250 Data ok",
				"221 Goodbye",
			},
			fn: func(addr string) error {
				return smtp.SendMail(addr, nil, "test@example.com", []string{"other@example.com"}, msgCRLF(sendMsg))
			},
		},
		{
			id:     "sendMail-auth-plain",
			kind:   "sendMail",
			banner: "220 localhost ESMTP",
			replies: []string{
				"250-localhost\n250 AUTH PLAIN LOGIN",
				"235 Accepted",
				"250 Sender ok",
				"250 Receiver ok",
				"354 Go ahead",
				"250 Data ok",
				"221 Goodbye",
			},
			fn: func(addr string) error {
				return smtp.SendMail(addr, smtp.PlainAuth("", "user", "pass", "127.0.0.1"), "a@b.com", []string{"c@d.com"}, msgCRLF(sendMsg))
			},
		},
		{
			id:     "sendMail-auth-unsupported",
			kind:   "sendMail",
			banner: "220 hello world",
			replies: []string{
				"250 mx.google.com at your service",
			},
			fn: func(addr string) error {
				return smtp.SendMail(addr, smtp.PlainAuth("", "user", "pass", "smtp.google.com"), "a@b.com", []string{"c@d.com"}, msgCRLF(sendMsg))
			},
		},
		{
			id:     "sendMail-multi-rcpt",
			kind:   "sendMail",
			banner: "220 hello world",
			replies: []string{
				"250 localhost",
				"250 Sender ok",
				"250 Receiver ok",
				"250 Receiver ok",
				"354 Go ahead",
				"250 Data ok",
				"221 Goodbye",
			},
			fn: func(addr string) error {
				return smtp.SendMail(addr, nil, "a@b.com", []string{"one@b.com", "two@b.com"}, msgCRLF(sendMsg))
			},
		},
		{
			id:     "client-auth-fail",
			kind:   "client",
			banner: "220 hello world",
			replies: []string{
				"250-mx.google.com at your service\n250 AUTH LOGIN PLAIN",
				"535-Invalid credentials\n535 please see www.example.com",
				"501 aborted",
				"221 Goodbye",
			},
			fn: func(addr string) error {
				c, err := smtp.Dial(addr)
				if err != nil {
					return err
				}
				defer c.Close()
				return c.Auth(smtp.PlainAuth("", "user", "pass", "127.0.0.1"))
			},
		},
		{
			id:     "client-dot-stuff",
			kind:   "client",
			banner: "220 hello world",
			replies: []string{
				"250-localhost\n250 8BITMIME",
				"250 Sender ok",
				"250 Receiver ok",
				"354 Go ahead",
				"250 Data ok",
				"221 Goodbye",
			},
			fn: func(addr string) error {
				c, err := smtp.Dial(addr)
				if err != nil {
					return err
				}
				defer c.Close()
				if err := c.Mail("user@gmail.com"); err != nil {
					return err
				}
				if err := c.Rcpt("golang-nuts@googlegroups.com"); err != nil {
					return err
				}
				w, err := c.Data()
				if err != nil {
					return err
				}
				if _, err := w.Write([]byte(dotMsg)); err != nil {
					return err
				}
				if err := w.Close(); err != nil {
					return err
				}
				return c.Quit()
			},
		},
		{
			id:     "client-lf-mixed",
			kind:   "client",
			banner: "220 hello world",
			replies: []string{
				"250 localhost",
				"250 Sender ok",
				"250 Receiver ok",
				"354 Go ahead",
				"250 Data ok",
				"221 Goodbye",
			},
			fn: func(addr string) error {
				c, err := smtp.Dial(addr)
				if err != nil {
					return err
				}
				defer c.Close()
				if err := c.Mail("a@b.com"); err != nil {
					return err
				}
				if err := c.Rcpt("c@d.com"); err != nil {
					return err
				}
				w, err := c.Data()
				if err != nil {
					return err
				}
				if _, err := w.Write([]byte(lfMsg)); err != nil {
					return err
				}
				if err := w.Close(); err != nil {
					return err
				}
				return c.Quit()
			},
		},
		{
			id:     "mail-not-250",
			kind:   "client",
			banner: "220 hello world",
			replies: []string{
				"250 localhost",
				"550 no such user",
				"221 Goodbye",
			},
			fn: func(addr string) error {
				c, err := smtp.Dial(addr)
				if err != nil {
					return err
				}
				defer c.Close()
				err = c.Mail("a@b.com")
				_ = c.Quit()
				return err
			},
		},
		{
			id:     "rcpt-reject",
			kind:   "client",
			banner: "220 hello world",
			replies: []string{
				"250 localhost",
				"250 Sender ok",
				"250 Receiver ok",
				"550 rejected",
				"250 Receiver ok",
				"354 Go ahead",
				"250 Data ok",
				"221 Goodbye",
			},
			fn: func(addr string) error {
				c, err := smtp.Dial(addr)
				if err != nil {
					return err
				}
				defer c.Close()
				if err := c.Mail("a@b.com"); err != nil {
					return err
				}
				if err := c.Rcpt("ok@b.com"); err != nil {
					return err
				}
				rej := c.Rcpt("bad@b.com")
				if rej == nil {
					return fmt.Errorf("expected RCPT reject")
				}
				if err := c.Rcpt("ok2@b.com"); err != nil {
					return err
				}
				w, err := c.Data()
				if err != nil {
					return err
				}
				if _, err := w.Write(msgCRLF(sendMsg)); err != nil {
					return err
				}
				if err := w.Close(); err != nil {
					return err
				}
				if err := c.Quit(); err != nil {
					return err
				}
				return nil
			},
		},
		{
			id:     "client-starttls-auth",
			kind:   "client",
			banner: "220 localhost",
			replies: []string{
				"250-localhost\n250-STARTTLS\n250 AUTH PLAIN LOGIN",
				"220 ready",
				"250-localhost\n250 AUTH PLAIN LOGIN",
				"235 Accepted",
				"250 Sender ok",
				"250 Receiver ok",
				"354 Go ahead",
				"250 Data ok",
				"221 Goodbye",
			},
			tls: true,
			fn: func(addr string) error {
				c, err := smtp.Dial(addr)
				if err != nil {
					return err
				}
				defer c.Close()
				if err := c.StartTLS(clientTLS()); err != nil {
					return err
				}
				if err := c.Auth(smtp.PlainAuth("", "user", "pass", "127.0.0.1")); err != nil {
					return err
				}
				if err := c.Mail("a@b.com"); err != nil {
					return err
				}
				if err := c.Rcpt("c@d.com"); err != nil {
					return err
				}
				w, err := c.Data()
				if err != nil {
					return err
				}
				if _, err := w.Write(msgCRLF(sendMsg)); err != nil {
					return err
				}
				if err := w.Close(); err != nil {
					return err
				}
				return c.Quit()
			},
		},
		{
			id:     "client-auth-cram-md5",
			kind:   "client",
			banner: "220 localhost",
			replies: []string{
				"250-localhost\n250 AUTH CRAM-MD5",
				"334 PDEyMzQ1Ni4xMzIyODc2OTE0QHRlc3RzZXJ2ZXI+",
				"235 Accepted",
				"221 Goodbye",
			},
			fn: func(addr string) error {
				c, err := smtp.Dial(addr)
				if err != nil {
					return err
				}
				defer c.Close()
				if err := c.Auth(smtp.CRAMMD5Auth("user", "pass")); err != nil {
					return err
				}
				return c.Quit()
			},
		},
		{
			id:     "client-vrfy-rset-noop",
			kind:   "client",
			banner: "220 localhost",
			replies: []string{
				"250 localhost",
				"250 alice",
				"250 reset",
				"250 ok",
				"221 Goodbye",
			},
			fn: func(addr string) error {
				c, err := smtp.Dial(addr)
				if err != nil {
					return err
				}
				defer c.Close()
				if err := c.Verify("alice@example.com"); err != nil {
					return err
				}
				if err := c.Reset(); err != nil {
					return err
				}
				if err := c.Noop(); err != nil {
					return err
				}
				return c.Quit()
			},
		},
		{
			id:     "client-smtputf8-mail",
			kind:   "client",
			banner: "220 localhost",
			replies: []string{
				"250-localhost\n250-8BITMIME\n250 SMTPUTF8",
				"250 Sender ok",
				"250 Receiver ok",
				"354 Go ahead",
				"250 Data ok",
				"221 Goodbye",
			},
			fn: func(addr string) error {
				c, err := smtp.Dial(addr)
				if err != nil {
					return err
				}
				defer c.Close()
				if err := c.Mail("a@b.com"); err != nil {
					return err
				}
				if err := c.Rcpt("c@d.com"); err != nil {
					return err
				}
				w, err := c.Data()
				if err != nil {
					return err
				}
				if _, err := w.Write(msgCRLF(sendMsg)); err != nil {
					return err
				}
				if err := w.Close(); err != nil {
					return err
				}
				return c.Quit()
			},
		},
		{
			id:     "client-short-response",
			kind:   "client",
			banner: "220 hello world",
			replies: []string{
				"250 localhost",
				"not a status",
			},
			fn: func(addr string) error {
				c, err := smtp.Dial(addr)
				if err != nil {
					return err
				}
				defer c.Close()
				return c.Mail("a@b.com")
			},
		},
		{
			id:     "client-malformed-continue",
			kind:   "client",
			banner: "220 hello world",
			replies: []string{
				"250-localhost\ngarbage without code\n250 AUTH PLAIN",
				"250 Sender ok",
				"221 Goodbye",
			},
			fn: func(addr string) error {
				c, err := smtp.Dial(addr)
				if err != nil {
					return err
				}
				defer c.Close()
				if err := c.Mail("a@b.com"); err != nil {
					return err
				}
				return c.Quit()
			},
		},
		{
			id:     "client-hello-custom",
			kind:   "client",
			banner: "220 hello world",
			replies: []string{
				"250 testhost",
				"221 Goodbye",
			},
			fn: func(addr string) error {
				c, err := smtp.Dial(addr)
				if err != nil {
					return err
				}
				defer c.Close()
				if err := c.Hello("testhost"); err != nil {
					return err
				}
				return c.Quit()
			},
		},
		{
			id:     "sendMail-mail-fail",
			kind:   "sendMail",
			banner: "220 hello world",
			replies: []string{
				"250 localhost",
				"550 no such user",
			},
			fn: func(addr string) error {
				return smtp.SendMail(addr, nil, "a@b.com", []string{"c@d.com"}, msgCRLF(sendMsg))
			},
		},
		{
			id:     "sendMail-rcpt-fail",
			kind:   "sendMail",
			banner: "220 hello world",
			replies: []string{
				"250 localhost",
				"250 Sender ok",
				"250 Receiver ok",
				"550 rejected",
			},
			fn: func(addr string) error {
				return smtp.SendMail(addr, nil, "a@b.com", []string{"ok@b.com", "bad@b.com"}, msgCRLF(sendMsg))
			},
		},
		{
			id:     "sendMail-data-fail",
			kind:   "sendMail",
			banner: "220 hello world",
			replies: []string{
				"250 localhost",
				"250 Sender ok",
				"250 Receiver ok",
				"554 not taking mail",
			},
			fn: func(addr string) error {
				return smtp.SendMail(addr, nil, "a@b.com", []string{"c@d.com"}, msgCRLF(sendMsg))
			},
		},
		{
			id:     "client-smtputf8-unicode",
			kind:   "client",
			banner: "220 localhost",
			replies: []string{
				"250-localhost\n250-8BITMIME\n250 SMTPUTF8",
				"250 Sender ok",
				"250 Receiver ok",
				"354 Go ahead",
				"250 Data ok",
				"221 Goodbye",
			},
			fn: func(addr string) error {
				c, err := smtp.Dial(addr)
				if err != nil {
					return err
				}
				defer c.Close()
				if err := c.Mail("用户@example.com"); err != nil {
					return err
				}
				if err := c.Rcpt("c@d.com"); err != nil {
					return err
				}
				w, err := c.Data()
				if err != nil {
					return err
				}
				if _, err := w.Write(msgCRLF(sendMsg)); err != nil {
					return err
				}
				if err := w.Close(); err != nil {
					return err
				}
				return c.Quit()
			},
		},
		{
			id:      "sendMail-inject-rcpt",
			kind:    "validate",
			banner:  "",
			replies: nil,
			fn: func(addr string) error {
				return smtp.SendMail("127.0.0.1:1", nil, "a@b.com", []string{"b@c.com>\nDATA\n"}, []byte("x"))
			},
		},
		{
			id:      "sendMail-from-inject",
			kind:    "validate",
			banner:  "",
			replies: nil,
			fn: func(addr string) error {
				return smtp.SendMail("127.0.0.1:1", nil, "a@b.com>\nDATA\n", []string{"c@d.com"}, []byte("x"))
			},
		},
	}

	if *clientID != "" {
		if *addrFlag == "" {
			fmt.Fprintln(os.Stderr, "-client requires -addr")
			os.Exit(2)
		}
		for _, spec := range specs {
			if spec.id == *clientID {
				if err := spec.fn(*addrFlag); err != nil {
					fmt.Fprintln(os.Stderr, err)
					os.Exit(1)
				}
				return
			}
		}
		fmt.Fprintf(os.Stderr, "unknown smtp case %s\n", *clientID)
		os.Exit(2)
	}

	var cases []Case
	for _, spec := range specs {
		var client []byte
		var err error
		if spec.kind == "validate" {
			err = spec.fn("")
		} else {
			client, err = runCase(spec.banner, spec.replies, spec.tls, spec.fn)
		}
		c := Case{
			ID:        spec.id,
			Kind:      spec.kind,
			Banner:    spec.banner,
			Replies:   spec.replies,
			ClientHex: hex.EncodeToString(client),
			TLS:       spec.tls,
		}
		if err != nil {
			c.Error = err.Error()
		}
		cases = append(cases, c)
	}

	packet := Packet{Package: "smtp", Go: runtime.Version(), Cases: cases}
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(packet); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
