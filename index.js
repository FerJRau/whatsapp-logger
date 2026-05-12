const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const Database = require('better-sqlite3');
const pino = require('pino');
const path = require('path');
require('dotenv').config();

// --- Configuration ---
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'auth_store');
const SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, 'messages.db');
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

// --- Logger ---
const logger = pino({ level: LOG_LEVEL });

// --- Supabase client (optional) ---
let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    logger.info('Supabase configured — messages will be logged to cloud DB');
} else {
    logger.info('No Supabase credentials — using local SQLite only');
}

// --- SQLite setup (always active as local backup) ---
const db = new Database(SQLITE_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT UNIQUE,
        from_jid TEXT,
        sender_phone TEXT,
        timestamp TEXT,
        message_type TEXT,
        body TEXT,
        raw_payload TEXT,
        synced_to_supabase INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
    )
`);

const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO whatsapp_messages 
    (message_id, from_jid, sender_phone, timestamp, message_type, body, raw_payload, synced_to_supabase)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const markSyncedStmt = db.prepare(`
    UPDATE whatsapp_messages SET synced_to_supabase = 1 WHERE message_id = ?
`);

const getUnsyncedStmt = db.prepare(`
    SELECT * FROM whatsapp_messages WHERE synced_to_supabase = 0 LIMIT 100
`);

// --- Message extraction helpers ---
function extractMessageBody(message) {
    if (!message) return null;
    return message.conversation
        || message.extendedTextMessage?.text
        || message.imageMessage?.caption
        || message.videoMessage?.caption
        || message.documentMessage?.caption
        || message.buttonsResponseMessage?.selectedDisplayText
        || message.listResponseMessage?.title
        || message.templateButtonReplyMessage?.selectedDisplayText
        || null;
}

function getMessageType(message) {
    if (!message) return 'unknown';
    if (message.conversation || message.extendedTextMessage) return 'text';
    if (message.imageMessage) return 'image';
    if (message.videoMessage) return 'video';
    if (message.audioMessage) return 'audio';
    if (message.documentMessage) return 'document';
    if (message.stickerMessage) return 'sticker';
    if (message.contactMessage || message.contactsArrayMessage) return 'contact';
    if (message.locationMessage || message.liveLocationMessage) return 'location';
    if (message.reactionMessage) return 'reaction';
    if (message.pollCreationMessage || message.pollUpdateMessage) return 'poll';
    if (message.buttonsResponseMessage || message.listResponseMessage) return 'button_response';
    return 'other';
}

function extractSenderPhone(key, msg) {
    // For group messages, participant has the sender
    if (key.participant) {
        return key.participant.replace('@s.whatsapp.net', '').replace('@lid', '');
    }
    // For private chats, remoteJid is the sender
    return key.remoteJid?.replace('@s.whatsapp.net', '').replace('@lid', '') || 'unknown';
}

// --- Save message to SQLite ---
function saveToSQLite(msgData) {
    try {
        insertStmt.run(
            msgData.message_id,
            msgData.from_jid,
            msgData.sender_phone,
            msgData.timestamp,
            msgData.message_type,
            msgData.body,
            msgData.raw_payload,
            0
        );
        return true;
    } catch (err) {
        if (err.message.includes('UNIQUE constraint')) {
            return false; // Duplicate, skip
        }
        logger.error({ err }, 'SQLite insert error');
        return false;
    }
}

// --- Save message to Supabase ---
async function saveToSupabase(msgData) {
    if (!supabase) return false;
    try {
        const { error } = await supabase.from('whatsapp_messages').upsert({
            message_id: msgData.message_id,
            from_jid: msgData.from_jid,
            sender_phone: msgData.sender_phone,
            timestamp: msgData.timestamp,
            message_type: msgData.message_type,
            body: msgData.body,
            raw_payload: JSON.parse(msgData.raw_payload)
        }, { onConflict: 'message_id' });

        if (error) {
            logger.error({ error }, 'Supabase insert error');
            return false;
        }
        return true;
    } catch (err) {
        logger.error({ err }, 'Supabase connection error');
        return false;
    }
}

// --- Sync unsynced messages to Supabase (periodic) ---
async function syncToSupabase() {
    if (!supabase) return;
    const unsynced = getUnsyncedStmt.all();
    if (unsynced.length === 0) return;

    logger.info(`Syncing ${unsynced.length} unsynced messages to Supabase...`);
    for (const row of unsynced) {
        const success = await saveToSupabase({
            message_id: row.message_id,
            from_jid: row.from_jid,
            sender_phone: row.sender_phone,
            timestamp: row.timestamp,
            message_type: row.message_type,
            body: row.body,
            raw_payload: row.raw_payload
        });
        if (success) {
            markSyncedStmt.run(row.message_id);
        }
    }
}

// --- Main WhatsApp connection ---
async function startLogger() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }), // Suppress Baileys internal logs
        browser: ['WhatsApp Logger', 'Chrome', '120.0.0'],
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
    });

    // Save credentials on update
    sock.ev.on('creds.update', saveCreds);

    // Handle connection updates
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            logger.info('QR code generated — scan with WhatsApp on the client phone');
        }

        if (connection === 'open') {
            logger.info('Connected to WhatsApp successfully');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            if (shouldReconnect) {
                logger.warn({ statusCode }, 'Connection closed, reconnecting...');
                setTimeout(startLogger, 3000);
            } else {
                logger.error('Logged out from WhatsApp. Delete auth_store/ and re-scan QR.');
            }
        }
    });

    // Listen for ALL messages (incoming + outgoing for complete audit)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        for (const msg of messages) {
            // Skip status broadcasts
            if (msg.key.remoteJid === 'status@broadcast') continue;

            const isIncoming = !msg.key.fromMe;
            const messageBody = extractMessageBody(msg.message);
            const messageType = getMessageType(msg.message);
            const senderPhone = extractSenderPhone(msg.key, msg);

            const msgData = {
                message_id: msg.key.id,
                from_jid: msg.key.remoteJid,
                sender_phone: senderPhone,
                timestamp: new Date((msg.messageTimestamp || 0) * 1000).toISOString(),
                message_type: messageType,
                body: messageBody || `[${messageType}]`,
                raw_payload: JSON.stringify(msg),
            };

            // Always save to SQLite first (fast, local, reliable)
            const saved = saveToSQLite(msgData);
            if (saved) {
                logger.info({
                    direction: isIncoming ? 'IN' : 'OUT',
                    from: senderPhone,
                    type: messageType,
                    body: messageBody?.substring(0, 50) || `[${messageType}]`
                }, 'Message logged');

                // Attempt Supabase save (non-blocking)
                const synced = await saveToSupabase(msgData);
                if (synced) {
                    markSyncedStmt.run(msgData.message_id);
                }
            }
        }
    });

    // Periodic sync of any messages that failed to reach Supabase
    setInterval(syncToSupabase, 60000); // Every 60 seconds
}

// --- Graceful shutdown ---
process.on('SIGINT', () => {
    logger.info('Shutting down...');
    db.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info('Shutting down...');
    db.close();
    process.exit(0);
});

// --- Start ---
logger.info('WhatsApp Logger starting...');
startLogger().catch((err) => {
    logger.error({ err }, 'Failed to start logger');
    process.exit(1);
});
