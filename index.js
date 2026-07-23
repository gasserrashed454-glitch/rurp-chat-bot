'use strict';

const {
    Client, GatewayIntentBits, Partials,
    ChannelType
} = require('discord.js');
const http    = require('http');
const https   = require('https');
const fetch   = require('node-fetch');
const { DatabaseSync: Database } = require('node:sqlite');

// ── Environment ───────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

// Support one key (MISTRAL_API_KEY) or many comma-separated (MISTRAL_API_KEYS)
const _rawKeys = (process.env.MISTRAL_API_KEYS || process.env.MISTRAL_API_KEY || '').trim();
const MISTRAL_KEYS = _rawKeys.split(',').map(k => k.trim()).filter(Boolean);

if (!DISCORD_TOKEN)       { console.error('Missing DISCORD_TOKEN');   process.exit(1); }
if (!MISTRAL_KEYS.length) { console.error('Missing MISTRAL_API_KEY(S)'); process.exit(1); }

let _keyIndex = 0;
function getApiKey() { return MISTRAL_KEYS[_keyIndex % MISTRAL_KEYS.length]; }
function rotateKey()  { _keyIndex = (_keyIndex + 1) % MISTRAL_KEYS.length; }

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

const RURP_KNOWLEDGE = `
ABOUT RURP:
RURP stands for Realistic Union RP. It is a private roleplay server within the Roblox game Emergency Hamburg. It is not its own game. The community is growing, friendly, and focused on serious roleplay within Emergency Hamburg. The server founder is @oz57hz. Invite: discord.gg/ehrurp

PARTNERSHIP RULES:
- Servers must have 150+ members (excluding bots).
- The server owner and at least 3 staff members must join RURP.
- 250 members and below: 2 representatives required.
- 200 members and below: 3 representatives required.
- Servers below 100 members must provide an @everyone ping.
- Representatives must remain in the server after partnership; leaving terminates it. A representative can be swapped via a ticket.
- The partner server must have a dedicated partnership channel.
- The partner server must comply with Roblox and Discord ToS.
- Must have a clean, safe environment — no NSFW, racism, homophobia, or universally unacceptable behaviour.
- Partnerships exist to grow both servers respectfully. Any disrespect results in termination.

STAFF APPLICATIONS:
- Open to anyone aged 13 and above.
- Applicants must be active, respectful, mature, calm under pressure, and able to communicate clearly.
- Applications channel: <#1499433931223597188>

KEY CHANNELS:
- Applications: <#1499433931223597188>
- RP Stats: <#1499433935267168468>
- Server Status: <#1506108882047602688>
`.trim();

function buildSystemPrompt() {
    const context = buildSyncContext();
    const contextBlock = context
        ? `\n\nRECENT SERVER MESSAGES (for additional context):\n${context}\n`
        : '';
    return (
        `You are a chat assistant in the RURP Discord server. ` +
        `You can talk about any topic. Keep responses short and to the point — do not over-explain or pad answers. ` +
        `Only go into detail if the user specifically asks for it. ` +
        `You do not use emojis. No lectures. If something is harmful or illegal, decline in one sentence. ` +
        `You know about the RURP server and can reference it when relevant.\n\n` +
        RURP_KNOWLEDGE +
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

    // Try each key once before giving up
    let lastErr;
    for (let attempt = 0; attempt < MISTRAL_KEYS.length; attempt++) {
        const key = getApiKey();
        const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${key}`,
            },
            body: JSON.stringify({ model, messages, max_tokens: 1024, temperature: 0.6 }),
        });

        if (res.status === 429 || res.status === 401) {
            // Rate-limited or invalid key — rotate and retry
            rotateKey();
            lastErr = `Mistral ${res.status} on key index ${_keyIndex}`;
            continue;
        }
        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Mistral error ${res.status}: ${err}`);
        }
        const data = await res.json();
        return data.choices?.[0]?.message?.content || null;
    }
    throw new Error(`All Mistral keys exhausted. Last error: ${lastErr}`);
}

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
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
                ch.type === ChannelType.GuildText
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
