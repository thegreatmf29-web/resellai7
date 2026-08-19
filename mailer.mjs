/* ============================================================================
   Resell.AI — mailer
   ----------------------------------------------------------------------------
   A minimal SMTP client over implicit TLS (port 465), plus an optional Resend
   HTTP path. No npm dependency.

   Why hand-rolled instead of nodemailer: this project ships with one
   dependency and I wanted the mail path to be testable and its errors legible.
   The scope here is deliberately tiny — one plain-text-and-HTML message to one
   recipient. It is not a general mail library and should not grow into one.

   Implicit TLS on 465 rather than STARTTLS on 587: the connection is encrypted
   from the first byte, so there is no negotiation step to get wrong and no
   window in which credentials could be sent in the clear.

   The message body is base64-encoded. That sidesteps SMTP's 998-character line
   limit and dot-stuffing (a line consisting of a single "." would otherwise
   terminate the message early) in one move.
   ========================================================================== */

import tls from 'node:tls';
import crypto from 'node:crypto';

const GMAIL_USER = () => (process.env.GMAIL_USER || '').trim();
/* App Passwords are displayed by Google in four groups of four ("abcd efgh
   ijkl mnop"). People paste them with the spaces, which fails authentication
   with a misleading "username and password not accepted". Strip whitespace. */
const GMAIL_PASS = () => (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');

const RESEND_KEY = () => (process.env.RESEND_API_KEY || '').trim();

/* Defaults to Gmail. Overridable so this same client works with any SMTPS
   provider — and so the test suite can point it at a local mock server. */
const SMTP_HOST = () => process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = () => Number(process.env.SMTP_PORT) || 465;
const SMTP_INSECURE = () => process.env.SMTP_INSECURE === '1';   // tests only

/* Node's socket failures are frequently useless as strings. A dual-stack host
   like smtp.gmail.com produces an AggregateError whose .message is EMPTY — it
   keeps the real causes in .errors — so naive `e.message` logging prints
   nothing at all and you are left staring at "FAILED:" with no reason.
   This flattens whatever shape arrived into something a human can act on. */
export function errText(e) {
  if (!e) return 'unknown error';
  const parts = [];
  if (Array.isArray(e.errors) && e.errors.length) {
    for (const sub of e.errors) {
      const bit = [sub?.code, sub?.syscall, sub?.address && `${sub.address}:${sub.port ?? ''}`, sub?.message]
        .filter(Boolean).join(' ');
      if (bit) parts.push(bit);
    }
  }
  if (e.message) parts.push(e.message);
  if (!parts.length && e.code) parts.push(`${e.code}${e.syscall ? ' ' + e.syscall : ''}`);
  return parts.join(' | ') || String(e) || 'unknown error';
}

/* Any failure to reach an SMTP port on a host that blocks them looks like this,
   so say the useful thing rather than echoing a raw errno. */
function smtpUnreachable(detail) {
  return `Could not reach ${SMTP_HOST()}:${SMTP_PORT()} — ${detail}. `
       + "If this is Render's free tier, that is expected: free instances block outbound SMTP "
       + '(ports 25, 465, 587). Remove GMAIL_USER and GMAIL_APP_PASSWORD and set BREVO_API_KEY '
       + 'instead — Brevo sends over HTTPS, which is not blocked.';
}

function connect(timeoutMs) {
  return new Promise((resolve, reject) => {
    const host = SMTP_HOST();
    const s = tls.connect(
      { host, port: SMTP_PORT(), servername: host,
        rejectUnauthorized: !SMTP_INSECURE() },
      () => resolve(s));
    s.setTimeout(timeoutMs, () => {
      s.destroy();
      reject(new Error(smtpUnreachable('the connection timed out')));
    });
    s.once('error', e => reject(new Error(smtpUnreachable(errText(e)))));
  });
}

const BREVO_KEY = () => (process.env.BREVO_API_KEY || '').trim();

export function mailProvider() {
  if (GMAIL_USER() && GMAIL_PASS()) return 'gmail';
  if (BREVO_KEY()) return 'brevo';
  if (RESEND_KEY()) return 'resend';
  return 'none';
}

/* Gmail needs a raw SMTP socket. Brevo and Resend are plain HTTPS on 443.
   That distinction decides whether a host can send mail at all: Render's free
   tier blocks outbound 25/465/587, so SMTP times out there no matter how
   correct the credentials are. */
export const providerUsesSmtp = () => mailProvider() === 'gmail';

export function mailFrom() {
  if (process.env.MAIL_FROM) return process.env.MAIL_FROM;
  if (mailProvider() === 'gmail') return `Resell.AI <${GMAIL_USER()}>`;
  if (mailProvider() === 'brevo') return 'Resell.AI <no-reply@example.com>';
  return 'Resell.AI <onboarding@resend.dev>';
}

/* Split "Name <a@b.c>" into its parts — Brevo wants them as separate fields. */
function splitAddr(a) {
  const m = String(a).match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return m ? { name: m[1] || 'Resell.AI', email: m[2].trim() } : { name: 'Resell.AI', email: String(a).trim() };
}

/* ───────────────────────────── SMTP plumbing ───────────────────────────── */

/* Reads one complete SMTP reply. Replies can span several lines: continuation
   lines are "250-TEXT", the final line is "250 TEXT". Treating the first line
   as the whole reply is the classic way to desynchronise an SMTP session. */
function readReply(sock, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const done = (fn, arg) => {
      clearTimeout(timer);
      sock.removeListener('data', onData);
      sock.removeListener('error', onErr);
      fn(arg);
    };
    const timer = setTimeout(() => done(reject, new Error('SMTP server did not reply in time')), timeoutMs);
    const onErr = e => done(reject, e);
    const onData = chunk => {
      buf += chunk.toString('utf8');
      const lines = buf.split(/\r?\n/).filter(Boolean);
      if (!lines.length) return;
      const last = lines[lines.length - 1];
      // final line has a space (not a hyphen) after the 3-digit code
      if (/^\d{3} /.test(last)) {
        done(resolve, { code: Number(last.slice(0, 3)), text: lines.join('\n') });
      }
    };
    sock.on('data', onData);
    sock.on('error', onErr);
  });
}

async function cmd(sock, line, expect, timeoutMs, redact = false) {
  if (line !== null) sock.write(line + '\r\n');
  const reply = await readReply(sock, timeoutMs);
  if (!expect.includes(reply.code)) {
    const sent = redact ? '<credentials>' : line;
    const err = new Error(smtpHint(reply, sent));
    err.smtpCode = reply.code;
    throw err;
  }
  return reply;
}

/* Turns SMTP's terse codes into something you can act on. */
function smtpHint(reply, sent) {
  const t = reply.text || '';
  if (reply.code === 535 || /username and password not accepted|BadCredentials/i.test(t)) {
    return 'Gmail rejected the login. Use a 16-character App Password (not your normal Google password), '
         + 'and make sure 2-step verification is on for that account.';
  }
  if (/application-specific password required/i.test(t)) {
    return 'Gmail requires an App Password for this account. Turn on 2-step verification, then create one.';
  }
  if (reply.code === 534 || /support\.google\.com\/accounts\/answer\/6010255/.test(t)) {
    return 'Google blocked the sign-in as insecure. An App Password with 2-step verification fixes this.';
  }
  if (reply.code === 550 || reply.code === 553) {
    return `The server refused the address: ${t.slice(0, 200)}`;
  }
  if (reply.code === 421 || reply.code === 454) {
    return 'Gmail is rate-limiting or temporarily unavailable. Free accounts allow about 500 recipients a day.';
  }
  return `SMTP error ${reply.code} after ${sent}: ${t.slice(0, 200)}`;
}

const b64 = s => Buffer.from(String(s), 'utf8').toString('base64');

/* RFC 2047 for non-ASCII subjects, so accented characters do not arrive as
   mojibake. Pure-ASCII subjects are left alone. */
const encodeHeader = s =>
  /^[\x20-\x7E]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;

function buildMessage({ from, to, subject, text, html }) {
  const boundary = 'rai_' + crypto.randomBytes(12).toString('hex');
  const wrap = s => b64(s).replace(/(.{76})/g, '$1\r\n');
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@resell.ai>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(html),
    `--${boundary}--`,
    ''
  ].join('\r\n');
}

/* Bare address for the SMTP envelope: "Name <a@b.c>" -> "a@b.c" */
const bare = a => {
  const m = String(a).match(/<([^>]+)>/);
  return (m ? m[1] : String(a)).trim();
};

async function sendViaGmail({ to, subject, text, html }) {
  const user = GMAIL_USER(), pass = GMAIL_PASS();
  const from = mailFrom();
  const TIMEOUT = 20_000;

  const sock = await connect(TIMEOUT);

  try {
    await cmd(sock, null, [220], TIMEOUT);                       // greeting
    await cmd(sock, 'EHLO resell.ai', [250], TIMEOUT);
    await cmd(sock, 'AUTH LOGIN', [334], TIMEOUT);
    await cmd(sock, b64(user), [334], TIMEOUT, true);
    await cmd(sock, b64(pass), [235], TIMEOUT, true);
    await cmd(sock, `MAIL FROM:<${bare(from)}>`, [250], TIMEOUT);
    await cmd(sock, `RCPT TO:<${bare(to)}>`, [250, 251], TIMEOUT);
    await cmd(sock, 'DATA', [354], TIMEOUT);
    sock.write(buildMessage({ from, to, subject, text, html }));
    await cmd(sock, '.', [250], TIMEOUT);
    try { await cmd(sock, 'QUIT', [221], 4000); } catch { /* server may just close */ }
    return { delivered: true, provider: 'gmail' };
  } finally {
    sock.destroy();
  }
}

async function sendViaBrevo({ to, subject, text, html }) {
  const sender = splitAddr(mailFrom());
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_KEY(), 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender, to: [{ email: to }], subject, textContent: text, htmlContent: html })
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    if (r.status === 400 && /sender/i.test(body)) {
      throw new Error('Brevo rejected the sender address. Verify it under Senders & IP in the Brevo dashboard, '
                    + 'then set MAIL_FROM to that exact address.');
    }
    throw new Error(`Brevo rejected the message (${r.status}): ${body.slice(0, 200)}`);
  }
  return { delivered: true, provider: 'brevo' };
}

async function sendViaResend({ to, subject, text, html }) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${RESEND_KEY()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: mailFrom(), to, subject, text, html })
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Resend rejected the message (${r.status}): ${body.slice(0, 200)}`);
  }
  return { delivered: true, provider: 'resend' };
}

/* ───────────────────────────── public API ───────────────────────────── */

export async function sendCode(to, code) {
  const subject = `${code} is your Resell.AI code`;
  const text = `Your Resell.AI sign-in code is ${code}\n\n`
             + `It expires in 10 minutes. If you didn't ask for this, ignore this email.`;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#0b0c0f">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0c0f;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#14161c;border-radius:18px;padding:32px">
        <tr><td style="font:600 13px/1 -apple-system,Segoe UI,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#d7ff3e;padding-bottom:14px">Resell.AI</td></tr>
        <tr><td style="font:700 21px/1.3 -apple-system,Segoe UI,sans-serif;color:#f7f8fa;padding-bottom:8px">Your sign-in code</td></tr>
        <tr><td style="font:400 15px/1.55 -apple-system,Segoe UI,sans-serif;color:#9ba1ae;padding-bottom:22px">Enter this in the app to finish signing in.</td></tr>
        <tr><td align="center" style="background:#0b0c0f;border-radius:12px;padding:20px">
          <span style="font:700 34px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.22em;color:#f7f8fa">${code}</span>
        </td></tr>
        <tr><td style="font:400 13px/1.55 -apple-system,Segoe UI,sans-serif;color:#5e6472;padding-top:22px">
          This code expires in 10 minutes. If you didn't request it, you can ignore this email.</td></tr>
      </table>
    </td></tr>
  </table></body></html>`;

  const provider = mailProvider();
  if (provider === 'gmail')  return sendViaGmail({ to, subject, text, html });
  if (provider === 'brevo')  return sendViaBrevo({ to, subject, text, html });
  if (provider === 'resend') return sendViaResend({ to, subject, text, html });

  console.log(`\n  ✉  [no mail provider configured] code for ${to}: ${code}\n`);
  return { delivered: false, provider: 'none' };
}

/* Used by the startup banner and the diagnose endpoint. Proves the credentials
   authenticate without actually sending anything to a real person. */
export async function verifyMailLogin() {
  const provider = mailProvider();
  if (provider === 'none') return { ok: false, reason: 'no mail provider configured' };
  /* HTTP providers have no login step to verify up front; a bad key surfaces
     on the first send with a specific message. */
  if (provider !== 'gmail') return { ok: true, reason: `${provider} uses HTTPS — nothing to pre-verify` };

  let sock;
  try {
    sock = await connect(15_000);
  } catch (e) {
    /* This used to sit outside the try. When the connection failed — which is
       guaranteed on a host that blocks SMTP — the rejection escaped, and any
       caller without its own catch took the whole process down with it. */
    return { ok: false, reason: e.message };
  }

  try {
    await cmd(sock, null, [220], 15_000);
    await cmd(sock, 'EHLO resell.ai', [250], 15_000);
    await cmd(sock, 'AUTH LOGIN', [334], 15_000);
    await cmd(sock, b64(GMAIL_USER()), [334], 15_000, true);
    await cmd(sock, b64(GMAIL_PASS()), [235], 15_000, true);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: errText(e) };
  } finally {
    sock.destroy();
  }
}
