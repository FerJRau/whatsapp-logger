# WhatsApp Message Audit — Instruction Manual

## Purpose

Detect and prove which component in your WhatsApp automation stack is silently dropping messages.  
The audit answers one question: **Is every WhatsApp message reaching Chatwoot?**

---

## Your Production Architecture

```
WhatsApp Cloud (Meta servers)
    │
    ├── WaSender (linked device #1) ─── webhook POST ──▶ GW3B (n8n gateway)
    │                                                        │
    │                                                        ├──▶ AWF-MIRROR ──▶ Chatwoot (mirror inbound)
    │                                                        ├──▶ AWF2 (Appointment Handler)
    │                                                        ├──▶ AWF3 (Booking Handler)
    │                                                        └──▶ AWF4 (Info Handler)
    │
    └── Baileys Logger (linked device #2) ──── direct INSERT ──▶ Supabase
                                                                 (whatsapp_messages table)
```

**Outbound path (agent replies):**
```
Chatwoot agent reply ──▶ AWF11b (Reply Bridge) ──▶ WaSender API ──▶ WhatsApp
```

### Key Workflows (25 total in production)

| Workflow | Role | Trigger |
|----------|------|---------|
| **GW3B** (not in exports) | Gateway — receives WaSender webhook, extracts fields, dispatches to other workflows | WaSender webhook |
| **AWF-MIRROR v2** | Mirrors every WhatsApp message into Chatwoot (inbound + bot outbound) | Called by GW3B |
| **AWF2 v3** | Appointment handler — confirm/cancel via AI classification | Called by GW3B |
| **AWF3 v2** | Booking handler — full booking flow with CMP integration (160 nodes) | Called by GW3B |
| **AWF4 v2** | Info handler — menus, templates, general inquiries | Called by GW3B |
| **AWF5 v2** | Reminders — AM/PM/Saturday cron-based WhatsApp reminders | Schedule triggers |
| **AWF11b v3** | Reply Bridge — forwards Chatwoot agent replies back to WhatsApp via WaSender | Chatwoot webhook |
| **AWF8** | Session cleanup | Hourly schedule |
| **AWF9** | Background jobs — status checks, Dentegra escalation | Multiple schedules |
| **AWF10 v2** | Maintenance — error handling, cleanup schedules | Error trigger + schedules |
| **AWF13** | Dentegra Reply Funnel — consent and OCR processing | Webhook + Execute Workflow |

### Key Technical Details

- **WaSender API endpoint:** `https://wasenderapi.com/api/send-message` (POST, Bearer auth)
- **Chatwoot API:** `https://app.chatwoot.com/api/v1/accounts/153401/...`
- **Deduplication:** `ChatwootMirrorDedupe` DataTable (key: `wa:{clinic}:{messageId}`)
- **Bot tracking:** `BotSentMessages` DataTable
- **Multi-clinic:** Polanco (primary), Insurgentes, Toluca — identified by Chatwoot inbox IDs
- **Reply Bridge mode:** Currently `MONITOR_ONLY` — clinics reply via WhatsApp Web, not Chatwoot

---

## Audit Components

### 1. Baileys Logger (Ground Truth)

**What:** Independent WhatsApp Web connection that logs every message to Supabase.  
**Where:** Easypanel service `whatsapp-logger` on your VPS (31.220.21.45).  
**Database:** Supabase project `ptssrzqlshqxowofecct` → table `whatsapp_messages`.

This captures messages **directly from WhatsApp servers**, completely bypassing WaSender, n8n, and Chatwoot. If a message exists here but not in Chatwoot, it was lost somewhere in the chain.

### 2. Chatwoot (Final Destination)

**What:** All conversations visible to agents.  
**API:** `https://app.chatwoot.com/api/v1/accounts/153401/`  
**Written by:** AWF-MIRROR (via GW3B dispatch).

### 3. n8n Execution Log (Optional — Phase 2)

Add a Supabase INSERT as the first node after GW3B receives the WaSender webhook. This tells you if n8n received the message at all.

---

## How to Perform the Audit

### Phase 1: Collect Data (Passive — runs automatically)

Once the Baileys logger is connected (QR scanned), it silently records every message.  
Let it run for **at least 48-72 hours** during normal business hours to capture a meaningful sample.

No action needed — just verify it's running:
- Easypanel dashboard: service should show green
- Supabase table: `SELECT COUNT(*) FROM whatsapp_messages` should grow

### Phase 2: Compare Baileys vs Chatwoot

After 48-72 hours, run this comparison.

#### Step 1: Export Baileys messages for a time window

Go to **https://supabase.com/dashboard/project/ptssrzqlshqxowofecct/sql/new** and run:

```sql
-- All inbound messages in the last 72 hours
SELECT 
    message_id,
    sender_phone,
    timestamp,
    message_type,
    LEFT(body, 100) AS body_preview,
    from_jid
FROM whatsapp_messages 
WHERE timestamp > NOW() - INTERVAL '72 hours'
ORDER BY timestamp ASC;
```

Note the total count:
```sql
SELECT COUNT(*) AS total_messages 
FROM whatsapp_messages 
WHERE timestamp > NOW() - INTERVAL '72 hours';
```

#### Step 2: Cross-reference with Chatwoot

For each unique `sender_phone` in the Baileys log, check if Chatwoot has a corresponding conversation with the same messages.

**Via Chatwoot API:**
```bash
# Search for a contact by phone number
curl -s "https://app.chatwoot.com/api/v1/accounts/153401/search?q=5215512345678" \
  -H "api_access_token: YOUR_CHATWOOT_TOKEN" | jq .
```

**Via Chatwoot UI:**
1. Open Chatwoot → search the phone number
2. Open the conversation → compare message timestamps

#### Step 3: Identify gaps

```sql
-- Messages grouped by hour (to spot time-based patterns)
SELECT 
    DATE_TRUNC('hour', timestamp) AS hour,
    COUNT(*) AS message_count
FROM whatsapp_messages 
WHERE timestamp > NOW() - INTERVAL '72 hours'
GROUP BY hour
ORDER BY hour;
```

Look for:
- Hours where Baileys logged messages but Chatwoot shows none → messages lost
- Specific sender_phone numbers with messages in Baileys but missing in Chatwoot
- Time gaps that correlate with VPS restarts, network issues, or WaSender downtime

### Phase 3: Pinpoint the Failure Layer

Once you've identified lost messages, determine WHERE they were lost:

| Scenario | Meaning | Evidence |
|----------|---------|----------|
| Message in Baileys, NOT in Chatwoot | Lost between WhatsApp → Chatwoot | WaSender or n8n dropped it |
| Message in Baileys, in Chatwoot but delayed | Slow processing, not a loss | Check timestamps |
| Message NOT in Baileys, NOT in Chatwoot | WhatsApp-level issue (very rare) | Device was offline |

**To narrow down WaSender vs n8n:**

Add a logging node in GW3B (your gateway workflow) as the **very first step** after the webhook trigger:

```javascript
// Add this as a Code node right after the WaSender webhook trigger in GW3B
// It logs to Supabase that n8n received the webhook
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
    'https://ptssrzqlshqxowofecct.supabase.co',
    'YOUR_SERVICE_KEY'
);

await supabase.from('n8n_webhook_log').insert({
    message_id: $json.body?.messageId || 'unknown',
    phone: $json.body?.phone || 'unknown',
    received_at: new Date().toISOString(),
    raw_payload: JSON.stringify($json)
});

return $input.all();
```

Then create the table:
```sql
CREATE TABLE n8n_webhook_log (
    id BIGSERIAL PRIMARY KEY,
    message_id TEXT,
    phone TEXT,
    received_at TIMESTAMPTZ,
    raw_payload JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

Now you can compare three layers:
```
Baileys (ground truth) → n8n_webhook_log (WaSender delivered?) → Chatwoot (fully processed?)
```

- In Baileys but NOT in n8n_webhook_log → **WaSender dropped the webhook**
- In n8n_webhook_log but NOT in Chatwoot → **n8n/AWF-MIRROR failed to write to Chatwoot**

---

## Operational Procedures

### Starting the Logger

1. Go to Easypanel: `http://31.220.21.45:3000/projects/whatsapp-logger/app/whatsapp-logger`
2. Click **Deploy** (green button)
3. Open `https://whatsapp-logger-whatsapp-logger.ed23t4.easypanel.host`
4. Scan QR with client's phone: WhatsApp → Settings → Linked Devices → Link a Device
5. Page shows "Connected to WhatsApp" when successful

### Stopping the Logger

1. Go to Easypanel: `http://31.220.21.45:3000/projects/whatsapp-logger/app/whatsapp-logger`
2. Click the **stop icon** (square ⏹) in the toolbar next to the Deploy button
3. The service will stop. Data in Supabase is preserved.

### Re-scanning QR (if session expires)

WhatsApp linked device sessions can expire if:
- The primary phone is offline for 14+ days
- The user manually removes the linked device
- WhatsApp forces a re-authentication

If this happens:
1. Click Deploy in Easypanel to restart the service
2. Open the QR page URL
3. Re-scan with the client's phone

The `auth_store` volume persists the session, so normal container restarts do NOT require re-scanning.

### Checking Logger Health

```sql
-- Most recent message logged
SELECT timestamp, sender_phone, message_type, LEFT(body, 50) 
FROM whatsapp_messages 
ORDER BY timestamp DESC 
LIMIT 1;

-- Messages per day for the last week
SELECT 
    DATE(timestamp) AS day,
    COUNT(*) AS messages
FROM whatsapp_messages 
WHERE timestamp > NOW() - INTERVAL '7 days'
GROUP BY day
ORDER BY day;
```

If the most recent message is hours old during business hours, the logger may have disconnected. Check Easypanel logs.

---

## Quick Reference

| Resource | URL |
|----------|-----|
| Easypanel Dashboard | `http://31.220.21.45:3000` |
| Logger Service | `http://31.220.21.45:3000/projects/whatsapp-logger/app/whatsapp-logger` |
| QR Scan Page | `https://whatsapp-logger-whatsapp-logger.ed23t4.easypanel.host` |
| Supabase Dashboard | `https://supabase.com/dashboard/project/ptssrzqlshqxowofecct` |
| Supabase Table Editor | `https://supabase.com/dashboard/project/ptssrzqlshqxowofecct/editor` |
| Supabase SQL Editor | `https://supabase.com/dashboard/project/ptssrzqlshqxowofecct/sql/new` |
| GitHub Repo | `https://github.com/FerJRau/whatsapp-logger` (private) |
| Chatwoot | `https://app.chatwoot.com` |
| WaSender API Docs | `https://wasenderapi.com` |

---

## Expected Outcomes

After running the audit for 72+ hours:

1. **If no messages are lost:** WaSender + n8n + Chatwoot chain is reliable. The original problem may have been transient (network blip, VPS restart, etc.). Keep the logger running as a safety net.

2. **If messages ARE lost (Baileys has them, Chatwoot doesn't):** You've confirmed the problem and can quantify it (X messages lost per day). Proceed to Phase 3 to pinpoint whether WaSender or n8n is the culprit.

3. **If many messages are lost:** Consider migrating from WaSender to the **official WhatsApp Cloud API** (via Meta), which has proper webhook retry logic, delivery receipts, and SLA guarantees. The Baileys logger can serve as the bridge during migration.
