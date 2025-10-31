// index.js (refactor 31/10) — Dialogflow Messenger + Google Sheet (read-only)
// Mục tiêu: khớp thủ tục chắc tay, không lẫn ngành; bấm chip -> luôn ra dữ liệu cột; có nút Back; UI gọn cho DF Messenger

import express from "express";
import bodyParser from "body-parser";
import { google } from "googleapis";
import Fuse from "fuse.js";
import _ from "lodash";

// ====== ENV ======
const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "TTHC";

// ====== APP ======
const app = express();
app.use(bodyParser.json());

// ====== Utils ======
const STOP_WORDS = new Set([
  "thu", "tuc", "thu_tuc", "thutuc",
  "giay", "giay_phep", "giayphep", "cap", "cap_moi", "cap_lai", "cap_doi",
  "ve", "la", "la_gi", "la gi", "lao", "the_nao", "the nao", "nhu_nao", "nhu nao",
  "xin", "lam", "muon", "toi", "tôi", "toi_muon", "toi muon",
  "quy_trinh", "trinh_tu", "thoi_gian", "ho_so", "le_phi", "phi",
  "o_dau", "o dau", "o", "tai", "bao_lau", "bao lau"
]);

const VN_NORMALIZE = (s) => (s || "")
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/đ/g, "d").replace(/Đ/g, "D")
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const toTokens = (s) => VN_NORMALIZE(s).split(" ").filter(Boolean);

// bóc hạt nhân câu hỏi: bỏ stopwords để lấy cụm danh từ core
const coreTokens = (s) => {
  const tks = toTokens(s);
  const core = tks.filter(t => !STOP_WORDS.has(t));
  return core.length ? core : tks; // nếu bỏ hết thì trả lại toàn bộ (để không “câm”)
};

const hasMustWords = (titleNorm, must) => {
  // require every token in `must` to appear in normalized title
  return must.every(m => titleNorm.includes(m));
};

// ====== Cache & Columns ======
let cache = { rows: [], fuse: null, last: 0 };

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
  dieu_kien: "dieu_kien"
};

const INFO_KEYS = new Set(Object.keys(COLUMN_MAP).filter(k => !["ma_thu_tuc","so_quyet_dinh","thu_tuc"].includes(k)));
const INFO_LABELS = {
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
  linh_vuc: "🧩 Lĩnh vực",
  cap_thuc_hien: "🏷️ Cấp thực hiện",
  loai_thu_tuc: "🔖 Loại thủ tục",
};

// ====== Load Google Sheet ======
async function ensureLoaded() {
  const now = Date.now();
  if (cache.rows.length && now - cache.last < 5 * 60 * 1000) return;

  const auth = await google.auth.getClient({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  const range = `${SHEET_NAME}!A1:Q`;
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });

  const [header, ...rows] = data.values || [];
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));

  const toObj = (r) =>
    Object.fromEntries(Object.keys(COLUMN_MAP).map((k) => [k, r[idx[k]] || ""]));

  const parsed = rows
    .map(toObj)
    .filter(r => r.thu_tuc);

  parsed.forEach(r => {
    r._thu_tuc_norm = VN_NORMALIZE(r.thu_tuc);
    r._tokens = toTokens(r.thu_tuc);
  });

  const fuse = new Fuse(parsed, {
    keys: ["thu_tuc", "_thu_tuc_norm"],
    threshold: 0.36,           // nới nhẹ so với trước (bao phủ hơn)
    includeScore: true,
    ignoreLocation: true,
    minMatchCharLength: 3
  });

  cache = { rows: parsed, fuse, last: now };
}

// ====== UI helpers (Dialogflow Messenger) ======
const desc = (title, lines = []) => ({
  type: "description",
  title, text: lines
});

const chips = (options) => [{ type: "chips", options }];
const divider = () => ({ type: "divider" });

const backChip = (ma_thu_tuc) => chips([{
  text: "⬅️ Quay lại thủ tục",
  event: { name: "BACK_TO_MENU", languageCode: "vi", parameters: { ma_thu_tuc } }
}]);

// Menu chọn thông tin của 1 thủ tục
function infoMenu(proc) {
  const opts = [];
  for (const key of INFO_KEYS) {
    const label = INFO_LABELS[key] || key;
    if ((proc[key] || "").trim().length === 0) continue; // ẩn mục trống
    opts.push({
      text: label,
      event: {
        name: "XEM_CHI_TIET_TTHC",
        languageCode: "vi",
        parameters: { ma_thu_tuc: proc.ma_thu_tuc, info_key: key }
      }
    });
  }
  return opts.length ? chips(opts) : chips([{ text: "Không có dữ liệu mục chi tiết." }]);
}

// Gợi ý thủ tục (support list dài)
function suggestionsBlock(title, items) {
  const list = [];
  list.push(desc(`**${title}**`, ["Chọn một thủ tục bên dưới:"]));
  list.push(divider());

  // In gọn từng dòng (mỗi item 1 description) + kèm chips ở cuối (tùy biến)
  const opts = [];
  for (const it of items.slice(0, 20)) { // giới hạn 20 cho gọn
    list.push(desc(it.thu_tuc, []));
    opts.push({
      text: it.thu_tuc.length > 24 ? it.thu_tuc.slice(0, 24) + "…" : it.thu_tuc,
      event: {
        name: "CHON_THU_TUC",
        languageCode: "vi",
        parameters: { ma_thu_tuc: it.ma_thu_tuc }
      }
    });
  }
  list.push(...chips(opts));
  return list;
}

// ====== Search logic ======
function searchProcedures(query) {
  const norm = VN_NORMALIZE(query);
  const core = coreTokens(query);

  // bắt buộc “xay dung” nếu phát hiện trong câu
  const must = [];
  if (norm.includes("xay dung")) must.push("xay", "dung");

  // 1) exact substring ưu tiên
  const exact = cache.rows.filter(r => r._thu_tuc_norm.includes(core.join(" ")));
  let list = exact;

  // 2) nếu exact ít, dùng Fuse rồi hậu kiểm must
  if (list.length < 2) {
    const rs = cache.fuse.search(norm).map(x => x.item);
    list = rs;
  }

  // hậu kiểm must
  if (must.length) {
    list = list.filter(r => hasMustWords(r._thu_tuc_norm, must));
  }

  // lọc trùng + ưu tiên tiêu đề chứa nguyên cụm core
  const uniq = [];
  const seen = new Set();
  for (const r of list) {
    if (seen.has(r.ma_thu_tuc)) continue;
    seen.add(r.ma_thu_tuc);
    uniq.push(r);
  }

  // sắp xếp ưu tiên
  uniq.sort((a, b) => {
    const aExact = a._thu_tuc_norm.includes(core.join(" ")) ? 1 : 0;
    const bExact = b._thu_tuc_norm.includes(core.join(" ")) ? 1 : 0;
    return bExact - aExact;
  });

  return uniq;
}

// ====== Fulfillment routing ======
app.post("/fulfillment", async (req, res) => {
  try {
    await ensureLoaded();

    const body = req.body;
    const qr = body.queryResult || {};
    const intentName = _.get(qr, "intent.displayName", "");
    const params = qr.parameters || {};
    const queryText = qr.queryText || "";

    // Event payload (Messenger)
    const evt = _.get(body, "originalDetectIntentRequest.payload.event", null);
    const evName = evt?.name || "";
    const evParams = evt?.parameters || {};

    // --- helpers
    const replyPayload = (blocks) => res.json({ fulfillmentMessages: [{ payload: { richContent: [blocks] } }] });

    // ===== 1) EVENT: CHỌN THỦ TỤC =====
    if (evName === "CHON_THU_TUC" || intentName === "EVT_CHON_THU_TUC") {
      const ma = evParams.ma_thu_tuc || params.ma_thu_tuc;
      const proc = cache.rows.find(r => r.ma_thu_tuc === ma);
      if (!proc) return replyPayload([desc("Xin lỗi", ["Không tìm thấy mã thủ tục."])]);
      const head = desc(`**${proc.thu_tuc}**`, [
        `Lĩnh vực: ${proc.linh_vuc || "-"}`,
        `Cấp thực hiện: ${proc.cap_thuc_hien || "-"}`
      ]);
      return replyPayload([head, divider(), ...infoMenu(proc)]);
    }

    // ===== 2) EVENT: XEM CHI TIẾT =====
    if (evName === "XEM_CHI_TIET_TTHC" || intentName === "EVT_XEM_CHI_TIET_TTHC") {
      const ma = evParams.ma_thu_tuc || params.ma_thu_tuc;
      let key = (evParams.info_key || params.info_key || "").toString();
      key = key.replace(/\s+/g, "_"); // phòng khi là plain text
      const proc = cache.rows.find(r => r.ma_thu_tuc === ma);
      if (!proc) return replyPayload([desc("Xin lỗi", ["Không tìm thấy mã thủ tục."])]);
      if (!INFO_KEYS.has(key)) {
        return replyPayload([desc("Mục bạn hỏi chưa rõ", ["Hãy chọn 1 mục trong danh sách dưới đây."]), ...infoMenu(proc)]);
      }
      const label = INFO_LABELS[key] || key.toUpperCase();
      const head = desc(`**${proc.thu_tuc}**`, []);
      const detail = desc(`**${label}**`, [(proc[key] || "Chưa có dữ liệu.")]);
      return replyPayload([head, detail, ...backChip(proc.ma_thu_tuc)]);
    }

    // ===== 3) EVENT: BACK =====
    if (evName === "BACK_TO_MENU" || intentName === "EVT_BACK_TO_MENU") {
      const ma = evParams.ma_thu_tuc || params.ma_thu_tuc;
      const proc = cache.rows.find(r => r.ma_thu_tuc === ma);
      if (!proc) return replyPayload([desc("Xin lỗi", ["Không tìm thấy mã thủ tục."])]);
      const head = desc(`**${proc.thu_tuc}**`, [
        `Lĩnh vực: ${proc.linh_vuc || "-"}`,
        `Cấp thực hiện: ${proc.cap_thuc_hien || "-"}`
      ]);
      return replyPayload([head, divider(), ...infoMenu(proc)]);
    }

    // ===== 4) INTENT: TRA_CUU_TU_KHOA (và mọi câu hỏi chung) =====
    if (intentName === "TRA_CUU_TU_KHOA" || intentName === "TraCuuTTHC" || intentName === "TracuuTTHC" || !intentName) {
      const keyword = (params.keyword || queryText || "").toString();
      const found = searchProcedures(keyword);

      if (!found.length) {
        return replyPayload([desc("Xin lỗi", ["Mình chưa nhận ra thủ tục bạn cần. Bạn mô tả rõ hơn tên thủ tục nhé?"])]);
      }

      if (found.length === 1) {
        // 1 kết quả → vào thẳng menu thông tin
        const proc = found[0];
        const head = desc(`**${proc.thu_tuc}**`, [
          `Lĩnh vực: ${proc.linh_vuc || "-"}`,
          `Cấp thực hiện: ${proc.cap_thuc_hien || "-"}`
        ]);
        return replyPayload([head, divider(), ...infoMenu(proc)]);
      }

      // Nhiều kết quả → gợi ý danh sách
      const blocks = suggestionsBlock("Gợi ý thủ tục", found.slice(0, 20));
      return replyPayload(blocks);
    }

    // ===== 5) Mặc định =====
    return replyPayload([desc("Xin lỗi", ["Mình chưa nhận ra ý bạn. Hãy thử diễn đạt tên thủ tục nhé!"])]);
  } catch (e) {
    console.error(e);
    return res.json({ fulfillmentText: "Xin lỗi, hệ thống đang bận. Bạn thử hỏi lại tên thủ tục nhé!" });
  }
});

app.get("/", (_, res) => res.send("SXDSL TTHC Webhook OK"));
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Listening on " + PORT));
