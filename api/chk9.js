const TRACKING_URL = "https://fe-online-gateway.ghn.vn/order-tracking/public-api/internal/tracking-logs";
const DELIVERED = "Giao hàng thành công";
const LOST_STATUSES = ["Hàng thất lạc", "Hàng hư hỏng", "Huỷ đơn hàng"];

function calcDenquahan(orderValue, codAmount, insuranceValue, packageValue, clientId) {
  if (packageValue > 0) return packageValue;
  if (clientId === 3892833 || clientId === 4447237) {
    if (codAmount > 0) return codAmount;
    if (orderValue <= 1000000) return orderValue;
    return Math.max(1000000, Math.min(30000000, orderValue * 0.7));
  }
  if (insuranceValue !== 0) return insuranceValue;
  if (orderValue <= 1000000) return orderValue;
  return Math.max(1000000, Math.min(14000000, orderValue * 0.8));
}

function calcDenbosung(orderValue, codAmount, insuranceValue, packageValue) {
  if (packageValue > 0) return packageValue;
  if (codAmount === 0) {
    if (insuranceValue !== 0) return insuranceValue;
    if (orderValue <= 1000000) return orderValue;
    if (orderValue * 0.8 <= 1000000) return 1000000;
    if (orderValue * 0.8 > 20000000) return 14000000;
    return 0.8 * orderValue;
  }
  if (codAmount >= orderValue) return 0;
  if (orderValue < 1000000) return orderValue - codAmount;
  if (orderValue * 0.8 < 1000000) return 1000000 - codAmount;
  if (orderValue * 0.8 <= codAmount) return 0;
  if (orderValue >= 20000000) return Math.max(0, 14000000 - codAmount);
  return 0.8 * orderValue - codAmount;
}

function computeCompensation(statusName, orderValue, codAmount, insuranceValue, packageValue, clientId) {
  if (LOST_STATUSES.includes(statusName)) {
    return calcDenquahan(orderValue, codAmount, insuranceValue, packageValue, clientId);
  }
  if (statusName === DELIVERED) {
    return calcDenbosung(orderValue, codAmount, insuranceValue, packageValue);
  }
  return calcDenquahan(orderValue, codAmount, insuranceValue, packageValue, clientId);
}

function toVNTime(actionAt) {
  if (!actionAt) return "";
  const d = new Date(actionAt);
  return d.toLocaleString("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" });
}

async function fetchOnce(orderCode, userAgent, token) {
  const res = await fetch(TRACKING_URL, {
    method: "POST",
    headers: {
      "User-Agent": userAgent,
      Token: token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ order_code: orderCode, source: "inside_system" })
  });
  return res;
}

module.exports = async (req, res) => {
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
      const response = await fetchOnce(order_code, user_agent, token);

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
      const orderInfo = (data.data && data.data.order_info) || {};
      const customField = orderInfo.custom_field || {};
      const trackingLogs = (data.data && data.data.tracking_logs) || [];

      let lastActionAtVN = "";
      trackingLogs.forEach(log => {
        if (log.action_at) lastActionAtVN = toVNTime(log.action_at);
      });

      const orderValue = Number(customField.OrderValue || 0);
      const codAmount = Number(orderInfo.cod_amount || 0);
      const insuranceValue = Number(orderInfo.insurance_value || 0);
      const packageValue = Number(customField.PackageValue || 0);
      const clientId = orderInfo.client_id;
      const statusName = orderInfo.status_name || "Not found";

      const compensation = Math.round(
        computeCompensation(statusName, orderValue, codAmount, insuranceValue, packageValue, clientId)
      );

      res.status(200).json({
        ok: true,
        order_code,
        status_name: statusName,
        client_id: clientId,
        order_value: orderValue,
        cod_amount: codAmount,
        insurance_value: insuranceValue,
        package_value: packageValue,
        last_action_at_vn: lastActionAtVN,
        compensation
      });
      return;
    } catch (err) {
      lastError = err.message;
      await new Promise(r => setTimeout(r, waitMs));
      waitMs *= 2;
    }
  }

  res.status(200).json({ ok: false, order_code, message: lastError || "Không xác định" });
};
