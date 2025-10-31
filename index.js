// index.js — Dialogflow webhook for TTHC-SXD (Cloud Run)
// Works with Dialogflow Messenger richContent

const express = require("express");
const bodyParser = require("body-parser");
const { google } = require("googleapis");

// ====== CONFIG ======
const SHEET_ID = process.env.SHEET_ID;      // ví dụ: 1AbC... (bạn đã set trong Cloud Run)
const SHEET_NAME = process.env.SHEET_NAME || "TTHC"; // tên sheet: 'TTHC'
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 phút

// ====== APP ======
const app = express();
app.use(bodyParser.json());

// ====== GOOGLE SHEETS HELPERS ======
let cacheRows = null;
let cacheAt = 0;

function now() { return Date.now(); }

function headersMap(row) {
  // Chuẩn theo cấu trúc cột bạn đã gửi:
  // 1) ma_thu_tuc, 2) so_quyet_dinh, 3) thu_tuc, 4) cap_thuc_hien, 5) loai_thu_tuc,
  // 6) linh_vuc, 7) trinh_tu, 8) hinh_thuc_nop, 9) thoi_han, 10) phi_le_phi,
  // 11) thanh_phan_hs, 12) doi_tuong, 13) co_quan_thuc_hien, 14) noi_tiep_nhan,
  // 15) ket_qua, 16) can_cu, 17) dieu_kien
  return {
    ma_thu_tuc: row[0] || "",
    so_quyet_dinh: row[1] || "",
    thu_tuc: row[2] || "",
    cap_thuc_hien: row[3] || "",
    loai_thu_tuc: row[4] || "",
    linh_vuc: row[5] || "",
    trinh_tu: row[6] || "",
    hinh_thuc_nop: row[7] || "",
    thoi_han: row[8] || "",
    le_phi: row[9] || "",
    thanh_phan_hs: row[10] || "",
    doi_tuong: row[11] || "",
    co_quan_thuc_hien: row[12] || "",
    noi_tiep_nhan: row[13] || "",
    ket_qua: row[14] || "",
    can_cu: row[15] || "",
    dieu_kien: row[16] || ""
  };
}

async function getSheetRows() {
  if (cacheRows && (now() - cacheAt) < CACHE_TTL_MS) return cacheRows;

  const auth = await google.auth.getClient({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
  });
  const sheets = google.sheets({ version: "v4", auth });

  const range = `${SHEET_NAME}!A2:Q`; // từ hàng 2, 17 cột
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range
  });

  const values = res.data.values || [];
  const rows = values.map(headersMap).filter(r => r.thu_tuc);
  cacheRows = rows;
  cacheAt = now();
  return rows;
}

async function findByMa(ma) {
  const rows = await getSheetRows();
  return rows.find(r => (r.ma_thu_tuc || "").toString().trim() === (ma || "").toString().trim());
}

// ====== TEXT UTILS & SEARCH ======
function norm(s = "") {
  return s.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ").trim();
}

function containsAllTokens(title, tokens) {
  const t = norm(title);
  return tokens.every(tok => t.includes(tok));
}

function searchProcedures(keyword, rows) {
  const kNorm = norm(keyword || "");
  if (!kNorm) return { mode: "empty", items: [] };

  // exact first
  const exact = rows.filter(r => norm(r.thu_tuc) === kNorm);
  if (exact.length) return { mode: "exact", items: exact };

  // fuzzy
  const tokens = kNorm.split(" ").filter(x => x.length > 1);
  let cand = rows.filter(r => containsAllTokens(r.thu_tuc, tokens));

  // domain guard: nếu mention 'xay dung' -> chỉ giữ tiêu đề có 'xay dung'
  if (kNorm.includes("xay dung")) {
    cand = cand.filter(r => norm(r.thu_tuc).includes("xay dung"));
  }

  cand = cand.map(r => {
    const title = norm(r.thu_tuc);
    const hits = tokens.filter(t => title.includes(t));
    const score = hits.length / Math.max(tokens.length, 1);
    return { ...r, score };
  })
  .filter(r => r.score >= 0.35)
  .sort((a,b) => b.score - a.score)
  .slice(0, 12);

  return { mode: "fuzzy", items: cand };
}

// ====== DFM PAYLOAD BUILDERS ======
function dfm(obj) { // wrap helper
  return { fulfillmentMessages: [ { payload: obj } ] };
}

function listItem(r) {
  return {
    type: "list",
    title: r.thu_tuc,
    subtitle: `Lĩnh vực: ${r.linh_vuc || "-"} · Cấp: ${r.cap_thuc_hien || "-"}`,
    event: {
      name: "CHON_THU_TUC",
      languageCode: "vi",
      parameters: { ma_thu_tuc: r.ma_thu_tuc }
    }
  };
}

function chipsInfo(ma) {
  const M = (k,label) => ({
    text: label,
    event: {
      name: "XEM_CHI_TIET_TTHC",
      languageCode: "vi",
      parameters: { ma_thu_tuc: ma, info_key: k }
    }
  });
  return {
    type: "chips",
    options: [
      M("thanh_phan_hs","📦 Thành phần hồ sơ"),
      M("thoi_han","⏱ Thời hạn giải quyết"),
      M("trinh_tu","🧭 Trình tự thực hiện"),
      M("le_phi","💳 Phí, lệ phí"),
      M("noi_tiep_nhan","📍 Nơi tiếp nhận"),
      M("co_quan_thuc_hien","🏢 Cơ quan thực hiện"),
      M("doi_tuong","👤 Đối tượng"),
      M("ket_qua","🧾 Kết quả"),
      M("dieu_kien","✅ Điều kiện")
    ]
  };
}

function showInfoMenuPayload(row) {
  return {
    richContent: [[
      {
        type: "info",
        title: `**Thủ tục: ${row.thu_tuc}**`,
        subtitle: `Lĩnh vực: ${row.linh_vuc || "-"}\nCấp thực hiện: ${row.cap_thuc_hien || "-"}`
      },
      chipsInfo(row.ma_thu_tuc)
    ]]
  };
}

// ====== INTENT HANDLERS ======
async function handleTraCuuTuKhoa(req, res) {
  const p = req.body.queryResult.parameters || {};
  const keyword = (p.keyword || p.any || p.text || "").toString();

  const rows = await getSheetRows();
  const { mode, items } = searchProcedures(keyword, rows);

  if (items.length === 0) {
    return res.json(dfm({
      richContent: [[
        {
          type: "description",
          title: "**Chưa tìm thấy thủ tục phù hợp**",
          text: [
            "Bạn có thể gõ rõ hơn, ví dụ:",
            "• Cấp giấy phép xây dựng cho nhà ở riêng lẻ",
            "• Cấp lại chứng chỉ hành nghề hoạt động xây dựng"
          ]
        }
      ]]
    }));
  }

  if (mode === "exact" || items.length === 1) {
    return res.json(dfm(showInfoMenuPayload(items[0])));
  }

  // show candidate list (each item clickable)
  const list = items.map(listItem);
  return res.json(dfm({ richContent: [ list ] }));
}

async function handleChonThuTuc(req, res) {
  const p = req.body.queryResult.parameters || {};
  const ma = (p.ma_thu_tuc || "").toString();
  const row = await findByMa(ma);
  if (!row) {
    return res.json({ fulfillmentText: "Xin lỗi, không tìm thấy thủ tục. Bạn thử hỏi lại tên nhé." });
  }
  return res.json(dfm(showInfoMenuPayload(row)));
}

async function handleXemChiTiet(req, res) {
  const p = req.body.queryResult.parameters || {};
  const ma = (p.ma_thu_tuc || "").toString();
  const key = (p.info_key || p.TTHC_Info || p["TTHC_Info"] || "").toString();

  const row = await findByMa(ma);
  if (!row) {
    return res.json({ fulfillmentText: "Xin lỗi, không tìm thấy thủ tục. Bạn thử hỏi lại tên nhé." });
  }

  const label = {
    thanh_phan_hs: "Thành phần hồ sơ",
    thoi_han: "Thời hạn giải quyết",
    trinh_tu: "Trình tự thực hiện",
    le_phi: "Phí, lệ phí",
    noi_tiep_nhan: "Nơi tiếp nhận",
    co_quan_thuc_hien: "Cơ quan thực hiện",
    doi_tuong: "Đối tượng",
    ket_qua: "Kết quả",
    dieu_kien: "Điều kiện",
    huong_dan_nop: "Hướng dẫn nộp TTHC"
  };

  // dữ liệu đặc biệt "Hướng dẫn nộp" — 3 thẻ tĩnh
  if (key === "huong_dan_nop") {
    return res.json(dfm({
      richContent: [[
        { type:"description", title:"**Nộp trực tiếp**",
          text:[ "Nộp hồ sơ tại Bộ phận một cửa Sở Xây dựng Sơn La – Trung tâm PVHCC tỉnh..." ] },
        { type:"description", title:"**Dịch vụ bưu chính**",
          text:[ "Bạn có thể gửi hồ sơ/nhận kết quả tại bưu điện. Các bước: 1) Chuẩn bị hồ sơ; 2) Đến bưu điện; 3) ..." ] },
        { type:"description", title:"**Nộp trực tuyến**",
          text:[
            "Truy cập: https://dichvucong.gov.vn/... (Sơn La).",
            "1) Đăng nhập VNeID; 2) Tìm tên thủ tục; 3) Nộp hồ sơ & lệ phí; 4) Theo dõi kết quả."
          ] },
        {
          type:"chips",
          options: [
            { text:"🔙 Quay lại thủ tục",
              event:{ name:"BACK_TO_MENU", languageCode:"vi", parameters:{ ma_thu_tuc: ma } } }
          ]
        }
      ]]
    }));
  }

  const content = (row[key] || "").toString().trim() || "—";
  const title = label[key] || "Thông tin";

  return res.json(dfm({
    richContent: [[
      { type:"description", title:`**${title}**`, text:[ content ] },
      {
        type:"chips",
        options: [
          { text:"🔙 Quay lại thủ tục",
            event:{ name:"BACK_TO_MENU", languageCode:"vi", parameters:{ ma_thu_tuc: ma } } },
          { text:"📄 Hướng dẫn nộp TTHC",
            event:{ name:"XEM_CHI_TIET_TTHC", languageCode:"vi", parameters:{ ma_thu_tuc: ma, info_key:"huong_dan_nop" } } }
        ]
      }
    ]]
  }));
}

async function handleBackToMenu(req, res) {
  const p = req.body.queryResult.parameters || {};
  const ma = (p.ma_thu_tuc || "").toString();
  const row = await findByMa(ma);
  if (!row) {
    return res.json({ fulfillmentText: "Xin lỗi, không tìm thấy thủ tục. Bạn thử hỏi lại tên nhé." });
  }
  return res.json(dfm(showInfoMenuPayload(row)));
}

// ====== ROUTER ======
app.post("/fulfillment", async (req, res) => {
  try {
    const intent = (req.body.queryResult.intent && req.body.queryResult.intent.displayName) || "";
    switch (intent) {
      case "TRA_CUU_TU_KHOA":
        return await handleTraCuuTuKhoa(req, res);
      case "EVT_CHON_THU_TUC":
        return await handleChonThuTuc(req, res);
      case "EVT_XEM_CHI_TIET_TTHC":
        return await handleXemChiTiet(req, res);
      case "EVT_BACK_TO_MENU":
        return await handleBackToMenu(req, res);
      default:
        // Luôn trả cái gì đó để không rơi fallback ngầm
        return res.json({ fulfillmentText: "Xin lỗi, hệ thống đang bận. Bạn thử hỏi lại tên thủ tục nhé!" });
    }
  } catch (e) {
    console.error("Webhook error:", e);
    return res.json({ fulfillmentText: "Xin lỗi, có lỗi xảy ra khi xử lý. Bạn thử lại sau nhé." });
  }
});

// Health
app.get("/", (req, res) => res.send("OK"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Webhook listening on port " + PORT));
