# FREEE BOT Rich Menu

## Current menu

- 前日レポート
- 今日の勤怠
- 出勤修正
- 退勤修正
- 休憩修正
- ヘルプ

Image file:

- `assets/freee-bot-richmenu.png`

Menu definition and sync logic:

- `services/freee-bot-menu.js`
- `scripts/sync-freee-bot-menu.js`

## Sync again

The script expects the LINE WORKS service-account environment variables and `FREEE_BOT_ID`.

```powershell
$env:LINEWORKS_CLIENT_ID='...'
$env:LINEWORKS_CLIENT_SECRET='...'
$env:LINEWORKS_PRIVATE_KEY_DER='...'
$env:LINEWORKS_SERVICE_ACCOUNT='...'
$env:FREEE_BOT_ID='11788376'
node scripts/sync-freee-bot-menu.js
```

If you omit the image path, the script uses:

```text
assets/freee-bot-richmenu.png
```

You can also specify another PNG or JPEG:

```powershell
node scripts/sync-freee-bot-menu.js .\assets\freee-bot-richmenu.png
```
