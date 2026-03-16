# Cloud Run Secret Manager Notes

This service now reads sensitive configuration from Google Secret Manager instead of storing those values directly in Cloud Run environment variables.

## Current secret-backed env vars

- `GEMINI_API_KEY`
- `LINEWORKS_CLIENT_SECRET`
- `LINEWORKS_PRIVATE_KEY_DER`
- `DATABASE_URL`
- `FREEE_CLIENT_SECRET`
- `FREEE_ACCESS_TOKEN`
- `FREEE_REFRESH_TOKEN`

## Non-secret env vars still stored directly on Cloud Run

- `NODE_ENV`
- `LINEWORKS_BOT_ID`
- `FREEE_BOT_ID`
- `LINEWORKS_CLIENT_ID`
- `LINEWORKS_DOMAIN_ID`
- `LINEWORKS_SERVICE_ACCOUNT`
- `FREEE_CLIENT_ID`
- `FREEE_COMPANY_ID`
- `FREEE_REDIRECT_URI`

## Service account access

Cloud Run runtime service account:

```txt
229549757994-compute@developer.gserviceaccount.com
```

It needs `roles/secretmanager.secretAccessor` on each secret above.

## Rotate a secret

Add a new secret version:

```powershell
gcloud secrets versions add SECRET_NAME `
  --project blissful-robot-485000-s3 `
  --data-file=PATH_TO_FILE
```

If you are adding a one-line value, make sure the file does not include an extra trailing newline.

Redeploy the service so the latest secret version is picked up by a new revision:

```powershell
gcloud run services update gakudo-shift-manager `
  --project blissful-robot-485000-s3 `
  --region asia-northeast1 `
  --update-secrets `
  GEMINI_API_KEY=GEMINI_API_KEY:latest,LINEWORKS_CLIENT_SECRET=LINEWORKS_CLIENT_SECRET:latest,LINEWORKS_PRIVATE_KEY_DER=LINEWORKS_PRIVATE_KEY_DER:latest,DATABASE_URL=DATABASE_URL:latest,FREEE_CLIENT_SECRET=FREEE_CLIENT_SECRET:latest,FREEE_ACCESS_TOKEN=FREEE_ACCESS_TOKEN:latest,FREEE_REFRESH_TOKEN=FREEE_REFRESH_TOKEN:latest
```

## Verify after rotation

Check LINE WORKS auth:

```powershell
Invoke-WebRequest -UseBasicParsing `
  'https://gakudo-shift-manager-229549757994.asia-northeast1.run.app/api/lineworks/debug' |
  Select-Object -ExpandProperty Content
```

Check service status:

```powershell
Invoke-WebRequest -UseBasicParsing `
  'https://gakudo-shift-manager-229549757994.asia-northeast1.run.app/api/lineworks/status' |
  Select-Object -ExpandProperty Content
```
