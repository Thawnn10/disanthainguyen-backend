const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '256kb' }));

/* ---------- ENV CHECK ---------- */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

console.log('========================================');
console.log('[BOOT] Port:', PORT);
console.log('[BOOT] Model:', MODEL_NAME);
console.log('[BOOT] GEMINI_API_KEY:', GEMINI_API_KEY
    ? `✅ Có (${GEMINI_API_KEY.slice(0,10)}...${GEMINI_API_KEY.slice(-4)})`
    : '❌ THIẾU');
try {
    const v = require('@google/genai/package.json').version;
    console.log('[BOOT] @google/genai version:', v);
} catch (e) {
    console.log('[BOOT] Không đọc được version @google/genai');
}
console.log('========================================');

let ai = null;
if (GEMINI_API_KEY) {
    try {
        ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
        console.log('[BOOT] ✅ GoogleGenAI đã khởi tạo.');
    } catch (e) {
        console.error('[BOOT] ❌ Khởi tạo GoogleGenAI lỗi:', e.message);
    }
} else {
    console.error('[BOOT] ❌ Không có API key → mọi request /api/chat sẽ trả 503.');
}

/* ---------- SYSTEM INSTRUCTION ---------- */
const SYSTEM_INSTRUCTION = `
Bạn là Trợ Lý AI Di Sản & Tri Thức Thông Minh — sản phẩm của dự án Khoa học Kỹ thuật "Di Sản Thái Nguyên · Âm Vang Di Sản" (A1K64 THPT Phú Bình).

Nhiệm vụ: giải đáp chính xác các câu hỏi về di sản, lịch sử, văn hóa (đặc biệt Thái Nguyên và Việt Nam) và các lĩnh vực tri thức khác.

XỬ LÝ ĐỊA DANH:
- Nếu người dùng nhập sai đơn vị hành chính, tự động hiểu đúng và nhẹ nhàng đính chính.
- Không bịa số hiệu văn bản, số liệu chưa kiểm chứng.

PHONG CÁCH:
- Ngắn gọn, dùng gạch đầu dòng.
- Đi thẳng vào vấn đề.
`.trim();

/* ---------- HELPER: lấy text từ response ---------- */
function getResponseText(response) {
    if (!response) return '';
    try {
        if (typeof response.text === 'string') return response.text;
        if (typeof response.text === 'function') return response.text();
    } catch (e) { }
    try {
        const parts = response.candidates?.[0]?.content?.parts || [];
        return parts.map(p => p?.text || '').join('');
    } catch (e) { return ''; }
}

/* ---------- ROUTE: /api/chat ---------- */
app.post('/api/chat', async (req, res) => {
    const t0 = Date.now();
    const message = req.body && req.body.message;

    console.log(`\n[CHAT] ====== Request nhận được ======`);
    console.log(`[CHAT] Message:`, JSON.stringify(message));

    if (!message || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({
            error: 'Message is required',
            detail: 'Trường "message" không được để trống.'
        });
    }
    if (message.length > 4000) {
        return res.status(400).json({
            error: 'Message too long',
            detail: 'Câu hỏi quá dài (giới hạn 4000 ký tự).'
        });
    }

    if (!ai) {
        const detail = GEMINI_API_KEY
            ? 'GoogleGenAI khởi tạo thất bại.'
            : 'Thiếu biến môi trường GEMINI_API_KEY trên server.';
        console.error('[CHAT] ❌', detail);
        return res.status(503).json({
            error: 'AI chưa được cấu hình. ' + detail,
            detail,
            hasApiKey: !!GEMINI_API_KEY
        });
    }

    /* ⚠️ KHÔNG dùng Google Search — chỉ gọi model thuần */
    let response;
    try {
        console.log('[CHAT] Gọi Gemini (KHÔNG search)...');
        response = await ai.models.generateContent({
            model: MODEL_NAME,
            contents: message,
            config: {
                systemInstruction: SYSTEM_INSTRUCTION,
                temperature: 0.3,
                maxOutputTokens: 1200
                // KHÔNG có tools: [{ googleSearch: {} }]
            }
        });
        console.log('[CHAT] ✅ Gemini trả về sau', Date.now() - t0, 'ms');
    } catch (err) {
        const msg = err?.message || String(err);
        console.error('[CHAT] ❌ GEMINI ERROR:', msg);
        console.error('[CHAT]    name:', err?.name);
        console.error('[CHAT]    status:', err?.status);
        console.error('[CHAT]    code:', err?.code);
        console.error('[CHAT]    stack:', err?.stack);

        let hint = 'Vui lòng thử lại sau.';
        if (/API key|api_key|API_KEY|permission|PERMISSION_DENIED|403|UNAUTHENTICATED/i.test(msg)) {
            hint = 'API key không hợp lệ hoặc chưa bật quyền Gemini API. Kiểm tra GEMINI_API_KEY và bật tại https://aistudio.google.com/app/apikey';
        } else if (/quota|rate|429|RESOURCE_EXHAUSTED/i.test(msg)) {
            hint = 'Đã vượt quota/giới hạn tốc độ. Chờ vài phút rồi thử lại.';
        } else if (/not found|404|model/i.test(msg)) {
            hint = `Model "${MODEL_NAME}" không khả dụng với key này. Thử đổi biến môi trường GEMINI_MODEL=gemini-2.0-flash hoặc gemini-1.5-flash.`;
        } else if (/timeout|DEADLINE/i.test(msg)) {
            hint = 'Gemini phản hồi quá chậm.';
        } else if (/fetch|network|ENOTFOUND|ECONNREFUSED/i.test(msg)) {
            hint = 'Lỗi mạng từ server tới Gemini.';
        }

        return res.status(500).json({
            error: 'Lỗi gọi Gemini: ' + hint,
            detail: msg,
            model: MODEL_NAME,
            hasApiKey: !!GEMINI_API_KEY,
            elapsedMs: Date.now() - t0
        });
    }

    const reply = getResponseText(response);

    if (!reply || !reply.trim()) {
        console.error('[CHAT] ❌ Gemini trả về rỗng');
        return res.status(502).json({
            error: 'Gemini trả về nội dung rỗng. Vui lòng thử lại.',
            detail: 'Empty response text',
            finishReason: response?.candidates?.[0]?.finishReason || null,
            elapsedMs: Date.now() - t0
        });
    }

    console.log('[CHAT] ✅ OK · len=' + reply.length + ' · ' + (Date.now() - t0) + 'ms');

    res.json({
        reply,
        sources: [],
        usedSearch: false,
        elapsedMs: Date.now() - t0
    });
});

/* ---------- HEALTH ---------- */
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        project: 'Heritage AI Assistant',
        model: MODEL_NAME,
        hasApiKey: !!GEMINI_API_KEY,
        aiReady: !!ai,
        uptimeSec: Math.round(process.uptime())
    });
});

/* ---------- HEALTH DEEP ---------- */
app.get('/health/deep', async (req, res) => {
    const t0 = Date.now();
    if (!ai) {
        return res.status(503).json({
            ok: false,
            error: GEMINI_API_KEY ? 'GoogleGenAI init failed' : 'Thiếu GEMINI_API_KEY',
            hasApiKey: !!GEMINI_API_KEY
        });
    }
    try {
        const r = await ai.models.generateContent({
            model: MODEL_NAME,
            contents: 'Nói đúng một từ: OK'
        });
        const text = getResponseText(r);
        return res.json({
            ok: true,
            model: MODEL_NAME,
            sampleText: text.slice(0, 100),
            elapsedMs: Date.now() - t0
        });
    } catch (err) {
        return res.status(500).json({
            ok: false,
            model: MODEL_NAME,
            error: err?.message || String(err),
            status: err?.status || null,
            code: err?.code || null,
            elapsedMs: Date.now() - t0
        });
    }
});

/* ---------- ROOT ---------- */
app.get('/', (req, res) => {
    res.json({
        name: 'Di Sản Thái Nguyên · Backend API',
        project: 'A1K64 THPT Phú Bình — Dự án KHKT',
        endpoints: {
            chat: 'POST /api/chat  { message: string }',
            health: 'GET /health',
            healthDeep: 'GET /health/deep'
        },
        model: MODEL_NAME,
        hasApiKey: !!GEMINI_API_KEY,
        aiReady: !!ai
    });
});

/* ---------- 404 + ERROR ---------- */
app.use((req, res) => {
    res.status(404).json({ error: 'Not found', path: req.path });
});

app.use((err, req, res, next) => {
    console.error('[UNHANDLED]', err);
    res.status(500).json({
        error: 'Internal server error',
        detail: err?.message || String(err)
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Server chạy tại cổng ${PORT}`);
});