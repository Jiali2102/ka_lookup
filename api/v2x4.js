const crypto = require("crypto");

const AUTH_URL = process.env.N8N_WEBHOOK_URL;
const LOOKUP_URL = process.env.N8N_LOOKUP_V2_URL;
const LOOKUP_KEY = process.env.N8N_LOOKUP_V2_KEY;
const AUTH_TTL_MS = 15 * 60 * 1000;
const authCache = new Map();

function cacheKey(email, password) {
  return crypto.createHash("sha256").update(`${email}|${password}`).digest("hex");
}

async function verifyUser(email, password) {
  const key = cacheKey(email, password);
  const hit = authCache.get(key);
  if (hit && hit > Date.now()) return true;
  const params = new URLSearchParams({ t: "v1", e: email, k: password });
  const r = await fetch(`${AUTH_URL}?${params.toString()}`, { method: "GET" });
  if (!r.ok) return false;
  const data = await r.json().catch(() => ({}));
  if (data.ok !== true) return false;
  authCache.set(key, Date.now() + AUTH_TTL_MS);
  if (authCache.size > 200) authCache.delete(authCache.keys().next().value);
  return true;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, message: "Chỉ hỗ trợ POST." });
    return;
  }
  if (!AUTH_URL || !LOOKUP_URL || !LOOKUP_KEY) {
    res.status(500).json({ ok: false, message: "Server chưa cấu hình N8N_LOOKUP_V2_URL / N8N_LOOKUP_V2_KEY." });
    return;
  }
  const { c, e, k } = req.body || {};
  const codes = Array.isArray(c) ? c : String(c || "").split(/[\s,;]+/);
  if (!e || !k) {
    res.status(401).json({ ok: false, message: "Phiên đăng nhập không hợp lệ, vui lòng đăng nhập lại." });
    return;
  }
  if (!codes.filter(Boolean).length) {
    res.status(400).json({ ok: false, message: "Thiếu danh sách mã đơn." });
    return;
  }
  try {
    const okUser = await verifyUser(String(e), String(k));
    if (!okUser) {
      res.status(401).json({ ok: false, message: "Phiên đăng nhập không hợp lệ, vui lòng đăng nhập lại." });
      return;
    }
  } catch (err) {
    res.status(502).json({ ok: false, message: "Không xác thực được, thử lại." });
    return;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 55000);
  try {
    const upstream = await fetch(LOOKUP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-kl-key": LOOKUP_KEY },
      body: JSON.stringify({ codes: codes.filter(Boolean), email: String(e) }),
      signal: ctrl.signal
    });
    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); } catch (err) { data = { ok: false, message: `n8n trả về dữ liệu không hợp lệ (HTTP ${upstream.status}).` }; }
    res.status(200).json(data);
  } catch (err) {
    res.status(504).json({ ok: false, message: err.name === "AbortError" ? "Quá thời gian chờ (55 giây), thử lại với ít mã hơn." : "Không gọi được n8n." });
  } finally {
    clearTimeout(timer);
  }
};

module.exports.config = { maxDuration: 60 };
