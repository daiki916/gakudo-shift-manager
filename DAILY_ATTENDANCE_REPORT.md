# Daily Attendance Report

## What it does

Every day at 9:00 JST, the service checks who had attendance punches on the previous day and sends a LINE WORKS report for attendance review.

## Issue categories

- `freee取得エラー`: freee work record lookup failed
- `打刻漏れ`: either clock-in or clock-out is missing

Workers without issues are listed in the `確認済み` section with actual times.

## Endpoint

- Preview: `GET /api/daily-report`
- Send now: `POST /api/daily-report`

If no `date` is provided, the service uses the previous day in JST.

## Scheduler

Cloud Scheduler job:

```txt
daily-attendance-report
```

Current schedule:

```txt
0 9 * * *  (Asia/Tokyo)
```

Current target:

```txt
https://gakudo-shift-manager-229549757994.asia-northeast1.run.app/api/daily-report
```

## Delivery

- If `DAILY_REPORT_CHANNEL_ID` is set, the report is sent to that LINE WORKS channel.
- Otherwise it is sent by DM to `DAILY_REPORT_RECIPIENT`.
- If `DAILY_REPORT_RECIPIENT` is unset, the fallback recipient is the current admin user ID already hardcoded in the service.
