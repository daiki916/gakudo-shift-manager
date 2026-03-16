/**
 * Gemini integration for natural language attendance correction parsing
 * 
 * ユーザーの自然言語メッセージを解析して、勤怠修正コマンドに変換する。
 */
const https = require('https');

const GEMINI_MODEL = 'gemini-3.1-flash-lite-preview';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

const SYSTEM_PROMPT = `あなたはfreee勤怠修正アシスタントです。スタッフからのメッセージを解析して、勤怠修正情報をJSON形式で返してください。

今日の日付: {{TODAY}}

## 出力フォーマット
必ず以下のJSON形式で返してください。余計なテキストは不要です。

### 勤怠確認の場合:
{
  "action": "check",
  "date": "YYYY-MM-DD",
  "message": "確認メッセージ（日本語）"
}

### 期間の勤怠確認の場合:
{
  "action": "check_range",
  "start_date": "YYYY-MM-DD",
  "end_date": "YYYY-MM-DD",
  "message": "確認メッセージ（日本語）"
}

### 出勤/退勤時刻の修正の場合:
{
  "action": "update",
  "date": "YYYY-MM-DD",
  "clock_in_at": "YYYY-MM-DDTHH:MM:SS+09:00 または null",
  "clock_out_at": "YYYY-MM-DDTHH:MM:SS+09:00 または null",
  "break_records": [
    {"clock_in_at": "YYYY-MM-DDTHH:MM:SS+09:00", "clock_out_at": "YYYY-MM-DDTHH:MM:SS+09:00"}
  ],
  "message": "確認メッセージ（日本語）"
}

### 理解できない場合:
{
  "action": "unknown",
  "message": "すみません、勤怠修正の内容を読み取れませんでした。\\n例: 「昨日の退勤を18:00に直して」「今日の勤怠を確認」"
}

## ルール
- 「昨日」「おととい」「今日」等の相対日付は今日の日付から正確に計算してください
- 時刻はISO 8601形式で日本時間(+09:00)で返してください
- clock_in_at は出勤時刻、clock_out_at は退勤時刻です
- 修正対象でないフィールドは null にしてください（例: 退勤だけ直す場合 clock_in_at は null）
- break_records は休憩時間の修正がある場合のみ含めてください。なければ空配列 [] にしてください
- 「出勤を9:30に」→ clock_in_at を 9:30 に設定
- 「退勤を18:00に」→ clock_out_at を 18:00 に設定
- 「休憩を12:00〜13:00に」→ break_records に追加
- messageフィールドには修正内容の確認文を入れてください`;

function getSystemPrompt() {
    // Cloud Run runs in UTC — explicitly get JST (UTC+9)
    const now = new Date();
    const jstMs = now.getTime() + 9 * 60 * 60 * 1000;
    const jst = new Date(jstMs);
    const yyyy = jst.getUTCFullYear();
    const mm = String(jst.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(jst.getUTCDate()).padStart(2, '0');
    const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
    const dayName = dayNames[jst.getUTCDay()];
    const todayStr = `${yyyy}-${mm}-${dd} (${dayName}曜日)`;
    console.log(`📅 Gemini today date (JST): ${todayStr} (UTC: ${now.toISOString()})`);
    return SYSTEM_PROMPT.replace('{{TODAY}}', todayStr);
}

async function callGemini(userMessage) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('GEMINI_API_KEY is not set');
    }

    const url = `${GEMINI_API_URL}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
    const systemPrompt = getSystemPrompt();

    const body = JSON.stringify({
        contents: [
            {
                role: 'user',
                parts: [{ text: systemPrompt + '\n\nスタッフのメッセージ:\n' + userMessage }]
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
