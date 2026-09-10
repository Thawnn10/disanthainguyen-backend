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
 * SYSTEM INSTRUCTION CHỐNG BỊA ĐẶT (ANTI-HALLUCINATION)
 */
const SYSTEM_INSTRUCTION = `
Bạn là "Trợ Lý AI Di Sản Thái Nguyên" — chuyên gia về văn hóa, lịch sử và di sản
văn hóa phi vật thể của tỉnh Thái Nguyên và Bắc Kạn (17 huyện/thành phố, 92 xã/phường).

==============================
NGUYÊN TẮC CHỐNG BỊA ĐẶT (BẮT BUỘC TUYỆT ĐỐI)
==============================
1. CHỈ trả lời dựa trên:
   (a) Thông tin trong kết quả tìm kiếm (Google Search grounding) nếu có.
   (b) Kiến thức đã được kiểm chứng và phổ biến rộng rãi về di sản Thái Nguyên/Bắc Kạn.

2. TUYỆT ĐỐI KHÔNG được:
   - Bịa tên người, năm tháng, con số, địa danh, văn bản pháp lý, số hiệu quyết định.
   - Bịa tên lễ hội, làn điệu, dân tộc, nhân vật lịch sử không tồn tại.
   - Suy đoán hoặc "suy luận cho hợp lý" khi không có dữ liệu.
   - Trả lời chắc chắn khi độ tin cậy dưới 80%.

3. NẾU KHÔNG CHẮC CHẮN, phải nói rõ ràng theo mẫu:
   "Tôi chưa có thông tin đã được kiểm chứng về vấn đề này. Bạn nên tham khảo
    Sở Văn hóa – Thể thao và Du lịch tỉnh Thái Nguyên/Bắc Kạn hoặc Bảo tàng
    Văn hóa các dân tộc Việt Nam để có thông tin chính xác."

4. Với mọi thông tin cụ thể (số liệu, năm, danh hiệu UNESCO, bằng xếp hạng),
   PHẢI nêu nguồn ở cuối câu trả lời dưới dạng: [Nguồn: …]
   Nếu không có nguồn rõ ràng → KHÔNG nêu thông tin đó.

5. Không được tự nhận mình đã tra cứu, đã xác minh, hay đã "kiểm tra thực tế"
   nếu không có kết quả tìm kiếm kèm theo.

6. Nếu người dùng hỏi ngoài chủ đề di sản/lịch sử/văn hóa Thái Nguyên – Bắc Kạn,
   hãy lịch sự lái về chủ đề di sản, KHÔNG cố trả lời chủ đề ngoài.

==============================
PHONG CÁCH
==============================
- Nhã nhặn, tự hào dân tộc, ngắn gọn 2–4 đoạn.
- Ưu tiên sự thật hơn sự trôi chảy. Thà trả lời ngắn mà đúng còn hơn dài mà sai.
`;

/**
 * Hàm phát hiện dấu hiệu câu trả lời "không đáng tin"
 * - Quá ngắn (có thể lỗi)
 * - Không có citation dù có số liệu/năm
 * - Chứa các cụm từ khẳng định tuyệt đối
 */
function looksLikeHallucination(text) {
    if (!text || typeof text !== 'string') return true;
    const t = text.trim();
    if (t.length < 5) return true;

    // Nếu có số liệu/năm nhưng không có [Nguồn: ...] → nghi vấn
    const hasNumbers = /(\b\d{3,4}\b|\b\d+%|UNESCO|quyết định|số \d+)/i.test(t);
    const hasCitation = /\[Nguồn:/i.test(t) || /https?:\/\//i.test(t) || /Theo\s/i.test(t);
    if (hasNumbers && !hasCitation) return true;

    return false;
}

const SAFE_FALLBACK =
    'Xin lỗi, tôi chưa có đủ thông tin đã được kiểm chứng để trả lời chính xác câu hỏi này. ' +
    'Bạn vui lòng tham khảo Sở Văn hóa – Thể thao và Du lịch tỉnh Thái Nguyên/Bắc Kạn ' +
    'hoặc Cục Di sản văn hóa để có thông tin chính thống. ' +
    'Tôi có thể giúp bạn tìm hiểu về các di sản như Hát Then, Soóng Cọ, Múa Tắc Xình, ' +
    'Lễ hội Lồng Tồng, Chè Tân Cương… nếu bạn muốn.';

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

                // 🔒 Chống bịa: temperature 0 → chọn token xác suất cao nhất
                temperature: 0,
                topP: 0.1,
                topK: 1,

                // Độ dài tối đa để tránh lan man
                maxOutputTokens: 800,

                // 🛡️ Bật grounding bằng Google Search → câu trả lời dựa trên web thật
                tools: [{ googleSearch: {} }],
            },
        });

        let reply = response.text || '';

        // 🧹 Hậu kiểm: nếu nghi vấn bịa → trả về fallback an toàn
        if (looksLikeHallucination(reply)) {
            // Thử lấy lại lần 2 với yêu cầu "chỉ trả lời nếu chắc chắn"
            const retry = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents:
                    `Câu hỏi gốc: "${message}"\n\n` +
                    `YÊU CẦU: Chỉ trả lời nếu bạn CHẮC CHẮN ≥ 90% và có nguồn cụ thể. ` +
                    `Nếu không chắc, hãy trả lời đúng một câu: "Tôi chưa có thông tin kiểm chứng."`,
                config: {
                    systemInstruction: SYSTEM_INSTRUCTION,
                    temperature: 0,
                    topP: 0.1,
                    topK: 1,
                    maxOutputTokens: 500,
                    tools: [{ googleSearch: {} }],
                },
            });

            const retryText = (retry.text || '').trim();
            if (
                retryText &&
                !/chưa có thông tin|không chắc|không có nguồn/i.test(retryText) &&
                !looksLikeHallucination(retryText)
            ) {
                reply = retryText;
            } else {
                reply = SAFE_FALLBACK;
            }
        }

        // 📚 Trích xuất nguồn grounding (nếu có) để minh bạch cho người dùng
        const chunks =
            response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
        const sources = chunks
            .map((c) => c.web?.uri)
            .filter(Boolean)
            .slice(0, 5);

        res.json({
            reply,
            sources, // frontend có thể hiển thị danh sách link tham khảo
        });
    } catch (err) {
        console.error('[AI ERROR]', err);
        res.status(500).json({
            error:
                'Server AI gặp sự cố, vui lòng thử lại sau. ' +
                'Nếu cần thông tin chính thống, vui lòng liên hệ Sở VHTT&DL tỉnh Thái Nguyên/Bắc Kạn.',
        });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', project: 'Di Sản Thái Nguyên AI API' });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
