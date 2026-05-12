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
