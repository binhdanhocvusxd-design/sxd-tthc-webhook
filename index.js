// index.js
import express from "express";
import bodyParser from "body-parser";
import { google } from "googleapis";
import Fuse from "fuse.js";
import _ from "lodash";

/** =========================
 *  CONFIG
 *  ========================= */
const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "TTHC";

// thời gian cache: 5 phút
const CACHE_TTL_MS = 5 * 60 * 1000;

// ngưỡng fuzzy (có thể chỉnh 0.45–0.55 tùy dữ liệu)
const FUSE_THRESHOLD = 0.5;

/** =========================
 *  APP
 *  ========================= */
const app = express();
app.use(bodyParser.json());

/** =========================
 *  UTIL
 *  ========================= */
const removeVietnameseTones = (str = "") =>
  str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const COLUMN_MAP = {
  ma_thu_tuc: "ma_thu_tuc",
  so_quyet_dinh: "so_quyet_dinh",
  thu_tuc: "thu_tuc",
  cap_thuc_hien: "cap_thuc_hien",
  loai_thu_tuc: "loai_thu_tuc",
  linh_vuc: "linh_vuc",
  trinh_tu: "trinh_tu",
  hinh_thuc_nop: "hinh_thuc_nop",
  thoi_han: "thoi_han",
  phi_le_phi: "phi_le_phi",
  thanh_phan_hs: "thanh_phan_hs",
  doi_tuong: "doi_tuong",
  co_quan_thuc_hien: "co_quan_thuc_hien",
  noi_tiep_nhan: "noi_tiep_nhan",
  ket_qua: "ket_qua",
  can_cu: "can_cu",
  dieu_kien: "dieu_kien",
};

const INFO_KEY_TO_LABEL = {
  thanh_phan_hs: "🗂️ Thành phần hồ sơ",
  thoi_han: "⏱️ Thời hạn giải quyết",
  trinh_tu: "🧭 Trình tự thực hiện",
  phi_le_phi: "💳 Phí, lệ phí",
  noi_tiep_nhan: "📍 Nơi tiếp nhận",
  co_quan_thuc_hien: "🏢 Cơ quan thực hiện",
  doi_tuong: "👥 Đối tượng",
  ket_qua: "📄 Kết quả",
  can_cu: "⚖️ Căn cứ pháp lý",
  dieu_kien: "✅ Điều kiện",
  hinh_thuc_nop: "🌐 Hình thức nộp",
  linh_vuc: "📚 Lĩnh vực",
  cap_thuc_hien: "🏷️ Cấp thực hiện",
  loai_thu_tuc: "🧾 Loại thủ tục",
};

// Những cột được coi là “thông tin chi tiết” để tạo chip
const DETAIL_COLS = [
  "thanh_phan_hs",
  "thoi_han",
  "trinh_tu",
  "phi_le_phi",
  "noi_tiep_nhan",
  "co_quan_thuc_hien",
  "doi_tuong",
  "ket_qua",
  "can_cu",
  "dieu_kien",
  "hinh_thuc_nop",
];

let cache = {
  lastLoad: 0,
  rows: [],
  fuse: null,
};

async function loadSheet() {
  const now = Date.now();
  if (now - cache.lastLoad < CACHE_TTL_MS && cache.rows.length) return;

  if (!SHEET_ID) throw new Error("SHEET_ID env is missing");

  const auth = await google.auth.getClient({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  const range = `${SHEET_NAME}!A1:Q`;
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });

  const [header = [], ...rows] = data.values || [];
  const colIdx = Object.fromEntries(header.map((h, i) => [h, i]));

  const toObj = (r) =>
    Object.fromEntries(
      Object.keys(COLUMN_MAP).map((k) => [k, r[colIdx[k]] || ""])
    );

  const parsed = rows
    .map(toObj)
    .filter((r) => r.thu_tuc && r.ma_thu_tuc)
    .map((r) => ({ ...r, _thu_tuc_norm: removeVietnameseTones(r.thu_tuc) }));

  const fuse = new Fuse(parsed, {
    keys: [
      "thu_tuc",
      "_thu_tuc_norm",
      "ma_thu_tuc",
      "linh_vuc",
      "loai_thu_tuc",
      "cap_thuc_hien",
    ],
    includeScore: true,
    threshold: FUSE_THRESHOLD,
    ignoreLocation: true,
    minMatchCharLength: 2,
  });

  cache = { lastLoad: now, rows: parsed, fuse };
}

/** =========================
 *  RICH CONTENT HELPERS (Dialogflow Messenger)
 *  ========================= */
function rcDescription(title, lines = []) {
  return { type: "description", title, text: lines };
}

function rcChips(options) {
  return { type: "chips", options };
}

function makeOptionChip(text, eventName, parameters = {}) {
  return {
    text,
    event: { name: eventName, languageCode: "vi", parameters },
  };
}

function payloadRichContent(blocks) {
  // blocks: array of arrays (each array = 1 column)
  return { richContent: blocks };
}

/** =========================
 *  BUILD RESPONSES
 *  ========================= */
function chipsForProcedures(list) {
  const options = list.slice(0, 8).map((r) => {
    const item = r.item || r;
    return makeOptionChip(item.thu_tuc, "CHON_THU_TUC", {
      ma_thu_tuc: item.ma_thu_tuc,
    });
  });
  // nút quay lại
  options.push(makeOptionChip("🔙 Quay lại", "BACK_TO_START", {}));
  return [rcChips(options)];
}

function chipsForInfo(proc) {
  const options = DETAIL_COLS.filter((col) =>
    String(proc[col] || "").trim().length
  ).map((col) =>
    makeOptionChip(INFO_KEY_TO_LABEL[col] || col, "XEM_CHI_TIET_TTHC", {
      ma_thu_tuc: proc.ma_thu_tuc,
      info_key: col,
    })
  );
  // Nút quay lại danh sách thủ tục?
  // Ở màn chi tiết thủ tục, “Quay lại” sẽ đưa về bảng chọn info của chính thủ tục
  options.push(
    makeOptionChip("🔙 Quay lại thủ tục", "BACK_TO_PROC", {
      ma_thu_tuc: proc.ma_thu_tuc,
    })
  );
  return [rcChips(options)];
}

function startPromptBlocks() {
  // Màn “bắt đầu” / fallback khi chưa hiểu
  return [
    rcDescription("❓Bạn muốn tra cứu thủ tục nào?", [
      "Hãy nhập từ khóa (ví dụ: **chứng chỉ thẩm tra viên**, **cấp phép xây dựng**, ...)",
      "Hoặc chọn ngay các gợi ý phổ biến bên dưới:",
    ]),
  ];
}

/** =========================
 *  CORE LOGIC
 *  ========================= */
function findProcByMa(ma) {
  return cache.rows.find((r) => r.ma_thu_tuc === ma);
}

function searchProcedures(qraw) {
  const q = removeVietnameseTones(qraw || "");
  if (!q) return [];
  return cache.fuse.search(q);
}

function respondWithProcedures(res, results, title = "Gợi ý thủ tục phù hợp") {
  const blocks = [
    [
      rcDescription(title, [
        results.length
          ? "Chọn một thủ tục bên dưới:"
          : "Không tìm thấy thủ tục phù hợp. Bạn có thể thử từ khóa khác.",
      ]),
      ...chipsForProcedures(results.length ? results : cache.rows.slice(0, 8)),
    ],
  ];
  return res.json({ fulfillmentMessages: [{ payload: payloadRichContent(blocks) }] });
}

function respondWithProcOverview(res, proc) {
  const lines = [
    `Lĩnh vực: ${proc.linh_vuc || "-"}`,
    `Cấp thực hiện: ${proc.cap_thuc_hien || "-"}`,
  ];
  const blocks = [[rcDescription(`**${proc.thu_tuc}**`, lines), ...chipsForInfo(proc)]];
  return res.json({ fulfillmentMessages: [{ payload: payloadRichContent(blocks) }] });
}

function respondWithProcDetail(res, proc, info_key) {
  const label = INFO_KEY_TO_LABEL[info_key] || info_key;
  const value = String(proc[info_key] || "").trim() || "Chưa có dữ liệu.";
  const blocks = [
    [
      rcDescription(`**${proc.thu_tuc}**`, []),
      rcDescription(`**${label.toUpperCase()}**`, [value]),
      ...chipsForInfo(proc),
    ],
  ];
  return res.json({ fulfillmentMessages: [{ payload: payloadRichContent(blocks) }] });
}

/** =========================
 *  WEBHOOK
 *  ========================= */
app.post("/fulfillment", async (req, res) => {
  try {
    await loadSheet();

    const body = req.body || {};
    const qr = body.queryResult || {};
    const params = qr.parameters || {};
    const action = qr.action || "";
    const queryText = qr.queryText || "";

    // Event từ chip (Dialogflow Messenger)
    const event = _.get(body, "originalDetectIntentRequest.payload.event", null);
    const evName = event?.name;
    const evParams = event?.parameters || {};

    // ƯU TIÊN: xử lý theo event (chip)
    if (evName === "CHON_THU_TUC") {
      const proc = findProcByMa(evParams.ma_thu_tuc);
      if (!proc) return respondWithProcedures(res, [], "Không tìm thấy thủ tục.");
      return respondWithProcOverview(res, proc);
    }

    if (evName === "XEM_CHI_TIET_TTHC") {
      const proc = findProcByMa(evParams.ma_thu_tuc);
      if (!proc) return respondWithProcedures(res, [], "Không tìm thấy thủ tục.");
      const info_key = evParams.info_key;
      return respondWithProcDetail(res, proc, info_key);
    }

    if (evName === "BACK_TO_PROC") {
      const proc = findProcByMa(evParams.ma_thu_tuc);
      if (!proc) return respondWithProcedures(res, [], "Không tìm thấy thủ tục.");
      return respondWithProcOverview(res, proc);
    }

    if (evName === "BACK_TO_START") {
      const blocks = [startPromptBlocks(), ...chipsForProcedures(cache.rows)];
      return res.json({
        fulfillmentMessages: [{ payload: payloadRichContent(blocks) }],
      });
    }

    // Intent TRA_CUU_TU_KHOA (action = "keyword")
    if (action === "keyword") {
      const k = params.keyword || queryText || "";
      const results = searchProcedures(k);
      return respondWithProcedures(res, results, `Gợi ý cho: “${k}”`);
    }

    // Nếu không có action/event rõ ràng:
    // 1) thử tìm theo queryText
    if (queryText) {
      const results = searchProcedures(queryText);
      if (results.length) return respondWithProcedures(res, results, "Gợi ý thủ tục");
    }

    // 2) fallback về màn bắt đầu + gợi ý top
    const blocks = [startPromptBlocks(), ...chipsForProcedures(cache.rows)];
    return res.json({ fulfillmentMessages: [{ payload: payloadRichContent(blocks) }] });
  } catch (e) {
    console.error(e);
    return res.json({
      fulfillmentText:
        "Xin lỗi, hệ thống đang gặp sự cố khi đọc dữ liệu. Vui lòng thử lại sau.",
    });
  }
});

app.get("/", (_, res) => res.send("SXDSL TTHC Webhook OK"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Webhook listening on " + PORT));
