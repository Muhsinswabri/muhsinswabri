/*
 * POST /api/contact — delivers the portfolio contact form to the owner's inbox.
 *
 * Serverless function in Vercel's Node format (an ES module whose default export is
 * `(req, res) => …`; package.json sets "type": "module"). It sends through Resend's HTTP API
 * with the built-in fetch (Node 18+), so there are no dependencies to install.
 *
 * Environment variables (set them on the host, never in the page):
 *   RESEND_API_KEY      required. Resend API key ("re_..."). Secret.
 *   CONTACT_TO_EMAIL    optional. Where messages go. Default: swabri2004@gmail.com
 *   CONTACT_FROM_EMAIL  optional. Sender shown in the inbox. Default: "Portfolio contact
 *                       <onboarding@resend.dev>", Resend's test sender, which only delivers to the
 *                       email address the Resend account was created with. To send from your own
 *                       address, verify a domain in Resend and set e.g. "Portfolio <hi@yourdomain>".
 *   ALLOWED_ORIGIN      optional. If set (e.g. https://swabri.dev), requests from other sites
 *                       are refused.
 *
 * The visitor's address is only ever used as Reply-To, never as the sender or the recipient.
 * Responses: 200 {ok:true} | 400 {error} invalid input | 405 wrong method | 403 bad origin |
 *            503 {error} email service not configured | 502 {error} provider failed.
 */

const DEFAULT_TO = "swabri2004@gmail.com";
const DEFAULT_FROM = "Portfolio contact <onboarding@resend.dev>";
const LIMITS = { name: 100, email: 254, message: 5000 };
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;      // already parsed by the host
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { error: "Method not allowed." });
  }

  const allowed = process.env.ALLOWED_ORIGIN;
  if (allowed && req.headers.origin && req.headers.origin !== allowed) {
    return send(res, 403, { error: "Origin not allowed." });
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    return send(res, 400, { error: "Invalid request." });
  }

  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim();
  const message = String(body.message || "").trim();
  const trap = String(body.company || "").trim();

  // Bots fill the hidden field: pretend success, send nothing.
  if (trap) return send(res, 200, { ok: true });

  if (!name || name.length > LIMITS.name) return send(res, 400, { error: "Please enter your name." });
  if (!EMAIL_RE.test(email) || email.length > LIMITS.email) return send(res, 400, { error: "Please enter a valid email address." });
  if (!message || message.length > LIMITS.message) return send(res, 400, { error: "Please write a message (up to 5000 characters)." });

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error("contact: RESEND_API_KEY is not set; message not sent.");
    return send(res, 503, { error: "Email delivery is not configured yet." });
  }

  const to = process.env.CONTACT_TO_EMAIL || DEFAULT_TO;
  const from = process.env.CONTACT_FROM_EMAIL || DEFAULT_FROM;
  const subject = `Portfolio message from ${name.replace(/[\r\n]+/g, " ")}`;
  const text = `Name: ${name}\nEmail: ${email}\n\n${message}\n`;
  const html =
    `<p><strong>Name:</strong> ${escapeHtml(name)}<br><strong>Email:</strong> ${escapeHtml(email)}</p>` +
    `<p style="white-space:pre-wrap">${escapeHtml(message)}</p>`;

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], reply_to: email, subject, text, html }),
    });
    if (!r.ok) {
      console.error("contact: Resend responded", r.status, await r.text().catch(() => ""));
      return send(res, 502, { error: "The message could not be sent." });
    }
  } catch (err) {
    console.error("contact: request to Resend failed", err);
    return send(res, 502, { error: "The message could not be sent." });
  }

  return send(res, 200, { ok: true });
}
