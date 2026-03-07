# LINE WORKS BOT 運用手順書

`gakudo-shift-manager` の LINE WORKS BOT を新規構築・更新・運用するときの手順をまとめたファイルです。

## 1. 対象

- Render service: `gakudo-shift-manager`
- 公開 URL: `https://gakudo-shift-manager.onrender.com`
- Webhook endpoint: `https://gakudo-shift-manager.onrender.com/api/lineworks/callback`
- ステータス確認:
  - `https://gakudo-shift-manager.onrender.com/api/lineworks/status`
  - `https://gakudo-shift-manager.onrender.com/api/lineworks/debug`

## 2. 事前に用意するもの

- LINE WORKS Developer Console で作成した BOT
- Service Account 認証に必要な以下の情報
  - `LINEWORKS_CLIENT_ID`
  - `LINEWORKS_CLIENT_SECRET`
  - `LINEWORKS_SERVICE_ACCOUNT`
  - `LINEWORKS_BOT_ID`
- 秘密鍵
  - 推奨: PKCS#8 DER バイナリを base64 化した `LINEWORKS_PRIVATE_KEY_DER`
  - 非推奨: `LINEWORKS_PRIVATE_KEY_BASE64` や `LINEWORKS_PRIVATE_KEY`

## 3. 新規 BOT 構築の流れ

1. LINE WORKS 側で BOT を作成する
2. Callback URL に `https://gakudo-shift-manager.onrender.com/api/lineworks/callback` を設定する
3. Render に必要な環境変数を登録する
4. Render をデプロイする
5. `/api/lineworks/status` と `/api/lineworks/debug` で疎通確認する
6. スタッフの `lineworks_id` を紐付ける
7. 実際の LINE WORKS から `ヘルプ` を送り、返信を確認する

## 4. Render 環境変数の設定

### 必須

- `LINEWORKS_CLIENT_ID`
- `LINEWORKS_CLIENT_SECRET`
- `LINEWORKS_SERVICE_ACCOUNT`
- `LINEWORKS_BOT_ID`
- `LINEWORKS_PRIVATE_KEY_DER`

### 秘密鍵の重要事項

- `LINEWORKS_PRIVATE_KEY_DER` には DER バイナリの base64 を入れる
- 前後に空白や改行を入れない
- `=` で終わる場合はそのまま保持する
- `LINEWORKS_PRIVATE_KEY_BASE64` と `LINEWORKS_PRIVATE_KEY` は使わない
- 旧形式が残っていると切り分けが難しくなるため、不要な場合は削除する

### Render Dashboard での更新手順

1. Render Dashboard にログインする
2. `gakudo-shift-manager` を開く
3. `Environment` を開く
4. 古い秘密鍵変数を削除する
   - `LINEWORKS_PRIVATE_KEY_BASE64`
   - `LINEWORKS_PRIVATE_KEY`
5. `LINEWORKS_PRIVATE_KEY_DER` を追加または更新する
6. 保存する
7. `Manual Deploy` から `Deploy latest commit` を実行する

## 5. デプロイ後の確認

### `/api/lineworks/status`

最低限以下を確認する。

- `configured: true`
- `gemini_configured: true`

### `/api/lineworks/debug`

最低限以下を確認する。

- `env.has_private_key_der === true`
- `env.private_key_der_length` が期待値と一致する
- `env.has_private_key_base64 === false`
- `env.has_private_key_raw === false`
- `jwt_sign.success === true`
- `access_token.success === true`
- `jwt_sign.key_source === "der_base64"`

## 6. スタッフと LINE WORKS ID の紐付け

BOT が返信できても、スタッフに紐付いていないとシフト登録はできません。

### 管理画面で紐付ける方法

1. 管理画面を開く
2. 対象スタッフを編集する
3. `LINE WORKS ID` に LINE WORKS の `userId` を設定する
4. 保存する

### API で紐付ける方法

1. 対象スタッフを探す

```powershell
Invoke-WebRequest -UseBasicParsing -Uri 'https://gakudo-shift-manager.onrender.com/api/staff' |
  Select-Object -ExpandProperty Content
```

2. 対象スタッフ ID に対して `PUT /api/staff/:id` を実行する

```powershell
$body = @{ lineworks_id = 'LINE_WORKS_USER_ID' } | ConvertTo-Json
Invoke-WebRequest `
  -UseBasicParsing `
  -Method PUT `
  -Uri 'https://gakudo-shift-manager.onrender.com/api/staff/31' `
  -ContentType 'application/json' `
  -Body $body
```

3. 再取得して反映を確認する

```powershell
$staff = Invoke-WebRequest -UseBasicParsing -Uri 'https://gakudo-shift-manager.onrender.com/api/staff/all' |
  Select-Object -ExpandProperty Content | ConvertFrom-Json
$staff | Where-Object { $_.lineworks_id -eq 'LINE_WORKS_USER_ID' }
```

### 実例

- `今井 大樹`
  - staff id: `31`
  - lineworks_id: `452ff3c7-cf67-4a86-169c-043d41306310`

## 7. 返信内容の変更手順

### ヘルプ文言

- ファイル: `routes/lineworks.js`
- 変数: `WELCOME_MESSAGE`

変更後は以下を実施する。

1. コード変更
2. コミット
3. `origin/main` に push
4. Render で `Deploy latest commit`
5. LINE WORKS から `ヘルプ` を送って確認

### 返信分岐の確認ポイント

- `isHelpMessage()` に入るメッセージか
- Gemini 解析後の `parsed.action`
- `pendingConfirmations` に入っていないか
- スタッフ紐付け済みか

## 8. ログ確認のポイント

Render Logs で主に見るログ:

- `📨 LINE WORKS callback`
- `🤖 Gemini parsed`
- `🔑 Private key loaded from DER base64`
- `✅ JWT signed successfully`
- `✅ LINE WORKS access token obtained`
- `📤 Sending LINE WORKS message`
- `✅ LINE WORKS message sent`
- `Send message error:`

## 9. よくあるトラブル

### 返信が返ってこない

確認順:

1. `/api/lineworks/status` が `configured: true` か
2. `/api/lineworks/debug` で `jwt_sign.success` と `access_token.success` が `true` か
3. Render Logs に `📨 LINE WORKS callback` が出ているか
4. `📤 Sending LINE WORKS message` の後に `✅ LINE WORKS message sent` が出ているか
5. LINE WORKS 側の callback URL 設定が正しいか

### 秘密鍵エラー

- `LINEWORKS_PRIVATE_KEY_DER` の文字列長を確認する
- DER base64 かどうかを確認する
- 旧変数 `LINEWORKS_PRIVATE_KEY_BASE64` / `LINEWORKS_PRIVATE_KEY` を消す

### シフト登録できない

ログに `No staff linked for LINE WORKS user` が出ていないか確認する。
出ている場合は `staff.lineworks_id` を紐付ける。

### ヘルプ文言を変えたのに反映されない

確認順:

1. 変更した repo が `daiki916/gakudo-shift-manager` か
2. `origin/main` に push 済みか
3. Render 上で対象 commit が `Live` になっているか
4. 送っているメッセージが `ヘルプ` 系の分岐に入るか

## 10. 今回の運用メモ

- 秘密鍵は `LINEWORKS_PRIVATE_KEY_DER` に統一する
- ヘルプ文言は月単位募集を前提にする
- スタッフ紐付けがないと、シフト解析が成功しても登録確認へ進まない
- 本番確認は Render Logs の `callback -> auth -> sending -> message sent` の流れで見る
