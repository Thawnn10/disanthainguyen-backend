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
 * SYSTEM INSTRUCTION: Thông minh, đa năng, chính xác và bám sát thực tế
 */
const SYSTEM_INSTRUCTION = `
Bạn là một Trợ Lý AI Thông Minh, chuyên sâu về văn hóa, lịch sử, di sản (đặc biệt là Thái Nguyên và Việt Nam), đồng thời có khả năng giải đáp chính xác các câu hỏi kiến thức chung.

==============================
NGUYÊN TẮC CHÍNH XÁC (CHỐNG BỊA ĐẶT)
==============================
1. VỚI THÔNG TIN ĐỊA PHƯƠNG / DI SẢN / LỊCH SỬ / SỐ LIỆU TỰ BẰNG:
   - Ưu tiên sử dụng dữ liệu từ kết quả tìm kiếm Google Search (grounding) được cung cấp.
   - Không tự nghĩ ra tên người, số hiệu quyết định, năm thành lập, tọa độ hoặc địa danh nếu không có trong dữ liệu tra cứu.

2. VỚI CÂU HỎI KIẾN THỨC CHUNG (Khoa học, đời sống, lập trình, văn học...):
   - Trả lời rõ ràng, chính xác, khách quan dựa trên tri thức đã xác minh.

3. KHI THÔNG TIN CHƯA RÕ RÀNG HOẶC KHÔNG TÌM THẤY:
   - Hãy trung thực thừa nhận chưa đủ dữ liệu xác minh thay vì suy đoán "cho hợp lý".
   - Hướng dẫn người dùng các nguồn tra cứu chính thống nếu cần.

==============================
PHONG CÁCH TRẢ LỜI
==============================
- Lịch sự, gãy gọn, ưu tiên dùng danh sách bullet point hoặc bảng biểu để dễ đọc.
- Không dẫn dắt dài dòng; đi thẳng vào trọng tâm câu hỏi.
`;

/**
 * Hàm trích xuất nguồn từ Grounding Metadata của Gemini SDK
 */
function extractGroundingSources(candidate) {
    const chunks = candidate?.groundingMetadata?.groundingChunks || [];
    const supports = candidate?.groundingMetadata?.groundingSupports || [];
    
    const sources = [];
    chunks.forEach((chunk) => {
        if (chunk.web?.uri && chunk.web?.title) {
            sources.push({
                title: chunk.web.title,
                url: chunk.web.uri
            });
        }
    });

    // Loại bỏ các nguồn trùng URL
    return Array.from(new Map(sources.map(s => [s.url, s])).values());
}

/**
 * Kiểm tra chất lượng câu trả lời
 */
function isLowQualityResponse(text, hasGrounding) {
    if (!text || typeof text !== 'string') return true;
    const t = text.trim();
    if (t.length < 10) return true;

    // Nếu hỏi về các văn bản pháp lý/số quyết định cụ thể nhưng không có grounding và không chắc chắn
    const hasStrictKeywords = /(quyết định số|nghị định|văn bản số)/i.test(t);
    if (hasStrictKeywords && !hasGrounding) return true;

    return false;
}

const SAFE_FALLBACK = 
    'Tôi chưa tìm thấy thông tin được kiểm chứng chính xác về địa điểm/vấn đề này trong cơ sở dữ liệu. ' +
    'Bạn có thể kiểm tra lại tên gọi hoặc tham khảo thông tin từ cơ quan quản lý văn hóa địa phương.';

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
                temperature: 0.2, // Nhiệt độ thấp để đảm bảo độ chính xác
                maxOutputTokens: 1000,
                tools: [{ googleSearch: {} }], // Kích hoạt Google Search Grounding
            },
        });

        const candidate = response.candidates?.[0];
        let reply = response.text || '';
        const sources = extractGroundingSources(candidate);
        const hasGrounding = sources.length > 0;

        // Nếu câu trả lời quá ngắn hoặc thiếu căn cứ với các thông tin nhạy cảm
        if (isLowQualityResponse(reply, hasGrounding)) {
            reply = SAFE_FALLBACK;
        } else if (hasGrounding) {
            // Tự động đính kèm danh sách nguồn trích dẫn từ Google Search vào cuối bài
            const sourceListText = sources
                .slice(0, 3)
                .map(s => `- [${s.title}](${s.url})`)
                .join('\n');
            
            reply += `\n\n**Nguồn tham khảo:**\n${sourceListText}`;
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
    res.json({ status: 'ok', project: 'Universal AI Assistant' });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
