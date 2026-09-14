/**
 * DoubleTick — WhatsApp Cloud API Webhook Server
 * 
 * Deploy this on Render.com (free tier)
 * 
 * FILL IN YOUR VALUES in the CONFIG section below
 * or set them as Environment Variables in Render dashboard
 */

const express = require('express');
const axios   = require('axios');
const app     = express();

app.use(express.json());

// ─── CONFIG ─────────────────────────────────────────────────────────────────
// Set these as Environment Variables in Render.com dashboard
// (never hardcode real credentials in code)

const CONFIG = {
  // WhatsApp Cloud API
  WA_VERIFY_TOKEN:   process.env.WA_VERIFY_TOKEN   || 'doubletick_verify_123',   // ← any string you choose
  WA_ACCESS_TOKEN:   process.env.WA_ACCESS_TOKEN   || 'YOUR_META_ACCESS_TOKEN',  // ← from Meta App dashboard
  WA_PHONE_NUMBER_ID: process.env.WA_PHONE_NUMBER_ID || 'YOUR_PHONE_NUMBER_ID',  // ← from Meta App dashboard

  // JSONBin
  JSONBIN_API_KEY:   process.env.JSONBIN_API_KEY   || 'YOUR_JSONBIN_API_KEY',     // ← X-Master-Key from jsonbin.io
  JSONBIN_BIN_ID:    process.env.JSONBIN_BIN_ID    || 'YOUR_JSONBIN_BIN_ID',      // ← Bin ID from jsonbin.io

  // Auto-reply message sent back to customer
  AUTO_REPLY: process.env.AUTO_REPLY || 'Thanks for reaching out! Our team will connect with you shortly. 🙏',

  PORT: process.env.PORT || 3000
};

// ─── UNICODE TAGS BLOCK DECODER ──────────────────────────────────────────────
// Mirrors the encoding done in redirect.html
// Unicode Tags Block: U+E0000 to U+E007F
// Each visible ASCII character maps to U+E0000 + charCode

function decodeTagsBlock(text) {
  const chars = [...text]; // spread handles astral plane codepoints correctly
  let token = '';
  
  for (const c of chars) {
    const cp = c.codePointAt(0);
    if (cp >= 0xE0000 && cp <= 0xE007F) {
      // Convert back to ASCII
      token += String.fromCharCode(cp - 0xE0000);
    }
  }
  
  return token.trim() || null;
}

function stripTagsBlock(text) {
  return [...text]
    .filter(c => {
      const cp = c.codePointAt(0);
      return !(cp >= 0xE0000 && cp <= 0xE007F);
    })
    .join('')
    .trim();
}

// ─── JSONBIN HELPERS ─────────────────────────────────────────────────────────

async function readBin() {
  const res = await axios.get(
    `https://api.jsonbin.io/v3/b/${CONFIG.JSONBIN_BIN_ID}/latest`,
    { headers: { 'X-Master-Key': CONFIG.JSONBIN_API_KEY } }
  );
  return res.data.record || { sessions: {} };
}

async function writeBin(record) {
  await axios.put(
    `https://api.jsonbin.io/v3/b/${CONFIG.JSONBIN_BIN_ID}`,
    record,
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': CONFIG.JSONBIN_API_KEY
      }
    }
  );
}

// ─── WHATSAPP CLOUD API — SEND MESSAGE ───────────────────────────────────────

async function sendWhatsAppReply(to, message) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${CONFIG.WA_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to: to,
      type: 'text',
      text: { body: message }
    },
    {
      headers: {
        'Authorization': `Bearer ${CONFIG.WA_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
}

// ─── WEBHOOK VERIFICATION (GET) ───────────────────────────────────────────────
// Meta calls this once when you register the webhook URL

app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log(`[Webhook Verify] mode=${mode} token=${token}`);

  if (mode === 'subscribe' && token === CONFIG.WA_VERIFY_TOKEN) {
    console.log('[Webhook Verify] ✅ Verified successfully');
    res.status(200).send(challenge);
  } else {
    console.log('[Webhook Verify] ❌ Token mismatch');
    res.sendStatus(403);
  }
});

// ─── WEBHOOK RECEIVER (POST) ──────────────────────────────────────────────────
// Meta calls this every time a WhatsApp message comes in

app.post('/webhook', async (req, res) => {
  // Always respond 200 immediately — Meta requires this within 5 seconds
  res.sendStatus(200);

  try {
    const body = req.body;

    // Validate it's a WhatsApp message event
    if (
      body.object !== 'whatsapp_business_account' ||
      !body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]
    ) {
      console.log('[Webhook] Received non-message event — skipping');
      return;
    }

    const change  = body.entry[0].changes[0].value;
    const message = change.messages[0];
    const from    = message.from;           // Customer's WhatsApp number
    const msgType = message.type;
    const msgText = message.text?.body || '';
    const msgId   = message.id;

    console.log(`\n[Inbound] From: ${from} | Type: ${msgType} | Text: "${msgText}"`);

    // Only process text messages
    if (msgType !== 'text') {
      console.log('[Inbound] Non-text message — skipping');
      return;
    }

    // ── Step 1: Decode invisible token ───────────────────────────────────────
    const token   = decodeTagsBlock(msgText);
    const cleaned = stripTagsBlock(msgText);

    console.log(`[Decoder] Raw text length: ${[...msgText].length}`);
    console.log(`[Decoder] Extracted token: ${token || 'NONE'}`);
    console.log(`[Decoder] Cleaned message: "${cleaned}"`);

    if (!token) {
      console.log('[Attribution] No invisible token found — organic message, skipping attribution');
      return;
    }

    // ── Step 2: Look up token in JSONBin ─────────────────────────────────────
    let record;
    try {
      record = await readBin();
    } catch (e) {
      console.error('[JSONBin] Read failed:', e.message);
      return;
    }

    const sessions = record.sessions || {};
    const session  = sessions[token];

    if (!session) {
      console.log(`[Attribution] Token ${token} not found in session store — may have expired`);
      return;
    }

    if (session.claimed_at) {
      console.log(`[Attribution] Token ${token} already claimed at ${session.claimed_at} — skipping`);
      return;
    }

    const gclid = session.gclid;
    console.log(`[Attribution] ✅ Token matched! GCLID: ${gclid}`);

    // ── Step 3: Mark session as claimed ──────────────────────────────────────
    session.claimed_at       = new Date().toISOString();
    session.conversation_id  = `wa_${from}_${Date.now()}`;
    session.whatsapp_number  = from;
    session.first_message    = cleaned; // Stripped message — no invisible chars

    try {
      await writeBin(record);
      console.log(`[JSONBin] ✅ Session ${token} marked as claimed`);
    } catch (e) {
      console.error('[JSONBin] Write failed:', e.message);
    }

    // ── Step 4: Send auto-reply to customer ──────────────────────────────────
    try {
      await sendWhatsAppReply(from, CONFIG.AUTO_REPLY);
      console.log(`[WhatsApp] ✅ Auto-reply sent to ${from}`);
    } catch (e) {
      console.error('[WhatsApp] Auto-reply failed:', e.message);
    }

    // ── Step 5: Log the full attribution event ───────────────────────────────
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('ATTRIBUTION EVENT');
    console.log(`  Token:          ${token}`);
    console.log(`  GCLID:          ${gclid}`);
    console.log(`  WhatsApp:       ${from}`);
    console.log(`  Campaign:       ${session.utm_campaign || '—'}`);
    console.log(`  Keyword:        ${session.utm_term || '—'}`);
    console.log(`  Click time:     ${session.created_at}`);
    console.log(`  Claimed at:     ${session.claimed_at}`);
    console.log(`  Message sent:   "${cleaned}"`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  } catch (err) {
    console.error('[Webhook] Unhandled error:', err.message);
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'DoubleTick WhatsApp Attribution Webhook',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ─── START ────────────────────────────────────────────────────────────────────

app.listen(CONFIG.PORT, () => {
  console.log(`\n🚀 DoubleTick Webhook Server running on port ${CONFIG.PORT}`);
  console.log(`   Verify Token: ${CONFIG.WA_VERIFY_TOKEN}`);
  console.log(`   Phone Number ID: ${CONFIG.WA_PHONE_NUMBER_ID}`);
  console.log(`   JSONBin Bin ID: ${CONFIG.JSONBIN_BIN_ID}\n`);
});
