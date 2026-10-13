import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";
import test from "node:test";
import { sendSmtpMail } from "../src/lib/smtp-client.js";

const key = readFileSync(new URL("./fixtures/smtp/server-key.pem", import.meta.url));
const cert = readFileSync(new URL("./fixtures/smtp/server-cert.pem", import.meta.url));
const wrongCert = readFileSync(new URL("./fixtures/smtp/wrong-host-cert.pem", import.meta.url));
const message = { to: "receiver@example.test", subject: "임시 비밀번호 안내 — Temporary password", text: "새 임시 비밀번호: sample-test-only\n.leading dot\n감사합니다." };

async function fakeSmtp(t, options = {}) {
  const connections = new Set();
  const commands = [];
  const messages = [];
  const context = tls.createSecureContext({ key, cert: options.cert || cert, minVersion: "TLSv1.2" });
  function session(socket, secure, greet = true) {
    connections.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => connections.delete(socket));
    let buffer = "";
    let inData = false;
    let authStep = 0;
    if (greet && !options.stallGreeting) socket.write("220 test.local SMTP ready\r\n");
    const onData = (bytes) => {
      buffer += bytes.toString("utf8");
      if (inData) {
        const end = buffer.indexOf("\r\n.\r\n");
        if (end < 0) return;
        messages.push(buffer.slice(0, end)); buffer = buffer.slice(end + 5); inData = false;
        if (options.dropAfterData) { socket.destroy(); return; }
        if (options.stallAfterData) return;
        if (options.rejectData) { socket.write("554 private server detail\r\n"); return; }
        socket.write("250 accepted\r\n");
        if (options.closeAfterAccepted) socket.end();
      }
      let end;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        commands.push({ line, secure });
        if (options.stallCommand && line.startsWith(options.stallCommand)) return;
        if (line.startsWith("EHLO")) {
          if (options.malformedReply) { socket.write(options.malformedReply); return; }
          if (!secure) socket.write(options.noStarttls ? "250 test.local\r\n" : "250-test.local\r\n250-AUTH PLAIN\r\n250 STARTTLS\r\n");
          else socket.write(`250-test.local\r\n250 AUTH ${options.loginOnly ? "LOGIN" : "PLAIN LOGIN"}\r\n`);
        } else if (line === "STARTTLS") {
          socket.write("220 begin TLS\r\n"); socket.off("data", onData);
          const upgraded = new tls.TLSSocket(socket, { isServer: true, secureContext: context });
          session(upgraded, true, false); return;
        } else if (line.startsWith("AUTH PLAIN")) {
          socket.write(options.authFailure ? "535 leaked-secret-do-not-propagate\r\n" : "235 authenticated\r\n");
        } else if (line === "AUTH LOGIN") { authStep = 1; socket.write("334 VXNlcm5hbWU6\r\n"); }
        else if (authStep === 1) { authStep = 2; socket.write("334 UGFzc3dvcmQ6\r\n"); }
        else if (authStep === 2) { authStep = 0; socket.write("235 authenticated\r\n"); }
        else if (line.startsWith("MAIL FROM:") || line.startsWith("RCPT TO:")) socket.write("250 okay\r\n");
        else if (line === "DATA") { inData = true; socket.write("354 send message\r\n"); }
        else if (line === "QUIT") { if (options.quitFailure) socket.destroy(); else socket.end("221 bye\r\n"); }
        else socket.write("500 unknown command\r\n");
      }
    };
    socket.on("data", onData);
  }
  const server = options.starttls ? net.createServer((socket) => session(socket, false)) : tls.createServer({ key, cert: options.cert || cert, minVersion: "TLSv1.2" }, (socket) => session(socket, true));
  server.on("tlsClientError", () => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of connections) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { config: { host: "127.0.0.1", port: server.address().port, tlsMode: options.starttls ? "starttls" : "tls", from: "sender@example.test", username: "test-user", password: "test-password" }, commands, messages };
}

const trust = { ca: cert, timeoutMs: 1500 };

test("implicit TLS sends authenticated UTF-8 MIME mail and treats DATA acceptance as final", async (t) => {
  const smtp = await fakeSmtp(t, { closeAfterAccepted: true, quitFailure: true });
  assert.deepEqual(await sendSmtpMail(smtp.config, message, trust), { accepted: true });
  assert.ok(smtp.commands.every((command) => command.secure));
  const authentication = smtp.commands.find((command) => command.line.startsWith("AUTH PLAIN "));
  assert.equal(Buffer.from(authentication.line.slice(11), "base64").toString(), "\0test-user\0test-password");
  const [headers, body] = smtp.messages[0].split("\r\n\r\n");
  assert.match(headers, /Content-Transfer-Encoding: base64/);
  const subjectHeader = /^Subject: ([\s\S]*?)\r\nDate:/m.exec(headers)[1];
  const decodedSubject = [...subjectHeader.matchAll(/=\?UTF-8\?B\?([^?]*)\?=/g)].map((match) => Buffer.from(match[1], "base64").toString()).join("");
  assert.equal(decodedSubject, message.subject);
  assert.equal(Buffer.from(body.replaceAll("\r\n", ""), "base64").toString(), message.text.replaceAll("\n", "\r\n"));
  assert.ok(body.split("\r\n").every((line) => line.length <= 76));
});

test("STARTTLS never authenticates plaintext and sends fresh EHLO before TLS auth", async (t) => {
  const smtp = await fakeSmtp(t, { starttls: true });
  assert.deepEqual(await sendSmtpMail(smtp.config, message, trust), { accepted: true });
  assert.deepEqual(smtp.commands.filter((command) => !command.secure).map((command) => command.line), ["EHLO artifacty.local", "STARTTLS"]);
  assert.equal(smtp.commands.find((command) => command.secure).line, "EHLO artifacty.local");
});

test("STARTTLS requires advertised TLS and certificate verification", async (t) => {
  const unavailable = await fakeSmtp(t, { starttls: true, noStarttls: true });
  await assert.rejects(sendSmtpMail(unavailable.config, message, trust), { code: "SMTP_TLS_FAILED" });
  assert.equal(unavailable.commands.some((command) => command.line.startsWith("AUTH")), false);
  const untrusted = await fakeSmtp(t, { starttls: true });
  await assert.rejects(sendSmtpMail(untrusted.config, message, { timeoutMs: 1500 }), { code: "SMTP_TLS_FAILED" });
  assert.equal(untrusted.commands.some((command) => command.line.startsWith("AUTH")), false);
});

test("TLS rejects untrusted and hostname-mismatched certificates", async (t) => {
  const untrusted = await fakeSmtp(t);
  await assert.rejects(sendSmtpMail(untrusted.config, message, { timeoutMs: 1500 }), { code: "SMTP_TLS_FAILED" });
  const mismatch = await fakeSmtp(t, { cert: wrongCert });
  await assert.rejects(sendSmtpMail(mismatch.config, message, { ca: wrongCert, timeoutMs: 1500 }), { code: "SMTP_TLS_FAILED" });
});

test("AUTH failures expose only a fixed sanitized error", async (t) => {
  const smtp = await fakeSmtp(t, { authFailure: true });
  await assert.rejects(sendSmtpMail(smtp.config, message, trust), (error) => error.code === "SMTP_AUTH_FAILED" && error.message === "SMTP authentication failed." && !error.cause);
  assert.equal(smtp.commands.some((command) => command.line.startsWith("MAIL")), false);
});

test("AUTH LOGIN fallback and credential-free TLS delivery", async (t) => {
  const smtp = await fakeSmtp(t, { loginOnly: true });
  await sendSmtpMail(smtp.config, message, trust);
  assert.ok(smtp.commands.some((command) => command.line === "AUTH LOGIN"));
  const anonymous = await fakeSmtp(t);
  await sendSmtpMail({ ...anonymous.config, username: "", password: "" }, message, trust);
  assert.equal(anonymous.commands.some((command) => command.line.startsWith("AUTH")), false);
});

test("rejects envelope/header injection and invalid TLS configuration before connecting", async () => {
  const config = { host: "127.0.0.1", port: 1, tlsMode: "tls", from: "sender@example.test" };
  for (const change of [{ from: "sender@example.test\r\nBcc:other@example.test" }, { host: "localhost\r\nNOOP" }, { tlsMode: "none" }, { port: 0 }, { username: "a\0b", password: "test" }, { username: "user" }]) {
    await assert.rejects(sendSmtpMail({ ...config, ...change }, message), { code: "SMTP_CONFIG_INVALID" });
  }
  for (const change of [{ to: "receiver@example.test>\r\nRCPT TO:<other@example.test>" }, { subject: "hello\nBcc:other@example.test" }, { to: "two@example.test,other@example.test" }]) {
    await assert.rejects(sendSmtpMail(config, { ...message, ...change }), { code: "SMTP_CONFIG_INVALID" });
  }
});

test("bounded greeting/command timeout and malformed or oversized multiline replies", async (t) => {
  for (const options of [{ stallGreeting: true }, { stallCommand: "MAIL" }]) {
    const smtp = await fakeSmtp(t, options);
    const started = Date.now();
    await assert.rejects(sendSmtpMail(smtp.config, message, { ca: cert, timeoutMs: 100 }), { code: "SMTP_TIMEOUT" });
    assert.ok(Date.now() - started < 1500);
  }
  for (const malformedReply of ["250-first\r\n550 changed code\r\n", "garbage\r\n", `250-${"x".repeat(65536)}\r\n250 okay\r\n`]) {
    const smtp = await fakeSmtp(t, { malformedReply });
    await assert.rejects(sendSmtpMail(smtp.config, message, trust), { code: "SMTP_PROTOCOL_ERROR" });
  }
});

test("unknown DATA outcomes never retry; explicit DATA rejection remains definite", async (t) => {
  for (const options of [{ dropAfterData: true }, { stallAfterData: true }]) {
    const smtp = await fakeSmtp(t, options);
    await assert.rejects(sendSmtpMail(smtp.config, message, { ca: cert, timeoutMs: 150 }), { code: "SMTP_DELIVERY_UNKNOWN", deliveryUnknown: true });
    assert.equal(smtp.messages.length, 1);
  }
  const rejected = await fakeSmtp(t, { rejectData: true });
  await assert.rejects(sendSmtpMail(rejected.config, message, trust), { code: "SMTP_REJECTED" });
  assert.equal(rejected.messages.length, 1);
});
