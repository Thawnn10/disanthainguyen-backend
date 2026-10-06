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

// ⚠️ TÊN MODEL PHẢI LÀ MODEL THẬT CỦA GOOGLE
const PRIMARY_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const FALLBACK_MODELS = (
    process.env.GEMINI_FALLBACK_MODELS ||
    'gemini-2.0-flash,gemini-2.0-flash-lite,gemini-flash-latest'
).split(',').map(s => s.trim()).filter(Boolean);

console.log('========================================');
console.log('[BOOT] Port:', PORT);
console.log('[BOOT] Primary model:', PRIMARY_MODEL);
console.log('[BOOT] Fallback models:', FALLBACK_MODELS.join(' → '));
console.log('[BOOT] GEMINI_API_KEY:', GEMINI_API_KEY
    ? `✅ Có (${GEMINI_API_KEY.slice(0, 10)}...${GEMINI_API_KEY.slice(-4)})`
    : '❌ THIẾU');
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
        if (typeof response.text === 'string' && response.text) return response.text;
    } catch (e) { }
    try {
        const parts = response.candidates?.[0]?.content?.parts || [];
        return parts.map(p => p?.text || '').join('');
    } catch (e) { return ''; }
}

/* ---------- HELPER: kiểm tra lỗi có thể retry ---------- */
function isRetryableError(err) {
    const msg = (err?.message || String(err)).toLowerCase();
    const status = err?.status || err?.code;

    if (status === 503 || status === 429 || status === 500 || status === 502 || status === 504) return true;
    if (/unavailable|overloaded|high demand|resource_exhausted|rate limit|timeout|deadline|try again later/i.test(msg)) return true;
    return false;
}

/* ---------- HELPER: exponential backoff delay với jitter ---------- */
function backoffDelay(attempt) {
    const base = Math.min(1000 * Math.pow(2, attempt), 8000);
    const jitter = Math.floor(Math.random() * 500);
    return base + jitter;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/* ---------- GỌI GEMINI VỚI RETRY + FALLBACK MODEL ---------- */
async function callGeminiWithRetry(message, maxRetriesPerModel = 3) {
    const modelsToTry = [PRIMARY_MODEL, ...FALLBACK_MODELS];
    const errors = [];

    for (const modelName of modelsToTry) {
        for (let attempt = 0; attempt < maxRetriesPerModel; attempt++) {
            try {
                console.log(`[GEMINI] Thử model="${modelName}" attempt=${attempt + 1}/${maxRetriesPerModel}`);

                const response = await ai.models.generateContent({
                    model: modelName,
                    contents: [
                        { role: 'user', parts: [{ text: message }] }
                    ],
                    config: {
                        systemInstruction: SYSTEM_INSTRUCTION,
                        temperature: 0.3,
                        maxOutputTokens: 1200
                    }
                });

                const text = getResponseText(response);
                if (!text || !text.trim()) {
                    throw new Error('Model trả về nội dung rỗng');
                }

                console.log(`[GEMINI] ✅ Thành công với model="${modelName}" attempt=${attempt + 1}`);
                return { response, modelUsed: modelName };

            } catch (err) {
                const msg = err?.message || String(err);
                const status = err?.status || err?.code;

                console.error(`[GEMINI] ❌ model="${modelName}" attempt=${attempt + 1} status=${status} msg=${msg}`);
                errors.push({ model: modelName, attempt: attempt + 1, status, message: msg });

                if (!isRetryableError(err)) {
                    console.log(`[GEMINI] ⏭️ Lỗi không thể retry, bỏ qua model="${modelName}"`);
                    break;
                }

                if (attempt < maxRetriesPerModel - 1) {
                    const delay = backoffDelay(attempt);
                    console.log(`[GEMINI] ⏳ Chờ ${delay}ms trước khi retry...`);
                    await sleep(delay);
                }
            }
        }
        console.log(`[GEMINI] 🔄 Chuyển sang model fallback tiếp theo...`);
    }

    const lastError = errors[errors.length - 1] || {};
    const error = new Error(
        `Tất cả model đều thất bại. Lỗi cuối: [${lastError.model || '?'}] ${lastError.message || 'unknown'}`
    );
    error.errors = errors;
    error.status = lastError.status || 503;
    throw error;
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

    let result;
    try {
        result = await callGeminiWithRetry(message);
    } catch (err) {
        console.error('[CHAT] ❌ TẤT CẢ MODEL ĐỀU THẤT BẠI');
        console.error('[CHAT] errors:', JSON.stringify(err.errors, null, 2));

        let hint = 'Vui lòng thử lại sau ít phút.';
        const msg = err.message || '';

        if (/api key|permission|unauthorized|403|401/i.test(msg)) {
            hint = 'API key không hợp lệ. Kiểm tra GEMINI_API_KEY tại https://aistudio.google.com/app/apikey';
        } else if (/quota|rate limit|resource_exhausted|429/i.test(msg)) {
            hint = 'Đã vượt quota. Chờ 1-2 phút rồi thử lại.';
        } else if (/unavailable|overloaded|high demand|503/i.test(msg)) {
            hint = 'Google đang quá tải tạm thời. Vui lòng thử lại sau 30-60 giây.';
        } else if (/not found|404|model/i.test(msg)) {
            hint = 'Model không khả dụng. Kiểm tra biến môi trường GEMINI_MODEL — dùng gemini-2.5-flash.';
        }

        return res.status(503).json({
            error: hint,
            detail: err.message,
            attempts: err.errors,
            elapsedMs: Date.now() - t0
        });
    }

    const reply = getResponseText(result.response);

    if (!reply || !reply.trim()) {
        console.error('[CHAT] ❌ Gemini trả về rỗng');
        return res.status(502).json({
            error: 'Gemini trả về nội dung rỗng. Vui lòng thử lại.',
            detail: 'Empty response text',
            modelUsed: result.modelUsed,
            finishReason: result.response?.candidates?.[0]?.finishReason || null,
            elapsedMs: Date.now() - t0
        });
    }

    console.log('[CHAT] ✅ OK · model=' + result.modelUsed + ' · len=' + reply.length + ' · ' + (Date.now() - t0) + 'ms');

    res.json({
        reply,
        sources: [],
        usedSearch: false,
        modelUsed: result.modelUsed,
        elapsedMs: Date.now() - t0
    });
});

/* ---------- HEALTH ---------- */
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        project: 'Heritage AI Assistant',
        primaryModel: PRIMARY_MODEL,
        fallbackModels: FALLBACK_MODELS,
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
        const result = await callGeminiWithRetry('Nói đúng một từ: OK', 2);
        const text = getResponseText(result.response);
        return res.json({
            ok: true,
            modelUsed: result.modelUsed,
            primaryModel: PRIMARY_MODEL,
            sampleText: text.slice(0, 100),
            elapsedMs: Date.now() - t0
        });
    } catch (err) {
        return res.status(503).json({
            ok: false,
            primaryModel: PRIMARY_MODEL,
            error: err?.message || String(err),
            attempts: err.errors,
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
        primaryModel: PRIMARY_MODEL,
        fallbackModels: FALLBACK_MODELS,
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