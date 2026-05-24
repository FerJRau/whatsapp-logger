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
- **Multi-clinic:** Polanco (inbox 97516), Insurgentes (inbox 104052), Toluca (inbox 103961)
- **Reply Bridge mode:** Currently `MONITOR_ONLY` — clinics reply via WhatsApp Web, not Chatwoot

---

## Setup: Two-Table Logging for Easy Diff

Both tables live in the same Supabase project so you can JOIN them with a single query.

### Table 1: `whatsapp_messages` (Baileys — Ground Truth)

Already created. Captures messages directly from WhatsApp servers via Baileys linked device.

### Table 2: `n8n_message_log` (n8n — WaSender path)

Captures every message that WaSender successfully delivers to your n8n gateway.

#### Step A: Create the table in Supabase

Go to **https://supabase.com/dashboard/project/ptssrzqlshqxowofecct/sql/new** and run:

```sql
-- n8n message log: records every message WaSender delivers to GW3B
CREATE TABLE IF NOT EXISTS n8n_message_log (
    id BIGSERIAL PRIMARY KEY,
    message_id TEXT,
    sender_phone TEXT,
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    message_type TEXT,
    body TEXT,
    clinic TEXT DEFAULT 'Polanco',
    from_me BOOLEAN DEFAULT FALSE,
    direction TEXT DEFAULT 'inbound',
    workflow TEXT DEFAULT 'GW3B',
    execution_id TEXT,
    raw_payload JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for fast diff queries
CREATE INDEX idx_n8n_log_message_id ON n8n_message_log(message_id);
CREATE INDEX idx_n8n_log_timestamp ON n8n_message_log(timestamp);
CREATE INDEX idx_n8n_log_sender ON n8n_message_log(sender_phone);

-- RLS: only service role can read/write
ALTER TABLE n8n_message_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON n8n_message_log
    FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');
```

#### Step B: Add logging node in GW3B

Open your GW3B workflow in n8n. Add a **Code node** called `Log to Supabase` as the **very first step** after the WaSender webhook trigger, BEFORE any other processing.

Wire it like this:
```
WaSender Webhook → Log to Supabase → (rest of your existing GW3B flow)
```

**Important:** The log node must pass data through unchanged — it only observes, never modifies.

Paste this code in the Code node:

```javascript
// GW3B Audit Logger — logs every incoming WaSender webhook to Supabase
// This node is pass-through: it logs and forwards the data unchanged.

const SUPABASE_URL = 'https://ptssrzqlshqxowofecct.supabase.co';
const SUPABASE_KEY = 'YOUR_SERVICE_KEY_HERE';  // Replace with your service_role key

const items = $input.all();
const raw = items[0]?.json || {};
const body = raw.body && typeof raw.body === 'object' ? raw.body : raw;

const phone = String(body.phone || body.rawPhone || '').replace(/\D/g, '');
const messageId = String(body.messageId || body.sourceMessageId || '').trim();
const messageType = String(body.messageType || 'text').trim().toLowerCase();
const content = String(body.content || body.message || body.text || '').trim();
const clinic = String(body.clinic || '').trim() || 'Polanco';
const fromMe = body.fromMe === true || String(body.fromMe || '') === 'true';

const row = {
    message_id: messageId || null,
    sender_phone: phone || null,
    message_type: messageType,
    body: content.substring(0, 500) || null,
    clinic: clinic,
    from_me: fromMe,
    direction: fromMe ? 'outbound' : 'inbound',
    workflow: 'GW3B',
    execution_id: $execution.id,
    raw_payload: body,
};

// Fire-and-forget HTTP call to Supabase REST API
try {
    await fetch(`${SUPABASE_URL}/rest/v1/n8n_message_log`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Prefer': 'return=minimal',
        },
        body: JSON.stringify(row),
    });
} catch (e) {
    // Silently ignore logging errors — never block message processing
}

// Pass through all items unchanged
return items;
```

> **Replace `YOUR_SERVICE_KEY_HERE`** with your Supabase service_role key.  
> The node uses the Supabase REST API directly (no extra npm packages needed).  
> Errors are caught silently — logging never blocks your message flow.

#### Step C: (Optional) Also log in AWF-MIRROR

For even more granularity, add the same pattern in AWF-MIRROR right after `Normalize Input`. This tells you if GW3B successfully dispatched to MIRROR:

```javascript
// AWF-MIRROR Audit Logger — confirms mirror received the message
const SUPABASE_URL = 'https://ptssrzqlshqxowofecct.supabase.co';
const SUPABASE_KEY = 'YOUR_SERVICE_KEY_HERE';

const normalized = $input.first().json || {};

try {
    await fetch(`${SUPABASE_URL}/rest/v1/n8n_message_log`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
            message_id: normalized.messageId || null,
            sender_phone: normalized.phone || null,
            message_type: normalized.messageType || 'unknown',
            body: (normalized.content || '').substring(0, 500) || null,
            clinic: normalized.clinic || 'Polanco',
            from_me: normalized.fromMe || false,
            direction: normalized.fromMe ? 'outbound' : 'inbound',
            workflow: 'AWF-MIRROR',
            execution_id: $execution.id,
            raw_payload: normalized,
        }),
    });
} catch (e) {}

return $input.all();
```

---

## Running the Diff

After both loggers have been running for 24-72 hours, go to **https://supabase.com/dashboard/project/ptssrzqlshqxowofecct/sql/new** and run these queries.

### Query 1: Summary — How many messages did each system capture?

```sql
SELECT 
    'Baileys (ground truth)' AS source,
    COUNT(*) AS total_messages
FROM whatsapp_messages 
WHERE timestamp > NOW() - INTERVAL '72 hours'

UNION ALL

SELECT 
    'n8n (WaSender→GW3B)' AS source,
    COUNT(*) AS total_messages
FROM n8n_message_log 
WHERE timestamp > NOW() - INTERVAL '72 hours';
```

If the Baileys count is higher than n8n → messages are being lost before n8n.

### Query 2: Messages Baileys captured but n8n did NOT (= Lost Messages)

```sql
-- LOST MESSAGES: Baileys saw them, WaSender/n8n did not
SELECT 
    b.message_id,
    b.sender_phone,
    b.timestamp,
    b.message_type,
    LEFT(b.body, 80) AS body_preview
FROM whatsapp_messages b
LEFT JOIN n8n_message_log n 
    ON b.sender_phone = n.sender_phone 
    AND b.timestamp BETWEEN n.timestamp - INTERVAL '2 minutes' 
                        AND n.timestamp + INTERVAL '2 minutes'
WHERE n.id IS NULL
    AND b.timestamp > NOW() - INTERVAL '72 hours'
ORDER BY b.timestamp DESC;
```

> **Why fuzzy timestamp match?** Baileys and WaSender may record slightly different timestamps for the same message. The 2-minute window accounts for this.

### Query 3: Messages n8n received but Baileys did NOT (should be rare)

```sql
-- Messages WaSender delivered to n8n but Baileys missed
-- (would indicate Baileys logger was disconnected)
SELECT 
    n.message_id,
    n.sender_phone,
    n.timestamp,
    n.message_type,
    LEFT(n.body, 80) AS body_preview
FROM n8n_message_log n
LEFT JOIN whatsapp_messages b 
    ON n.sender_phone = b.sender_phone 
    AND n.timestamp BETWEEN b.timestamp - INTERVAL '2 minutes' 
                        AND b.timestamp + INTERVAL '2 minutes'
WHERE b.id IS NULL
    AND n.timestamp > NOW() - INTERVAL '72 hours'
    AND n.workflow = 'GW3B'
ORDER BY n.timestamp DESC;
```

### Query 4: Hourly comparison — spot patterns

```sql
-- Side-by-side hourly counts to spot drop patterns
SELECT 
    COALESCE(bh.hour, nh.hour) AS hour,
    COALESCE(bh.baileys_count, 0) AS baileys_count,
    COALESCE(nh.n8n_count, 0) AS n8n_count,
    COALESCE(bh.baileys_count, 0) - COALESCE(nh.n8n_count, 0) AS diff
FROM (
    SELECT DATE_TRUNC('hour', timestamp) AS hour, COUNT(*) AS baileys_count
    FROM whatsapp_messages
    WHERE timestamp > NOW() - INTERVAL '72 hours'
    GROUP BY hour
) bh
FULL OUTER JOIN (
    SELECT DATE_TRUNC('hour', timestamp) AS hour, COUNT(*) AS n8n_count
    FROM n8n_message_log
    WHERE timestamp > NOW() - INTERVAL '72 hours'
        AND workflow = 'GW3B'
    GROUP BY hour
) nh ON bh.hour = nh.hour
ORDER BY hour;
```

A positive `diff` means Baileys saw more messages than n8n → those were dropped by WaSender.

### Query 5: Per-clinic breakdown

```sql
SELECT 
    n.clinic,
    COUNT(DISTINCT n.sender_phone) AS unique_senders,
    COUNT(*) AS n8n_messages,
    (SELECT COUNT(*) FROM whatsapp_messages b 
     WHERE b.timestamp > NOW() - INTERVAL '72 hours') AS baileys_total
FROM n8n_message_log n
WHERE n.timestamp > NOW() - INTERVAL '72 hours'
GROUP BY n.clinic
ORDER BY n8n_messages DESC;
```

### Query 6: If you also log in AWF-MIRROR — pinpoint GW3B→MIRROR drops

```sql
-- Messages GW3B received but MIRROR never got (= GW3B dispatch failure)
SELECT 
    gw.message_id,
    gw.sender_phone,
    gw.timestamp,
    gw.clinic
FROM n8n_message_log gw
LEFT JOIN n8n_message_log mir 
    ON gw.message_id = mir.message_id 
    AND mir.workflow = 'AWF-MIRROR'
WHERE gw.workflow = 'GW3B'
    AND mir.id IS NULL
    AND gw.timestamp > NOW() - INTERVAL '72 hours'
ORDER BY gw.timestamp DESC;
```

---

## Interpreting Results

| Baileys | n8n (GW3B) | n8n (MIRROR) | Chatwoot | Diagnosis |
|---------|------------|--------------|----------|-----------|
| Yes | No | No | No | **WaSender dropped the webhook** — message never reached n8n |
| Yes | Yes | No | No | **GW3B failed to dispatch to MIRROR** — check execution errors |
| Yes | Yes | Yes | No | **MIRROR→Chatwoot write failed** — Chatwoot API error or dedup false positive |
| Yes | Yes | Yes | Yes | Message delivered successfully |
| No | Yes | Yes | Yes | **Baileys logger was disconnected** — check Easypanel service status |

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
2. Click the **stop icon** (square) in the toolbar next to the Deploy button
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
-- Most recent message logged (both sources)
SELECT 'Baileys' AS source, timestamp, sender_phone, message_type
FROM whatsapp_messages ORDER BY timestamp DESC LIMIT 1
UNION ALL
SELECT 'n8n' AS source, timestamp, sender_phone, message_type
FROM n8n_message_log ORDER BY timestamp DESC LIMIT 1;

-- Messages per day for the last week (both sources)
SELECT 
    DATE(b.day) AS day,
    COALESCE(b.baileys, 0) AS baileys,
    COALESCE(n.n8n, 0) AS n8n,
    COALESCE(b.baileys, 0) - COALESCE(n.n8n, 0) AS diff
FROM (
    SELECT DATE(timestamp) AS day, COUNT(*) AS baileys
    FROM whatsapp_messages WHERE timestamp > NOW() - INTERVAL '7 days'
    GROUP BY DATE(timestamp)
) b
FULL OUTER JOIN (
    SELECT DATE(timestamp) AS day, COUNT(*) AS n8n
    FROM n8n_message_log WHERE timestamp > NOW() - INTERVAL '7 days'
    GROUP BY DATE(timestamp)
) n ON b.day = n.day
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

---

## Phase 1 Results (WaSender → n8n)

Audit period: May 20–24 (~3.3 days). **WaSender is NOT dropping patient messages.**

- 172 raw gap — but 170 are `protocolMessage` (WhatsApp internal signals, no content)
- Only 2 actual messages missing: both outbound bot consent reminders, not patient messages
- **0 inbound patient messages were lost**

**Conclusion:** If Chatwoot is missing messages, the problem is downstream of GW3B — in AWF-MIRROR.

---

## Phase 2: AWF-MIRROR Audit (MIRROR → Chatwoot)

Since WaSender→GW3B is clean, we now add three checkpoints inside AWF-MIRROR to catch exactly where messages are dropped:

```
GW3B ──▶ [MIRROR-ENTRY] ──▶ Normalize Input ──▶ Input Valid?
                                                    │
                  ┌──────── Return Invalid ◄────── No (MIRROR-EXIT: status=skipped)
                  │
                  │ Yes
                  │
                  ▼
              Get Dedupe Row ──▶ Already Mirrored? ──▶ Return Deduped (MIRROR-EXIT: status=deduped)
                                        │
                                       No
                                        ▼
                                  ... Contact + Conversation logic ...
                                        │
                                        ▼
                              Send Chatwoot Message ──▶ [MIRROR-SENT] ──▶ Return Result
```

### Step 1: Add columns to n8n_message_log

Run this SQL in Supabase SQL Editor:

```sql
ALTER TABLE n8n_message_log ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'received';
ALTER TABLE n8n_message_log ADD COLUMN IF NOT EXISTS skip_reason TEXT;
ALTER TABLE n8n_message_log ADD COLUMN IF NOT EXISTS mirror_key TEXT;
ALTER TABLE n8n_message_log ADD COLUMN IF NOT EXISTS chatwoot_message_id TEXT;
ALTER TABLE n8n_message_log ADD COLUMN IF NOT EXISTS conversation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_n8n_log_workflow ON n8n_message_log(workflow);
CREATE INDEX IF NOT EXISTS idx_n8n_log_status ON n8n_message_log(status);
```

### Step 2: Import the test workflow

Import `n8n_mirror_audit_logger.json` into n8n (Add workflow → Import from file).

The workflow contains 3 logging nodes you'll copy into AWF-MIRROR:

| Node | Where to place in AWF-MIRROR | Workflow tag |
|------|------------------------------|--------------|
| **Log MIRROR Entry** | Side-branch from `Normalize Input` output | `MIRROR-ENTRY` |
| **Log MIRROR Sent** | Side-branch from `Send Chatwoot Message` AND `Send Chatwoot Attachment` | `MIRROR-SENT` |
| **Log MIRROR Exit** | Connected from `Return Invalid`, `Return Deduped`, `Return Self Guard Skip`, `Return Result` | `MIRROR-EXIT` |

### Step 3: Test the imported workflow

1. Open the imported workflow
2. Replace `YOUR_SERVICE_KEY_HERE` in ALL 3 logging nodes (6 total header values — `apikey` and `Authorization` in each)
3. Click "Test workflow" → check `n8n_message_log` table for 3 new rows:
   - One with `workflow = 'MIRROR-ENTRY'`
   - One with `workflow = 'MIRROR-SENT'`
   - One with `workflow = 'MIRROR-EXIT'`

### Step 4: Copy nodes into AWF-MIRROR

**Node 1: Log MIRROR Entry**
- Copy the `Log MIRROR Entry` node from the test workflow
- Paste into AWF-MIRROR
- Wire: `Normalize Input` → `Log MIRROR Entry` (as a SECOND output, keep the existing connection to `Input Valid?`)
- Do NOT connect Log MIRROR Entry's output to anything (dead end)
- **IMPORTANT:** The JSON body expression uses `$json.messageId`, `$json.phone`, etc. which match Normalize Input's output exactly

**Node 2: Log MIRROR Sent**
- Copy the `Log MIRROR Sent` node
- Paste into AWF-MIRROR
- Wire: `Send Chatwoot Message` → `Log MIRROR Sent` (second output, keep existing connection to `Should Auto-Resolve?`)
- Also wire: `Send Chatwoot Attachment` → `Log MIRROR Sent`
- **IMPORTANT:** Change `$('Sample Normalize Output')` to `$('Normalize Input')` in the JSON body expression (5 places)

**Node 3: Log MIRROR Exit**
- Copy the `Log MIRROR Exit` node
- Paste into AWF-MIRROR
- Wire FROM all 4 exit nodes:
  - `Return Invalid` → `Log MIRROR Exit`
  - `Return Deduped` → `Log MIRROR Exit` (BOTH Return Deduped nodes)
  - `Return Self Guard Skip` → `Log MIRROR Exit`
  - `Return Result` → `Log MIRROR Exit`
- **IMPORTANT:** Change `$('Sample Normalize Output')` to `$('Normalize Input')` in the JSON body expression (5 places)

### Step 5: Save and activate AWF-MIRROR

The flow should now look like:
```
Normalize Input ──┬──▶ Input Valid? ──▶ (existing flow) ──▶ Send CW Msg ──┬──▶ Should Auto-Resolve?
                  │                                                        │
                  └──▶ Log MIRROR Entry (dead end)                         └──▶ Log MIRROR Sent (dead end)
                                                                           
Return Invalid ────┐
Return Deduped ────┤
Return Self Guard ─┤
Return Result ─────┴──▶ Log MIRROR Exit (dead end)
```

### Phase 2 Diff Queries

After 24–72 hours, run these queries:

**Query P2-1: Three-layer comparison**
```sql
SELECT 'GW3B received' AS checkpoint, COUNT(*) AS total
FROM n8n_message_log WHERE workflow = 'GW3B' AND timestamp > NOW() - INTERVAL '72 hours'
UNION ALL
SELECT 'MIRROR received' AS checkpoint, COUNT(*) AS total
FROM n8n_message_log WHERE workflow = 'MIRROR-ENTRY' AND timestamp > NOW() - INTERVAL '72 hours'
UNION ALL
SELECT 'MIRROR sent to CW' AS checkpoint, COUNT(*) AS total
FROM n8n_message_log WHERE workflow = 'MIRROR-SENT' AND timestamp > NOW() - INTERVAL '72 hours'
UNION ALL
SELECT 'MIRROR skipped/dropped' AS checkpoint, COUNT(*) AS total
FROM n8n_message_log WHERE workflow = 'MIRROR-EXIT' AND status != 'mirrored' AND timestamp > NOW() - INTERVAL '72 hours';
```

**Query P2-2: Why did MIRROR skip messages?**
```sql
SELECT status, skip_reason, COUNT(*) AS total
FROM n8n_message_log
WHERE workflow = 'MIRROR-EXIT'
  AND timestamp > NOW() - INTERVAL '72 hours'
GROUP BY status, skip_reason
ORDER BY total DESC;
```

**Query P2-3: Messages that entered MIRROR but never got sent to Chatwoot**
```sql
SELECT e.message_id, e.sender_phone, e.timestamp, e.clinic, e.status AS entry_status
FROM n8n_message_log e
LEFT JOIN n8n_message_log s ON e.message_id = s.message_id AND s.workflow = 'MIRROR-SENT'
LEFT JOIN n8n_message_log x ON e.message_id = x.message_id AND x.workflow = 'MIRROR-EXIT'
WHERE e.workflow = 'MIRROR-ENTRY'
  AND s.id IS NULL
  AND x.id IS NULL
  AND e.timestamp > NOW() - INTERVAL '72 hours'
ORDER BY e.timestamp DESC;
```

**Query P2-4: GW3B received but MIRROR never got (dispatch failure)**
```sql
SELECT g.message_id, g.sender_phone, g.timestamp, g.clinic
FROM n8n_message_log g
LEFT JOIN n8n_message_log m ON g.message_id = m.message_id AND m.workflow = 'MIRROR-ENTRY'
WHERE g.workflow = 'GW3B'
  AND m.id IS NULL
  AND g.timestamp > NOW() - INTERVAL '72 hours'
  AND g.from_me = false
ORDER BY g.timestamp DESC;
```

**Query P2-5: Chatwoot send failures**
```sql
SELECT message_id, sender_phone, timestamp, clinic, skip_reason, chatwoot_message_id
FROM n8n_message_log
WHERE workflow = 'MIRROR-SENT'
  AND status = 'send_failed'
  AND timestamp > NOW() - INTERVAL '72 hours'
ORDER BY timestamp DESC;
```

### Interpreting Phase 2 Results

| GW3B | MIRROR-ENTRY | MIRROR-EXIT status | MIRROR-SENT | Diagnosis |
|------|-------------|-------------------|-------------|-----------|
| Yes | No | — | — | **GW3B→MIRROR dispatch failed** (Execute Workflow node error) |
| Yes | Yes | `skipped` (invalid_input) | — | **Normalize Input rejected it** (missing phone, empty content) |
| Yes | Yes | `deduped` | — | **Dedup false positive** — ChatwootMirrorDedupe already had the mirrorKey |
| Yes | Yes | `skipped` (self_contact_guard) | — | **Self-message filtered** — message from clinic's own number |
| Yes | Yes | — | Yes (send_failed) | **Chatwoot API error** — check Chatwoot API logs, rate limits |
| Yes | Yes | `mirrored` | Yes (sent_ok) | **Message delivered to Chatwoot** — check Chatwoot inbox directly |

---

## Expected Outcomes

After running the audit for 72+ hours:

1. **If counts match (diff ≈ 0):** WaSender + n8n + Chatwoot chain is reliable. Losses may have been transient. Keep the logger running as a safety net.

2. **If Baileys > n8n (positive diff):** WaSender is dropping webhooks. Quantify it (X messages lost per day). Consider migrating to the official WhatsApp Cloud API.

3. **If n8n > Baileys (negative diff):** Baileys logger was probably disconnected for a period. Check the logger health queries and Easypanel uptime.

4. **If both captured the same messages but Chatwoot is missing some:** The problem is in AWF-MIRROR's Chatwoot write logic — check for dedup false positives, Chatwoot API rate limits, or contact/conversation creation failures.
