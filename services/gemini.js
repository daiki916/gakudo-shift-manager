/**
 * Gemini 3.1 Flash-Lite integration for shift parsing
 */
const https = require('https');

const GEMINI_MODEL = 'gemini-3.1-flash-lite-preview';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

const SYSTEM_PROMPT = `あなたはシフト管理アシスタントです。スタッフからのメッセージを解析して、シフト情報をJSON形式で返してください。

今日の日付: {{TODAY}}

## 出力フォーマット
必ず以下のJSON形式で返してください。余計なテキストは不要です。

### シフト登録の場合:
{
  "action": "register",
  "shifts": [
    {"date": "YYYY-MM-DD", "start_time": "HH:MM", "end_time": "HH:MM"}
  ],
  "message": "確認メッセージ（日本語）"
}

### 休み申請の場合:
{
  "action": "dayoff",
  "dates": ["YYYY-MM-DD"],
  "message": "確認メッセージ（日本語）"
}

### シフト確認の場合:
{
  "action": "check",
  "year": 2026,
  "month": 3,
  "message": "確認メッセージ（日本語）"
}

### 理解できない場合:
{
  "action": "unknown",
  "message": "すみません、シフト情報を読み取れませんでした。\\n例: 「3/10は10時から17時」「来週月曜はお休み」"
}

## ルール
- 「来週月曜」等の相対日付は今日の日付から正確に計算してください
- 時刻は24時間制(HH:MM)で返してください
- 「10時」→ "10:00"、「午後3時」→ "15:00"
- 複数日指定(3/10〜3/14)は全日分のshiftsを生成してください
- messageフィールドには登録内容の確認文を入れてください（例: 「3/10(月) 10:00-17:00 で登録します」）`;

function getSystemPrompt() {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
    const dayName = dayNames[today.getDay()];
    return SYSTEM_PROMPT.replace('{{TODAY}}', `${yyyy}-${mm}-${dd} (${dayName}曜日)`);
}

async function callGemini(userMessage) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('GEMINI_API_KEY is not set');
    }

    const url = `${GEMINI_API_URL}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

    const body = JSON.stringify({
        contents: [
            {
                role: 'user',
                parts: [{ text: getSystemPrompt() + '\n\nスタッフのメッセージ:\n' + userMessage }]
            }
        ],
        generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 1024,
            responseMimeType: 'application/json'
        }
    });

    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = https.request({
            hostname: u.hostname,
            path: u.pathname + u.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    if (res.statusCode !== 200) {
                        console.error('Gemini API error:', res.statusCode, data);
                        reject(new Error(`Gemini API error: ${res.statusCode}`));
                        return;
                    }
                    const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (!text) {
                        reject(new Error('No response from Gemini'));
                        return;
                    }
                    // Parse the JSON response
                    const parsed = JSON.parse(text);
                    resolve(parsed);
                } catch (e) {
                    console.error('Failed to parse Gemini response:', e.message, data);
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

module.exports = { callGemini };
