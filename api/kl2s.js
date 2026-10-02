const crypto = require("crypto");

const COOKIE_NAME = "kl2s";
const TTL_SEC = 12 * 60 * 60;

function secret() {
  return process.env.N8N_LOOKUP_V2_KEY || "";
}

function sign(payload) {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

function issue(res, email) {
  if (!secret() || !email) return;
  const exp = Math.floor(Date.now() / 1000) + TTL_SEC;
  const payload = Buffer.from(`${String(email).toLowerCase()}|${exp}`).toString("base64url");
  const value = `${payload}.${sign(payload)}`;
  const cookie = `${COOKIE_NAME}=${value}; Path=/api; Max-Age=${TTL_SEC}; HttpOnly; Secure; SameSite=Strict`;
  const prev = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", prev ? [].concat(prev, cookie) : cookie);
}

function read(req) {
  const raw = String(req.headers.cookie || "");
  const m = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!m || !secret()) return null;
  const [payload, sig] = m[1].split(".");
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const [email, exp] = Buffer.from(payload, "base64url").toString().split("|");
  if (!email || Number(exp) * 1000 < Date.now()) return null;
  return { email, exp: Number(exp) };
}

module.exports = { issue, read };
