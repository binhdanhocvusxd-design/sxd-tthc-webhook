import express from "express";
import bodyParser from "body-parser";
import { google } from "googleapis";
import Fuse from "fuse.js";
import _ from "lodash";

const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "TTHC";

const app = express();
app.use(bodyParser.json());

// ---------- Utils ----------
const norm = (s) =>
  (s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d").replace(/Đ/g, "D")
    .toLowerCase().replace(/\s+/g, " ").trim();

const TITLE = (s) => `**${s}**`;

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

const CHIP_INFO_DEFS = [
  ["📥 Quay lại thủ tục", "__BACK__"],
  ["📄 Thành phần hồ sơ", "thanh_phan_hs"],
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
  ["📚 Hướng dẫn nộp TTHC", "__GUIDE__"]
];

// cache
let cache = { rows: [], fuse: null, last: 0 };

async function loadSheet() {
  const now = Date.now();
  if (now - cache.last < 5 * 60 * 1000 && cache.rows.length) return;

  const auth = await google.auth.getClient({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
  });
  const sheets = google.sheets({ version: "v4", auth });

  const range = `${SHEET_NAME}!A1:Q`;
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });

  const [header, ...rows] = data.values || [];
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const pick = (r, k) => (r[idx[k]] || "").toString();

  const parsed = rows.map(r => {
    const obj = {
      ma_thu_tuc: pick(r, "ma_thu_tuc"),
      so_quyet_dinh: pick(r, "so_quyet_dinh"),
      thu_tuc: pick(r, "thu_tuc"),
      cap_thuc_hien: pick(r, "cap_thuc_hien"),
      loai_thu_tuc: pick(r, "loai_thu_tuc"),
      linh_vuc: pick(r, "linh_vuc"),
      trinh_tu: pick(r, "trinh_tu"),
      hinh_thuc_nop: pick(r, "hinh_thuc_nop"),
      thoi_han: pick(r, "thoi_han"),
      phi_le_phi: pick(r, "phi_le_phi"),
      thanh_phan_hs: pick(r, "thanh_phan_hs"),
      doi_tuong: pick(r, "doi_tuong"),
      co_quan_thuc_hien: pick(r, "co_quan_thuc_hien"),
      noi_tiep_nhan: pick(r, "noi_tiep_nhan"),
      ket_qua: pick(r, "ket_qua"),
      can_cu: pick(r, "can_cu"),
      dieu_kien: pick(r, "dieu_kien")
    };
    obj._thu_tuc_norm = norm(obj.thu_tuc);
    return obj;
  }).filter(x => x.thu_tuc);

  cache = {
    rows: parsed,
    fuse: new Fuse(parsed, {
      keys: ["thu_tuc", "_thu_tuc_norm"],
      includeScore: true,
      threshold: 0.42,
      ignoreLocation: true,
      minMatchCharLength: 3
    }),
    last: now
  };
}

const sessionName = (body, ctx) => `${body.session}/contexts/${ctx}`;

// ---------- Renderers ----------
function cardProcedure(proc) {
  return {
    type: "description",
    title: TITLE(proc.thu_tuc),
    text: [
      `Lĩnh vực: ${proc.linh_vuc || "-"}`,
      `Cấp thực hiện: ${proc.cap_thuc_hien || "-"}`
    ]
  };
}

function buttonsInfo(proc) {
  const options = CHIP_INFO_DEFS
    .filter(([, key]) => key.startsWith("__") || (proc[key] || "").trim().length)
    .map(([label, key]) => ({ text: label }));

  return [{ type: "chips", options }];
}

function chipsProcedures(list) {
  const options = list.slice(0, 10).map(item => ({ text: item.thu_tuc }));
  return [{ type: "chips", options }];
}

// ---------- Helpers with Context ----------
function setContext(res, body, name, lifespan, parameters) {
  const ctx = {
    name: sessionName(body, name),
    lifespanCount: lifespan,
    parameters
  };
  res.outputContexts = res.outputContexts || [];
  res.outputContexts.push(ctx);
}

function findSelectedFromContext(body, ctxName) {
  const ctx = (body.queryResult.outputContexts || []).find(c =>
    c.name.endsWith(`/contexts/${ctxName}`)
  );
  return ctx;
}

// ---------- Main Handlers ----------
function buildGuideCards() {
  const lines = [
    {
      type: "description",
      title: TITLE("Hướng dẫn nộp thủ tục hành chính"),
      text: ["Chọn 1 hình thức bên dưới:"]
    },
    {
      type: "description",
      title: "Nộp trực tiếp",
      text: [
        "Nộp hồ sơ trực tiếp tại Bộ phận một cửa Sở Xây dựng Sơn La - Trung tâm Phục vụ hành chính công tỉnh.",
        "Địa chỉ: Tầng 1, Toà nhà 7 tầng, Trung tâm Lưu trữ lịch sử tỉnh Sơn La (Khu Quảng trường Tây Bắc, phường Tô Hiệu, tỉnh Sơn La) hoặc Trung tâm phục vụ hành chính công xã, phường gần nhất."
      ]
    },
    {
      type: "description",
      title: "Dịch vụ bưu chính",
      text: [
        "Bạn có thể thực hiện qua bưu điện (gửi hồ sơ / nhận kết quả / hoặc cả hai).",
        "1) Chuẩn bị hồ sơ; 2) Đến bưu điện; 3) Giao dịch (chọn hình thức); 4) Nhận kết quả tại nhà."
      ]
    },
    {
      type: "description",
      title: "Nộp hồ sơ trực tuyến",
      text: [
        "Truy cập: https://dichvucong.gov.vn/p/home/dvc-dich-vu-cong-truc-tuyen-ds.html?pCoQuanId=426103",
        "Đăng nhập VNeID, tìm tên thủ tục, chọn Sở Xây dựng Sơn La, nộp hồ sơ & lệ phí (nếu có)."
      ]
    }
  ];
  return lines;
}

function reply(payload, extra = {}) {
  const o = {
    fulfillmentMessages: [{ payload }],
    ...extra
  };
  return o;
}

function replyText(text, extra = {}) {
  return {
    fulfillmentText: text,
    ...extra
  };
}

function matchTopProcedures(q) {
  const QQ = norm(q);
  const scored = cache.fuse.search(QQ);
  // nếu không có thì thử filter chứa cụm từ
  if (!scored.length) {
    const contains = cache.rows.filter(r => r._thu_tuc_norm.includes(QQ));
    return contains.slice(0, 10);
  }
  // lọc điểm đủ tốt hoặc lấy top ~10
  return scored
    .filter(x => x.score <= 0.6)
    .slice(0, 10)
    .map(x => x.item);
}

// ---------- Fulfillment ----------
app.post("/fulfillment", async (req, res) => {
  try {
    await loadSheet();

    const body = req.body;
    const intent = _.get(body, "queryResult.intent.displayName", "");
    const params = _.get(body, "queryResult.parameters", {});
    const queryText = _.get(body, "queryResult.queryText", "");

    // Ưu tiên bắt hành vi "click chip" qua Context trước
    // 1) Đang chờ chọn thủ tục
    const ctxProc = findSelectedFromContext(body, "await_select_proc");
    if (ctxProc) {
      // user gõ/bấm một lựa chọn thủ tục
      const options = ctxProc.parameters?.options || [];
      const hit = options.find(o => norm(o.title) === norm(queryText));
      if (hit) {
        // đã chọn đúng thủ tục -> hiển thị card + chips info
        const proc = cache.rows.find(r => r.ma_thu_tuc === hit.ma_thu_tuc);
        const payload = { richContent: [[cardProcedure(proc)], ...buttonsInfo(proc)] };

        // lưu Context đang xem chi tiết thủ tục + menu info
        const out = {};
        setContext(out, body, "current_proc", 10, { ma_thu_tuc: proc.ma_thu_tuc });
        setContext(out, body, "await_select_info", 10, {
          info: CHIP_INFO_DEFS.filter(([label, key]) => key.startsWith("__") || (proc[key] || "").trim().length)
            .map(([label, key]) => ({ label, key }))
        });

        return res.json(reply(payload, out));
      }
      // Không khớp – bỏ qua để xuống logic tổng quát
    }

    // 2) Đang chờ chọn loại thông tin
    const ctxInfo = findSelectedFromContext(body, "await_select_info");
    if (ctxInfo) {
      const current = findSelectedFromContext(body, "current_proc");
      const ma = current?.parameters?.ma_thu_tuc;
      const proc = cache.rows.find(r => r.ma_thu_tuc === ma);

      if (proc) {
        const opts = ctxInfo.parameters?.info || [];
        const hitInfo = opts.find(o => norm(o.label) === norm(queryText));
        if (hitInfo) {
          if (hitInfo.key === "__BACK__") {
            // Quay lại menu info
            const payload = { richContent: [[cardProcedure(proc)], ...buttonsInfo(proc)] };
            const out = {};
            setContext(out, body, "await_select_info", 10, { info: opts });
            return res.json(reply(payload, out));
          }
          if (hitInfo.key === "__GUIDE__") {
            const payload = { richContent: [buildGuideCards()] };
            const out = {};
            // vẫn giữ context info để tiếp tục Back nếu cần
            setContext(out, body, "await_select_info", 10, { info: opts });
            setContext(out, body, "current_proc", 10, { ma_thu_tuc: proc.ma_thu_tuc });
            return res.json(reply(payload, out));
          }

          const col = INFO_KEY_TO_COL[hitInfo.key] || hitInfo.key;
          const value = (proc[col] || "Chưa có dữ liệu.").toString();
          const payload = {
            richContent: [[
              { type: "description", title: TITLE(proc.thu_tuc), text: [] },
              { type: "description", title: TITLE(hitInfo.label), text: [value] },
            ], ...buttonsInfo(proc)]
          };
          const out = {};
          setContext(out, body, "await_select_info", 10, { info: opts });
          setContext(out, body, "current_proc", 10, { ma_thu_tuc: proc.ma_thu_tuc });
          return res.json(reply(payload, out));
        }
      }
      // không khớp – rơi tiếp xuống logic tổng quát
    }

    // ====== Nhánh theo intent / param ======

    // 1) Người dùng đưa keyword (intent TRA_CUU_TU_KHOA) – tìm & gợi ý thủ tục
    if (intent === "TRA_CUU_TU_KHOA") {
      const key = params.keyword || queryText;
      const list = matchTopProcedures(key);

      if (!list.length) {
        return res.json(replyText("Mình chưa tìm được thủ tục phù hợp. Bạn mô tả cụ thể hơn nhé?"));
      }

      const payload = { richContent: [[
        { type: "description", title: TITLE("Gợi ý thủ tục"), text: ["Chọn một thủ tục bên dưới:"] },
      ], ...[chipsProcedures(list)]] };

      const out = {};
      setContext(out, body, "await_select_proc", 5, {
        options: list.map(p => ({ title: p.thu_tuc, ma_thu_tuc: p.ma_thu_tuc })),
        original_query: key
      });
      return res.json(reply(payload, out));
    }

    // 2) Người dùng hỏi tự nhiên: có/không info_key (intent TraCuuTTHC)
    if (intent === "TraCuuTTHC") {
      const infoRaw = (params.TTHC_Info || "").toString().toLowerCase();
      const info_key = INFO_KEY_TO_COL[infoRaw] || infoRaw || null;

      const textForSearch =
        params.procedure_name || params.keyword || queryText;

      const results = matchTopProcedures(textForSearch);

      // Không có kết quả → fallback
      if (!results.length) {
        return res.json(replyText("Mình chưa nhận ra thủ tục bạn cần. Bạn mô tả rõ hơn tên thủ tục nhé?"));
      }

      // Nếu có nhiều thủ tục tương tự → gợi ý cho chọn
      if (results.length > 1 && !info_key) {
        const payload = { richContent: [[
          { type: "description", title: TITLE("Gợi ý thủ tục"), text: ["Chọn một thủ tục bên dưới:"] },
        ], ...[chipsProcedures(results)]] };

        const out = {};
        setContext(out, body, "await_select_proc", 5, {
          options: results.map(p => ({ title: p.thu_tuc, ma_thu_tuc: p.ma_thu_tuc })),
          original_query: textForSearch
        });
        return res.json(reply(payload, out));
      }

      // Lấy thủ tục tốt nhất
      const proc = results[0];

      // Nếu có info → trả thẳng nội dung
      if (info_key) {
        const col = INFO_KEY_TO_COL[info_key] || info_key;
        const value = (proc[col] || "Chưa có dữ liệu.").toString();
        const payload = {
          richContent: [[
            { type: "description", title: TITLE(proc.thu_tuc), text: [] },
            { type: "description", title: TITLE(info_key.replaceAll("_", " ")), text: [value] },
          ], ...buttonsInfo(proc)]
        };
        const out = {};
        setContext(out, body, "current_proc", 10, { ma_thu_tuc: proc.ma_thu_tuc });
        setContext(out, body, "await_select_info", 10, {
          info: CHIP_INFO_DEFS.filter(([label, key]) => key.startsWith("__") || (proc[key] || "").trim().length)
            .map(([label, key]) => ({ label, key }))
        });
        return res.json(reply(payload, out));
      }

      // Không có info → hiển thị menu info
      const payload = { richContent: [[cardProcedure(proc)], ...buttonsInfo(proc)] };
      const out = {};
      setContext(out, body, "current_proc", 10, { ma_thu_tuc: proc.ma_thu_tuc });
      setContext(out, body, "await_select_info", 10, {
        info: CHIP_INFO_DEFS.filter(([label, key]) => key.startsWith("__") || (proc[key] || "").trim().length)
          .map(([label, key]) => ({ label, key }))
      });
      return res.json(reply(payload, out));
    }

    // 3) EVTs qua event (nếu widget tương thích) – vẫn hỗ trợ
    if (intent === "EVT_CHON_THU_TUC" || intent === "CHON_THU_TUC") {
      const ma = params.ma_thu_tuc;
      const proc = cache.rows.find(r => r.ma_thu_tuc === ma);
      if (!proc) return res.json(replyText("Mình chưa nhận ra thủ tục bạn chọn, bạn thử nói rõ hơn nhé?"));

      const payload = { richContent: [[cardProcedure(proc)], ...buttonsInfo(proc)] };
      const out = {};
      setContext(out, body, "current_proc", 10, { ma_thu_tuc: proc.ma_thu_tuc });
      setContext(out, body, "await_select_info", 10, {
        info: CHIP_INFO_DEFS.filter(([label, key]) => key.startsWith("__") || (proc[key] || "").trim().length)
          .map(([label, key]) => ({ label, key }))
      });
      return res.json(reply(payload, out));
    }

    if (intent === "EVT_XEM_CHI_TIET_TTHC" || intent === "XEM_CHI_TIET_TTHC") {
      const ma = params.ma_thu_tuc;
      const key = params.info_key;
      const proc = cache.rows.find(r => r.ma_thu_tuc === ma);
      if (!proc) return res.json(replyText("Mình chưa nhận ra thủ tục bạn chọn, bạn thử nói rõ hơn nhé?"));

      if (key === "__BACK__") {
        const payload = { richContent: [[cardProcedure(proc)], ...buttonsInfo(proc)] };
        const out = {};
        setContext(out, body, "current_proc", 10, { ma_thu_tuc: proc.ma_thu_tuc });
        setContext(out, body, "await_select_info", 10, {
          info: CHIP_INFO_DEFS.filter(([label, k]) => k.startsWith("__") || (proc[k] || "").trim().length)
            .map(([label, k]) => ({ label, key: k }))
        });
        return res.json(reply(payload, out));
      }

      const col = INFO_KEY_TO_COL[key] || key;
      const value = (proc[col] || "Chưa có dữ liệu.").toString();
      const payload = {
        richContent: [[
          { type: "description", title: TITLE(proc.thu_tuc), text: [] },
          { type: "description", title: TITLE(key.replaceAll("_", " ")), text: [value] }
        ], ...buttonsInfo(proc)]
      };
      const out = {};
      setContext(out, body, "current_proc", 10, { ma_thu_tuc: proc.ma_thu_tuc });
      setContext(out, body, "await_select_info", 10, {
        info: CHIP_INFO_DEFS.filter(([label, k]) => k.startsWith("__") || (proc[k] || "").trim().length)
          .map(([label, k]) => ({ label, key: k }))
      });
      return res.json(reply(payload, out));
    }

    // 4) Fallback (có thể là postback text không khớp) → thử bắt lần cuối bằng context
    if (intent === "Default Fallback Intent") {
      // Thử xem có đang đứng ở “chọn thủ tục” hay “chọn info”
      if (ctxProc || ctxInfo) {
        // cố gắng match như phần trên (đã làm). Nếu tới đây nghĩa là không khớp.
        return res.json(replyText("Mình chưa nhận ra lựa chọn của bạn. Bạn bấm lại trong các gợi ý nhé!"));
      }
      return res.json(replyText("Câu hỏi của bạn không liên quan đến lĩnh vực TTHC, xin vui lòng đặt lại câu hỏi. Xin cảm ơn!"));
    }

    // Nếu rơi ngoài tất cả
    return res.json(replyText("Mình chưa hiểu yêu cầu. Bạn thử diễn đạt lại giúp mình nhé!"));
  } catch (err) {
    console.error(err);
    return res.json({ fulfillmentText: "Xin lỗi, hệ thống đang gặp sự cố khi đọc dữ liệu. Vui lòng thử lại." });
  }
});

app.get("/", (_, res) => res.send("SXDSL TTHC Webhook OK"));
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Listening on " + PORT));
