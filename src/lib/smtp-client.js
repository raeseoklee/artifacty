import net from "node:net";
import tls from "node:tls";
import { randomUUID } from "node:crypto";

const ERRORS = {
  SMTP_CONFIG_INVALID: "SMTP configuration or message is invalid.",
  SMTP_CONNECT_FAILED: "Could not connect to the SMTP server.",
  SMTP_TLS_FAILED: "Could not establish a verified TLS connection to the SMTP server.",
  SMTP_AUTH_FAILED: "SMTP authentication failed.",
  SMTP_PROTOCOL_ERROR: "The SMTP server returned an invalid or unexpected response.",
  SMTP_REJECTED: "The SMTP server rejected the message.",
  SMTP_TIMEOUT: "The SMTP operation timed out.",
  SMTP_DELIVERY_UNKNOWN: "The SMTP connection ended before message acceptance could be confirmed. Delivery may have occurred."
};
const MAX_REPLY_BYTES = 64 * 1024;

function smtpError(code) {
  return Object.assign(new Error(ERRORS[code]), { code, ...(code === "SMTP_DELIVERY_UNKNOWN" ? { deliveryUnknown: true } : {}) });
}

function mailbox(value) {
  if (typeof value !== "string" || value.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/.test(value)) return false;
  const [local, domain] = value.split("@");
  return local.length <= 64 && !local.startsWith(".") && !local.endsWith(".") && !local.includes("..") &&
    domain.split(".").every((label) => label.length > 0 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}

function validate(config, message) {
  const bad = () => { throw smtpError("SMTP_CONFIG_INVALID"); };
  if (!config || !message || typeof config.host !== "string" || !config.host || config.host.length > 253 ||
      (!net.isIP(config.host) && !config.host.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label))) ||
      !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || !["tls", "starttls"].includes(config.tlsMode)) bad();
  if (!mailbox(config.from) || !mailbox(message.to)) bad();
  for (const value of [config.username ?? "", config.password ?? "", message.subject]) {
    if (typeof value !== "string" || Buffer.byteLength(value) > 4096 || /[\x00-\x1f\x7f]/.test(value)) bad();
  }
  if (Boolean(config.username) !== Boolean(config.password) || typeof message.text !== "string" || Buffer.byteLength(message.text) > 1024 * 1024) bad();
}

function encodedSubject(subject) {
  if (!subject) return "";
  const chunks = [];
  let current = "";
  for (const character of subject) {
    if (Buffer.byteLength(current + character) > 42) { chunks.push(current); current = ""; }
    current += character;
  }
  chunks.push(current);
  return chunks.map((chunk) => `=?UTF-8?B?${Buffer.from(chunk).toString("base64")}?=`).join("\r\n ");
}

function encodeMessage(config, { to, subject, text }) {
  const encoded = Buffer.from(text.replace(/\r\n|\r|\n/g, "\r\n"), "utf8").toString("base64");
  const body = encoded.match(/.{1,76}/g)?.join("\r\n") || "";
  return [
    `From: ${config.from}`, `To: ${to}`, `Subject: ${encodedSubject(subject)}`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <${randomUUID()}@${config.from.split("@")[1]}>`,
    "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", body
  ].join("\r\n").replace(/^\./gm, "..") + "\r\n.\r\n";
}

// One bounded response parser per transport; STARTTLS discards the plaintext
// parser and its capabilities before sending a fresh EHLO over verified TLS.
function replies(socket) {
  let buffer = "";
  let current = null;
  let failed = null;
  let pending = null;
  const queued = [];
  function fail(error = smtpError("SMTP_CONNECT_FAILED")) {
    if (failed) return;
    failed = error;
    if (pending) { pending.reject(error); pending = null; }
  }
  function onData(data) {
    buffer += data.toString("latin1");
    if (buffer.length + (current?.bytes || 0) > MAX_REPLY_BYTES) { fail(smtpError("SMTP_PROTOCOL_ERROR")); socket.destroy(); return; }
    let end;
    while ((end = buffer.indexOf("\r\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const match = /^([2-5]\d{2})([ -])([^\r\n]*)$/.exec(line);
      if (!match || (current && current.code !== Number(match[1]))) { fail(smtpError("SMTP_PROTOCOL_ERROR")); socket.destroy(); return; }
      current ||= { code: Number(match[1]), lines: [], bytes: 0 };
      current.lines.push(match[3]);
      current.bytes += line.length + 2;
      if (match[2] === " ") {
        const reply = current;
        current = null;
        if (pending) { pending.resolve(reply); pending = null; }
        else queued.push(reply);
        if (queued.length > 8) { fail(smtpError("SMTP_PROTOCOL_ERROR")); socket.destroy(); return; }
      }
    }
  }
  const onError = () => fail();
  const onClose = () => fail();
  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("close", onClose);
  return {
    next() {
      if (failed) return Promise.reject(failed);
      if (queued.length) return Promise.resolve(queued.shift());
      return new Promise((resolve, reject) => { pending = { resolve, reject }; });
    },
    detach() {
      if (buffer || current || queued.length || pending) throw smtpError("SMTP_PROTOCOL_ERROR");
      socket.off("data", onData); socket.off("error", onError); socket.off("close", onClose);
    },
    fail
  };
}

/** Send one message, without retries. options.ca is solely an explicit caller
 * trust override for isolated tests; production settings must not expose it. */
export async function sendSmtpMail(config, message, options = {}) {
  validate(config, message);
  const timeoutMs = Math.min(15000, options.timeoutMs ?? 15000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw smtpError("SMTP_CONFIG_INVALID");
  let socket;
  let reader;
  let timer;
  let deliveryStarted = false;
  let accepted = false;
  let timeoutReject;
  const timeout = new Promise((_, reject) => { timeoutReject = reject; });
  timer = setTimeout(() => {
    const error = smtpError(deliveryStarted ? "SMTP_DELIVERY_UNKNOWN" : "SMTP_TIMEOUT");
    timeoutReject(error);
    reader?.fail(error);
    socket?.destroy();
  }, timeoutMs);
  const bounded = async (operation) => {
    let commandTimer;
    try {
      return await Promise.race([operation, timeout, new Promise((_, reject) => {
        commandTimer = setTimeout(() => reject(smtpError(deliveryStarted ? "SMTP_DELIVERY_UNKNOWN" : "SMTP_TIMEOUT")), Math.min(timeoutMs, 5000));
      })]);
    } finally { clearTimeout(commandTimer); }
  };
  const connect = async (secure, underlying) => {
    socket = secure ? tls.connect({
      ...(underlying ? { socket: underlying } : { port: config.port }),
      host: config.host, servername: net.isIP(config.host) ? undefined : config.host,
      rejectUnauthorized: true, minVersion: "TLSv1.2", ...(options.ca ? { ca: options.ca } : {}),
      checkServerIdentity: (_hostname, certificate) => tls.checkServerIdentity(config.host, certificate)
    }) : net.connect({ host: config.host, port: config.port });
    reader = replies(socket);
    await bounded(new Promise((resolve, reject) => {
      const event = secure ? "secureConnect" : "connect";
      const onError = () => { socket.off(event, onReady); reject(smtpError(secure ? "SMTP_TLS_FAILED" : "SMTP_CONNECT_FAILED")); };
      const onReady = () => { socket.off("error", onError); resolve(); };
      socket.once(event, onReady); socket.once("error", onError);
    }));
  };
  const expect = async (codes, code = "SMTP_PROTOCOL_ERROR") => {
    const response = await bounded(reader.next());
    if (!codes.includes(response.code)) throw smtpError(code);
    return response;
  };
  const command = async (text, codes, errorCode) => {
    socket.write(`${text}\r\n`);
    return expect(codes, errorCode);
  };
  try {
    await connect(config.tlsMode === "tls");
    await expect([220]);
    let hello = await command("EHLO artifacty.local", [250]);
    if (config.tlsMode === "starttls") {
      if (!hello.lines.some((line) => /^STARTTLS(?:\s|$)/i.test(line))) throw smtpError("SMTP_TLS_FAILED");
      await command("STARTTLS", [220], "SMTP_TLS_FAILED");
      reader.detach();
      await connect(true, socket);
      hello = await command("EHLO artifacty.local", [250]);
    }
    if (config.username) {
      const methods = hello.lines.flatMap((line) => /^AUTH(?:=|\s+)(.*)$/i.exec(line)?.[1].toUpperCase().split(/\s+/) || []);
      if (methods.includes("PLAIN")) {
        const credentials = Buffer.from(`\0${config.username}\0${config.password}`).toString("base64");
        const response = await command(`AUTH PLAIN ${credentials}`, [235, 334], "SMTP_AUTH_FAILED");
        if (response.code === 334) await command(credentials, [235], "SMTP_AUTH_FAILED");
      } else if (methods.includes("LOGIN")) {
        await command("AUTH LOGIN", [334], "SMTP_AUTH_FAILED");
        await command(Buffer.from(config.username).toString("base64"), [334], "SMTP_AUTH_FAILED");
        await command(Buffer.from(config.password).toString("base64"), [235], "SMTP_AUTH_FAILED");
      } else throw smtpError("SMTP_AUTH_FAILED");
    }
    await command(`MAIL FROM:<${config.from}>`, [250], "SMTP_REJECTED");
    await command(`RCPT TO:<${message.to}>`, [250, 251, 252], "SMTP_REJECTED");
    await command("DATA", [354], "SMTP_REJECTED");
    deliveryStarted = true;
    socket.write(encodeMessage(config, message));
    await expect([250], "SMTP_REJECTED");
    accepted = true;
    // Acceptance is final; failed QUIT must never turn success into a retry.
    try { socket.end("QUIT\r\n"); } catch { /* DATA acceptance remains final. */ }
    return { accepted: true };
  } catch (error) {
    if (deliveryStarted && !accepted && error.code !== "SMTP_REJECTED") throw smtpError("SMTP_DELIVERY_UNKNOWN");
    throw smtpError(Object.hasOwn(ERRORS, error.code) ? error.code : "SMTP_PROTOCOL_ERROR");
  } finally {
    clearTimeout(timer);
    socket?.destroy();
  }
}
