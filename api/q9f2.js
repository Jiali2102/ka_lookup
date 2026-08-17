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
