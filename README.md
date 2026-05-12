# WhatsApp Message Logger

Independent audit trail for WhatsApp messages using [Baileys](https://github.com/WhiskeySockets/Baileys). Logs **all** incoming and outgoing messages to a local SQLite database and optionally syncs to Supabase.

## Purpose

Designed to detect message loss in automation pipelines (e.g., WaSender → n8n → Chatwoot). By running as a **separate linked device** on the same WhatsApp account, it captures every message independently — providing a ground truth to compare against downstream systems.

## Architecture

```
WhatsApp servers
    ├── → WaSender (device slot 1) → webhook → n8n → Chatwoot
    └── → This logger (device slot 2) → SQLite + Supabase
```

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/FerJRau/whatsapp-logger.git
cd whatsapp-logger
npm install
```

### 2. Configure (optional Supabase)

```bash
cp .env.example .env
# Edit .env with your Supabase credentials (or leave empty for SQLite-only)
```

### 3. Run and scan QR

```bash
npm start
```

A QR code will appear in the terminal. Open WhatsApp on the client's phone → Settings → Linked Devices → Link a Device → scan the QR code.

After scanning once, the session persists in `auth_store/`. You won't need to re-scan unless explicitly logged out.

### 4. Verify it works

Send a test message to the WhatsApp number. You should see:

```
{"level":30,"time":1234567890,"direction":"IN","from":"5491234567","type":"text","body":"Hello test","msg":"Message logged"}
```

## Deployment with Docker (Easypanel / VPS)

```bash
# Build and run
docker-compose up -d

# View QR code for first-time setup
docker-compose logs -f whatsapp-logger

# After scanning, the container runs persistently
```

**Important:** The `auth_data` and `sqlite_data` volumes persist the QR login and message database across container restarts/updates.

## Supabase Setup

Once your Supabase project is active:

1. Go to the SQL Editor in your Supabase dashboard
2. Run the contents of `supabase_migration.sql`
3. Copy your project URL and **service role** key into `.env`
4. Restart the logger

The logger will:
- Always write to local SQLite first (instant, reliable)
- Attempt to sync each message to Supabase
- Retry any failed syncs every 60 seconds

## Comparing Against Chatwoot

To find messages that WhatsApp received but Chatwoot missed:

```sql
-- In Supabase SQL editor
SELECT 
    timestamp,
    sender_phone,
    body,
    message_type
FROM whatsapp_messages
WHERE timestamp > NOW() - INTERVAL '7 days'
    AND message_id NOT IN (
        -- Replace with your method of querying Chatwoot message IDs
        SELECT source_id FROM chatwoot_messages
    )
ORDER BY timestamp DESC;
```

Or locally with SQLite:
```bash
sqlite3 messages.db "SELECT timestamp, sender_phone, body FROM whatsapp_messages WHERE timestamp > datetime('now', '-7 days') ORDER BY timestamp DESC;"
```

## Multi-Device Notes

- WhatsApp allows up to **4 linked devices** simultaneously
- This logger uses 1 additional device slot
- It is **read-only** — it does not send messages, mark as read, or interfere with WaSender
- If the client logs out all devices from their phone, you'll need to re-scan the QR

## Troubleshooting

| Issue | Solution |
|-------|----------|
| QR code not appearing | Check internet connectivity on the server |
| "Logged out" error | Delete `auth_store/` directory and restart to get a new QR |
| Messages not appearing in Supabase | Check `.env` credentials; look at SQLite (`synced_to_supabase = 0` rows) |
| Container restarts lose QR session | Ensure Docker volumes are properly mounted |

## File Structure

```
whatsapp-logger/
├── index.js              # Main application
├── package.json
├── .env.example          # Environment template
├── .env                  # Your config (gitignored)
├── supabase_migration.sql # DB schema for Supabase
├── Dockerfile
├── docker-compose.yml
├── auth_store/           # WhatsApp session (gitignored, persisted via volume)
└── messages.db           # Local SQLite backup (gitignored, persisted via volume)
```
