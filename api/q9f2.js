const crypto = require("crypto");

const KL2S_NAME = "kl2s";
const KL2S_TTL = 12 * 60 * 60;

function kl2sSign(payload) {
  return crypto.createHmac("sha256", process.env.N8N_LOOKUP_V2_KEY || "").update(payload).digest("base64url");
}

function kl2sIssue(res, email) {
  if (!process.env.N8N_LOOKUP_V2_KEY || !email) return;
  const exp = Math.floor(Date.now() / 1000) + KL2S_TTL;
  const payload = Buffer.from(`${String(email).toLowerCase()}|${exp}`).toString("base64url");
  res.setHeader("Set-Cookie", `${KL2S_NAME}=${payload}.${kl2sSign(payload)}; Path=/api; Max-Age=${KL2S_TTL}; HttpOnly; Secure; SameSite=Strict`);
}

function kl2sRead(req) {
  if (!process.env.N8N_LOOKUP_V2_KEY) return null;
  const m = String(req.headers.cookie || "").match(/(?:^|;\s*)kl2s=([^;]+)/);
  if (!m) return null;
  const [payload, sig] = m[1].split(".");
  if (!payload || !sig) return null;
  const expected = kl2sSign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const [email, exp] = Buffer.from(payload, "base64url").toString().split("|");
  if (!email || Number(exp) * 1000 < Date.now()) return null;
  return { email, exp: Number(exp) };
}

const LOOKUP_TYPES = new Set(["v1", "v2", "v3", "v4", "v5", "v6"]);

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");

  const target = process.env.N8N_WEBHOOK_URL;

  if (!target) {
    res.status(500).json({ ok: false, message: "Server chưa cấu hình N8N_WEBHOOK_URL." });
    return;
  }

  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";

  try {
    const upstream = await fetch(`${target}${qs}`, { method: "GET" });
    const text = await upstream.text();
    let q = {};
    try { q = Object.fromEntries(new URLSearchParams(qs.slice(1))); } catch (err) { }

    try {
      if (upstream.ok && LOOKUP_TYPES.has(String(q.t || "")) && q.e) {
        const data = JSON.parse(text);
        const passed = Array.isArray(data) || (data && data.ok !== false && (q.t !== "v1" || data.ok === true));
        if (passed) kl2sIssue(res, q.e);
      }
    } catch (err) {
    }

    res.status(upstream.status);
    res.setHeader(
      "Content-Type",
      upstream.headers.get("content-type") || "application/json"
    );
    res.send(text);
  } catch (err) {
    res.status(502).json({ ok: false, message: "Không gọi được webhook n8n." });
  }
};
