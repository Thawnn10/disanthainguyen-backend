import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { GoogleGenAI } from '@google/genai';

const app = new Hono();

// Middleware: Kích hoạt CORS cho mọi request
app.use('/*', cors({ origin: '*' }));

/* ---------- SYSTEM INSTRUCTION ---------- */
const SYSTEM_INSTRUCTION = `
Bạn là Trợ Lý AI Di Sản & Tri Thức Thông Minh — sản phẩm của dự án Khoa học Kỹ thuật "Di Sản Thái Nguyên · Âm Vang Di Sản" (A1K64 THPT Phú Bình).

Nhiệm vụ: giải đáp chính xác các câu hỏi về di sản, lịch sử, văn hóa (đặc biệt Thái Nguyên và Việt Nam) và các lĩnh vực tri thức khác.

XỬ LÝ ĐỊA DANH & TRA CỨU:
- Bạn CÓ KHẢ NĂNG TRA CỨU INTERNET. Hãy tổng hợp thông tin mới nhất và chính xác nhất.
- Nếu người dùng nhập sai đơn vị hành chính, tự động hiểu đúng và nhẹ nhàng đính chính.
- Không bịa số hiệu văn bản, số liệu chưa kiểm chứng. Tuyệt đối dựa vào nguồn tra cứu nếu không chắc chắn.

PHONG CÁCH:
- Ngắn gọn, dùng gạch đầu dòng.
- Đi thẳng vào vấn đề.
`.trim();

/* ---------- HELPER: exponential backoff ---------- */
function backoffDelay(attempt) {
    return Math.min(1000 * Math.pow(2, attempt), 8000) + Math.floor(Math.random() * 500);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/* ---------- LOGIC: GỌI GEMINI VỚI SEARCH & RETRY ---------- */
async function callGeminiWithRetry(message, env, maxRetriesPerModel = 3) {
    const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    
    const primaryModel = env.GEMINI_MODEL || 'gemini-2.0-flash';
    const fallbackString = env.GEMINI_FALLBACK_MODELS || 'gemini-1.5-flash';
    const fallbackModels = fallbackString.split(',').map(s => s.trim()).filter(Boolean);
    
    const modelsToTry = [primaryModel, ...fallbackModels];
    let errors = [];

    for (const modelName of modelsToTry) {
        for (let attempt = 0; attempt < maxRetriesPerModel; attempt++) {
            try {
                // ĐÂY LÀ ĐIỂM CHÍNH: KÍCH HOẠT SIÊU AI TRA CỨU
                const response = await ai.models.generateContent({
                    model: modelName,
                    contents: [{ role: 'user', parts: [{ text: message }] }],
                    config: {
                        systemInstruction: SYSTEM_INSTRUCTION,
                        temperature: 0.3,
                        maxOutputTokens: 2000,
                        // Bật tính năng tra cứu Google chuẩn xác
                        tools: [{ googleSearch: {} }] 
                    }
                });

                if (!response.text) throw new Error('Model trả về rỗng');
                
                // Trích xuất nguồn (nếu có tra cứu)
                const searchChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
                const sources = searchChunks.map(chunk => chunk.web?.uri).filter(Boolean);

                return { 
                    reply: response.text, 
                    modelUsed: modelName,
                    sources: [...new Set(sources)] // Lọc trùng lặp
                };
            } catch (err) {
                errors.push({ model: modelName, attempt: attempt + 1, message: err.message });
                const delay = backoffDelay(attempt);
                await sleep(delay);
            }
        }
    }
    throw new Error('Tất cả model đều thất bại. ' + JSON.stringify(errors));
}

/* ---------- ROUTE: /api/chat ---------- */
app.post('/api/chat', async (c) => {
    const t0 = Date.now();
    const env = c.env;

    if (!env.GEMINI_API_KEY) {
        return c.json({ error: 'Thiếu GEMINI_API_KEY trên Cloudflare' }, 503);
    }

    try {
        const body = await c.req.json();
        const message = body.message;

        if (!message || typeof message !== 'string') {
            return c.json({ error: 'Câu hỏi không hợp lệ' }, 400);
        }

        const result = await callGeminiWithRetry(message, env);

        return c.json({
            reply: result.reply,
            sources: result.sources,
            usedSearch: result.sources.length > 0,
            modelUsed: result.modelUsed,
            elapsedMs: Date.now() - t0
        });

    } catch (err) {
        return c.json({
            error: 'Hệ thống AI đang bận hoặc quá tải.',
            detail: err.message,
            elapsedMs: Date.now() - t0
        }, 503);
    }
});

/* ---------- HEALTH ---------- */
app.get('/health', (c) => {
    return c.json({
        status: 'ok',
        project: 'Heritage AI Assistant - Edge Version',
        model: c.env.GEMINI_MODEL,
        hasApiKey: !!c.env.GEMINI_API_KEY,
        isSearchEnabled: true
    });
});

app.get('/', (c) => c.json({ message: 'Di Sản Thái Nguyên API is running on Cloudflare Edge!' }));

// Export app cho Cloudflare Workers
export default app;