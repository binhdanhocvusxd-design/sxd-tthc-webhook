
import express from "express";
import bodyParser from "body-parser";
import { google } from "googleapis";
import Fuse from "fuse.js";
import _ from "lodash";

const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "TTHC";

const app = express();
app.use(bodyParser.json());

const removeVietnameseTones = (str) => {
  if (!str) return "";
  return str
    .normalize("NFD").replace(/[̀-\u036f]/g, "")
    .replace(/đ/g, "d").replace(/Đ/g, "D")
    .toLowerCase().replace(/\s+/g, " ").trim();
};

let cache = { rows: [], fuse: null, lastLoad: 0 };

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

const INFO_KEY_TO_COL = {
  thoi_gian: "thoi_han",
  thoi_han: "thoi_han",
  trinh_tu: "trinh_tu",
  le_phi: "phi_le_phi",
  phi_le_phi: "phi_le_phi",
  thanh_phan_hs: "thanh_phan_hs",
  ho_so: "thanh_phan_hs",
  doi_tuong: "doi_tuong",
  co_quan: "co_quan_thuc_hien",
  noi_nop: "noi_tiep_nhan",
  ket_qua: "ket_qua",
  can_cu: "can_cu",
  dieu_kien: "dieu_kien",
  hinh_thuc_nop: "hinh_thuc_nop",
  linh_vuc: "linh_vuc",
  cap_thuc_hien: "cap_thuc_hien",
  loai_thu_tuc: "loai_thu_tuc"
};

async function loadSheet() {
  const now = Date.now();
  if (now - cache.lastLoad < 5 * 60 * 1000 && cache.rows.length) return;

  const auth = await google.auth.getClient({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
  });
  const sheets = google.sheets({ version: "v4", auth });

  const range = `${SHEET_NAME}!A1:Q`;
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range
  });

  const [header, ...rows] = data.values || [];
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const toObj = (r) =>
    Object.fromEntries(Object.keys(COLUMN_MAP).map((k) => [k, r[idx[k]] || ""]));

  const parsed = rows.map(toObj).filter((r) => r.thu_tuc);
  parsed.forEach((r) => (r._thu_tuc_norm = removeVietnameseTones(r.thu_tuc)));

  const fuse = new Fuse(parsed, {
    keys: ["thu_tuc", "_thu_tuc_norm"],
    includeScore: true,
    threshold: 0.42,
    ignoreLocation: true,
    minMatchCharLength: 3
  });

  cache = { rows: parsed, fuse, lastLoad: now };
}

function chipsForProcedures(list) {
  const options = list.slice(0, 8).map((r) => {
    const item = r.item || r;
    return {
      text: item.thu_tuc,
      event: {
        name: "CHON_THU_TUC",
        languageCode: "vi",
        parameters: { ma_thu_tuc: item.ma_thu_tuc }
      }
    };
  });
  return [{ type: "chips", options }];
}

function chipsForInfo(proc) {
  const defs = [
    ["🗂️ Thành phần hồ sơ", "thanh_phan_hs"],
    ["⏱️ Thời hạn giải quyết", "thoi_han"],
    ["🧭 Trình tự thực hiện", "trinh_tu"],
    ["💳 Phí, lệ phí", "phi_le_phi"],
    ["📍 Nơi tiếp nhận", "noi_tiep_nhan"],
    ["🏢 Cơ quan thực hiện", "co_quan_thuc_hien"],
    ["👥 Đối tượng", "doi_tuong"],
    ["📄 Kết quả", "ket_qua"],
    ["⚖️ Căn cứ pháp lý", "can_cu"],
    ["✅ Điều kiện", "dieu_kien"],
    ["🌐 Hình thức nộp", "hinh_thuc_nop"]
  ];
  const options = defs
    .filter(([, col]) => (proc[col] || "").trim().length)
    .map(([label, col]) => ({
      text: label,
      event: {
        name: "XEM_CHI_TIET_TTHC",
        languageCode: "vi",
        parameters: { ma_thu_tuc: proc.ma_thu_tuc, info_key: col }
      }
    }));
  return [{ type: "chips", options }];
}

app.post("/fulfillment", async (req, res) => {
  try {
    await loadSheet();

    const body = req.body;
    const params = _.get(body, "queryResult.parameters", {});
    const queryText = _.get(body, "queryResult.queryText", "");
    // Read parameters as per your current Dialogflow intent (Cách A)
    const rawTTHC = (params.procedure_name || params["any"] || "").toString();
    const infoRaw = (params.TTHC_Info || "").toString().toLowerCase();
    const info_key = INFO_KEY_TO_COL[infoRaw] || infoRaw;

    const ev = _.get(body, "originalDetectIntentRequest.payload.event", null);
    const evParams = ev?.parameters || {};
    const chosenMa = evParams.ma_thu_tuc || params.ma_thu_tuc;

    let proc = null;

    if (chosenMa) {
      proc = cache.rows.find((r) => r.ma_thu_tuc === chosenMa);
    } else {
      const q = removeVietnameseTones(rawTTHC || queryText);
      const results = cache.fuse.search(q);

      if (!results.length || results[0].score > 0.42) {
        const payload = {
          richContent: [[
            { type: "description",
              title: "❓Bạn muốn tra cứu thủ tục nào?",
              text: ["Chọn trong các gợi ý dưới đây:"] },
            ...chipsForProcedures(results.length ? results : cache.rows.slice(0, 8))
          ]]
        };
        return res.json({ fulfillmentMessages: [{ payload }] });
      }
      proc = results[0].item;
    }

    const title = `**${proc.thu_tuc}**`;

    if (!info_key || !COLUMN_MAP[info_key]) {
      const payload = {
        richContent: [[
          { type: "description",
            title: title,
            text: [
              `Lĩnh vực: ${proc.linh_vuc || "-"}`,
              `Cấp thực hiện: ${proc.cap_thuc_hien || "-"}`
            ] },
          ...chipsForInfo(proc)
        ]]
      };
      return res.json({ fulfillmentMessages: [{ payload }] });
    }

    const value = proc[info_key] || "Chưa có dữ liệu.";
    const payload = {
      richContent: [[
        { type: "description", title: title, text: [] },
        { type: "description", title: `**${info_key.replaceAll("_", " ").toUpperCase()}**`, text: [value] },
        ...chipsForInfo(proc)
      ]]
    };
    return res.json({ fulfillmentMessages: [{ payload }] });
  } catch (e) {
    console.error(e);
    return res.json({
      fulfillmentText: "Xin lỗi, hệ thống đang gặp sự cố khi đọc dữ liệu. Vui lòng thử lại."
    });
  }
});

app.get("/", (_, res) => res.send("SXDSL TTHC Webhook OK"));
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Listening on " + PORT));
