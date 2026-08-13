const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const SYSTEM_INSTRUCTION = `
Bạn là "Trợ Lý AI Di Sản Thái Nguyên", một chuyên gia am hiểu sâu sắc về văn hóa, lịch sử và di sản văn hóa phi vật thể của tỉnh Thái Nguyên và Bắc Kạn (bao gồm 17 huyện/thành phố và 92 xã/phường).

Nhiệm vụ của bạn:
1. Trả lời các câu hỏi về di sản văn hóa phi vật thể: Hát Then - Đàn Tính (UNESCO), Hát Soóng Cọ, Múa Tắc Xình, Múa Khèn H'Mông, Nghệ thuật Múa Bát, Lễ hội Lồng Tồng (ATK Định Hóa, Ba Bể), Tri thức chế biến Chè Tân Cương, Nghi lễ Cấp sắc người Dao,...
2. Cung cấp thông tin lịch sử, nguồn gốc, ý nghĩa văn hóa và địa danh liên quan một cách chính xác, thân thiện, mang niềm tự hào dân tộc.
3. Phong cách trả lời: Nhã nhặn, lịch sự, truyền cảm hứng, ngắn gọn, súc tích (khoảng 2-4 đoạn văn).
4. Nếu người dùng hỏi các chủ đề không liên quan đến di sản, lịch sử hoặc văn hóa Thái Nguyên/Bắc Kạn, hãy lịch sự lái câu chuyện quay về chủ đề di sản văn hóa của vùng đất này.
`;

app.post('/api/chat', async (req, res) => {
    const { message } = req.body;

    if (!message) {
        return res.status(400).json({ error: 'Message is required' });
    }

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: message,
            config: {
                systemInstruction: SYSTEM_INSTRUCTION,
                temperature: 0.7,
            }
        });

        res.json({ reply: response.text });
    } catch (err) {
        res.status(500).json({ error: 'Server AI gặp sự cố, vui lòng thử lại sau.' });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', project: 'Di Sản Thái Nguyên AI API' });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
