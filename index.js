// index.js — phiên bản đã tái cấu trúc theo “QUY TRÌNH HOẠT ĐỘNG”
// Node 18.x

import express from "express";
import bodyParser from "body-parser";
import { google } from "googleapis";
import Fuse from "fuse.js";
import _ from "lodash";

/** ========== CẤU HÌNH BẢNG TTHC ========= **/
const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "TTHC";

/** ========== APP ========= **/
const app = express();
app.use(bodyParser.json());

/** ========== TIỆN ÍCH ========= **/
const VN_NORM = (str) =>
  (str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const TOKENIZE = (s) =>
  VN_NORM(s)
    .split(" ")
    .filter((t) => t && t.length > 1); // bỏ token 1 ký tự

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
  loai_thu_tuc: "loai_thu_tuc",
};

let cache = { rows: [], lastLoad: 0, nameMap: new Map() };

/** Đọc Google Sheet + tạo chỉ mục */
async function loadSheet() {
  const now = Date.now();
  if (now - cache.lastLoad < 5 * 60 * 1000 && cache.rows.length) return;

  const auth = await google.auth.getClient({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  const range = `${SHEET_NAME}!A1:Q`;
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });

  const [header, ...rows] = data.values || [];
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const toObj = (r) =>
    Object.fromEntries(Object.keys(COLUMN_MAP).map((k) => [k, r[idx[k]] || ""]));

  const parsed = rows.map(toObj).filter((r) => r.thu_tuc);
  parsed.forEach((r) => {
    r._norm = VN_NORM(r.thu_tuc);
    r._tokens = TOKENIZE(r.thu_tuc);
  });

  // Bản đồ “tên gốc → record” để nhận khi UI trả về text chip
  const nameMap = new Map();
  for (const r of parsed) {
    nameMap.set(r.thu_tuc.trim(), r);
  }

  cache = { rows: parsed, lastLoad: now, nameMap };
}

/** Tìm thủ tục theo truy vấn “AND-token” + chấm điểm độ phủ */
function searchProcedures(qRaw, limit = 20) {
  const tokens = TOKENIZE(qRaw);
  if (!tokens.length) return [];

  const hits = [];
  for (const r of cache.rows) {
    // tất cả token đều phải hiện diện
    const ok = tokens.every((t) => r._norm.includes(t));
    if (!ok) continue;
    // điểm = tổng chiều dài token trùng / chiều dài tên chuẩn hóa
    const overlap =
      tokens.reduce((sum, t) => sum + (r._norm.includes(t) ? t.length : 0), 0) /
      Math.max(1, r._norm.length);
    hits.push({ score: 1 - overlap, item: r }); // score nhỏ hơn = tốt hơn
  }
  hits.sort((a, b) => a.score - b.score);
  return hits.slice(0, limit);
}

/** ======= UI helpers (Dialogflow Messenger richContent) ======= **/

// 1) Danh sách thủ tục dạng LIST (đẹp cho tiêu đề dài)
function listForProcedures(results, title = "**Gợi ý thủ tục**") {
  const items = results.slice(0, 20).map((r) => {
    const item = r.item || r;
    return {
      type: "list",
      title: item.thu_tuc, // người dùng click -> trả text = title
    };
  });
  return {
    fulfillmentMessages: [
      {
        payload: {
          richContent: [
            [
              { type: "description", title, text: ["Chọn một thủ tục bên dưới:"] },
              ...items,
            ],
          ],
        },
      },
    ],
  };
}

// 2) Menu chip chi tiết của một thủ tục (có Back + Hướng dẫn nộp)
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
    ["🌐 Hình thức nộp", "hinh_thuc_nop"],
    ["📌 Hướng dẫn nộp TTHC", "_huongdan_"], // đặc biệt
  ];

  const options = defs
    .filter(([_, col]) => col === "_huongdan_" || (proc[col] || "").trim().length)
    .map(([label, col]) => ({
      text: label,
      event: {
        name: "XEM_CHI_TIET_TTHC",
        languageCode: "vi",
        parameters: { ma_thu_tuc: proc.ma_thu_tuc, info_key: col },
      },
    }));

  // nút Back
  options.unshift({
    text: "⬅️ Quay lại thủ tục",
    event: {
      name: "BACK_TO_MENU",
      languageCode: "vi",
      parameters: { ma_thu_tuc: proc.ma_thu_tuc },
    },
  });

  return {
    payload: {
      richContent: [[{ type: "chips", options }]],
    },
  };
}

/** Nội dung “Hướng dẫn nộp TTHC” */
function huongDanNopCards() {
  return {
    payload: {
      richContent: [
        [
          {
            type: "description",
            title: "Nộp trực tiếp",
            text: [
              "Nộp hồ sơ trực tiếp tại Bộ phận một cửa Sở Xây dựng Sơn La - Trung tâm Phục vụ hành chính công tỉnh.",
              "Địa chỉ: Tầng 1, Toà nhà 7 tầng, Trung tâm Lưu trữ lịch sử tỉnh Sơn La (Khu Quảng trường Tây Bắc, phường Tô Hiệu, tỉnh Sơn La) hoặc Trung tâm phục vụ hành chính công xã, phường gần nhất.",
            ],
          },
          {
            type: "description",
            title: "Dịch vụ bưu chính",
            text: [
              "Bạn có thể gửi hồ sơ / nhận kết quả qua bưu điện.",
              "Các bước: 1) Chuẩn bị hồ sơ; 2) Đến bưu điện; 3) Chọn hình thức (gửi hồ sơ / nhận kết quả / cả hai); 4) Nhận kết quả tại địa chỉ đã đăng ký.",
            ],
          },
          {
            type: "description",
            title: "Nộp hồ sơ trực tuyến",
            text: [
              "Truy cập: https://dichvucong.gov.vn/p/home/dvc-dich-vu-cong-truc-tuyen-ds.html?pCoQuanId=426103",
              "Các bước (rút gọn): 1) Đăng nhập VNeID; 2) Tìm tên thủ tục; 3) Chọn cơ quan thực hiện; 4) Điền thông tin + đính kèm hồ sơ; 5) Chọn hình thức nhận kết quả; 6) Nộp lệ phí (nếu có); 7) Kiểm tra và hoàn tất.",
              "Hướng dẫn chi tiết: https://binhdanhocvusxd.com/huongdansudungdichvuso/abc",
            ],
          },
        ],
      ],
    },
  };
}

/** ======= XỬ LÝ CHÍNH ======= **/
app.post("/fulfillment", async (req, res) => {
  try {
    await loadSheet();

    const body = req.body;
    const params = _.get(body, "queryResult.parameters", {});
    const queryText = _.get(body, "queryResult.queryText", "").trim();

    // Kiểm tra event (khi click chip)
    const ev = _.get(body, "originalDetectIntentRequest.payload.event", null);
    const evName = ev?.name || "";
    const evParams = ev?.parameters || {};

    /** ===== 1) SỰ KIỆN: CHỌN THỦ TỤC ===== */
    if (evName === "CHON_THU_TUC") {
      const ma = evParams.ma_thu_tuc?.toString() || "";
      const proc = cache.rows.find((r) => r.ma_thu_tuc === ma);
      if (!proc) return res.json(listForProcedures([])); // phòng hờ

      const payload = chipsForInfo(proc);
      const card = {
        payload: {
          richContent: [
            [
              {
                type: "description",
                title: `**${proc.thu_tuc}**`,
                text: [
                  `Lĩnh vực: ${proc.linh_vuc || "-"}`,
                  `Cấp thực hiện: ${proc.cap_thuc_hien || "-"}`,
                ],
              },
            ],
          ],
        },
      };
      return res.json({ fulfillmentMessages: [card, payload] });
    }

    /** ===== 2) SỰ KIỆN: XEM CHI TIẾT ===== */
    if (evName === "XEM_CHI_TIET_TTHC") {
      const ma = evParams.ma_thu_tuc?.toString() || "";
      const infoKey = (evParams.info_key || "").toString();
      const proc = cache.rows.find((r) => r.ma_thu_tuc === ma);
      if (!proc) return res.json(listForProcedures([]));

      // Hướng dẫn nộp TTHC (đặc biệt)
      if (infoKey === "_huongdan_") {
        const title = { payload: { richContent: [[{ type: "description", title: `**${proc.thu_tuc}**`, text: [] }]] } };
        return res.json({
          fulfillmentMessages: [title, huongDanNopCards(), chipsForInfo(proc)],
        });
      }

      const col = COLUMN_MAP[infoKey];
      const value = (col && proc[col]) ? proc[col] : "Chưa có dữ liệu.";
      const fm = {
        payload: {
          richContent: [
            [
              { type: "description", title: `**${proc.thu_tuc}**`, text: [] },
              {
                type: "description",
                title: `**${infoKey.replaceAll("_", " ").toUpperCase()}**`,
                text: [value],
              },
            ],
          ],
        },
      };
      return res.json({ fulfillmentMessages: [fm, chipsForInfo(proc)] });
    }

    /** ===== 3) SỰ KIỆN: BACK ===== */
    if (evName === "BACK_TO_MENU") {
      const ma = evParams.ma_thu_tuc?.toString() || "";
      const proc = cache.rows.find((r) => r.ma_thu_tuc === ma);
      if (!proc) return res.json(listForProcedures([]));
      const card = {
        payload: {
          richContent: [
            [
              {
                type: "description",
                title: `**${proc.thu_tuc}**`,
                text: [
                  `Lĩnh vực: ${proc.linh_vuc || "-"}`,
                  `Cấp thực hiện: ${proc.cap_thuc_hien || "-"}`,
                ],
              },
            ],
          ],
        },
      };
      return res.json({ fulfillmentMessages: [card, chipsForInfo(proc)] });
    }

    /** ===== 4) DÒ TEXT = NHÃN CHIP (phòng trường hợp UI không gửi event) ===== */
    const exactProc = cache.nameMap.get(queryText);
    if (exactProc) {
      const card = {
        payload: {
          richContent: [
            [
              {
                type: "description",
                title: `**${exactProc.thu_tuc}**`,
                text: [
                  `Lĩnh vực: ${exactProc.linh_vuc || "-"}`,
                  `Cấp thực hiện: ${exactProc.cap_thuc_hien || "-"}`,
                ],
              },
            ],
          ],
        },
      };
      return res.json({ fulfillmentMessages: [card, chipsForInfo(exactProc)] });
    }

    /** ===== 5) XỬ LÝ Ý ĐỊNH TRA CỨU  ===== */
    const intent = _.get(body, "queryResult.intent.displayName", "");
    if (intent === "TraCuuTTHC") {
      const rawProc = (params.procedure_name || "").toString();
      const infoRaw = (params.TTHC_Info || "").toString().toLowerCase();
      const infoKey = INFO_KEY_TO_COL[infoRaw] || infoRaw;

      // Tìm thủ tục theo text người dùng
      let proc = null;
      if (rawProc) {
        const best = searchProcedures(rawProc, 1);
        if (best.length) proc = best[0].item;
      } else if (queryText) {
        const best = searchProcedures(queryText, 1);
        if (best.length) proc = best[0].item;
      }

      if (!proc) {
        const results = searchProcedures(queryText || rawProc);
        if (!results.length) {
          return res.json({
            fulfillmentText:
              "Mình chưa nhận ra thủ tục bạn cần. Bạn mô tả rõ hơn tên thủ tục nhé?",
          });
        }
        return res.json(listForProcedures(results));
      }

      // Có info -> trả thẳng chi tiết (Lựa chọn 2)
      if (infoKey && COLUMN_MAP[infoKey]) {
        const value = proc[infoKey] || "Chưa có dữ liệu.";
        const fm = {
          payload: {
            richContent: [
              [
                { type: "description", title: `**${proc.thu_tuc}**`, text: [] },
                {
                  type: "description",
                  title: `**${infoKey.replaceAll("_", " ").toUpperCase()}**`,
                  text: [value],
                },
              ],
            ],
          },
        };
        const chipXemThem = {
          payload: {
            richContent: [
              [
                {
                  type: "chips",
                  options: [
                    {
                      text: "Tìm hiểu thông tin khác về thủ tục này",
                      event: {
                        name: "BACK_TO_MENU",
                        languageCode: "vi",
                        parameters: { ma_thu_tuc: proc.ma_thu_tuc },
                      },
                    },
                  ],
                },
              ],
            ],
          },
        };
        return res.json({ fulfillmentMessages: [fm, chipXemThem] });
      }

      // Không có info -> menu chip chi tiết (Lựa chọn 1)
      const card = {
        payload: {
          richContent: [
            [
              {
                type: "description",
                title: `**${proc.thu_tuc}**`,
                text: [
                  `Lĩnh vực: ${proc.linh_vuc || "-"}`,
                  `Cấp thực hiện: ${proc.cap_thuc_hien || "-"}`,
                ],
              },
            ],
          ],
        },
      };
      return res.json({ fulfillmentMessages: [card, chipsForInfo(proc)] });
    }

    if (intent === "TRA_CUU_TU_KHOA" || intent === "Default Fallback Intent") {
      // Với keyword ngắn → gợi ý danh sách (lọc chặt)
      const base = params.keyword?.toString() || queryText;
      const results = searchProcedures(base);
      if (!results.length) {
        return res.json({
          fulfillmentText:
            "Mình chưa nhận ra thủ tục bạn cần. Bạn mô tả rõ hơn tên thủ tục nhé?",
        });
      }
      return res.json(listForProcedures(results));
    }

    // Mặc định
    return res.json({
      fulfillmentText:
        "Xin lỗi, hệ thống đang bận. Bạn thử hỏi lại tên thủ tục nhé!",
    });
  } catch (e) {
    console.error(e);
    return res.json({
      fulfillmentText:
        "Xin lỗi, hệ thống đang gặp sự cố khi đọc dữ liệu. Vui lòng thử lại.",
    });
  }
});

app.get("/", (_, res) => res.send("SXDSL TTHC Webhook OK"));
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Listening on " + PORT));
