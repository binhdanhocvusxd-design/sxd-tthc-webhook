import express from "express";
import bodyParser from "body-parser";
import { google } from "googleapis";
import Fuse from "fuse.js";
import _ from "lodash";

/** ====== CONFIG ====== **/
const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "TTHC";

/** ====== APP ====== **/
const app = express();
app.use(bodyParser.json());

/** ====== UTILS ====== **/
const vnNorm = (s) =>
  (s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d").replace(/Đ/g, "D")
    .toLowerCase().replace(/\s+/g, " ").trim();

const COLS = {
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

const INFO_KEYS = {
  trinh_tu: "trinh_tu",
  thoi_han: "thoi_han",
  le_phi: "phi_le_phi",
  phi_le_phi: "phi_le_phi",
  thanh_phan_hs: "thanh_phan_hs",
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

/** ====== CACHE + SHEET ====== **/
let cache = { rows: [], fuse: null, last: 0 };

async function loadSheet() {
  const now = Date.now();
  if (cache.rows.length && now - cache.last < 5 * 60 * 1000) return;

  const auth = await google.auth.getClient({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  const range = `${SHEET_NAME}!A1:Q`;
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range,
  });

  const [header, ...rows] = data.values || [];
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const toObj = (r) =>
    Object.fromEntries(Object.keys(COLS).map((k) => [k, r[idx[k]] || ""]));

  const parsed = rows.map(toObj).filter((r) => r.thu_tuc);
  parsed.forEach((r) => {
    r._thu_tuc_norm = vnNorm(r.thu_tuc);
  });

  const fuse = new Fuse(parsed, {
    keys: ["thu_tuc", "_thu_tuc_norm"],
    threshold: 0.44, // nới nhẹ để bao gần đúng
    includeScore: true,
    ignoreLocation: true,
    minMatchCharLength: 3,
  });

  cache = { rows: parsed, fuse, last: now };
}

const findByMa = (ma) => cache.rows.find((r) => r.ma_thu_tuc === ma);

/** ====== RENDER HELPERS (CCAI rich responses) ====== **/
const desc = (title, textLines = []) => ({
  type: "description",
  title,
  text: textLines,
});

const section = (title, text) => desc(`**${title}**`, [text || "Chưa có dữ liệu."]);

function chips(items) {
  return [{ type: "chips", options: items }];
}

function chipsChonThuTuc(list) {
  const opts = list.slice(0, 10).map((r) => {
    const item = r.item || r;
    return {
      text: item.thu_tuc,
      event: {
        name: "CHON_THU_TUC",
        languageCode: "vi",
        parameters: { ma_thu_tuc: item.ma_thu_tuc },
      },
    };
  });
  return chips(opts);
}

function chipsMenuThongTin(proc) {
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
  ];
  const infoOpts = defs
    .filter(([, k]) => (proc[k] || "").trim().length)
    .map(([label, k]) => ({
      text: label,
      event: {
        name: "XEM_CHI_TIET_TTHC",
        languageCode: "vi",
        parameters: { ma_thu_tuc: proc.ma_thu_tuc, info_key: k },
      },
    }));

  // “Hướng dẫn nộp TTHC”
  infoOpts.push({
    text: "📥 Hướng dẫn nộp thủ tục hành chính",
    event: {
      name: "HUONG_DAN_NOP",
      languageCode: "vi",
      parameters: { ma_thu_tuc: proc.ma_thu_tuc },
    },
  });

  return chips(infoOpts);
}

function chipBack(ma) {
  return chips([
    {
      text: "⬅️ Quay lại",
      event: {
        name: "BACK_TO_MENU",
        languageCode: "vi",
        parameters: { ma_thu_tuc: ma },
      },
    },
  ]);
}

function renderHuongDanNop(mode) {
  if (mode === "TRUC_TIEP") {
    return [
      desc("**Nộp trực tiếp**", [
        "Nộp hồ sơ trực tiếp tại **Bộ phận một cửa Sở Xây dựng Sơn La** - Trung tâm Phục vụ hành chính công tỉnh.",
        "Địa chỉ: **Tầng 1, Toà nhà 7 tầng, Trung tâm Lưu trữ lịch sử tỉnh Sơn La** (Khu Quảng trường Tây Bắc, phường Tô Hiệu, tỉnh Sơn La) **hoặc** Trung tâm phục vụ hành chính công xã, phường gần nhất.",
      ]),
    ];
  }
  if (mode === "BUU_CHINH") {
    return [
      desc("**Dịch vụ bưu chính**", [
        "Bạn có thể gửi hồ sơ/nhận kết quả qua bưu điện.",
        "Quy trình:",
        "1) Chuẩn bị hồ sơ theo hướng dẫn của chatbot.",
        "2) Đến bưu điện gần nhất.",
        "3) Chọn: chỉ gửi hồ sơ / chỉ nhận kết quả / cả hai.",
        "4) Nhân viên bưu điện chuyển hồ sơ đến cơ quan, sau khi giải quyết sẽ chuyển kết quả về địa chỉ của bạn.",
      ]),
    ];
  }
  if (mode === "TRUC_TUYEN") {
    return [
      desc("**Nộp hồ sơ trực tuyến**", [
        "Truy cập: https://dichvucong.gov.vn/p/home/dvc-dich-vu-cong-truc-tuyen-ds.html?pCoQuanId=426103",
        "Các bước tóm tắt:",
        "1) Đăng nhập VNeID → Tìm tên thủ tục (như chatbot cung cấp).",
        "2) Chọn tỉnh **Sơn La**, cơ quan **Sở Xây dựng Sơn La** (hoặc UBND xã/phường nếu phù hợp).",
        "3) Nhập thông tin người thực hiện; **thành phần hồ sơ** theo chatbot hướng dẫn.",
        "4) Chọn hình thức nhận kết quả.",
        "5) Thanh toán lệ phí (nếu có) trực tuyến – mức phí xem trong chatbot hướng dẫn.",
        "6) Kiểm tra và nộp hồ sơ.",
      ]),
    ];
  }
  // Màn chọn 3 phương thức
  return chips([
    {
      text: "🏢 Nộp trực tiếp",
      event: {
        name: "HUONG_DAN_NOP",
        languageCode: "vi",
        parameters: { mode: "TRUC_TIEP" },
      },
    },
    {
      text: "📮 Dịch vụ bưu chính",
      event: {
        name: "HUONG_DAN_NOP",
        languageCode: "vi",
        parameters: { mode: "BUU_CHINH" },
      },
    },
    {
      text: "🌐 Nộp trực tuyến",
      event: {
        name: "HUONG_DAN_NOP",
        languageCode: "vi",
        parameters: { mode: "TRUC_TUYEN" },
      },
    },
  ]);
}

/** ====== MAIN HANDLER ====== **/
app.post("/fulfillment", async (req, res) => {
  try {
    await loadSheet();

    const body = req.body;
    const intent = _.get(body, "queryResult.intent.displayName", "");
    const params = _.get(body, "queryResult.parameters", {});
    const queryText = _.get(body, "queryResult.queryText", "");

    // EVENT payload (click từ chips)
    const eventObj = _.get(
      body,
      "originalDetectIntentRequest.payload.event",
      null
    );
    const eventName = eventObj?.name || "";
    const eventParams = eventObj?.parameters || {};

    /** ===== Routing theo EVENT trước (ưu tiên chống lặp) ===== **/
    if (eventName === "CHON_THU_TUC") {
      const ma = eventParams.ma_thu_tuc;
      const proc = findByMa(ma);
      if (!proc) return res.json({ fulfillmentText: "Không tìm thấy thủ tục." });

      const payload = {
        richContent: [
          [
            desc(`**${proc.thu_tuc}**`, [
              `Lĩnh vực: ${proc.linh_vuc || "-"}`,
              `Cấp thực hiện: ${proc.cap_thuc_hien || "-"}`,
            ]),
            ...chipsMenuThongTin(proc),
          ],
        ],
      };
      return res.json({ fulfillmentMessages: [{ payload }] });
    }

    if (eventName === "XEM_CHI_TIET_TTHC") {
      const ma = eventParams.ma_thu_tuc;
      const key = eventParams.info_key;
      const proc = findByMa(ma);
      if (!proc) return res.json({ fulfillmentText: "Không tìm thấy thủ tục." });

      const value = proc[key] || "Chưa có dữ liệu.";
      const title = `**${proc.thu_tuc}**`;
      const payload = {
        richContent: [
          [
            desc(title, []),
            section((key || "").replaceAll("_", " ").toUpperCase(), value),
            ...chipsMenuThongTin(proc),
            ...chipBack(proc.ma_thu_tuc),
          ],
        ],
      };
      return res.json({ fulfillmentMessages: [{ payload }] });
    }

    if (eventName === "BACK_TO_MENU") {
      const ma = eventParams.ma_thu_tuc;
      const proc = findByMa(ma);
      if (!proc) return res.json({ fulfillmentText: "Không tìm thấy thủ tục." });
      const payload = {
        richContent: [
          [
            desc(`**${proc.thu_tuc}**`, [
              `Lĩnh vực: ${proc.linh_vuc || "-"}`,
              `Cấp thực hiện: ${proc.cap_thuc_hien || "-"}`,
            ]),
            ...chipsMenuThongTin(proc),
          ],
        ],
      };
      return res.json({ fulfillmentMessages: [{ payload }] });
    }

    if (eventName === "HUONG_DAN_NOP") {
      const mode = eventParams.mode;
      const payload = { richContent: [renderHuongDanNop(mode)] };
      return res.json({ fulfillmentMessages: [{ payload }] });
    }

    /** ===== Routing theo INTENT ===== **/
    // 1) Ý định keyword ngắn: TRA_CUU_TU_KHOA
    if (intent === "TRA_CUU_TU_KHOA") {
      const keyword = (params.keyword || queryText || "").toString();
      const q = vnNorm(keyword);
      const results = cache.fuse.search(q);
      if (!results.length) {
        // Thất bại -> nhắc chọn từ khoá khác
        return res.json({
          fulfillmentText:
            "Mình chưa tìm thấy thủ tục phù hợp. Bạn thử gõ rõ hơn tên thủ tục nhé.",
        });
      }
      // Trả chips chọn thủ tục
      const payload = {
        richContent: [
          [
            desc("**Gợi ý thủ tục**", ["Chọn một thủ tục bên dưới:"]),
            ...chipsChonThuTuc(results),
          ],
        ],
      };
      return res.json({ fulfillmentMessages: [{ payload }] });
    }

    // 2) Ý định tự nhiên: TraCuuTTHC (+ follow-up)
    if (intent === "TraCuuTTHC" || intent === "TraCuuTTHC - custom") {
      const rawName =
        (params.procedure_name || params.keyword || queryText || "").toString();
      const infoRaw = (params.TTHC_Info || "").toString().toLowerCase();

      const q = vnNorm(rawName);
      let proc = null;

      if (q) {
        const results = cache.fuse.search(q);
        if (results.length && results[0].score <= 0.44) {
          proc = results[0].item;
        } else if (results.length > 1) {
          // Trả gợi ý danh sách
          const payload = {
            richContent: [
              [
                desc("**Gợi ý thủ tục**", ["Chọn một thủ tục bên dưới:"]),
                ...chipsChonThuTuc(results),
              ],
            ],
          };
          return res.json({ fulfillmentMessages: [{ payload }] });
        }
      }

      // Không xác định được thủ tục -> gợi ý chung
      if (!proc) {
        const sample = cache.rows.slice(0, 10).map((r) => ({ item: r }));
        const payload = {
          richContent: [
            [
              desc("**Gợi ý thủ tục**", ["Chọn một thủ tục bên dưới:"]),
              ...chipsChonThuTuc(sample),
            ],
          ],
        };
        return res.json({ fulfillmentMessages: [{ payload }] });
      }

      // ĐÃ xác định thủ tục:
      const title = `**${proc.thu_tuc}**`;

      // Nếu có yêu cầu đi kèm (Lựa chọn 2): trả thẳng các thẻ dữ liệu tương ứng
      const infoKey = INFO_KEYS[infoRaw] || infoRaw;
      if (infoKey && COLS[infoKey]) {
        const value = proc[infoKey] || "Chưa có dữ liệu.";
        const payload = {
          richContent: [
            [
              desc(title, []),
              section(infoKey.replaceAll("_", " ").toUpperCase(), value),
              ...chipsMenuThongTin(proc),
              ...chipBack(proc.ma_thu_tuc),
            ],
          ],
        };
        return res.json({ fulfillmentMessages: [{ payload }] });
      }

      // Nếu hỏi chung (Lựa chọn 1): trả menu info (chips)
      const payload = {
        richContent: [
          [
            desc(title, [
              `Lĩnh vực: ${proc.linh_vuc || "-"}`,
              `Cấp thực hiện: ${proc.cap_thuc_hien || "-"}`,
            ]),
            ...chipsMenuThongTin(proc),
          ],
        ],
      };
      return res.json({ fulfillmentMessages: [{ payload }] });
    }

    // Mặc định
    return res.json({
      fulfillmentText:
        "Mình chưa hiểu ý bạn. Bạn có thể nói rõ tên thủ tục (vd: cấp giấy phép xây dựng)…",
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
