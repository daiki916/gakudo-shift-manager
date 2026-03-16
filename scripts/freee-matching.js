#!/usr/bin/env node
/**
 * freee会計 仕訳・明細 マッチングツール v3
 *
 * freee会計の構造を理解した上での3パターンマッチング:
 *   パターン1: 未決済取引との消込マッチング
 *   パターン2: レシート画像との照合 (Gemini Vision)
 *   パターン3: 新規取引登録の提案 (Gemini AI)
 */

const https = require('https');
const path = require('path');

// ── 設定 ─────────────────────────────────────────────────────
const CLOUD_RUN_HOST = 'gakudo-shift-manager-229549757994.asia-northeast1.run.app';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const GEMINI_MODEL = 'gemini-3.1-flash-lite-preview';
const DATE_FROM = '2025-04-01';
const DATE_TO = '2026-03-12';

// ── HTTP ─────────────────────────────────────────────────────
function httpsGet(url) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { 'Content-Type': 'application/json' } }, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => {
                if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 500)}`));
                try { resolve(JSON.parse(d)); } catch { reject(new Error(`Parse error: ${d.slice(0, 300)}`)); }
            });
        }).on('error', reject);
    });
}

function httpsGetBinary(url) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        https.get({ hostname: u.hostname, path: u.pathname + u.search }, res => {
            const chunks = []; res.on('data', c => chunks.push(c));
            res.on('end', () => {
                if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
                resolve({ buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] || 'image/jpeg' });
            });
        }).on('error', reject);
    });
}

function httpsPost(url, body) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const data = JSON.stringify(body);
        const req = https.request({
            hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        }, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(d.slice(0, 500))); } });
        });
        req.on('error', reject); req.write(data); req.end();
    });
}

// ── freee API ────────────────────────────────────────────────
async function freeeGet(apiPath, params = {}) {
    const qs = new URLSearchParams(params);
    const data = await httpsGet(`https://${CLOUD_RUN_HOST}/api/freee/accounting/${apiPath}?${qs}`);
    if (data.status_code >= 400) {
        const msg = (data.errors || []).flatMap(e => e.messages || []).join(', ');
        throw new Error(`freee ${data.status_code}: ${msg}`);
    }
    return data;
}

async function fetchAll(apiPath, key, params = {}) {
    const all = []; let offset = 0;
    while (true) {
        const data = await freeeGet(apiPath, { ...params, limit: 100, offset });
        const items = data[key] || [];
        all.push(...items);
        process.stdout.write(`  ↳ ${all.length}件...\r`);
        if (items.length < 100) break;
        offset += 100;
    }
    console.log(`  ↳ ${all.length}件取得完了      `);
    return all;
}

// ── Gemini API ───────────────────────────────────────────────
async function gemini(prompt) {
    if (!GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY is not set. Export GEMINI_API_KEY (or GOOGLE_API_KEY) before running this script.');
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    try {
        const res = await httpsPost(url, {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
        });
        return res.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch (e) { return ''; }
}

async function geminiVision(base64, mime, prompt) {
    if (!GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY is not set. Export GEMINI_API_KEY (or GOOGLE_API_KEY) before running this script.');
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    try {
        const res = await httpsPost(url, {
            contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: base64 } }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
        });
        return res.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch (e) { return ''; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function dayDiff(a, b) { return Math.abs(Math.round((new Date(a) - new Date(b)) / 86400000)); }

// ── データ取得 ────────────────────────────────────────────────
async function loadData() {
    // 口座
    console.log('\n📋 口座一覧...');
    const { walletables } = await freeeGet('walletables');
    console.log(`  ✅ ${walletables.length}件`);
    const walletMap = new Map(walletables.map(w => [w.id, { name: w.name, type: w.type }]));

    // 未処理明細
    console.log(`\n📋 未処理明細... (${DATE_FROM}〜${DATE_TO})`);
    const allTxns = await fetchAll('wallet_txns', 'wallet_txns', {});
    const txns = allTxns
        .filter(t => t.status === 1 && t.date >= DATE_FROM && t.date <= DATE_TO)
        .map(t => {
            const w = walletMap.get(t.walletable_id);
            t._wallet_name = w ? w.name : `ID:${t.walletable_id}`;
            t._wallet_type = w ? w.type : t.walletable_type;
            return t;
        });
    const byWallet = {};
    for (const t of txns) byWallet[t._wallet_name] = (byWallet[t._wallet_name] || 0) + 1;
    for (const [n, c] of Object.entries(byWallet)) console.log(`    ${n}: ${c}件`);
    console.log(`  📊 未処理明細: ${txns.length}件`);

    // 未決済取引
    console.log(`\n📋 未決済取引(unsettled)...`);
    let unsettledDeals = [];
    try {
        const inc = await fetchAll('deals', 'deals', { type: 'income', status: 'unsettled' });
        const exp = await fetchAll('deals', 'deals', { type: 'expense', status: 'unsettled' });
        unsettledDeals = [...inc, ...exp].filter(d => d.due_amount > 0);
    } catch (e) {
        console.log(`  ⚠️ 未決済取引の取得エラー: ${e.message}`);
    }
    console.log(`  ✅ due_amount > 0: ${unsettledDeals.length}件`);

    // 取引先
    console.log('\n📋 取引先...');
    const partners = await fetchAll('partners', 'partners', {});
    const partnerMap = new Map(partners.map(p => [p.id, p.name]));
    console.log(`  ✅ ${partners.length}件`);

    // 勘定科目
    console.log('\n📋 勘定科目...');
    const { account_items } = await freeeGet('account_items');
    console.log(`  ✅ ${account_items.length}件`);

    // 過去の処理済み取引（パターン3の参照用 - 直近のみ）
    console.log(`\n📋 参照用: 直近の処理済み取引...`);
    const recentDeals = await fetchAll('deals', 'deals', {
        type: 'expense', start_issue_date: DATE_FROM, end_issue_date: DATE_TO,
    });
    console.log(`  ✅ ${recentDeals.length}件`);

    // レシート
    console.log(`\n📋 レシート(証憑)... (${DATE_FROM}〜${DATE_TO})`);
    let receipts = [];
    try {
        receipts = await fetchAll('receipts', 'receipts', { start_date: DATE_FROM, end_date: DATE_TO });
        receipts = receipts.filter(r => r.status !== 'confirmed' || !r.receipt_metadatum?.amount);
    } catch (e) {
        console.log(`  ⚠️ レシート取得エラー: ${e.message}`);
    }
    console.log(`  ✅ 解析対象: ${receipts.length}件`);

    return { walletables, txns, unsettledDeals, partnerMap, accountItems: account_items, recentDeals, receipts };
}

// ── パターン1: 未決済取引との消込 ─────────────────────────────
function pattern1_unsettledMatch(txns, unsettledDeals, partnerMap) {
    console.log('\n🔄 パターン1: 未決済取引との消込マッチング...');
    const results = [];
    const matchedIds = new Set();

    for (const txn of txns) {
        const amt = Math.abs(txn.amount);
        for (const deal of unsettledDeals) {
            if (deal.due_amount !== amt) continue;
            const dd = dayDiff(txn.date, deal.issue_date);
            if (dd > 30) continue;

            const pName = partnerMap.get(deal.partner_id) || '';
            const accts = (deal.details || []).map(d => d.account_item_name || '').filter(Boolean).join(', ');
            const desc = (deal.details || []).map(d => d.description || '').filter(Boolean).join(' ');

            let grade = dd <= 3 ? 'A' : dd <= 14 ? 'B' : 'C';
            let reason = `未決済取引(ID:${deal.id})の未払い残額${deal.due_amount}円と明細金額${amt}円が一致。`;
            reason += ` 取引日:${deal.issue_date} / 明細日:${txn.date} (差${dd}日)。`;
            if (pName) reason += ` 取引先:${pName}。`;

            results.push({
                pattern: '消込', txn, deal, grade, reason,
                dealPartner: pName, dealAccount: accts, dealDesc: desc,
            });
            matchedIds.add(txn.id);
        }
    }

    console.log(`  ✅ ${results.length}件の消込候補`);
    return { results, matchedIds };
}

// ── パターン2: レシート照合 (Gemini Vision) ───────────────────
async function pattern2_receiptMatch(txns, receipts, matchedIds) {
    console.log('\n📸 パターン2: レシート画像との照合...');
    const unmatched = txns.filter(t => !matchedIds.has(t.id));
    if (unmatched.length === 0 || receipts.length === 0) {
        console.log('  ⏭ 対象なし');
        return { results: [], matchedIds: new Set() };
    }

    const results = [];
    const newMatchedIds = new Set();
    const maxR = Math.min(receipts.length, 50);

    for (let i = 0; i < maxR; i++) {
        const r = receipts[i];
        process.stdout.write(`  📸 ${i + 1}/${maxR}...\r`);
        try {
            const { buffer, contentType } = await httpsGetBinary(
                `https://${CLOUD_RUN_HOST}/api/freee/accounting/receipts/${r.id}/download`
            );
            const resp = await geminiVision(buffer.toString('base64'), contentType,
                `このレシート/領収書から以下をJSON形式で抽出:\n{"store":"店名","date":"YYYY-MM-DD","amount":合計金額数値,"items":["品目"]}\nJSONのみ回答。読み取れない項目はnullに。`
            );

            const m = resp.match(/\{[\s\S]*\}/);
            if (!m) continue;
            const info = JSON.parse(m[0]);
            if (!info.amount) continue;

            for (const txn of unmatched) {
                if (newMatchedIds.has(txn.id)) continue;
                const amt = Math.abs(txn.amount);
                if (amt !== info.amount) continue;
                const dd = info.date ? dayDiff(txn.date, info.date) : 999;
                if (dd > 14) continue;

                const grade = dd <= 1 ? 'A' : dd <= 7 ? 'B' : 'C';
                const reason = `レシートOCR結果: ${info.store || '店名不明'}で${info.amount}円`
                    + (info.date ? `（${info.date}）` : '')
                    + `。明細の金額${amt}円と一致、日付差${dd}日。`
                    + (info.items?.length ? ` 品目: ${info.items.join(', ')}` : '');

                results.push({
                    pattern: 'レシート', txn, deal: null, receiptId: r.id,
                    grade, reason, receiptInfo: info,
                    dealPartner: info.store || '', dealAccount: '', dealDesc: '',
                });
                newMatchedIds.add(txn.id);
            }
        } catch { /* skip */ }
        await sleep(300);
    }

    console.log(`  ✅ ${results.length}件のレシート照合候補`);
    return { results, matchedIds: newMatchedIds };
}

// ── パターン3: 新規取引登録の提案 (Gemini AI) ─────────────────
async function pattern3_newDealSuggestions(txns, matchedIds, recentDeals, partnerMap, accountItems) {
    console.log('\n🤖 パターン3: 新規取引登録の提案...');
    const unmatched = txns.filter(t => !matchedIds.has(t.id));
    if (unmatched.length === 0) {
        console.log('  ⏭ 全て処理済み');
        return [];
    }

    // 過去取引のパターンを集計（摘要→勘定科目のマッピング）
    const pastPatterns = [];
    for (const deal of recentDeals.slice(0, 200)) {
        const pName = partnerMap.get(deal.partner_id) || '';
        for (const det of (deal.details || [])) {
            if (det.description || pName) {
                pastPatterns.push({
                    partner: pName,
                    description: det.description || '',
                    accountItemId: det.account_item_id,
                    accountItemName: det.account_item_name || '',
                    amount: det.amount,
                });
            }
        }
    }

    // 勘定科目リスト（主要なもの）
    const acctList = accountItems
        .filter(a => a.available)
        .slice(0, 50)
        .map(a => `${a.name}(ID:${a.id})`)
        .join(', ');

    const results = [];

    // バッチ処理
    for (let i = 0; i < unmatched.length; i += 5) {
        const batch = unmatched.slice(i, i + 5);
        process.stdout.write(`  🤖 ${i + 1}〜${Math.min(i + 5, unmatched.length)}/${unmatched.length}...\r`);

        const txnList = batch.map((t, idx) =>
            `${idx + 1}. 日付:${t.date} 金額:${Math.abs(t.amount)}円 入出金:${t.entry_side === 'income' ? '入金' : '出金'} 摘要:${t.description || '(なし)'} 口座:${t._wallet_name}`
        ).join('\n');

        // 過去の類似パターン
        const relevantPatterns = [];
        for (const txn of batch) {
            const desc = (txn.description || '').toLowerCase();
            for (const p of pastPatterns) {
                if (desc && (p.description.toLowerCase().includes(desc.slice(0, 5)) ||
                    p.partner.toLowerCase().includes(desc.slice(0, 5)) ||
                    desc.includes(p.partner.toLowerCase().slice(0, 5)))) {
                    relevantPatterns.push(p);
                }
            }
        }

        const patternInfo = relevantPatterns.length > 0
            ? '\n\n## 過去の類似取引パターン:\n' + relevantPatterns.slice(0, 10).map(p =>
                `- ${p.partner}: ${p.description || '(なし)'} → 勘定科目:${p.accountItemName} 金額:${p.amount}円`
            ).join('\n')
            : '';

        const prompt = `あなたはNPO法人（にこにこおひさまクラブ）の経理担当です。
以下の未処理の銀行/クレジットカード明細について、freee会計に登録する取引内容を提案してください。

## 未処理明細:
${txnList}
${patternInfo}

各明細について、以下のJSON配列で回答してください:
[{
  "index": 明細番号,
  "account_item": "推薦する勘定科目名",
  "partner": "取引先名（推測）",
  "description": "取引の摘要（推測）",
  "reason": "この勘定科目を選んだ理由（日本語で詳しく）"
}]
JSONのみ回答してください。`;

        const resp = await gemini(prompt);
        try {
            const m = resp.match(/\[[\s\S]*\]/);
            if (m) {
                const suggestions = JSON.parse(m[0]);
                for (const s of suggestions) {
                    const txn = batch[s.index - 1];
                    if (!txn) continue;
                    results.push({
                        pattern: '新規提案', txn, deal: null,
                        grade: 'B', // AI提案はB判定
                        reason: s.reason || '摘要テキストからの推測',
                        suggestedAccount: s.account_item || '',
                        suggestedPartner: s.partner || '',
                        suggestedDesc: s.description || '',
                        dealPartner: s.partner || '',
                        dealAccount: s.account_item || '',
                        dealDesc: s.description || '',
                    });
                }
            }
        } catch { /* skip */ }
        await sleep(500);
    }

    console.log(`  ✅ ${results.length}件の新規取引提案`);
    return results;
}

// ── Excel出力 ─────────────────────────────────────────────────
async function writeExcel(pattern1, pattern2, pattern3, unmatchedTxns, walletables, accountItems) {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'freee-matching-v3';

    const hStyle = {
        font: { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 },
        alignment: { horizontal: 'center', vertical: 'middle', wrapText: true },
        border: { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } },
    };
    const gradeColors = { A: 'FFE2EFDA', B: 'FFFFF2CC', C: 'FFFCE4EC' };
    const patternColors = { '消込': 'FF2B5797', 'レシート': 'FF7B2D8B', '新規提案': 'FF2E7D32' };

    // ── Sheet1: マッチング候補（消込・レシート） ──
    const allMatches = [...pattern1, ...pattern2];
    const s1 = wb.addWorksheet('紐づけ候補');
    s1.columns = [
        { header: 'パターン', key: 'pattern', width: 10 },
        { header: '判定', key: 'grade', width: 6 },
        { header: '明細日付', key: 'txn_date', width: 12 },
        { header: '口座', key: 'wallet', width: 20 },
        { header: '入出金', key: 'side', width: 8 },
        { header: '金額', key: 'amount', width: 14 },
        { header: '明細摘要', key: 'txn_desc', width: 28 },
        { header: '→', key: 'arrow', width: 3 },
        { header: 'マッチ先ID', key: 'match_id', width: 14 },
        { header: '取引先', key: 'partner', width: 20 },
        { header: '勘定科目', key: 'account', width: 18 },
        { header: '判定根拠', key: 'reason', width: 50 },
    ];
    s1.getRow(1).eachCell(cell => Object.assign(cell, { ...hStyle, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2B5797' } } }));
    s1.getRow(1).height = 28;

    for (const r of allMatches) {
        const row = s1.addRow({
            pattern: r.pattern,
            grade: r.grade,
            txn_date: r.txn.date,
            wallet: r.txn._wallet_name,
            side: r.txn.entry_side === 'income' ? '入金' : '出金',
            amount: Math.abs(r.txn.amount),
            txn_desc: r.txn.description || '',
            arrow: '→',
            match_id: r.deal ? `取引:${r.deal.id}` : (r.receiptId ? `レシート:${r.receiptId}` : ''),
            partner: r.dealPartner,
            account: r.dealAccount,
            reason: r.reason,
        });
        const bg = gradeColors[r.grade] || 'FFFFFFFF';
        row.eachCell(cell => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
            cell.border = { top: { style: 'thin', color: { argb: 'FFD9D9D9' } }, bottom: { style: 'thin', color: { argb: 'FFD9D9D9' } }, left: { style: 'thin', color: { argb: 'FFD9D9D9' } }, right: { style: 'thin', color: { argb: 'FFD9D9D9' } } };
            cell.alignment = { wrapText: true, vertical: 'top' };
        });
    }
    s1.getColumn('amount').numFmt = '#,##0';

    // ── Sheet2: 新規取引登録の提案 ──
    const s2 = wb.addWorksheet('新規取引の提案');
    s2.columns = [
        { header: '明細日付', key: 'txn_date', width: 12 },
        { header: '口座', key: 'wallet', width: 20 },
        { header: '入出金', key: 'side', width: 8 },
        { header: '金額', key: 'amount', width: 14 },
        { header: '明細摘要', key: 'txn_desc', width: 28 },
        { header: '→ 推薦勘定科目', key: 'account', width: 22 },
        { header: '→ 推薦取引先', key: 'partner', width: 20 },
        { header: '→ 推薦摘要', key: 'description', width: 28 },
        { header: 'AI判定根拠', key: 'reason', width: 50 },
    ];
    s2.getRow(1).eachCell(cell => Object.assign(cell, { ...hStyle, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E7D32' } } }));
    s2.getRow(1).height = 28;

    for (const r of pattern3) {
        const row = s2.addRow({
            txn_date: r.txn.date,
            wallet: r.txn._wallet_name,
            side: r.txn.entry_side === 'income' ? '入金' : '出金',
            amount: Math.abs(r.txn.amount),
            txn_desc: r.txn.description || '',
            account: r.suggestedAccount || '',
            partner: r.suggestedPartner || '',
            description: r.suggestedDesc || '',
            reason: r.reason,
        });
        row.eachCell(cell => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
            cell.border = { top: { style: 'thin', color: { argb: 'FFD9D9D9' } }, bottom: { style: 'thin', color: { argb: 'FFD9D9D9' } }, left: { style: 'thin', color: { argb: 'FFD9D9D9' } }, right: { style: 'thin', color: { argb: 'FFD9D9D9' } } };
            cell.alignment = { wrapText: true, vertical: 'top' };
        });
    }
    s2.getColumn('amount').numFmt = '#,##0';

    // ── Sheet3: 口座一覧 ──
    const s3 = wb.addWorksheet('口座一覧');
    s3.columns = [
        { header: 'ID', key: 'id', width: 10 }, { header: '口座名', key: 'name', width: 30 },
        { header: 'タイプ', key: 'type', width: 15 },
    ];
    s3.getRow(1).eachCell(cell => Object.assign(cell, { ...hStyle, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } } }));
    const tl = { bank_account: '銀行口座', credit_card: 'クレジットカード', wallet: '現金・その他' };
    for (const w of walletables) s3.addRow({ id: w.id, name: w.name, type: tl[w.type] || w.type });

    // ── 保存 ──
    const now = new Date();
    const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const ts = `${jst.getUTCFullYear()}${String(jst.getUTCMonth() + 1).padStart(2, '0')}${String(jst.getUTCDate()).padStart(2, '0')}_${String(jst.getUTCHours()).padStart(2, '0')}${String(jst.getUTCMinutes()).padStart(2, '0')}`;
    const fn = `freee_matching_v3_${ts}.xlsx`;
    const fp = path.join(__dirname, '..', fn);
    await wb.xlsx.writeFile(fp);
    return { fn, fp };
}

// ── メイン ────────────────────────────────────────────────────
async function main() {
    console.log('');
    console.log('═══════════════════════════════════════════════════');
    console.log('  freee会計 マッチングツール v3');
    console.log(`  期間: ${DATE_FROM} 〜 ${DATE_TO}`);
    console.log('═══════════════════════════════════════════════════');

    try {
        const data = await loadData();

        if (!data.txns.length) {
            console.log('\n✅ 未処理明細がありません！');
            return;
        }

        // パターン1: 未決済取引との消込
        const p1 = pattern1_unsettledMatch(data.txns, data.unsettledDeals, data.partnerMap);

        // パターン2: レシート照合
        const allMatched = new Set([...p1.matchedIds]);
        const p2 = await pattern2_receiptMatch(data.txns, data.receipts, allMatched);
        for (const id of p2.matchedIds) allMatched.add(id);

        // パターン3: 新規取引登録の提案
        const p3 = await pattern3_newDealSuggestions(
            data.txns, allMatched, data.recentDeals, data.partnerMap, data.accountItems
        );

        // サマリー
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('  📊 結果サマリー');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`  🔄 消込候補:       ${p1.results.length}件`);
        console.log(`  📸 レシート照合:   ${p2.results.length}件`);
        console.log(`  🤖 新規取引提案:   ${p3.length}件`);
        console.log(`  ━━━━━━━━━━━━`);
        const remaining = data.txns.filter(t => !allMatched.has(t.id) && !p3.find(r => r.txn.id === t.id)).length;
        console.log(`  未対応: ${remaining}件`);

        // Excel
        console.log('\n📊 Excel出力中...');
        const { fn, fp } = await writeExcel(
            p1.results, p2.results, p3,
            data.txns.filter(t => !allMatched.has(t.id)),
            data.walletables, data.accountItems
        );

        console.log('');
        console.log('═══════════════════════════════════════════════════');
        console.log(`  ✅ 完了！`);
        console.log(`  📄 ${fn}`);
        console.log(`  📂 ${fp}`);
        console.log('═══════════════════════════════════════════════════\n');
        console.log('  Sheet1「紐づけ候補」: 消込・レシート照合の候補');
        console.log('  Sheet2「新規取引の提案」: AI推薦の勘定科目・取引先');
        console.log('  Sheet3「口座一覧」');
        console.log('');
    } catch (err) {
        console.error('\n❌ エラー:', err.message);
        if (err.message.includes('401')) console.error(`  → 再認証: https://${CLOUD_RUN_HOST}/auth/freee`);
        process.exit(1);
    }
}

main();
