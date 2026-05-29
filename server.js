require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const generatePayload = require('promptpay-qr');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PROMPTPAY_ID = process.env.PROMPTPAY_ID || '';

// ---- Settings (in-memory, reset on restart) ----
let settings = {
  chimeEnabled: true,
  chimeVolume: 0.6,
  ttsEnabled: true,
  ttsVoice: '',       // voice name, empty = auto pick Thai female
  ttsRate: 0.95,
  ttsPitch: 1.1,
  alertDuration: 6000 // ms
};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- WebSocket ----
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[WS] Overlay connected (${clients.size} total)`);
  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WS] Overlay disconnected (${clients.size} total)`);
  });
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// ---- PromptPay QR API ----
// GET /api/qr?amount=100
app.get('/api/qr', async (req, res) => {
  const amount = parseFloat(req.query.amount) || 0;
  if (!PROMPTPAY_ID) return res.status(500).json({ error: 'PROMPTPAY_ID not set in .env' });

  const payload = generatePayload(PROMPTPAY_ID, { amount });
  const qrDataUrl = await QRCode.toDataURL(payload, { width: 300, margin: 2 });
  res.json({ qr: qrDataUrl });
});

// ---- Android LINE notification webhook ----
// MacroDroid POST to /webhook/android with body: { "text": "..raw notification text.." }
app.post('/webhook/android', (req, res) => {
  try {
    const text = req.body?.text || '';
    console.log('[Android notification]', text);

    // Parse SCB Connect LINE notification format
    // Example: "รายการเงินเข้า\n+1,200.00 บาท\nจากบัญชี นาย ธนกร พนธน X-3070\nกสิกรไทย"
    const amountMatch = text.match(/\+([\d,]+(?:\.\d{1,2})?)\s*บาท/);
    const senderMatch = text.match(/จากบัญชี\s+(.+?)\s+X-\d+/);

    const amount = amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : 0;
    const sender = senderMatch ? senderMatch[1].trim() : 'ไม่ระบุชื่อ';
    const message = req.body?.donorMessage || '';

    if (amount > 0) {
      broadcast({ type: 'donation', sender, amount, message });
      console.log(`[Donation] ${sender} → ฿${amount}`);
    }

    res.json({ status: 'ok', parsed: { sender, amount } });
  } catch (err) {
    console.error('[Webhook error]', err);
    res.status(400).json({ error: 'bad request' });
  }
});

// ---- Test endpoint ----
app.post('/test', (req, res) => {
  const { sender = 'ผู้ทดสอบ', amount = 100, message = 'ทดสอบระบบ!' } = req.body || {};
  broadcast({ type: 'donation', sender, amount: parseFloat(amount), message });
  console.log(`[Test] ${sender} → ฿${amount}`);
  res.json({ status: 'ok', sent: { sender, amount, message } });
});

// ---- Config endpoint (for donate page) ----
app.get('/api/config', (req, res) => {
  res.json({ hasPromptPay: !!PROMPTPAY_ID });
});

// ---- Settings endpoints ----
app.get('/api/settings', (req, res) => res.json(settings));
app.post('/api/settings', (req, res) => {
  settings = { ...settings, ...req.body };
  broadcast({ type: 'settings', settings });
  console.log('[Settings updated]', settings);
  res.json({ status: 'ok', settings });
});

// ---- TTS proxy (Google Translate) ----
app.get('/api/tts', async (req, res) => {
  const text = req.query.text || '';
  const rate = parseFloat(req.query.rate) || 0.95;
  if (!text) return res.status(400).end();
  try {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=th&client=tw-ob&ttsspeed=${rate}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://translate.google.com/' }
    });
    if (!response.ok) throw new Error('TTS fetch failed');
    res.set('Content-Type', 'audio/mpeg');
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('[TTS error]', err.message);
    res.status(500).end();
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  const ip = getLocalIP();
  console.log(`\n=== Donation Alert Server ===`);
  console.log(`PC local IP:  ${ip}`);
  console.log(`Overlay:      http://localhost:${PORT}/overlay.html  ← OBS Browser Source`);
  console.log(`Donate page:  http://${ip}:${PORT}/donate.html       ← ส่งให้คนดู`);
  console.log(`Test:         http://localhost:${PORT}/test.html`);
  console.log(`Android hook: http://${ip}:${PORT}/webhook/android   ← ใส่ใน MacroDroid`);
  console.log(`============================\n`);
});

function getLocalIP() {
  const { networkInterfaces } = require('os');
  for (const iface of Object.values(networkInterfaces())) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) return alias.address;
    }
  }
  return 'localhost';
}
