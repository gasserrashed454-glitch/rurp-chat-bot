'use strict';

const {
    Client, GatewayIntentBits, Partials, MessageFlags,
    PermissionsBitField, ChannelType
} = require('discord.js');
const http    = require('http');
const https   = require('https');
const fetch   = require('node-fetch');
const Database = require('better-sqlite3');

// ── Environment ───────────────────────────────────────────────────────────────
const DISCORD_TOKEN    = process.env.DISCORD_TOKEN;
const MISTRAL_API_KEY  = process.env.MISTRAL_API_KEY;

if (!DISCORD_TOKEN)   { console.error('Missing DISCORD_TOKEN'); process.exit(1); }
if (!MISTRAL_API_KEY) { console.error('Missing MISTRAL_API_KEY'); process.exit(1); }

// ── Constants ─────────────────────────────────────────────────────────────────
const OWNER_ID = '1459268330933326087';

const ALLOWED_CHANNELS = new Set([
    '1529866897317822544',
    '1528332597036322907',
]);

const MISTRAL_MODEL_VISION = 'pixtral-large-latest'; // supports images
const MISTRAL_MODEL_TEXT   = 'mistral-large-latest';
const MAX_HISTORY          = 20;   // messages kept in memory per channel
const MAX_SYNC_CONTEXT     = 120;  // synced messages fed into system prompt
const SYNC_PER_CHANNEL     = 200;  // messages fetched per channel on .sync

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database('./rurp.db');
db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT
    );
    CREATE TABLE IF NOT EXISTS sync_messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id    TEXT,
        guild_name  TEXT,
        channel_id  TEXT,
        channel_name TEXT,
        author_tag  TEXT,
        content     TEXT,
        ts          INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sync_ts ON sync_messages (ts DESC);
`);

function getSetting(key, def) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : def;
}
function setSetting(key, value) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

// ── State ─────────────────────────────────────────────────────────────────────
let botEnabled = getSetting('enabled', 'true') === 'true';

// Per-channel conversation history: Map<channelId, Array<{role, content}>>
const channelHistory = new Map();

function getHistory(channelId) {
    if (!channelHistory.has(channelId)) channelHistory.set(channelId, []);
    return channelHistory.get(channelId);
}
function pushHistory(channelId, role, content) {
    const hist = getHistory(channelId);
    hist.push({ role, content });
    if (hist.length > MAX_HISTORY * 2) hist.splice(0, hist.length - MAX_HISTORY * 2);
}

// ── Synced context builder ────────────────────────────────────────────────────
function buildSyncContext() {
    const rows = db.prepare(
        `SELECT guild_name, channel_name, author_tag, content, ts
         FROM sync_messages
         ORDER BY ts DESC
         LIMIT ?`
    ).all(MAX_SYNC_CONTEXT);

    if (!rows.length) return '';

    // Reverse so it reads chronologically
    rows.reverse();
    const lines = rows.map(r =>
        `[#${r.channel_name}] ${r.author_tag}: ${r.content.slice(0, 300)}`
    );
    return lines.join('\n');
}

function buildSystemPrompt() {
    const context = buildSyncContext();
    const contextBlock = context
        ? `\n\nSERVER CONTEXT (recent messages from RURP):\n${context}\n`
        : '';
    return (
        `You are the AI assistant for the RURP Discord server. ` +
        `You are helpful, precise, and professional. ` +
        `You do not use emojis. ` +
        `If a request is inappropriate, harmful, or irrelevant, respond briefly that you cannot help with that and move on. ` +
        `Do not explain your refusal at length. ` +
        `Use the server context below to answer questions about RURP accurately.` +
        contextBlock
    );
}

// ── Mistral API ───────────────────────────────────────────────────────────────
async function fetchImageAsBase64(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`);
    const buf = await res.buffer();
    const mime = res.headers.get('content-type') || 'image/png';
    return { base64: buf.toString('base64'), mime };
}

async function callMistral(channelId, userContent, hasImage) {
    const model = hasImage ? MISTRAL_MODEL_VISION : MISTRAL_MODEL_TEXT;
    const messages = [
        { role: 'system', content: buildSystemPrompt() },
        ...getHistory(channelId),
        { role: 'user', content: userContent },
    ];

    const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${MISTRAL_API_KEY}`,
        },
        body: JSON.stringify({ model, messages, max_tokens: 1024, temperature: 0.6 }),
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Mistral error ${res.status}: ${err}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
}

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Channel, Partials.Message],
});

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (!ALLOWED_CHANNELS.has(message.channel.id)) return;

    const raw = message.content.trim();
    const cmd = raw.toLowerCase();

    // ── Owner commands ────────────────────────────────────────────────────────
    if (message.author.id === OWNER_ID) {

        // .toggle on / .toggle off
        if (cmd === '.toggle on' || cmd === '.toggle off') {
            botEnabled = cmd === '.toggle on';
            setSetting('enabled', String(botEnabled));
            return message.reply({
                content: botEnabled ? 'Bot enabled.' : 'Bot disabled.',
                allowedMentions: { repliedUser: false },
            });
        }

        // .sync — fetch last 200 messages from every readable channel
        if (cmd === '.sync') {
            const reply = await message.reply({
                content: 'Syncing channels...',
                allowedMentions: { repliedUser: false },
            });

            const guild = message.guild;
            if (!guild) return reply.edit({ content: 'Must be used in a server.' });

            const textChannels = guild.channels.cache.filter(ch =>
                ch.type === ChannelType.GuildText &&
                ch.permissionsFor(guild.members.me)?.has(PermissionsBitField.Flags.ReadMessageHistory)
            );

            let total = 0;
            const insertMsg = db.prepare(
                `INSERT OR IGNORE INTO sync_messages
                 (guild_id, guild_name, channel_id, channel_name, author_tag, content, ts)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
            );

            // Use a unique constraint on (channel_id, ts) to prevent duplicates
            // We'll clear and re-sync for freshness
            db.prepare('DELETE FROM sync_messages WHERE guild_id = ?').run(guild.id);

            for (const [, ch] of textChannels) {
                try {
                    let fetched = [];
                    let before  = null;
                    // Fetch up to SYNC_PER_CHANNEL messages (Discord limit: 100/request)
                    while (fetched.length < SYNC_PER_CHANNEL) {
                        const opts = { limit: Math.min(100, SYNC_PER_CHANNEL - fetched.length) };
                        if (before) opts.before = before;
                        const batch = await ch.messages.fetch(opts);
                        if (!batch.size) break;
                        fetched = fetched.concat([...batch.values()]);
                        before  = batch.last().id;
                        if (batch.size < 100) break;
                    }

                    const insert = db.transaction(() => {
                        for (const m of fetched) {
                            if (m.author.bot) continue;
                            const text = m.content.trim();
                            if (!text) continue;
                            insertMsg.run(
                                guild.id, guild.name,
                                ch.id, ch.name,
                                m.author.tag, text,
                                m.createdTimestamp
                            );
                            total++;
                        }
                    });
                    insert();
                } catch (e) {
                    console.error(`[Sync] Failed #${ch.name}:`, e.message);
                }
            }

            return reply.edit({
                content: `Sync complete. ${total} messages indexed across ${textChannels.size} channels.`,
            });
        }
    }

    // ── Chat handling ─────────────────────────────────────────────────────────
    if (!botEnabled) return;
    if (!raw && !message.attachments.size) return;

    // Build user content (may be multipart for images)
    let userContent;
    let hasImage = false;

    try {
        const parts = [];

        // Text portion
        if (raw) parts.push({ type: 'text', text: raw });

        // Attachments
        for (const [, att] of message.attachments) {
            const mime = att.contentType || '';

            if (mime.startsWith('image/')) {
                hasImage = true;
                try {
                    const { base64, mime: m } = await fetchImageAsBase64(att.url);
                    parts.push({
                        type: 'image_url',
                        image_url: { url: `data:${m};base64,${base64}` },
                    });
                } catch {
                    parts.push({ type: 'text', text: `[Image attached: ${att.name}]` });
                }
            } else if (mime.startsWith('audio/') || mime.startsWith('video/')) {
                parts.push({
                    type: 'text',
                    text: `[${mime.startsWith('audio/') ? 'Audio' : 'Video'} file attached: ${att.name} — ${att.url}]`,
                });
            } else {
                parts.push({ type: 'text', text: `[File attached: ${att.name}]` });
            }
        }

        if (!parts.length) return;

        // If only one text part, send as plain string (faster path)
        userContent = (parts.length === 1 && parts[0].type === 'text')
            ? parts[0].text
            : parts;

        await message.channel.sendTyping();

        const reply = await callMistral(message.channel.id, userContent, hasImage);
        if (!reply) return;

        // Store in history (store text summary for multi-part)
        const historyText = typeof userContent === 'string'
            ? userContent
            : parts.filter(p => p.type === 'text').map(p => p.text).join(' ') || '[media]';
        pushHistory(message.channel.id, 'user', historyText);
        pushHistory(message.channel.id, 'assistant', reply);

        // Discord max 2000 chars — split if needed
        if (reply.length <= 2000) {
            await message.reply({ content: reply, allowedMentions: { repliedUser: false } });
        } else {
            const chunks = reply.match(/[\s\S]{1,1990}/g) || [];
            for (const chunk of chunks) {
                await message.channel.send({ content: chunk });
            }
        }

    } catch (err) {
        console.error('[Chat] Error:', err.message);
        // Silent fail on bad requests — don't surface API errors to users
    }
});

// ── HTTP ping server (Render uptime detection) ────────────────────────────────
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!DOCTYPE html><html><head><title>RURP Bot</title></head><body><p>Online</p></body></html>');
}).listen(PORT, () => console.log(`Ping server on port ${PORT}`));

// ── Login ─────────────────────────────────────────────────────────────────────
client.login(DISCORD_TOKEN);
