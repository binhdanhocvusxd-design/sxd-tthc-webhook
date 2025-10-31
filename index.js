// index.js — Webhook Dialogflow ES cho TTHC Sở Xây dựng Sơn La
// Khớp intents: 01_WELCOME, 02_USER_QUERY_ROUTER, 03_SELECT_PROCEDURE,
// 04_SELECT_ATTRIBUTE, 05_BACK_TO_ATTRIBUTES, 06_GUIDE_SUBMISSION, ZZ_FALLBACK
// Context dùng: ctx_selected_procedure
// UI: Dialogflow Messenger (richContent)

const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');

const app = express();
app.use(bodyParser.json());

// ====== CONFIG ======
const SHEET_ID = process.env.SHEET_ID || process.env.sheet_id || '';
const SHEET_NAME = process.env.SHEET_NAME || process.env.sheet_name || 'TTHC';
const PORT = process.env.PORT || 8080;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 phút

let _cache = { at: 0, headers: [], rows: [], colIndex: {} };

// ====== GOOGLE SHEETS ======
async function getSheetsClient() {
  const auth = await google.auth.getClient({
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

const HEADER_ALIASES = {
  // Alias → key chuẩn
  'phi_le_phi': 'le_phi',
  'le_phi': 'le_phi',
  'thoi_han': 'thoi_han',
  'trinh_tu': 'trinh_tu',
  'hinh_thuc_nop': 'hinh_thuc_nop',
  'co_quan_thuc_hien': 'co_quan_thuc_hien',
  'noi_tiep_nhan': 'noi_tiep_nhan',
  'thanh_phan_hs': 'thanh_phan_hs',
  'ket_qua': 'ket_qua',
  'dieu_kien': 'dieu_kien',
  'linh_vuc': 'linh_vuc',
  'loai_thu_tuc': 'loai_thu_tuc',
  'cap_thuc_hien': 'cap_thuc_hien',
  'thu_tuc': 'thu_tuc',
};

function normalizeHeader(h) {
  const base = norm(h).replace(/\s+/g, '_');
  return HEADER_ALIASES[base] || base;
}

async function loadSheet() {
  const now = Date.now();
  if (now - _cache.at < CACHE_TTL_MS && _cache.rows.length) return _cache;

  if (!SHEET_ID) throw new Error('Missing SHEET_ID env');

  const sheets = await getSheetsClient();
  const range = `${SHEET_NAME}!A:Z`;
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });
  const values = resp.data.values || [];
  if (!values.length) throw new Error('Sheet empty');

  const rawHeaders = values[0];
  const headers = rawHeaders.map(normalizeHeader);
  const colIndex = {};
  headers.forEach((h, i) => (colIndex[h] = i));
  if (colIndex['thu_tuc'] === undefined)
    throw new Error('Missing column "thu_tuc"');

  const rows = values.slice(1);
  _cache = { at: now, headers, rows, colIndex };
  return _cache;
}

// ====== TIẾNG VIỆT HELPERS ======
const VI_MAP = {
  a: /[áàạảãâấầậẩẫăắằặẳẵ]/g,
  e: /[éèẹẻẽêếềệểễ]/g,
  i: /[íìịỉĩ]/g,
  o: /[óòọỏõôốồộổỗơớờợởỡ]/g,
  u: /[úùụủũưứừựửữ]/g,
  y: /[ýỳỵỷỹ]/g,
  d: /[đ]/g,
  A: /[ÁÀẠẢÃÂẤẦẬẨẪĂẮẰẶẲẴ]/g,
  E: /[ÉÈẸẺẼÊẾỀỆỂỄ]/g,
  I: /[ÍÌỊỈĨ]/g,
  O: /[ÓÒỌỎÕÔỐỒỘỔỖƠỚỜỢỞỠ]/g,
  U: /[ÚÙỤỦŨƯỨỪỰỬỮ]/g,
  Y: /[ÝỲỴỶỸ]/g,
  D: /[Đ]/g,
};
function stripVN(s = '') {
  let out = s;
  for (const [r, reg] of Object.entries(VI_MAP)) out = out.replace(reg, r);
  return out.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}
function norm(s = '') {
  return stripVN(String(s).toLowerCase().trim())
    .replace(/[^\p{L}\p{N}\s_]/gu, ' ')
    .replace(/\s+/g, ' ');
}
function tokens(s) {
  return new Set(norm(s).split(' ').filter(Boolean));
}
function jaccard(aSet, bSet) {
  const a = new Set(aSet),
    b = new Set(bSet);
  const inter = [...a].filter((x) => b.has(x)).length;
  const uni = new Set([...a, ...b]).size;
  return uni ? inter / uni : 0;
}

// ====== PHÂN TÍCH YÊU CẦU ======
const ATTR_SYNONYMS = [
  { key: 'trinh_tu', syn: ['trinh tu', 'cach lam', 'huong dan', 'cac buoc', 'lam ra sao', 'nop ho so the nao'] },
  { key: 'thoi_han', syn: ['thoi han', 'bao lau', 'mat bao lau', 'may ngay', 'nhanh khong', 'trong bao lau'] },
  { key: 'le_phi', syn: ['le phi', 'phi', 'muc thu', 'ton bao nhieu', 'het bao nhieu tien'] },
  { key: 'thanh_phan_hs', syn: ['ho so', 'thanh phan ho so', 'giay to', 'can gi', 'can chuan bi gi'] },
  { key: 'cap_thuc_hien', syn: ['cap thuc hien', 'lam o dau', 'noi lam', 'co quan nao'] },
  { key: 'loai_thu_tuc', syn: ['loai thu tuc'] },
  { key: 'doi_tuong', syn: ['doi tuong', 'ai duoc lam', 'ai duoc cap'] },
  { key: 'linh_vuc', syn: ['linh vuc', 'thuoc linh vuc nao'] },
  { key: 'hinh_thuc_nop', syn: ['hinh thuc nop', 'gui buu dien', 'online', 'nop o dau'] },
  { key: 'co_quan_thuc_hien', syn: ['co quan thuc hien', 'noi giai quyet', 'ai tiep nhan'] },
  { key: 'noi_tiep_nhan', syn: ['noi tiep nhan', 'o xa duoc khong', 'o mot cua'] },
  { key: 'ket_qua', syn: ['ket qua', 'nhan gi'] },
  { key: 'dieu_kien', syn: ['dieu kien', 'yeu cau'] },
];
const ATTR_LOOK = (() => {
  const m = new Map();
  for (const { key, syn } of ATTR_SYNONYMS) for (const s of syn) m.set(norm(s), key);
  return m;
})();

function detectAttributesFromText(text, headers) {
  const t = norm(text);
  const found = new Set();
  for (const [k, v] of ATTR_LOOK) if (t.includes(k)) found.add(v);
  for (const h of headers) {
    if (h === 'thu_tuc') continue;
    const h2 = h.replace(/_/g, ' ');
    if (h2.length >= 6 && t.includes(h2)) found.add(h);
  }
  return [...found];
}

// ====== TÌM THỦ TỤC TƯƠNG TỰ ======
function buildProcedureIndex(rows, colIndex) {
  return rows.map((r, i) => {
    const name = r[colIndex['thu_tuc']] || '';
    return { idx: i, name, nameNorm: norm(name), tok: tokens(name) };
  });
}
function findCandidates(query, procIndex) {
  const qtok = tokens(query);
  const qnorm = norm(query);
  const scored = procIndex
    .map((p) => {
      let score = jaccard(qtok, p.tok);
      if (p.nameNorm.includes(qnorm) || qnorm.includes(p.nameNorm)) score += 0.2;
      return { ...p, score };
    })
    .sort((a, b) => b.score - a.score);
  const filtered = scored.filter((s) => s.score >= 0.15).slice(0, 10);
  return filtered.length ? filtered : scored.slice(0, 5);
}

// ====== DIALOGFLOW HELPERS ======
function card(title, text) {
  return [{ type: 'description', title: `**${title}**`, text: Array.isArray(text) ? text : [String(text || '')] }];
}
function chips(items) {
  return [{ type: 'chips', options: items.map((it) => ({ text: it.text, event: it.event })) }];
}
function listWithSelect(procs) {
  return procs.map((p) => ({
    type: 'list',
    title: p.name,
    subtitle: 'Thủ tục hành chính',
    event: { name: 'EVT_SELECT_PROCEDURE', languageCode: 'vi', parameters: { procedure_idx: p.idx, procedure_name: p.name } },
  }));
}
// IMPORTANT: richContent cần 2 lớp mảng [[ ... ]]
function dfPayload(blocks) {
  return { payload: { richContent: [blocks] } };
}
function dfText(text) {
  return { text: { text: [text] } };
}
function dfOutput(msgs = []) {
  return { fulfillmentMessages: msgs };
}
function setCtx(session, name, lifespan, params) {
  return { name: `${session}/contexts/${name}`, lifespanCount: lifespan, parameters: params || {} };
}
function getCtx(ctxs, name) {
  return ctxs.find((c) => c.name.endsWith(`/contexts/${name}`));
}
function buildAttributeChips(headers) {
  const attrs = headers.filter((h) => h !== 'thu_tuc');
  const options = attrs.map((h) => ({
    text: h.replace(/_/g, ' ').toUpperCase(),
    event: { name: 'EVT_SELECT_ATTRIBUTE', languageCode: 'vi', parameters: { attribute_key: h } },
  }));
  return chips(options);
}

// ====== HƯỚNG DẪN ======
const GUIDE = {
  DIRECT:
    `**Nộp trực tiếp**\n\nNộp hồ sơ trực tiếp tại **Bộ phận một cửa Sở Xây dựng Sơn La - Trung tâm Phục vụ hành chính công tỉnh**.\n` +
    `Địa chỉ: *Tầng 1, Toà nhà 7 tầng, Trung tâm Lưu trữ lịch sử tỉnh Sơn La (Khu Quảng trường Tây Bắc, phường Tô Hiệu, tỉnh Sơn La)* hoặc **Trung tâm phục vụ hành chính công xã, phường** gần nhất.`,
  POST:
    `**Dịch vụ bưu chính**\n\nBạn có thể thực hiện TTHC qua **bưu chính** (gửi hồ sơ, nhận kết quả, hoặc cả hai).\n` +
    `**Các bước:**\n1. Chuẩn bị hồ sơ theo yêu cầu.\n2. Đến bưu điện gần nhất.\n3. Chọn: chỉ gửi hồ sơ / chỉ nhận kết quả / gửi & nhận cả hai.\n4. Kết quả sẽ được chuyển phát về địa chỉ đã đăng ký.`,
  ONLINE:
    `**Nộp trực tuyến**\n\nCổng DVCQG: https://dichvucong.gov.vn/p/home/dvc-dich-vu-cong-truc-tuyen-ds.html?pCoQuanId=426103\n` +
    `1. Đăng nhập **VNeID** và tìm tên thủ tục.\n2. Chọn **Tỉnh Sơn La**; cơ quan: **Sở Xây dựng Sơn La** hoặc **UBND xã/phường**.\n3. Nhập thông tin và **thành phần hồ sơ**.\n4. Chọn **hình thức nhận kết quả**.\n5. Nộp **lệ phí (nếu có)** trực tuyến.\n6. Kiểm tra và nộp hồ sơ.\n(Hướng dẫn chi tiết: https://binhdanhocvusxd.com/huongdansudungdichvuso/abc)`,
};

// ====== WEBHOOK ======
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body || {};
    const intent = body.queryResult?.intent?.displayName || '';
    const params = body.queryResult?.parameters || {};
    const queryText = body.queryResult?.queryText || '';
    const outputContexts = body.queryResult?.outputContexts || [];
    const session = body.session || '';

    console.log('🟢 intent:', intent, '| query:', queryText);

    const { headers, rows, colIndex } = await loadSheet();
    const procIndex = buildProcedureIndex(rows, colIndex);

    let responses = [];

    // ---- 03_SELECT_PROCEDURE ----
    if (intent === '03_SELECT_PROCEDURE') {
      const pIdx = Number(params.procedure_idx);
      const pName = params.procedure_name;
      const row = Number.isInteger(pIdx) ? rows[pIdx] : null;
      if (!row) {
        responses.push(dfText('Xin lỗi, không tìm thấy thủ tục vừa chọn. Vui lòng chọn lại.'));
        return res.json(dfOutput(responses));
      }
      const ctxSel = setCtx(session, 'ctx_selected_procedure', 10, { procedure_idx: pIdx, procedure_name: pName });
      responses.push(dfPayload(card(`Thủ tục: ${pName}`, 'Vui lòng chọn thông tin muốn xem:')));
      responses.push(dfPayload(buildAttributeChips(headers)));
      responses.push(dfPayload(chips([{ text: 'Hướng dẫn nộp thủ tục hành chính', event: { name: 'EVT_GUIDE_MENU', languageCode: 'vi', parameters: {} } }])));
      return res.json({ fulfillmentMessages: responses, outputContexts: [ctxSel] });
    }

    // ---- 04_SELECT_ATTRIBUTE ----
    if (intent === '04_SELECT_ATTRIBUTE') {
      const ctx = getCtx(outputContexts, 'ctx_selected_procedure');
      if (!ctx?.parameters?.procedure_idx) {
        responses.push(dfText('Mình chưa biết thủ tục đã chọn. Vui lòng chọn thủ tục trước nhé.'));
        return res.json(dfOutput(responses));
      }
      const pIdx = Number(ctx.parameters.procedure_idx);
      const row = rows[pIdx];
      const attrKey = params.attribute_key || '';
      const val = colIndex[attrKey] !== undefined ? (row[colIndex[attrKey]] || 'Chưa có dữ liệu') : 'Chưa có dữ liệu';
      const title = `Thủ tục: ${row[colIndex['thu_tuc']]}`;
      responses.push(dfPayload(card(title, val)));
      responses.push(dfPayload(chips([
        { text: '← Quay lại thủ tục', event: { name: 'EVT_BACK_ATTRIBUTES', languageCode: 'vi', parameters: {} } },
        { text: 'Hướng dẫn nộp thủ tục hành chính', event: { name: 'EVT_GUIDE_MENU', languageCode: 'vi', parameters: {} } },
      ])));
      return res.json(dfOutput(responses));
    }

    // ---- 05_BACK_TO_ATTRIBUTES ----
    if (intent === '05_BACK_TO_ATTRIBUTES') {
      const ctx = getCtx(outputContexts, 'ctx_selected_procedure');
      if (!ctx?.parameters?.procedure_idx) {
        responses.push(dfText('Chưa có thủ tục để quay lại. Anh/chị nhập tên thủ tục giúp mình nhé.'));
        return res.json(dfOutput(responses));
      }
      const pIdx = Number(ctx.parameters.procedure_idx);
      const pName = rows[pIdx][colIndex['thu_tuc']];
      responses.push(dfPayload(card(`Thủ tục: ${pName}`, 'Vui lòng chọn thông tin muốn xem:')));
      responses.push(dfPayload(buildAttributeChips(headers)));
      responses.push(dfPayload(chips([{ text: 'Hướng dẫn nộp thủ tục hành chính', event: { name: 'EVT_GUIDE_MENU', languageCode: 'vi', parameters: {} } }])));
      return res.json(dfOutput(responses));
    }

    // ---- 06_GUIDE_SUBMISSION ----
    if (intent === '06_GUIDE_SUBMISSION') {
      const ev = body.originalDetectIntentRequest?.payload?.event?.name || '';
      if (ev === 'EVT_GUIDE_DIRECT') responses.push(dfPayload(card('**Hướng dẫn nộp trực tiếp**', GUIDE.DIRECT)));
      else if (ev === 'EVT_GUIDE_POST') responses.push(dfPayload(card('**Dịch vụ bưu chính**', GUIDE.POST)));
      else if (ev === 'EVT_GUIDE_ONLINE') responses.push(dfPayload(card('**Nộp trực tuyến**', GUIDE.ONLINE)));
      else {
        responses.push(dfPayload(card('**Hướng dẫn nộp thủ tục hành chính**', 'Chọn một hình thức:')));
        responses.push(dfPayload(chips([
          { text: 'Nộp trực tiếp', event: { name: 'EVT_GUIDE_DIRECT', languageCode: 'vi', parameters: {} } },
          { text: 'Dịch vụ bưu chính', event: { name: 'EVT_GUIDE_POST', languageCode: 'vi', parameters: {} } },
          { text: 'Nộp trực tuyến', event: { name: 'EVT_GUIDE_ONLINE', languageCode: 'vi', parameters: {} } },
        ])));
      }
      return res.json(dfOutput(responses));
    }

    // ---- 02_USER_QUERY_ROUTER ----
    if (intent === '02_USER_QUERY_ROUTER') {
      const attrHints = detectAttributesFromText(queryText, headers);
      const candidates = findCandidates(queryText, procIndex);

      if (!candidates.length) {
        responses.push(dfPayload(card('Không tìm thấy thủ tục phù hợp', 'Vui lòng mô tả cụ thể hơn tên thủ tục hoặc mục đích.')));
        return res.json(dfOutput(responses));
      }

      if (candidates.length > 1) {
        responses.push(dfPayload(card('Có thể bạn đang tìm các thủ tục sau', 'Chọn đúng thủ tục mong muốn:')));
        responses.push(dfPayload(listWithSelect(candidates)));
        return res.json(dfOutput(responses));
      }

      // Chỉ còn 1 thủ tục
      const picked = candidates[0];
      const pIdx = picked.idx;
      const pRow = rows[pIdx];
      const pName = pRow[colIndex['thu_tuc']];
      const ctxSel = setCtx(session, 'ctx_selected_procedure', 10, { procedure_idx: pIdx, procedure_name: pName });

      if (attrHints.length) {
        const blocks = [];
        blocks.push(...card(`Thủ tục: ${pName}`, 'Kết quả theo yêu cầu:'));
        for (const a of attrHints) {
          if (colIndex[a] === undefined) continue;
          const v = pRow[colIndex[a]] || 'Chưa có dữ liệu';
          blocks.push(...card(a.replace(/_/g, ' ').toUpperCase(), v));
        }
        responses.push(dfPayload(blocks));
        responses.push(dfPayload(chips([{ text: 'Tìm hiểu thông tin khác về thủ tục này', event: { name: 'EVT_BACK_ATTRIBUTES', languageCode: 'vi', parameters: {} } }])));
        return res.json({ fulfillmentMessages: responses, outputContexts: [ctxSel] });
      }

      responses.push(dfPayload(card(`Thủ tục: ${pName}`, 'Vui lòng chọn thông tin muốn xem:')));
      responses.push(dfPayload(buildAttributeChips(headers)));
      responses.push(dfPayload(chips([{ text: 'Hướng dẫn nộp thủ tục hành chính', event: { name: 'EVT_GUIDE_MENU', languageCode: 'vi', parameters: {} } }])));
      return res.json({ fulfillmentMessages: responses, outputContexts: [ctxSel] });
    }

    // ---- FALLBACK ----
    responses.push(dfPayload(card('Mình chưa hiểu yêu cầu', 'Bạn vui lòng nêu tên thủ tục hoặc mục đích cần làm (ví dụ: cấp giấy phép xây dựng, xin phép sửa chữa nhà ở…).')));
    return res.json(dfOutput(responses));
  } catch (e) {
    console.error('❌ Webhook error:', e);
    return res.json({ fulfillmentText: 'Có lỗi xảy ra trong quá trình xử lý. Vui lòng thử lại!' });
  }
});

// Health check
app.get('/', (_req, res) => res.send('Dialogflow TTHC Webhook OK'));
app.listen(PORT, () => console.log('✅ Webhook listening on', PORT));
