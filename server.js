const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Store connected overlay clients
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

// SCB webhook endpoint
app.post('/webhook/scb', (req, res) => {
  try {
    const body = req.body;
    console.log('[SCB webhook]', JSON.stringify(body));

    // SCB Easy API transaction notification format
    const txn = body?.data?.transactionList?.[0] || body;
    const amount = parseFloat(txn?.amount || txn?.transactionAmount || 0);
    const sender = txn?.sender?.displayName || txn?.senderName || 'ไม่ระบุชื่อ';
    const message = txn?.transactionRemark || txn?.comment || '';

    if (amount > 0) {
      broadcast({ type: 'donation', sender, amount, message });
      console.log(`[Donation] ${sender} → ฿${amount} "${message}"`);
    }

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[Webhook error]', err);
    res.status(400).json({ error: 'bad request' });
  }
});

// Test endpoint — send fake donation without needing real SCB
app.post('/test', (req, res) => {
  const { sender = 'ผู้ทดสอบ', amount = 100, message = 'ทดสอบระบบ!' } = req.body || {};
  broadcast({ type: 'donation', sender, amount: parseFloat(amount), message });
  console.log(`[Test donation] ${sender} → ฿${amount} "${message}"`);
  res.json({ status: 'ok', sent: { sender, amount, message } });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n=== Donation Alert Server ===`);
  console.log(`Server:   http://localhost:${PORT}`);
  console.log(`Overlay:  http://localhost:${PORT}/overlay.html  ← ใส่ใน OBS`);
  console.log(`Test:     http://localhost:${PORT}/test.html`);
  console.log(`Webhook:  http://localhost:${PORT}/webhook/scb  ← ใส่ใน SCB`);
  console.log(`============================\n`);
});
