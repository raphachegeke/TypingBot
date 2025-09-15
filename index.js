import express from "express"
import makeWASocket, { useMultiFileAuthState, Browsers } from "@whiskeysockets/baileys"
import QRCode from "qrcode"
import fs from "fs"

const app = express()
app.use(express.urlencoded({ extended: true }))
app.use(express.json())

let qrCodeData = null
let pairingCodeInfo = null
let connectionStatus = "🔄 Starting..."
let sock = null

// SSE clients (for live updates)
const clients = new Set()
function broadcastStatus() {
    for (const res of clients) {
        res.write(`data: ${JSON.stringify({ status: connectionStatus, qrCodeData, pairingCodeInfo })}\n\n`)
    }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("session")

    sock = makeWASocket({
        auth: state,
        browser: Browsers.macOS("Desktop"),
        printQRInTerminal: false
    })

    sock.ev.on("creds.update", saveCreds)

    sock.ev.on("connection.update", ({ connection, qr }) => {
        if (qr) {
            QRCode.toDataURL(qr, (err, url) => {
                if (!err) {
                    qrCodeData = url
                    connectionStatus = "📲 Scan the QR to log in"
                    broadcastStatus()
                }
            })
        }

        if (connection === "connecting") {
            connectionStatus = "🔄 Connecting..."
            broadcastStatus()
        }

        if (connection === "open") {
            console.log("✅ Bot connected successfully!")
            connectionStatus = "✅ Connected to WhatsApp"
            qrCodeData = null
            pairingCodeInfo = null
            broadcastStatus()
        }

        if (connection === "close") {
            console.log("⚠️ Connection closed. Restarting in 3s...")
            connectionStatus = "⚠️ Disconnected. Reconnecting..."
            broadcastStatus()
            setTimeout(() => startBot(), 3000)
        }
    })

    // ✅ Auto-typing + Auto-view status
    sock.ev.on("messages.upsert", async ({ messages }) => {
        const m = messages[0]
        if (!m.message) return

        const jid = m.key.remoteJid

        // Auto-view status
        if (jid.includes("status")) {
            try {
                await sock.readMessages([m.key])
                console.log("👀 Viewed status from:", jid)
            } catch (err) {
                console.error("❌ Error viewing status:", err)
            }
            return
        }

        // Ignore own messages
        if (m.key.fromMe) return

        try {
            // Show "typing..."
            await sock.sendPresenceUpdate("composing", jid)

            // wait 2s
            await new Promise(res => setTimeout(res, 9000))

            // Stop typing
            await sock.sendPresenceUpdate("paused", jid)

            // Reply
            // await sock.sendMessage(jid, { text: " " })
            console.log("💬 Replied to:", jid)
        } catch (err) {
            console.error("❌ Error in auto-typing handler:", err)
        }
    })
}

// Web UI
app.get("/", (req, res) => {
    res.send(`
        <html>
        <body style="font-family:sans-serif; text-align:center; margin-top:50px;">
            <h1>WhatsApp Bot Login</h1>
            <h3 id="status">${connectionStatus}</h3>
            <div id="content"></div>
            <br><br>
            <form action="/pair" method="POST" style="margin-bottom:20px;">
                <input type="text" name="number" placeholder="e.g. 15551234567" required />
                <button type="submit">Get Pairing Code</button>
            </form>
            <form action="/logout" method="POST">
                <button type="submit" style="background:red;color:white;padding:10px 20px;border:none;border-radius:5px;cursor:pointer;">
                    Logout
                </button>
            </form>

            <script>
                const evtSource = new EventSource('/events')
                evtSource.onmessage = function(event) {
                    const data = JSON.parse(event.data)
                    document.getElementById("status").innerText = data.status

                    let content = ""
                    if (data.qrCodeData) {
                        content = "<h2>📲 Scan this QR</h2><img src='" + data.qrCodeData + "' />"
                    } else if (data.pairingCodeInfo) {
                        content = "<h2>📲 Enter this code in WhatsApp</h2><h1>" + data.pairingCodeInfo + "</h1>"
                    } else if (data.status.includes("✅ Connected")) {
                        content = "<h2>✅ Already connected to WhatsApp!</h2>"
                    }
                    document.getElementById("content").innerHTML = content
                }
            </script>
        </body>
        </html>
    `)
})

// SSE endpoint
app.get("/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream")
    res.setHeader("Cache-Control", "no-cache")
    res.setHeader("Connection", "keep-alive")
    res.flushHeaders()

    clients.add(res)
    res.write(`data: ${JSON.stringify({ status: connectionStatus, qrCodeData, pairingCodeInfo })}\n\n`)

    req.on("close", () => {
        clients.delete(res)
    })
})

// Generate pairing code
app.post("/pair", async (req, res) => {
    const number = req.body.number
    if (!number) return res.send("❌ Phone number required")

    try {
        if (!sock) return res.send("❌ Bot not ready")

        const code = await sock.requestPairingCode(number)
        pairingCodeInfo = code
        qrCodeData = null
        connectionStatus = "📲 Enter this code in WhatsApp"
        broadcastStatus()

        res.redirect("/")
    } catch (err) {
        console.error("❌ Pairing failed:", err)
        connectionStatus = "❌ Pairing failed"
        broadcastStatus()
        res.send("❌ Could not generate pairing code. Try again.")
    }
})

// Logout (clear session)
app.post("/logout", (req, res) => {
    try {
        if (fs.existsSync("./session")) {
            fs.rmSync("./session", { recursive: true, force: true })
            console.log("🗑️ Session cleared.")
        }
        qrCodeData = null
        pairingCodeInfo = null
        connectionStatus = "🔄 Logged out. Restarting..."
        broadcastStatus()
        startBot()
        res.redirect("/")
    } catch (err) {
        console.error("❌ Logout failed:", err)
        res.send("❌ Could not logout")
    }
})

app.listen(3000, () => {
    console.log("🌐 Open http://localhost:3000")
})

startBot()
