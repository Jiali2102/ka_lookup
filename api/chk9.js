let warehouses = {};
let warehousesLoadError = null;
try {
  warehouses = require("./warehouses.json");
} catch (err) {
  warehousesLoadError = err.message;
  warehouses = {};
}

let wards = {};
try {
  wards = require("./wards.json");
} catch (err) {
  wards = {};
}

let statuses = {};
try {
  statuses = require("./statuses.json");
} catch (err) {
  statuses = {};
}

const TRACKING_URL = process.env.GHN_TRACKING_URL;
const HISTORY_URL = process.env.GHN_HISTORY_URL;
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

function warehouseName(id) {
  if (id === undefined || id === null || id === "") return { id: "", name: "", found: false };
  const normalizedId = String(id).trim().split(".")[0];
  const name = warehouses[normalizedId];
  return { id: normalizedId, name: name || "", found: Boolean(name) };
}

function warehouseNameOnly(id) {
  const info = warehouseName(id);
  if (!info.id) return "";
  return info.found ? info.name : info.id;
}

function wardInfo(wardCode) {
  if (!wardCode) return { district_name: "", province_name: "" };
  const w = wards[String(wardCode).trim()];
  return w ? { district_name: w.district_name || "", province_name: w.province_name || "" } : { district_name: "", province_name: "" };
}

function statusVietnamese(status, fallback) {
  if (!status) return fallback || "";
  return statuses[status] || fallback || status;
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

async function fetchOrderLogsOnce(orderCode, userAgent, token) {
  const res = await fetch(`${HISTORY_URL}${encodeURIComponent(orderCode)}`, {
    method: "GET",
    headers: {
      "User-Agent": userAgent,
      Token: token,
      "Content-Type": "application/json"
    }
  });
  return res;
}

function extractMaxCodAmount(historyJson) {
  const entries = (historyJson && historyJson.data && historyJson.data.data) || [];
  let maxCod = 0;
  entries.forEach(entry => {
    const oldCod = entry.old_data && typeof entry.old_data.cod_amount === "number" ? entry.old_data.cod_amount : null;
    const newCod = entry.new_data && typeof entry.new_data.cod_amount === "number" ? entry.new_data.cod_amount : null;
    if (oldCod !== null && oldCod > maxCod) maxCod = oldCod;
    if (newCod !== null && newCod > maxCod) maxCod = newCod;
  });
  return maxCod;
}

async function fetchMaxCodAmount(orderCode, userAgent, token) {
  try {
    const res = await fetchOrderLogsOnce(orderCode, userAgent, token);
    if (!res.ok) return null;
    const json = await res.json();
    return extractMaxCodAmount(json);
  } catch (err) {
    return null;
  }
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
      let lastOperator = "";
      let lastOperatorPhone = "";
      let firstReturnActionAtVN = "";
      if (trackingLogs.length) {
        const lastLog = trackingLogs[trackingLogs.length - 1];
        if (lastLog.action_at) lastActionAtVN = toVNTime(lastLog.action_at);

        for (let i = trackingLogs.length - 1; i >= 0; i--) {
          const executor = trackingLogs[i].executor || {};
          const opId = executor.employee_id || executor.client_id || "";
          const opName = executor.name || "";
          if (opId && opName) {
            lastOperator = (i === trackingLogs.length - 1)
              ? `${opId} - ${opName}`
              : `${opId} - ${opName} ↩️`;
            lastOperatorPhone = executor.phone || "";
            break;
          }
        }

        for (let i = 0; i < trackingLogs.length; i++) {
          if (trackingLogs[i].action_code === "RETURN") {
            firstReturnActionAtVN = toVNTime(trackingLogs[i].action_at);
            break;
          }
        }
      }

      const orderValue = Number(customField.OrderValue || 0);
      const trackingCodAmount = Number(orderInfo.cod_amount || 0);
      const historyMaxCod = await fetchMaxCodAmount(order_code, user_agent, token);
      const codAmount = Math.max(trackingCodAmount, historyMaxCod || 0);
      const insuranceValue = Number(orderInfo.insurance_value || 0);
      const packageValue = Number(customField.PackageValue || 0);
      const clientId = orderInfo.client_id;
      const statusName = orderInfo.status_name || "Not found";

      const compensation = Math.round(
        computeCompensation(statusName, orderValue, codAmount, insuranceValue, packageValue, clientId)
      );

      const pickWarehouseId = orderInfo.pick_warehouse_id;
      const deliverWarehouseId = orderInfo.deliver_warehouse_id;
      const returnWarehouseId = orderInfo.return_warehouse_id;
      const currentWarehouseId = orderInfo.current_warehouse_id;

      const pickWhInfo = warehouseName(pickWarehouseId);
      const deliverWhInfo = warehouseName(deliverWarehouseId);
      const returnWhInfo = warehouseName(returnWarehouseId);
      const currentWhInfo = warehouseName(currentWarehouseId);

      function mergeWh(info) {
        if (!info.id) return "";
        return info.found ? `${info.id} - ${info.name}` : info.id;
      }

      const fromWard = wardInfo(orderInfo.from_ward_code);
      const toWard = wardInfo(orderInfo.to_ward_code);
      const endDeliveryOrReturnVN = orderInfo.end_deliverytime
        ? toVNTime(orderInfo.end_deliverytime)
        : firstReturnActionAtVN;

      res.status(200).json({
        ok: true,
        order_code,
        created_date: toVNTime(orderInfo.created_date),
        end_picktime: toVNTime(orderInfo.end_picktime),
        end_delivery_or_return_vn: endDeliveryOrReturnVN,
        returned_date_vn: toVNTime(orderInfo.leadtime_order && orderInfo.leadtime_order.returned_date),
        status: orderInfo.status || "",
        status_name: statusName,
        status_vn: statusVietnamese(orderInfo.status, statusName),
        status_ops_name: orderInfo.status_ops_name || "",
        client_id: clientId,
        from_name: orderInfo.from_name || "",
        from_address: orderInfo.from_address || "",
        from_ward_code: orderInfo.from_ward_code || "",
        from_district_name: fromWard.district_name,
        from_province_name: fromWard.province_name,
        to_ward_code: orderInfo.to_ward_code || "",
        to_district_name: toWard.district_name,
        to_province_name: toWard.province_name,
        content: orderInfo.content || "",
        weight: orderInfo.weight || 0,
        converted_weight: orderInfo.converted_weight || 0,
        length: orderInfo.length || 0,
        width: orderInfo.width || 0,
        height: orderInfo.height || 0,
        order_value: orderValue,
        cod_amount: codAmount,
        insurance_value: insuranceValue,
        package_value: packageValue,
        last_action_at_vn: lastActionAtVN,
        last_operator: lastOperator,
        last_operator_phone: lastOperatorPhone,
        pick_warehouse_id: pickWarehouseId,
        deliver_warehouse_id: deliverWarehouseId,
        return_warehouse_id: returnWarehouseId,
        current_warehouse_id: currentWarehouseId,
        pickwh: mergeWh(pickWhInfo),
        deliverywh: mergeWh(deliverWhInfo),
        returnwh: mergeWh(returnWhInfo),
        currentwh: mergeWh(currentWhInfo),
        pick_warehouse_name: warehouseNameOnly(pickWarehouseId),
        deliver_warehouse_name: warehouseNameOnly(deliverWarehouseId),
        return_warehouse_name: warehouseNameOnly(returnWarehouseId),
        current_warehouse_name: warehouseNameOnly(currentWarehouseId),
        compensation,
        _wh_loaded: Object.keys(warehouses).length,
        _wh_load_error: warehousesLoadError,
        _wh_debug: {
          pick_id_raw: pickWarehouseId,
          pick_id_type: typeof pickWarehouseId,
          pick_found: pickWhInfo.found
        },
        _tracking_url_source: process.env.GHN_TRACKING_URL ? "env" : "fallback",
        _tracking_url_env_raw: JSON.stringify(process.env.GHN_TRACKING_URL || null),
        _tracking_url_used: TRACKING_URL
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
    message: lastError || "Không xác định",
    _tracking_url_source: process.env.GHN_TRACKING_URL ? "env" : "fallback",
    _tracking_url_env_raw: JSON.stringify(process.env.GHN_TRACKING_URL || null),
    _tracking_url_used: TRACKING_URL
  });
}
