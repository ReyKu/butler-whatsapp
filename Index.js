import pkg from '@whiskeysockets/baileys'
const { default: makeWASocket, DisconnectReason, makeCacheableSignalKeyStore } = pkg
import { Boom } from '@hapi/boom'
import express from 'express'
import fetch from 'node-fetch'
import pino from 'pino'

const app = express()
app.use(express.json())

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SERVICE_ROLE_KEY
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY

let qrCode = null
let isConnected = false
let sock = null

// ── Supabase auth state storage ───────────────────────────────────────────────
async function getAuthFromSupabase() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/whatsapp_auth?select=key,value`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  })
  const rows = await res.json()
  const state = {}
  for (const row of rows || []) {
    try { state[row.key] = JSON.parse(row.value) } catch { state[row.key] = row.value }
  }
  return state
}

async function saveAuthToSupabase(key, value) {
  await fetch(`${SUPABASE_URL}/rest/v1/whatsapp_auth`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates'
    },
    body: JSON.stringify({ key, value: JSON.stringify(value) })
  })
}

function useSupabaseAuthState() {
  const authState = { creds: null, keys: {} }

  const saveCreds = async () => {
    await saveAuthToSupabase('creds', authState.creds)
  }

  const state = {
    creds: authState.creds,
    keys: {
      get: async (type, ids) => {
        const data = {}
        for (const id of ids) {
          const res = await fetch(`${SUPABASE_URL}/rest/v1/whatsapp_auth?key=eq.${type}-${id}&select=value`, {
            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
          })
          const rows = await res.json()
          if (rows?.[0]?.value) {
            try { data[id] = JSON.parse(rows[0].value) } catch { data[id] = rows[0].value }
          }
        }
        return data
      },
      set: async (data) => {
        for (const [type, ids] of Object.entries(data)) {
          for (const [id, value] of Object.entries(ids || {})) {
            if (value) await saveAuthToSupabase(`${type}-${id}`, value)
          }
        }
      }
    }
  }

  return { state, saveCreds }
}

// ── QR endpoints ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: isConnected ? 'connected' : 'waiting', qr: qrCode })
})

app.get('/qr', (req, res) => {
  if (qrCode) {
    res.send(`<html><body style="background:#000;display:flex;align-items:center;justify-content:center;min-height:100vh">
      <div style="text-align:center;color:white;font-family:sans-serif">
        <h2 style="margin-bottom:20px">Scan with WhatsApp</h2>
        <img src="${qrCode}" style="width:280px;height:280px;border-radius:12px"/>
        <p style="margin-top:16px;color:#888">Refresh if QR expires</p>
      </div>
    </body></html>`)
  } else if (isConnected) {
    res.send('<html><body style="background:#000;color:#30d158;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;font-size:24px"><div>✅ WhatsApp Connected</div></body></html>')
  } else {
    res.send('<html><body style="background:#000;color:white;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;font-size:20px"><div>Starting... refresh in 10s</div></body></html>')
  }
})

// ── Extract and save to Butler ────────────────────────────────────────────────
async function extractAndSave(message, from) {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: `You are Butler, a business intelligence agent for Reyhan Saif, a UAE-based consultant working with Cosentus/Lion Holdings (Inder Bhalla), Avior Advisory (Nikhil K), and Dr. Salem/Kaizen Consulting. Key contacts: Aman, Jayanta, Nanki, Sujith, Ashmeen, Yashika, Dr. Mohammed (RHG CEO). Extract action items from WhatsApp messages. Only extract if there is a genuine action item or decision — ignore casual conversation, greetings, and one-word replies. Return ONLY valid JSON: {"has_actions": true/false, "actions": [{"task": "action item", "contact": "person name or empty", "priority": "urgent|high|watch", "workstream": "Hiring|M&A|Legal|Operations|Ashmeen|Finance"}]}`,
        messages: [{ role: 'user', content: `WhatsApp message from ${from}:\n\n${message}` }]
      })
    })
    const data = await response.json()
    let content = data.content[0].text
    content = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
    const extracted = JSON.parse(content)
    if (!extracted.has_actions || !extracted.actions?.length) return
    for (const action of extracted.actions) {
      await fetch(`${SUPABASE_URL}/rest/v1/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: 'return=minimal'
        },
        body: JSON.stringify({
          task: action.task,
          priority: action.priority || 'high',
          status: 'pending',
          workstream: action.workstream || 'Operations',
          contact: action.contact || '',
          email: '',
          source: `WhatsApp — ${from}`,
          date: new Date().toISOString().split('T')[0],
          notes: `Original: ${message.substring(0, 200)}`,
          masteronly: false
        })
      })
    }
    console.log(`✅ Saved ${extracted.actions.length} actions from ${from}`)
  } catch(e) {
    console.error('Extract error:', e.message)
  }
}

// ── Connect WhatsApp ──────────────────────────────────────────────────────────
async function connectWhatsApp() {
  const { state, saveCreds } = useSupabaseAuthState()

  // Load existing creds from Supabase
  const existing = await getAuthFromSupabase()
  if (existing.creds) state.creds = existing.creds

  sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
    },
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    generateHighQualityLinkPreview: false,
    browser: ['Butler', 'Chrome', '1.0.0']
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) {
      const QRCode = await import('qrcode')
      qrCode = await QRCode.toDataURL(qr)
      console.log('QR generated — visit /qr')
    }
    if (connection === 'close') {
      isConnected = false
      qrCode = null
      const code = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 0
      const shouldReconnect = code !== DisconnectReason.loggedOut
      console.log('Connection closed, code:', code, 'reconnect:', shouldReconnect)
      if (shouldReconnect) setTimeout(connectWhatsApp, 5000)
    }
    if (connection === 'open') {
      isConnected = true
      qrCode = null
      console.log('✅ WhatsApp connected!')
    }
  })

  sock.ev.on('creds.update', async (creds) => {
    state.creds = { ...state.creds, ...creds }
    await saveCreds()
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      if (msg.key.fromMe) continue
      const text = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || ''
      if (!text || text.length < 15) continue
      const from = msg.key.remoteJid?.replace('@s.whatsapp.net', '') || 'unknown'
      console.log(`Message from ${from}: ${text.substring(0, 60)}`)
      await extractAndSave(text, from)
    }
  })
}

connectWhatsApp()

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Butler WhatsApp running on port ${PORT}`))
