const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * SYSTEM INSTRUCTION: Thông minh, linh hoạt sửa lỗi địa danh & chính xác
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
`;

/**
 * Trích xuất danh sách nguồn từ Google Search Grounding
 */
function extractGroundingSources(candidate) {
    const chunks = candidate?.groundingMetadata?.groundingChunks || [];
    const sources = [];
    chunks.forEach((chunk) => {
        if (chunk.web?.uri && chunk.web?.title) {
            sources.push({
                title: chunk.web.title,
                url: chunk.web.uri
            });
        }
    });
    return Array.from(new Map(sources.map(s => [s.url, s])).values());
}

app.post('/api/chat', async (req, res) => {
    const { message } = req.body;

    if (!message || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'Message is required' });
    }

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: message,
            config: {
                systemInstruction: SYSTEM_INSTRUCTION,
                temperature: 0.3, // Độ sáng tạo vừa đủ để linh hoạt xử lý ngữ cảnh
                maxOutputTokens: 1000,
                tools: [{ googleSearch: {} }],
            },
        });

        const candidate = response.candidates?.[0];
        let reply = response.text || '';
        const sources = extractGroundingSources(candidate);

        // Đính kèm nguồn tra cứu nếu có
        if (sources.length > 0) {
            const sourceText = sources
                .slice(0, 3)
                .map(s => `- [${s.title}](${s.url})`)
                .join('\n');
            reply += `\n\n**Nguồn tham khảo:**\n${sourceText}`;
        }

        res.json({
            reply,
            sources,
        });

    } catch (err) {
        console.error('[AI ERROR]', err);
        res.status(500).json({
            error: 'Đã xảy ra lỗi khi kết nối với AI. Vui lòng thử lại sau.'
        });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', project: 'Heritage AI Assistant' });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
