-- Run this in your Supabase SQL editor once the project is active
-- https://supabase.com/dashboard/project/YOUR_PROJECT_ID/sql

CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id BIGSERIAL PRIMARY KEY,
    message_id TEXT UNIQUE NOT NULL,
    from_jid TEXT,
    sender_phone TEXT,
    timestamp TIMESTAMPTZ,
    message_type TEXT,
    body TEXT,
    raw_payload JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookups by timestamp (for comparing against Chatwoot)
CREATE INDEX idx_whatsapp_messages_timestamp ON whatsapp_messages(timestamp);

-- Index for deduplication
CREATE INDEX idx_whatsapp_messages_message_id ON whatsapp_messages(message_id);

-- Index for filtering by sender
CREATE INDEX idx_whatsapp_messages_sender ON whatsapp_messages(sender_phone);

-- Enable Row Level Security (recommended)
ALTER TABLE whatsapp_messages ENABLE ROW LEVEL SECURITY;

-- Policy: only service role can insert/read (no public access)
CREATE POLICY "Service role full access" ON whatsapp_messages
    FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

-- ============================================================
-- Table 2: n8n message log (for diffing against Baileys)
-- Records every message WaSender delivers to GW3B in n8n.
-- ============================================================
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

CREATE INDEX idx_n8n_log_message_id ON n8n_message_log(message_id);
CREATE INDEX idx_n8n_log_timestamp ON n8n_message_log(timestamp);
CREATE INDEX idx_n8n_log_sender ON n8n_message_log(sender_phone);

ALTER TABLE n8n_message_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON n8n_message_log
    FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');
