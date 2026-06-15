import pkg from '@whiskeysockets/baileys'
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = pkg
import { Boom } from '@hapi/boom'
import express from 'express'
import fetch from 'node-fetch'
import pino from 'pino'
import { mkdirSync } from 'fs'

const app = express()
app.use(express.json())

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SERVICE_ROLE_KEY
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY

let qrCode = null
let isConnected = false
let sock = null

app.get('/', (req, res) => {
  res.json({ 
    status: isConnected ? 'connected' : 'waiting',
    qr: qrCode 
  })
})

app.get('/qr', (req, res) => {
  if (qrCode) {
    res.send(`<html><body style="background:#000;display:flex;align-items:center;justify-content:center;min-height:100vh">
      <div style="text-align:center;color:white;font-family:sans-serif">
        <h2>Scan with WhatsApp</h2>
        <img src="${qrCode}" style="width:300px;height:300px"/>
        <p>Refresh page if QR expires</p>
      </div>
    </body></html>`)
  } else if (isConnected) {
    res.send('<html><body style="background:#000;color:#30d158;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh"><h1>✅ WhatsApp Connected</h1></body></html>')
  } else {
    res.send('<html><body style="background:#000;color:white;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh"><h1>Starting... refresh in 10s</h1></body></html>')
  }
})

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
        system: `You are Butler, a business intelligence agent for Reyhan Saif, a UAE-based consultant working with Cosentus/Lion Holdings (Inder Bhalla), Avior Advisory (Nikhil K), and Dr. Salem/Kaizen Consulting. Key contacts: Aman, Jayanta, Nanki, Sujith, Ashmeen, Yashika, Dr. Mohammed (RHG CEO). Extract action items from WhatsApp messages. Only extract if there is a genuine action item or decision — ignore casual conversation. Return ONLY valid JSON: {"has_actions": true/false, "actions": [{"task": "action item", "contact": "person name or empty", "priority": "urgent|high|watch", "workstream": "Hiring|M&A|Legal|Operations|Ashmeen|Finance"}]}`,
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
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Prefer': 'return=minimal'
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
          notes: `Original message: ${message.substring(0, 200)}`,
          masteronly: false
        })
      })
    }

    console.log(`Saved ${extracted.actions.length} actions from ${from}`)
  } catch(e) {
    console.error('Extract error:', e.message)
  }
}

async function connectWhatsApp() {
  mkdirSync('./auth', { recursive: true })
  const { state, saveCreds } = await useMultiFileAuthState('./auth')

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    generateHighQualityLinkPreview: false,
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      const QRCode = await import('qrcode')
      qrCode = await QRCode.toDataURL(qr)
      console.log('QR generated — visit /qr to scan')
    }

    if (connection === 'close') {
      isConnected = false
      qrCode = null
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
        : true
      if (shouldReconnect) {
        console.log('Reconnecting...')
        setTimeout(connectWhatsApp, 3000)
      }
    }

    if (connection === 'open') {
      isConnected = true
      qrCode = null
      console.log('WhatsApp connected!')
    }
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      if (msg.key.fromMe) continue
      const text = msg.message?.conversation 
        || msg.message?.extendedTextMessage?.text 
        || ''
      if (!text || text.length < 10) continue
      const from = msg.key.remoteJid?.replace('@s.whatsapp.net', '') || 'unknown'
      console.log(`Message from ${from}: ${text.substring(0, 50)}`)
      await extractAndSave(text, from)
    }
  })
}

connectWhatsApp()

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Butler WhatsApp running on port ${PORT}`))
