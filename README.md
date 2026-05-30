# PW API Server — Vercel Deploy

## Project Structure
```
pw-vercel/
├── api/
│   └── index.js        ← Main Express app (Vercel serverless)
├── public/
│   └── index.html      ← Web UI
├── vercel.json         ← Vercel routing config
├── package.json
└── .env.example
```

## Deploy Steps

### 1. GitHub pe upload karo
```bash
git init
git add .
git commit -m "PW API Server"
git remote add origin https://github.com/YOUR_USER/pw-api.git
git push -u origin main
```

### 2. Vercel pe deploy karo
1. https://vercel.com/new kholo
2. GitHub repo select karo
3. **Environment Variables** add karo (Settings → Environment Variables):
   - `TELEGRAM_BOT_TOKEN` = your bot token
   - `TELEGRAM_CHANNEL_ID` = your channel ID (e.g. -100xxx)
   - `UPSTASH_REDIS_URL` = redis URL (optional)
   - `UPSTASH_REDIS_TOKEN` = redis token (optional)
4. Deploy karo ✅

## Token Add Karne Ke Tarike

### API se (curl)
```bash
curl -X POST https://your-app.vercel.app/api/admin/add-token \
  -H "Content-Type: application/json" \
  -d '{"token": "eyJ...", "label": "My Account"}'
```

### Web UI se
`https://your-app.vercel.app` → Manager tab → token paste karo

## Persistent Storage (Important!)
Vercel serverless functions mein memory reset hoti hai cold start pe.
Permanent storage ke liye **Upstash Redis** use karo (free tier available):
1. https://upstash.com → Create Database
2. REST URL aur Token copy karo
3. Vercel env variables mein daalo

## API Endpoints
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/send-otp` | ❌ | OTP send karo |
| POST | `/api/auth/verify-otp` | ❌ | OTP verify → token |
| POST | `/api/admin/add-token` | ❌ | Token add/refresh |
| GET | `/api/admin/tokens` | ❌ | Sab saved tokens |
| DELETE | `/api/admin/tokens/:token` | ❌ | Token remove |
| POST | `/api/admin/refresh-token/:token` | ❌ | Batches refresh |
| GET | `/api/batches` | ✅ | My batches |
| GET | `/api/batches/:id` | ✅ | Batch details |
| GET | `/api/batches/:id/subjects/:sid/contents` | ✅ | Videos/Notes |
| GET | `/api/batches/:id/subjects/:sid/topics` | ✅ | Topics |
| GET | `/api/batches/:id/live` | ✅ | Live classes |

✅ Auth = `Authorization: Bearer <token>` header required
