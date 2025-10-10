import makeWASocket, {
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    Browsers
} from '@whiskeysockets/baileys'
import express from 'express'
import P from 'pino'
import axios from 'axios'

const app = express()
app.use(express.json())

async function startSock() {
    const { state, saveCreds } = await useMultiFileAuthState('session')
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false, // We’ll use pairing
        browser: Browsers.macOS('Safari'),
        markOnlineOnConnect: true,
        logger: P({ level: 'silent' }),
    })

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update

        if (connection === 'connecting') {
            console.log('⏳ Connecting to WhatsApp...')
        } else if (connection === 'open') {
            console.log('✅ WhatsApp bot connected successfully!')
        } else if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode
            console.log('❌ Connection closed. Reason:', reason)

            if (reason !== DisconnectReason.loggedOut) {
                console.log('🔁 Reconnecting...')
                startSock()
            } else {
                console.log('🧹 Session logged out. Delete /session folder and pair again.')
            }
        }
    })

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0]
        if (!msg.message || msg.key.fromMe) return

        const from = msg.key.remoteJid
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text

        console.log('💬 New message from', from, ':', text)

        if (text?.toLowerCase() === 'hi') {
            await sock.sendMessage(from, { text: 'Hello 👋 I’m your bot!' })
        }

        // 💸 Handle payment text like "0748397839,100"
        if (/^\d{9,},\d+$/.test(text)) {
            const [phone, amount] = text.split(',')
            const payload = {
                phone: `+254${phone.slice(-9)}`,
                amount: parseInt(amount),
            }

            console.log('💰 Sending to server:', payload)

            // Example: send to your payment API
            // await axios.post('https://your-server.com/pay', payload)

            await sock.sendMessage(from, {
                text: `✅ STK push of KES ${amount} sent to ${payload.phone}`,
            })
        }
    })

    sock.ev.on('creds.update', saveCreds)

    return sock
}

const sock = await startSock()

// Pairing endpoint
app.post('/pair', async (req, res) => {
    try {
        const { phoneNumber } = req.body
        if (!phoneNumber) return res.status(400).json({ error: 'Phone number required' })

        const code = await sock.requestPairingCode(phoneNumber)
        console.log('📲 Pairing code for', phoneNumber, '=>', code)
        res.json({ pairingCode: code })
    } catch (err) {
        console.error('❌ Pairing failed:', err.message)
        res.status(500).json({ error: err.message })
    }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`))
