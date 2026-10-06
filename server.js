const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

/* ------------------------------------------------------------
 * CORS — cho phép mọi origin (có thể siết lại nếu cần)
 * ---------------------------------------------------------- */
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json({ limit: '256kb' }));

/* ------------------------------------------------------------
 * KIỂM TRA API KEY LÚC KHỞI ĐỘNG
 * ---------------------------------------------------------- */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY || !GEMINI_API_KEY.trim()) {
    console.error('❌ [FATAL] Thiếu biến môi trường GEMINI_API_KEY.');
    console.error('   → Vào Render Dashboard > Service > Environment > thêm GEMINI_API_KEY.');
    console.error('   → Lấy key tại: https://aistudio.google.com/app/apikey');
} else {
    console.log('✅ [ENV] GEMINI_API_KEY đã được nạp (độ dài:', GEMINI_API_KEY.length, 'ký tự).');
}

let ai = null;
try {
    if (GEMINI_API_KEY) {
        ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    }
} catch (e) {
    console.error('❌ Không khởi tạo được GoogleGenAI:', e.message);
}

/* ------------------------------------------------------------
 * MODEL & SYSTEM INSTRUCTION
 * ---------------------------------------------------------- */
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const SYSTEM_INSTRUCTION = `
Bạn là Trợ Lý AI Di Sản & Tri Thức Thông Minh — sản phẩm của dự án Khoa học Kỹ thuật "Di Sản Thái Nguyên · Âm Vang Di Sản" (A1K64 THPT Phú Bình). Nhiệm vụ của bạn là giải đáp chính xác, đầy đủ các câu hỏi về di sản, lịch sử, văn hóa (đặc biệt là Thái Nguyên và Việt Nam) cũng như các lĩnh vực tri thức khác.

==============================
XỬ LÝ THÔNG TIN & ĐỊA DANH
==============================
1. TỰ ĐỘNG KHÔI PHỤC VÀ SỬA LỖI ĐỊA DANH:
   - Nếu người dùng nhập sai/nhầm lẫn đơn vị hành chính (ví dụ: nhầm "huyện Phú Bình" thành "xã Phú Bình"), hãy tự động hiểu đúng địa danh (xã Xuân Phương, huyện Phú Bình, tỉnh Thái Nguyên) để trả lời.
   - Nhẹ nhàng đính chính lại địa danh đúng trong câu trả lời.

2. NGUYÊN TẮC CHÍNH XÁC:
   - Kết hợp giữa dữ liệu tìm kiếm Google Search và tri thức lịch sử/văn hóa đã được xác minh.
   - Với các di tích quốc gia, danh thắng nổi tiếng (như Đình Phương Độ, Đền Đuổm, ATK Định Hóa...), hãy cung cấp thông tin lịch sử, năm xếp hạng di tích, lễ hội liên quan một cách chi tiết.
   - Tuyệt đối không bịa đặt số hiệu văn bản, số liệu chưa kiểm chứng.

==============================
PHONG CÁCH TRẢ LỜI
==============================
- Ngắn gọn, rõ ràng, sử dụng gạch đầu dòng (bullet points) để người dùng dễ theo dõi.
- Đi thẳng vào vấn đề, không chào hỏi dài dòng.
`.trim();

/* ------------------------------------------------------------
 * TRÍCH XUẤT NGUỒN TỪ GOOGLE SEARCH GROUNDING
 * ---------------------------------------------------------- */
function extractGroundingSources(candidate) {
    const chunks = candidate?.groundingMetadata?.groundingChunks || [];
    const sources = [];
    chunks.forEach((chunk) => {
        if (chunk.web?.uri && chunk.web?.title) {
            sources.push({ title: chunk.web.title, url: chunk.web.uri });
        }
    });
    return Array.from(new Map(sources.map(s => [s.url, s])).values());
}

/* ------------------------------------------------------------
 * LẤY TEXT TỪ RESPONSE (hỗ trợ cả .text property và .text() method)
 * ---------------------------------------------------------- */
function getResponseText(response) {
    if (!response) return '';
    try {
        if (typeof response.text === 'string') return response.text;
        if (typeof response.text === 'function') return response.text();
    } catch (e) { /* ignore */ }
    // Fallback: đọc từ candidates
    try {
        const parts = response.candidates?.[0]?.content?.parts || [];
        return parts.map(p => p?.text || '').join('');
    } catch (e) {
        return '';
    }
}

/* ------------------------------------------------------------
 * WRAPPER: GỌI GEMINI VỚI TIMEOUT
 * ---------------------------------------------------------- */
function withTimeout(promise, ms, label) {
    let t;
    const timeout = new Promise((_, reject) => {
        t = setTimeout(() => reject(new Error(`${label} timeout sau ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

/* ------------------------------------------------------------
 * GỌI GEMINI — thử với Google Search, fallback nếu lỗi
 * ---------------------------------------------------------- */
async function callGemini(message, { useSearch = true } = {}) {
    if (!ai) {
        throw new Error('GoogleGenAI chưa được khởi tạo (thiếu GEMINI_API_KEY).');
    }

    const config = {
        systemInstruction: SYSTEM_INSTRUCTION,
        temperature: 0.3,
        maxOutputTokens: 1200
    };
    if (useSearch) {
        config.tools = [{ googleSearch: {} }];
    }

    return await withTimeout(
        ai.models.generateContent({
            model: MODEL_NAME,
            contents: message,
            config
        }),
        45000,
        'Gemini'
    );
}

/* ------------------------------------------------------------
 * ENDPOINT CHÍNH: /api/chat
 * ---------------------------------------------------------- */
app.post('/api/chat', async (req, res) => {
    const startedAt = Date.now();
    const { message } = req.body || {};

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
        console.error('[AI ERROR] GoogleGenAI chưa được khởi tạo.');
        return res.status(503).json({
            error: 'AI chưa được cấu hình. Vui lòng kiểm tra GEMINI_API_KEY trên server.',
            detail: 'GEMINI_API_KEY is missing on server.'
        });
    }

    let response = null;
    let usedSearch = true;
    let lastErr = null;

    /* Lần 1: có Google Search */
    try {
        response = await callGemini(message, { useSearch: true });
    } catch (err) {
        lastErr = err;
        console.error('[AI ERROR · with search]', {
            name: err?.name,
            message: err?.message,
            status: err?.status,
            code: err?.code,
            details: err?.errorDetails || err?.details
        });

        /* Lần 2: fallback — không search */
        try {
            console.log('[AI] Thử lại KHÔNG có Google Search...');
            response = await callGemini(message, { useSearch: false });
            usedSearch = false;
        } catch (err2) {
            lastErr = err2;
            console.error('[AI ERROR · without search]', {
                name: err2?.name,
                message: err2?.message,
                status: err2?.status,
                code: err2?.code
            });
        }
    }

    if (!response) {
        const msg = lastErr?.message || 'Unknown error';
        let hint = 'Vui lòng thử lại sau ít phút.';

        if (/API key|api_key|API_KEY|permission|PERMISSION_DENIED|403/i.test(msg)) {
            hint = 'API key không hợp lệ hoặc chưa được bật quyền. Kiểm tra GEMINI_API_KEY trên Render.';
        } else if (/quota|rate|429|RESOURCE_EXHAUSTED/i.test(msg)) {
            hint = 'Đã vượt quota/giới hạn tốc độ của Gemini. Vui lòng chờ vài phút rồi thử lại.';
        } else if (/not found|404|model/i.test(msg)) {
            hint = `Model "${MODEL_NAME}" không khả dụng với API key này. Thử đổi biến môi trường GEMINI_MODEL=gemini-2.0-flash.`;
        } else if (/timeout/i.test(msg)) {
            hint = 'Gemini phản hồi quá chậm. Thử lại với câu hỏi ngắn hơn.';
        }

        return res.status(500).json({
            error: 'Đã xảy ra lỗi khi kết nối với AI. ' + hint,
            detail: msg,
            model: MODEL_NAME,
            hasApiKey: !!GEMINI_API_KEY,
            elapsedMs: Date.now() - startedAt
        });
    }

    const candidate = response.candidates?.[0];
    let reply = getResponseText(response) || '';

    if (!reply || !reply.trim()) {
        return res.status(502).json({
            error: 'AI trả về nội dung rỗng. Vui lòng thử lại.',
            detail: 'Empty response from Gemini.',
            finishReason: candidate?.finishReason || null,
            elapsedMs: Date.now() - startedAt
        });
    }

    const sources = usedSearch ? extractGroundingSources(candidate) : [];

    if (sources.length > 0) {
        const sourceText = sources
            .slice(0, 3)
            .map(s => `- [${s.title}](${s.url})`)
            .join('\n');
        reply += `\n\n**Nguồn tham khảo:**\n${sourceText}`;
    }

    console.log(`[OK] ${Date.now() - startedAt}ms · search=${usedSearch} · sources=${sources.length} · len=${reply.length}`);

    res.json({
        reply,
        sources,
        usedSearch,
        elapsedMs: Date.now() - startedAt
    });
});

/* ------------------------------------------------------------
 * HEALTH CHECK — cơ bản
 * ---------------------------------------------------------- */
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        project: 'Heritage AI Assistant',
        model: MODEL_NAME,
        hasApiKey: !!GEMINI_API_KEY,
        uptimeSec: Math.round(process.uptime())
    });
});

/* ------------------------------------------------------------
 * DEEP HEALTH — gọi thử Gemini để xác minh API key
 * GET /health?deep=1
 * ---------------------------------------------------------- */
app.get('/health/deep', async (req, res) => {
    const startedAt = Date.now();
    if (!ai) {
        return res.status(503).json({
            ok: false,
            stage: 'init',
            error: 'GoogleGenAI chưa được khởi tạo (thiếu GEMINI_API_KEY).'
        });
    }

    // 1. Test không search
    try {
        const r1 = await callGemini('Trả lời đúng 1 từ: "OK"', { useSearch: false });
        const t1 = getResponseText(r1);
        // 2. Test có search
        let searchOk = false;
        let searchErr = null;
        try {
            const r2 = await callGemini('Hôm nay là ngày gì?', { useSearch: true });
            searchOk = !!getResponseText(r2);
        } catch (e) {
            searchErr = e?.message || String(e);
        }

        return res.json({
            ok: true,
            model: MODEL_NAME,
            noSearchOK: true,
            sampleText: t1.slice(0, 80),
            googleSearchOK: searchOk,
            googleSearchError: searchErr,
            elapsedMs: Date.now() - startedAt
        });
    } catch (err) {
        return res.status(500).json({
            ok: false,
            stage: 'generateContent',
            model: MODEL_NAME,
            error: err?.message || String(err),
            status: err?.status || null,
            code: err?.code || null,
            elapsedMs: Date.now() - startedAt
        });
    }
});

/* ------------------------------------------------------------
 * 404 + ERROR HANDLER
 * ---------------------------------------------------------- */
app.use((req, res) => {
    res.status(404).json({ error: 'Not found', path: req.path });
});

app.use((err, req, res, next) => {
    console.error('[UNHANDLED]', err);
    res.status(500).json({ error: 'Internal server error', detail: err?.message });
});

/* ------------------------------------------------------------
 * START
 * ---------------------------------------------------------- */
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT} | model=${MODEL_NAME}`);
    console.log(`   Test API key:  GET  http://localhost:${PORT}/health/deep`);
    console.log(`   Chat:          POST http://localhost:${PORT}/api/chat`);
});