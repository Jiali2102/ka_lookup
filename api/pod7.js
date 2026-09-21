const CALLBACK_LOGS_URL = process.env.GHN_CALLBACK_LOGS_URL;
const TYPE_ORDER = { PICK: 0, DELIVER: 1, RETURN: 2 };

function getEpodType(url) {
  try {
    const u = new URL(url);
    return (u.searchParams.get("type") || "").toUpperCase();
  } catch (err) {
    return "";
  }
}

function extractEpodUrls(callbackEntries) {
  const seen = new Set();
  const urlsWithType = [];

  function addUrl(url) {
    if (url && !seen.has(url)) {
      seen.add(url);
      const type = getEpodType(url);
      urlsWithType.push({ order: TYPE_ORDER[type] !== undefined ? TYPE_ORDER[type] : 99, type: type || "?", url });
    }
  }

  (callbackEntries || []).forEach(entry => {
    const trackings = ((entry.request || {}).request || {}).trackings || [];
    trackings.forEach(tr => {
      const extendFields = tr.extend_fields || {};

      // Một số tracking chỉ có "epod" là 1 URL trực tiếp (không có epod_details)
      if (typeof extendFields.epod === "string") {
        addUrl(extendFields.epod);
      }

      // Một số tracking khác có "epod_details" là mảng { url }
      const epodDetails = extendFields.epod_details || [];
      epodDetails.forEach(detail => addUrl(detail && detail.url));
    });
  });

  urlsWithType.sort((a, b) => a.order - b.order);
  return urlsWithType.map(({ type, url }) => ({ type, url }));
}

async function fetchCallbackLogsOnce(orderCode, userAgent, token) {
  const res = await fetch(`${CALLBACK_LOGS_URL}${encodeURIComponent(orderCode)}`, {
    method: "GET",
    headers: {
      "User-Agent": userAgent,
      Token: token,
      "Content-Type": "application/json"
    }
  });
  return res;
}

module.exports = async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (err) {
    res.status(200).json({ ok: false, message: "Lỗi hệ thống: " + err.message });
  }
};

async function handleRequest(req, res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, message: "Chỉ hỗ trợ POST." });
    return;
  }

  const { order_code, user_agent, token } = req.body || {};

  if (!order_code || !user_agent || !token) {
    res.status(400).json({ ok: false, message: "Thiếu order_code, user_agent hoặc token." });
    return;
  }

  let waitMs = 800;
  let lastError = null;

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetchCallbackLogsOnce(order_code, user_agent, token);

      if (response.status === 429) {
        lastError = "Bị giới hạn tần suất (429)";
        await new Promise(r => setTimeout(r, waitMs));
        waitMs *= 2;
        continue;
      }

      if (!response.ok) {
        res.status(200).json({
          ok: false,
          order_code,
          message: `Lỗi HTTP ${response.status}`
        });
        return;
      }

      const data = await response.json();
      const callbackEntries = ((data.data || {}).data) || [];
      const urls = extractEpodUrls(callbackEntries);

      const pickCount = urls.filter(u => u.type === "PICK").length;
      const deliverCount = urls.filter(u => u.type === "DELIVER").length;
      const returnCount = urls.filter(u => u.type === "RETURN").length;

      res.status(200).json({
        ok: true,
        order_code,
        urls,
        pick_count: pickCount,
        deliver_count: deliverCount,
        return_count: returnCount
      });
      return;
    } catch (err) {
      lastError = err.message;
      await new Promise(r => setTimeout(r, waitMs));
      waitMs *= 2;
    }
  }

  res.status(200).json({
    ok: false,
    order_code,
    message: lastError || "Không xác định"
  });
}
