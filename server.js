const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * SYSTEM INSTRUCTION
 */
const SYSTEM_INSTRUCTION = `
Bạn là Trợ Lý AI Di Sản & Tri Thức Thông Minh. Nhiệm vụ của bạn là giải đáp chính xác, đầy đủ các câu hỏi về di sản, lịch sử, văn hóa (đặc biệt là Thái Nguyên và Việt Nam) cũng như các lĩnh vực tri thức khác.

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
- KHÔNG tự thêm phần "Nguồn tham khảo" ở cuối — hệ thống sẽ tự đính kèm.
`;

/* ============================================================
 *  HẬU XỬ LÝ (POST-PROCESSING) — GỌT DŨA DỮ LIỆU TRƯỚC KHI TRẢ VỀ
 * ============================================================ */

/**
 * Chuẩn hóa text trả về từ AI:
 *  - Bỏ khối "Nguồn tham khảo" nếu AI tự sinh (tránh trùng lặp)
 *  - Bỏ citation dạng [1], [2]… hoặc [source](url) lẫn trong câu
 *  - Chuẩn hóa bullet (-, *, •) về "- "
 *  - Gộp dòng trống liên tiếp, trim đầu/cuối
 *  - Sửa khoảng trắng thừa trước dấu câu
 */
function polishReply(raw) {
    if (!raw || typeof raw !== 'string') return '';

    let text = raw;

    // 1) Bỏ phần "Nguồn tham khảo" do AI tự thêm (nếu có)
    text = text.replace(
        /\n*\*{0,2}\s*Nguồn tham khảo\s*:?\s*\*{0,2}[\s\S]*$/i,
        ''
    );

    // 2) Bỏ citation dạng [1], [2], [1][2]...
    text = text.replace(/\[\d+\]/g, '');

    // 3) Bỏ link markdown dạng [title](url) nằm rời rạc trong câu trả lời
    //    (nhưng vẫn giữ lại text title)
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1');

    // 4) Chuẩn hóa bullet: *, •, + ở đầu dòng -> "- "
    text = text.replace(/^[\s]*[*•+]\s+/gm, '- ');

    // 5) Chuẩn hóa heading markdown: ### -> ### (giữ), nhưng bỏ dấu # lạc
    text = text.replace(/^#{4,}\s*/gm, '### ');

    // 6) Sửa khoảng trắng trước dấu câu
    text = text.replace(/\s+([,.;:!?])/g, '$1');

    // 7) Gộp nhiều dòng trống liên tiếp thành 1 dòng trống
    text = text.replace(/\n{3,}/g, '\n\n');

    // 8) Trim từng dòng (bỏ khoảng trắng thừa cuối dòng)
    text = text
        .split('\n')
        .map((line) => line.replace(/[ \t]+$/g, ''))
        .join('\n');

    // 9) Trim toàn bộ
    return text.trim();
}

/**
 * Trích xuất + làm sạch danh sách nguồn từ Google Search Grounding
 *  - Loại bỏ nguồn trùng URL
 *  - Chuẩn hóa title (bỏ prefix site, trim, cắt độ dài)
 *  - Ưu tiên domain uy tín (gov.vn, edu.vn, wikipedia...)
 */
function extractGroundingSources(candidate) {
    const chunks = candidate?.groundingMetadata?.groundingChunks || [];

    const TRUSTED = [
        '.gov.vn', '.edu.vn', 'wikipedia.org', 'baothainguyen.vn',
        'dangcongsan.vn', 'nhandan.vn', 'vov.vn', 'vnexpress.net'
    ];

    const seen = new Map();

    chunks.forEach((chunk) => {
        const web = chunk?.web;
        if (!web?.uri || !web?.title) return;

        const url = web.uri.trim();
        const key = url.replace(/\/+$/, '').toLowerCase();
        if (seen.has(key)) return;

        // Làm sạch title
        let title = web.title
            .replace(/\s+/g, ' ')
            .replace(/^[\-–—|:]\s*/, '')
            .trim();
        if (title.length > 120) title = title.slice(0, 117) + '...';

        let host = '';
        try {
            host = new URL(url).hostname.toLowerCase();
        } catch (_) { /* ignore */ }

        const trusted = TRUSTED.some((d) => host.endsWith(d));

        seen.set(key, { title, url, host, trusted });
    });

    const list = Array.from(seen.values());

    // Ưu tiên nguồn uy tín lên trước, sau đó tới thứ tự xuất hiện
    list.sort((a, b) => Number(b.trusted) - Number(a.trusted));

    return list.map(({ title, url }) => ({ title, url }));
}

/**
 * Định dạng khối "Nguồn tham khảo" sạch sẽ
 */
function formatSourcesBlock(sources, limit = 3) {
    if (!sources.length) return '';
    const lines = sources
        .slice(0, limit)
        .map((s, i) => `${i + 1}. [${s.title}](${s.url})`)
        .join('\n');
    return `\n\n---\n**Nguồn tham khảo:**\n${lines}`;
}

/* ============================================================
 *  API ROUTES
 * ============================================================ */

app.post('/api/chat', async (req, res) => {
    const { message, history } = req.body || {};

    if (!message || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'Message is required' });
    }

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: message.trim(),
            config: {
                systemInstruction: SYSTEM_INSTRUCTION,
                temperature: 0.3,
                maxOutputTokens: 1000,
                tools: [{ googleSearch: {} }],
            },
        });

        const candidate = response.candidates?.[0];

        // B1: Lấy text thô
        const rawReply = response.text || '';

        // B2: Gọt dũa text
        let reply = polishReply(rawReply);

        // B3: Trích xuất & làm sạch nguồn
        const sources = extractGroundingSources(candidate);

        // B4: Gắn khối nguồn đã chuẩn hóa
        reply += formatSourcesBlock(sources, 3);

        // B5: Fallback nếu AI không trả về nội dung
        if (!reply.trim()) {
            reply = 'Xin lỗi, hiện tại tôi chưa có câu trả lời phù hợp. Bạn vui lòng thử lại hoặc diễn đạt câu hỏi rõ hơn.';
        }

        return res.json({
            reply,
            sources,
            meta: {
                model: 'gemini-2.5-flash',
                hasGrounding: sources.length > 0,
            },
        });
    } catch (err) {
        console.error('[AI ERROR]', err);
        return res.status(500).json({
            error: 'Đã xảy ra lỗi khi kết nối với AI. Vui lòng thử lại sau.',
        });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', project: 'Heritage AI Assistant' });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});