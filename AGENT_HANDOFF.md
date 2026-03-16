# 🤖 Agent Handoff — 学童シフト管理アプリ

> **最終更新**: 2026-03-16
> **対象リポジトリ**: `daiki916/gakudo-shift-manager`

---

## 📌 プロジェクト概要

「にこにこおひさまクラブ」の **学童保育スタッフ向けシフト管理 + 人件費シミュレーション + LINE WORKS BOT + freee 勤怠連携** を統合した Web アプリケーション。

| 項目 | 値 |
|------|----|
| **言語/FW** | Node.js 20 / Express 4 |
| **DB** | PostgreSQL（Neon） |
| **デプロイ先** | Google Cloud Run（本番）、Render（旧・併用可） |
| **GCP プロジェクト** | `blissful-robot-485000-s3` |
| **Cloud Run リージョン** | `asia-northeast1` |
| **本番 URL** | `https://gakudo-shift-manager-229549757994.asia-northeast1.run.app` |
| **Git** | `https://github.com/daiki916/gakudo-shift-manager.git`（`main` ブランチ） |

---

## 🏗 アーキテクチャ

```
gakudo-shift-manager/
├── server.js              # Express エントリポイント（全ルート登録）
├── database.js            # PostgreSQL 接続 & テーブル自動生成（Neon）
├── routes/
│   ├── staff.js           # スタッフ CRUD API（17.7KB）
│   ├── shifts.js          # シフト・人件費 API（20KB）
│   ├── lineworks.js       # LINE WORKS シフト BOT webhook（22KB）
│   └── lineworks-freee.js # LINE WORKS freee 勤怠 BOT webhook（24KB）
├── services/
│   ├── lineworks-auth.js  # LINE WORKS Service Account JWT 認証（15KB）
│   ├── freee-auth.js      # freee OAuth2 トークン管理（7.3KB）
│   ├── freee-api.js       # freee HR API 呼び出し（7.5KB）
│   ├── gemini.js          # Gemini AI シフト解析（4.4KB）
│   ├── gemini-freee.js    # Gemini AI freee コマンド解析（5.4KB）
│   ├── daily-report.js    # 日次出勤レポート生成・LINE WORKS 送信（6.4KB）
│   └── freee-bot-menu.js  # freee BOT リッチメニュー管理（7.7KB）
├── public/
│   ├── index.html         # ランディングページ
│   ├── admin/index.html   # 管理画面 SPA
│   ├── staff/index.html   # スタッフ入力画面 SPA
│   └── css/style.css      # デザインシステム
├── scripts/
│   ├── freee-matching.js  # freee 明細マッチングスクリプト
│   └── sync-freee-bot-menu.js
├── Dockerfile             # Cloud Run 用（node:20-alpine, PORT=8080）
├── render.yaml            # Render 用デプロイ設定
└── data/                  # ローカル SQLite DB（本番では不使用）
```

---

## ⚠️ Git 未コミットの変更（重要）

現在 `main` ブランチに **大量の未コミット変更** があります。他 PC で作業する前に、まずこのPCで以下を実行してください：

```bash
cd gakudo-shift-manager
git add -A
git commit -m "feat: add freee bot, Cloud Run support, daily reports"
git push origin main
```

### 未コミットファイル一覧

**変更済み (Modified)**:
- `database.js` — PostgreSQL 化（元は SQLite）
- `package.json` / `package-lock.json` — `pg`, `exceljs`, `jsonwebtoken` 追加
- `server.js` — freee BOT / daily report ルート追加
- `public/admin/index.html` — 管理画面の改善
- `routes/staff.js` — lineworks_id 対応
- `services/lineworks-auth.js` — DER base64 秘密鍵方式

**新規 (Untracked)**:
- `Dockerfile`, `.dockerignore`, `.gcloudignore` — Cloud Run 対応
- `routes/lineworks-freee.js` — freee 勤怠 BOT
- `services/freee-*.js`, `services/daily-report.js`, `services/gemini-freee.js` — freee 連携全体
- `CLOUD_RUN_SECRETS.md`, `DAILY_ATTENDANCE_REPORT.md`, `FREEE_BOT_RICH_MENU.md`

---

## 🔧 他 PC でのセットアップ手順

### 1. リポジトリを clone

```bash
git clone https://github.com/daiki916/gakudo-shift-manager.git
cd gakudo-shift-manager
npm install
```

### 2. 環境変数を設定

`.env` ファイルを作成（`.env.example` 参照）:

```env
# 必須: Neon PostgreSQL 接続URL
DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require

# ポート（デフォルト 3000）
PORT=3000
NODE_ENV=development
```

> **DATABASE_URL** は Neon Dashboard（https://neon.tech）から取得。
> 本番と同じ DB に接続すれば、既存データがそのまま使えます。

### 3. ローカル起動

```bash
npm start
# → http://localhost:3000/admin で管理画面
```

---

## 🔑 環境変数一覧

### Cloud Run 本番（Secret Manager 経由）

| 変数名 | 用途 |
|--------|------|
| `DATABASE_URL` | Neon PostgreSQL 接続文字列 |
| `GEMINI_API_KEY` | Gemini AI API キー |
| `LINEWORKS_CLIENT_SECRET` | LINE WORKS BOT 認証 |
| `LINEWORKS_PRIVATE_KEY_DER` | LINE WORKS JWT 署名用秘密鍵（DER base64） |
| `FREEE_CLIENT_SECRET` | freee OAuth2 |
| `FREEE_ACCESS_TOKEN` | freee API トークン |
| `FREEE_REFRESH_TOKEN` | freee リフレッシュトークン |

### Cloud Run 本番（直接設定）

| 変数名 | 用途 |
|--------|------|
| `NODE_ENV` | `production` |
| `LINEWORKS_BOT_ID` | シフト BOT ID |
| `FREEE_BOT_ID` | freee 勤怠 BOT ID |
| `LINEWORKS_CLIENT_ID` | LINE WORKS アプリ ID |
| `LINEWORKS_DOMAIN_ID` | LINE WORKS ドメイン ID |
| `LINEWORKS_SERVICE_ACCOUNT` | LINE WORKS サービスアカウント |
| `FREEE_CLIENT_ID` | freee アプリ ID |
| `FREEE_COMPANY_ID` | freee 事業所 ID |
| `FREEE_REDIRECT_URI` | freee OAuth コールバック URL |

---

## 🚀 デプロイ手順

### Cloud Run（本番推奨）

```bash
gcloud run deploy gakudo-shift-manager \
  --project blissful-robot-485000-s3 \
  --region asia-northeast1 \
  --source .
```

Secret の更新は `CLOUD_RUN_SECRETS.md` を参照。

### Render（旧環境）

`main` に push すると自動デプロイ。

---

## 📋 DB スキーマ（PostgreSQL）

| テーブル | 用途 |
|---------|------|
| `organizations` | 組織マスタ（固定: `nikoniko-ohisama`） |
| `clubs` | クラブ 1〜6（ログイン ID/PW あり） |
| `staff` | スタッフ（名前, 時給/月給, 各種手当, `lineworks_id`） |
| `shift_requests` | シフト希望（スタッフ入力分） |
| `shifts` | 確定シフト（管理者確定分） |
| `shift_patterns` | シフトパターンマスタ |

---

## 🤖 BOT 仕様

### シフト BOT（LINE WORKS）

- Webhook: `/api/lineworks/callback`
- ステータス: `/api/lineworks/status`
- Gemini AI でメッセージ解析 → シフト希望を自動登録
- スタッフは `staff.lineworks_id` で紐付け

### freee 勤怠 BOT（LINE WORKS）

- Webhook: `/api/freee-bot/callback`
- freee HR API 経由で打刻・勤怠照会
- Gemini AI でコマンド解析

### 日次レポート

- `POST /api/daily-report` — 当日の出勤状況を LINE WORKS グループに送信
- `GET /api/daily-report?date=2026-03-16` — プレビュー

---

## 🛠 よくある作業

| やりたいこと | 方法 |
|-------------|------|
| スタッフ追加 | `/admin` → スタッフタブ → 新規追加 |
| シフト確認 | `/admin` → シフト表タブ |
| BOT トラブル | `LINEWORKS_BOT_RUNBOOK.md` 参照 |
| Secret 更新 | `CLOUD_RUN_SECRETS.md` 参照 |
| freee 認証切れ | `https://本番URL/auth/freee` にアクセス |
| DB 直接確認 | Neon Dashboard でクエリ実行 |

---

## 📝 開発時の注意点

1. **DB は PostgreSQL のみ**。`$1, $2` プレースホルダ構文（`?` ではない）
2. **LINE WORKS 秘密鍵は DER base64 形式**に統一済み。PEMは不使用
3. **freee トークンは Cloud Run Secret Manager に保存**。ローカルでは `.env.local` に直接記述可
4. **Gemini AI** をシフト解析・freee コマンド解析の2箇所で使用
5. **フロントエンドは SPA**（vanilla JS）。`public/admin/index.html` と `public/staff/index.html`
