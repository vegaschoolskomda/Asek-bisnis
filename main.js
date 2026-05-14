// ================= LOGIN =================

const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const sharp = require("sharp");
const https = require("https");
const http = require("http");
const Tiktok = require("@tobyg74/tiktok-api-dl");
const { createCanvas } = require("canvas");
console.log("Starting WhatsApp bot...");
const startupKeepAlive = setInterval(() => {}, 1000);
const debugMessageLogs = process.env.DEBUG_MESSAGE_LOGS === "1";
const allowSelfCommands = process.env.ALLOW_SELF_COMMANDS === "1";
const botLockFile = path.join(__dirname, ".bot.lock");
let isWhatsAppReady = false;

function releaseBotLock() {
    try {
        if (fs.existsSync(botLockFile)) {
            fs.unlinkSync(botLockFile);
        }
    } catch {
        // Ignore cleanup errors.
    }
}

function acquireBotLock() {
    try {
        if (fs.existsSync(botLockFile)) {
            let existing = null;

            try {
                const raw = fs.readFileSync(botLockFile, "utf8");
                existing = JSON.parse(raw);
            } catch {
                // Lock korup biasanya terjadi kalau proses mati mendadak saat menulis file.
                releaseBotLock();
            }

            const existingPid = Number(existing && existing.pid);

            if (Number.isInteger(existingPid) && existingPid > 0) {
                if (isSameBotProcessRunning(existingPid)) {
                    console.log("❌ Bot sudah berjalan di proses lain. Jalankan hanya 1 instance node main.js.");
                    return false;
                }

                releaseBotLock();
            } else {
                releaseBotLock();
            }
        }

        fs.writeFileSync(botLockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
        return true;
    } catch (error) {
        console.log("Gagal membuat lock bot:", error.message);
        return false;
    }
}

function isSameBotProcessRunning(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }

    if (process.platform === "win32") {
        try {
            const command = `$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\"; if ($null -eq $p) { '' } else { $p.CommandLine }`;
            const output = execSync(`powershell -NoProfile -Command "${command}"`, {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            });

            const cmdLine = String(output || "").toLowerCase();
            if (!cmdLine.trim()) {
                return false;
            }

            return cmdLine.includes("node") && cmdLine.includes(path.basename(__filename).toLowerCase());
        } catch {
            return false;
        }
    }

    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

if (!acquireBotLock()) {
    process.exit(1);
}

process.on("exit", releaseBotLock);
process.on("SIGINT", () => {
    releaseBotLock();
    process.exit(0);
});
process.on("SIGTERM", () => {
    releaseBotLock();
    process.exit(0);
});

function clearStaleChromeProfileLocks(profileDir) {
    const lockFiles = [
        "SingletonLock",
        "SingletonCookie",
        "SingletonSocket",
        "DevToolsActivePort",
    ];

    for (const fileName of lockFiles) {
        const fullPath = path.join(profileDir, fileName);
        try {
            if (fs.existsSync(fullPath)) {
                fs.unlinkSync(fullPath);
            }
        } catch {
            // Abaikan kalau file tidak bisa dihapus.
        }
    }
}

function isChromeProfileBusy(profileDir) {
    const lockFiles = ["SingletonLock", "SingletonCookie", "SingletonSocket", "DevToolsActivePort"];

    return lockFiles.some((fileName) => fs.existsSync(path.join(profileDir, fileName)));
}

function resolveAuthDataPath() {
    const primaryAuthPath = path.join(__dirname, "Auth");
    const primarySessionPath = path.join(primaryAuthPath, "session");
    const fallbackAuthPath = path.join(__dirname, "AuthFallback");
    const fallbackSessionPath = path.join(fallbackAuthPath, "session");

    if (!fs.existsSync(primaryAuthPath)) {
        fs.mkdirSync(primaryAuthPath, { recursive: true });
    }

    if (!fs.existsSync(fallbackAuthPath)) {
        fs.mkdirSync(fallbackAuthPath, { recursive: true });
    }

    function hasSessionData(authPath) {
        const sessionPath = path.join(authPath, "session");
        if (!fs.existsSync(sessionPath)) {
            return false;
        }

        const defaultPath = path.join(sessionPath, "Default");
        if (fs.existsSync(defaultPath)) {
            return true;
        }

        try {
            return fs.readdirSync(sessionPath).length > 0;
        } catch {
            return false;
        }
    }

    clearStaleChromeProfileLocks(primarySessionPath);
    clearStaleChromeProfileLocks(fallbackSessionPath);

    const primaryBusy = isChromeProfileBusy(primarySessionPath);
    const fallbackBusy = isChromeProfileBusy(fallbackSessionPath);
    const primaryHasSession = hasSessionData(primaryAuthPath);
    const fallbackHasSession = hasSessionData(fallbackAuthPath);

    if (!primaryBusy && primaryHasSession) {
        return primaryAuthPath;
    }

    if (!fallbackBusy && fallbackHasSession) {
        return fallbackAuthPath;
    }

    if (!primaryBusy) {
        return primaryAuthPath;
    }

    if (!fallbackBusy) {
        console.log("⚠️ Auth/session masih dipakai. Pindah ke AuthFallback agar bot tetap bisa jalan.");
        return fallbackAuthPath;
    }

    console.log("⚠️ Kedua profile auth sedang terkunci. Gunakan Auth utama untuk menjaga sesi tetap sama.");
    return primaryAuthPath;
}

const authDataPath = resolveAuthDataPath();
console.log(`Using auth data path: ${authDataPath}`);

const chromeExecutable = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const chromePath = fs.existsSync(chromeExecutable) ? chromeExecutable : undefined;

const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: authDataPath
    }),
    puppeteer: {
        headless: true,
        executablePath: chromePath,
        protocolTimeout: 180000,
        timeout: 180000,
        args: [
            "--disable-dev-shm-usage",
            "--no-sandbox",
            "--disable-setuid-sandbox",
        ],
    },
});

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientWwebError(error) {
    const text = String(error && error.message ? error.message : error).toLowerCase();

    return [
        "execution context was destroyed",
        "protocol error",
        "runtime.callfunctionon timed out",
        "unsafe is not a function",
        "target closed",
    ].some((pattern) => text.includes(pattern));
}

async function patchClientSendMessage() {
    const originalSendMessage = client.sendMessage.bind(client);

    client.sendMessage = async (...args) => {
        const maxRetry = 3;

        for (let attempt = 1; attempt <= maxRetry; attempt += 1) {
            try {
                return await originalSendMessage(...args);
            } catch (error) {
                if (!isTransientWwebError(error) || attempt === maxRetry) {
                    throw error;
                }

                const waitMs = 700 * attempt;
                const msg = error && error.message ? error.message : String(error);
                console.log(`[sendMessage] retry ${attempt}/${maxRetry} karena error transient: ${msg}`);
                await sleep(waitMs);
            }
        }

        throw new Error("sendMessage retry exhausted");
    };
}

patchClientSendMessage();

async function safeGetChats(maxRetry = 3, retryDelayMs = 3000) {
    if (!client || typeof client.getChats !== "function") {
        const cachedChats = groupDirectory.map((group) => ({
            isGroup: true,
            id: { _serialized: group.id },
            name: group.name,
            participants: [],
        }));

        if (debugMessageLogs) {
            console.log("[getChats] client belum siap, pakai cache grup lokal.");
        }

        return cachedChats;
    }

    for (let attempt = 1; attempt <= maxRetry; attempt += 1) {
        try {
            return await client.getChats();
        } catch (error) {
            const msg = error && error.message ? error.message : String(error);
            console.log(`[getChats] attempt ${attempt}/${maxRetry} gagal: ${msg}`);

            if (attempt === maxRetry) {
                if (groupDirectory.length) {
                    console.log(`[getChats] fallback ke cache grup lokal (${groupDirectory.length} grup).`);
                    return groupDirectory.map((group) => ({
                        isGroup: true,
                        id: { _serialized: group.id },
                        name: group.name,
                        participants: [],
                    }));
                }

                return [];
            }

            await sleep(retryDelayMs * attempt);
        }
    }

    return [];
}

client.once("ready", async () => {
    isWhatsAppReady = true;
    clearInterval(startupKeepAlive);
    console.log("BOT ALWAYS READY 🚀");

    // Hindari panggilan berat ke runtime saat startup karena context WA Web bisa reload.
    // Daftar chat tetap akan diambil saat command yang membutuhkannya dipanggil.
    await sleep(500);
});

client.on("qr", (qr) => {
    console.log("Scan QR di bawah ini:");
    qrcode.generate(qr, { small: true });
    const chunkSize = 300;
    const totalParts = Math.ceil(qr.length / chunkSize);

    console.log("QR raw (gabungkan semua part sesuai urutan):");
    console.log("QR_RAW_BEGIN");

    for (let i = 0; i < totalParts; i += 1) {
        const start = i * chunkSize;
        const part = qr.slice(start, start + chunkSize);
        console.log(`QR_RAW_PART_${i + 1}/${totalParts}: ${part}`);
    }

    console.log("QR_RAW_END");
});

// ================= DATABASE =================

const file = "data.json";
const contentDbFile = "database.json";
const depositDbFile = "deposit.json";
const savedContactsFile = "saved_contacts.json";
const groupCacheFile = "group_cache.json";
const mediaStorageDir = "stored_media";
const contactExportDir = path.join(mediaStorageDir, "contact_exports");
const tiktokMediaDir = path.join(mediaStorageDir, "tiktok");
const instagramMediaDir = path.join(mediaStorageDir, "instagram");
const allowedDataCategories = ["payment", "gb"];
const defaultBotDb = {
    owner: null,
    data: {
        payment: [],
        gb: [],
    },
};
const defaultDepositDb = {
    transactions: [],
    users: {},
    history: [],
    meta: {
        lastActiveUserId: null,
        lastActiveAt: null,
    },
};
const defaultSavedContactsDb = {
    updatedAt: null,
    groups: [],
};
const defaultGroupCacheDb = {
    updatedAt: null,
    groups: [],
};

if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify([]));
}

if (!fs.existsSync(contentDbFile)) {
    fs.writeFileSync(contentDbFile, JSON.stringify(defaultBotDb, null, 2));
}

if (!fs.existsSync(depositDbFile)) {
    fs.writeFileSync(depositDbFile, JSON.stringify(defaultDepositDb, null, 2));
}

if (!fs.existsSync(savedContactsFile)) {
    fs.writeFileSync(savedContactsFile, JSON.stringify(defaultSavedContactsDb, null, 2));
}

if (!fs.existsSync(groupCacheFile)) {
    fs.writeFileSync(groupCacheFile, JSON.stringify(defaultGroupCacheDb, null, 2));
}

if (!fs.existsSync(mediaStorageDir)) {
    fs.mkdirSync(mediaStorageDir, { recursive: true });
}

if (!fs.existsSync(contactExportDir)) {
    fs.mkdirSync(contactExportDir, { recursive: true });
}

if (!fs.existsSync(tiktokMediaDir)) {
    fs.mkdirSync(tiktokMediaDir, { recursive: true });
}

if (!fs.existsSync(instagramMediaDir)) {
    fs.mkdirSync(instagramMediaDir, { recursive: true });
}

// ================= BROADCAST SYSTEM =================

const broadcastConcurrency = 1;
const broadcastBatchDelayMs = 7000;
const blockedGroups = []; // Grup yang tidak akan menerima broadcast
const shareSessions = new Map(); // Simpan sesi input !share per user
const processedMessages = new Set();
const processedMessageTimers = new Map();
const processedMessageTtlMs = 10 * 60 * 1000;

const broadcastState = {
    intervalId: null,
    intervalHours: 0,
    message: "",
    starterChatId: null,
    targetGroups: [],
    sessionBlockedGroupIds: [],
    isSending: false,
};

let groupDirectory = loadGroupCache(); // Cache daftar grup untuk !larang
const saveSessions = new Map(); // Simpan sesi input !save per user
const addSessions = new Map(); // Simpan sesi input !add per user

function loadGroupCache() {
    try {
        const parsed = JSON.parse(fs.readFileSync(groupCacheFile, "utf8"));
        return Array.isArray(parsed && parsed.groups)
            ? parsed.groups.filter((group) => group && group.id && group.name)
            : [];
    } catch {
        return [];
    }
}

function saveGroupCache(groups) {
    const sanitizedGroups = Array.isArray(groups)
        ? groups.filter((group) => group && group.id && group.name)
        : [];

    const payload = {
        updatedAt: new Date().toISOString(),
        groups: sanitizedGroups,
    };

    fs.writeFileSync(groupCacheFile, JSON.stringify(payload, null, 2));
}

function normalizeUserId(raw) {
    if (!raw) {
        return null;
    }

    const text = String(raw).trim();
    if (!text) {
        return null;
    }

    if (text.endsWith("@g.us")) {
        return text;
    }

    if (text.includes("@")) {
        const normalizedText = text.replace("@lid", "@c.us");
        const [localPart] = normalizedText.split("@");
        let number = String(localPart || "").replace(/\D/g, "");

        if (number.startsWith("0")) {
            number = `62${number.slice(1)}`;
        } else if (number.startsWith("8")) {
            number = `62${number}`;
        }

        if (!number) {
            return null;
        }

        return `${number}@c.us`;
    }

    let number = text.replace(/\D/g, "");

    if (number.startsWith("0")) {
        number = `62${number.slice(1)}`;
    } else if (number.startsWith("8")) {
        number = `62${number}`;
    }

    if (!number) {
        return null;
    }

    return `${number}@c.us`;
}

function markMessageAsProcessed(messageId) {
    processedMessages.add(messageId);

    if (processedMessageTimers.has(messageId)) {
        clearTimeout(processedMessageTimers.get(messageId));
    }

    const timer = setTimeout(() => {
        processedMessages.delete(messageId);
        processedMessageTimers.delete(messageId);
    }, processedMessageTtlMs);

    processedMessageTimers.set(messageId, timer);
}

function resolveSenderId(message) {
    if (message && message.fromMe && client.info && client.info.wid && client.info.wid._serialized) {
        return normalizeUserId(client.info.wid._serialized);
    }

    return normalizeUserId(message.author || message.from);
}

async function safeGetContact(message) {
    try {
        return await message.getContact();
    } catch (error) {
        const errorText = String(error && error.message ? error.message : error);
        if (errorText.includes("No LID for user")) {
            return null;
        }
        throw error;
    }
}

async function safeGetChat(message) {
    try {
        return await message.getChat();
    } catch (error) {
        const errorText = String(error && error.message ? error.message : error);
        if (errorText.includes("No LID for user")) {
            return null;
        }
        throw error;
    }
}

function loadContentDb() {
    try {
        const parsed = JSON.parse(fs.readFileSync(contentDbFile, "utf8"));

        const dataSource = parsed && parsed.data && typeof parsed.data === "object"
            ? parsed.data
            : parsed;

        return {
            owner: normalizeUserId(parsed.owner) || null,
            data: {
                payment: Array.isArray(dataSource.payment) ? dataSource.payment : [],
                gb: Array.isArray(dataSource.gb) ? dataSource.gb : [],
            },
        };
    } catch {
        return JSON.parse(JSON.stringify(defaultBotDb));
    }
}

function saveContentDb(data) {
    fs.writeFileSync(contentDbFile, JSON.stringify(data, null, 2));
}

function loadDepositDb() {
    try {
        const parsed = JSON.parse(fs.readFileSync(depositDbFile, "utf8"));
        return {
            transactions: Array.isArray(parsed && parsed.transactions) ? parsed.transactions : [],
            users: parsed && typeof parsed.users === "object" && parsed.users ? parsed.users : {},
            history: Array.isArray(parsed && parsed.history) ? parsed.history : [],
            meta: parsed && typeof parsed.meta === "object" && parsed.meta
                ? {
                    lastActiveUserId: parsed.meta.lastActiveUserId || null,
                    lastActiveAt: parsed.meta.lastActiveAt || null,
                }
                : { lastActiveUserId: null, lastActiveAt: null },
        };
    } catch {
        return JSON.parse(JSON.stringify(defaultDepositDb));
    }
}

function saveDepositDb(data) {
    fs.writeFileSync(depositDbFile, JSON.stringify(data, null, 2));
}

function setOwnerForce(rawNumber) {
    const normalized = normalizeUserId(rawNumber);
    if (!normalized) {
        return { ok: false, message: "Nomor owner tidak valid." };
    }

    const db = loadContentDb();
    db.owner = normalized;
    saveContentDb(db);

    return { ok: true, message: `Owner berhasil dipaksa ke ${normalized}` };
}

function setupLocalEmergencyCommands() {
    // Hanya bisa dipakai dari terminal lokal yang menjalankan proses node ini.
    if (!process.stdin || !process.stdin.isTTY) {
        return;
    }

    process.stdin.setEncoding("utf8");
    process.stdin.resume();

    console.log("[LOCAL] Command darurat aktif. Gunakan: !setownerforce <nomor>");

    process.stdin.on("data", (chunk) => {
        const input = String(chunk || "").trim();
        if (!input) {
            return;
        }

        if (!input.toLowerCase().startsWith("!setownerforce")) {
            return;
        }

        const rawNumber = input.slice("!setownerforce".length).trim();
        if (!rawNumber) {
            console.log("[LOCAL] Gunakan: !setownerforce <nomor>");
            return;
        }

        const result = setOwnerForce(rawNumber);
        if (!result.ok) {
            console.log(`[LOCAL] ❌ ${result.message}`);
            return;
        }

        console.log(`[LOCAL] ✅ ${result.message}`);
    });
}

function getOwnerId() {
    const db = loadContentDb();
    return normalizeUserId(db.owner);
}

function getDepositOwnerId() {
    return getOwnerId() || normalizeUserId("6283189121617");
}

function isDepositOwner(senderId) {
    const normalizedSender = normalizeUserId(senderId);
    const ownerId = getOwnerId();
    const fallbackOwner = normalizeUserId("6283189121617");

    if (!normalizedSender) {
        return false;
    }

    if ((ownerId && normalizedSender === ownerId) || (fallbackOwner && normalizedSender === fallbackOwner)) {
        return true;
    }

    const senderNumber = normalizedSender.split("@")[0];
    const ownerNumber = ownerId ? ownerId.split("@")[0] : null;
    const fallbackNumber = fallbackOwner ? fallbackOwner.split("@")[0] : null;

    return Boolean(
        senderNumber
        && ((ownerNumber && senderNumber === ownerNumber) || (fallbackNumber && senderNumber === fallbackNumber))
    );
}

async function isDepositOwnerFromMessage(message, senderId) {
    if (isDepositOwner(senderId)) {
        return true;
    }

    const fallbackNumber = await getSenderNumberFromMessage(message, senderId);
    return isDepositOwner(fallbackNumber);
}

async function getSenderNumberFromMessage(message, senderId) {
    const normalizedSender = normalizeUserId(senderId);
    let senderNumber = normalizedSender ? normalizedSender.split("@")[0] : null;

    try {
        const contact = await message.getContact();
        if (contact && contact.number) {
            return normalizeUserId(contact.number);
        }
    } catch {
        // Abaikan jika gagal baca contact.
    }

    try {
        const chat = await message.getChat();
        if (chat && !chat.isGroup && chat.id && chat.id.user) {
            return normalizeUserId(chat.id.user);
        }

        if (chat && chat.isGroup && Array.isArray(chat.participants)) {
            const participant = chat.participants.find((member) => {
                const memberId = normalizeUserId(member.id && member.id._serialized ? member.id._serialized : null);
                const memberNumber = member.id && member.id.user ? String(member.id.user) : "";

                return memberId === normalizedSender || memberNumber === senderNumber;
            });

            if (participant && participant.id && participant.id.user) {
                return normalizeUserId(participant.id.user);
            }
        }
    } catch {
        // Abaikan error baca chat/participant.
    }

    return senderNumber ? normalizeUserId(senderNumber) : null;
}

async function resolveUserKey(message, senderId) {
    const normalizedSender = normalizeUserId(senderId);
    const numberId = await getSenderNumberFromMessage(message, senderId);

    if (normalizedSender && numberId) {
        const senderNumber = normalizedSender.split("@")[0];
        const numberIdValue = numberId.split("@")[0];
        if (senderNumber === numberIdValue) {
            return numberId;
        }
    }

    return normalizedSender || numberId || null;
}

function isOwnerSender(senderId) {
    const ownerId = getOwnerId();
    if (!ownerId || !senderId) {
        return false;
    }

    return normalizeUserId(senderId) === ownerId;
}

async function isGroupAdmin(message, senderId) {
    try {
        const normalizedSenderId = normalizeUserId(senderId);
        if (!normalizedSenderId) {
            return false;
        }

        const chat = await message.getChat();
        if (!chat.isGroup || !Array.isArray(chat.participants)) {
            return false;
        }

        const senderNumber = normalizedSenderId.split("@")[0];

        const participant = chat.participants.find((member) => {
            const memberId = normalizeUserId(member.id && member.id._serialized ? member.id._serialized : null);
            const memberNumber = member.id && member.id.user ? String(member.id.user) : "";

            return memberId === normalizedSenderId || memberNumber === senderNumber;
        });

        return Boolean(participant && (participant.isAdmin || participant.isSuperAdmin));
    } catch (error) {
        console.log("Gagal deteksi admin grup:", error.message);
        return false;
    }
}

async function getRoleContext(message, senderId) {
    return {
        isOwner: true,
        isAdmin: true,
        isUser: true,
    };
}

function ensureOwnerAccess(roleContext) {
    return true;
}

function ensureAdminAccess(roleContext) {
    return true;
}

function getFileExtensionByMime(mimeType = "") {
    const mimeMap = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "image/gif": "gif",
        "video/mp4": "mp4",
        "video/webm": "webm",
        "audio/mpeg": "mp3",
        "audio/ogg": "ogg",
        "application/pdf": "pdf",
    };

    if (mimeMap[mimeType]) {
        return mimeMap[mimeType];
    }

    const fallback = mimeType.split("/")[1];
    return fallback || "bin";
}

function inferStoredType(mimeType = "") {
    if (mimeType.startsWith("image/")) {
        return "image";
    }

    if (mimeType.startsWith("video/")) {
        return "video";
    }

    if (mimeType.startsWith("audio/")) {
        return "audio";
    }

    return "media";
}

async function buildDataEntryFromMessage(message, contentText) {
    const trimmedText = contentText.trim();
    let mediaPayload = null;
    let mediaCaption = trimmedText;

    if (message.hasMedia) {
        mediaPayload = await message.downloadMedia();
    } else {
        try {
            const quoted = await message.getQuotedMessage();
            if (quoted && quoted.hasMedia) {
                mediaPayload = await quoted.downloadMedia();
                if (!mediaCaption) {
                    mediaCaption = (quoted.body || "").trim();
                }
            }
        } catch {
            // Abaikan jika tidak ada quoted message.
        }
    }

    if (!mediaPayload) {
        if (!trimmedText) {
            throw new Error("Isi data kosong. Kirim teks atau lampirkan media.");
        }

        return {
            type: "text",
            content: trimmedText,
            createdAt: new Date().toISOString(),
        };
    }

    const extension = getFileExtensionByMime(mediaPayload.mimetype || "");
    const fileName = `${Date.now()}-${Math.random().toString(16).slice(2)}.${extension}`;
    const absolutePath = path.join(mediaStorageDir, fileName);

    fs.writeFileSync(absolutePath, Buffer.from(mediaPayload.data, "base64"));

    return {
        type: inferStoredType(mediaPayload.mimetype || ""),
        path: absolutePath,
        mimetype: mediaPayload.mimetype || "application/octet-stream",
        caption: mediaCaption,
        createdAt: new Date().toISOString(),
    };
}

async function sendCategoryEntries(targetChatId, category) {
    const db = loadContentDb();
    const entries = db.data[category] || [];

    if (!entries.length) {
        await client.sendMessage(targetChatId, `Data kategori ${category} masih kosong.`);
        return;
    }

    for (const entry of entries) {
        if (entry.type === "text") {
            await client.sendMessage(targetChatId, entry.content || "(teks kosong)");
            continue;
        }

        if (!entry.path || !fs.existsSync(entry.path)) {
            await client.sendMessage(targetChatId, `Media tidak ditemukan untuk kategori ${category}.`);
            continue;
        }

        try {
            const media = MessageMedia.fromFilePath(entry.path);
            const options = entry.caption ? { caption: entry.caption } : {};
            await client.sendMessage(targetChatId, media, options);
        } catch (error) {
            await client.sendMessage(targetChatId, `Gagal mengirim media kategori ${category}: ${error.message}`);
        }
    }
}

function buildListCategoryMessage(category) {
    const db = loadContentDb();
    const entries = db.data[category] || [];

    if (!entries.length) {
        return `Kategori ${category} masih kosong.`;
    }

    let result = `Daftar data kategori ${category}:\n\n`;

    entries.forEach((entry, index) => {
        if (entry.type === "text") {
            const preview = (entry.content || "").slice(0, 80);
            result += `${index + 1}. [text] ${preview}\n`;
            return;
        }

        const captionPreview = (entry.caption || "(tanpa caption)").slice(0, 80);
        result += `${index + 1}. [${entry.type}] ${captionPreview}\n`;
    });

    return result;
}

function loadSavedContactsDb() {
    try {
        const parsed = JSON.parse(fs.readFileSync(savedContactsFile, "utf8"));

        return {
            updatedAt: parsed && typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
            groups: Array.isArray(parsed && parsed.groups) ? parsed.groups : [],
        };
    } catch {
        return JSON.parse(JSON.stringify(defaultSavedContactsDb));
    }
}

function saveSavedContactsDb(data) {
    fs.writeFileSync(savedContactsFile, JSON.stringify(data, null, 2));
}

function buildSaveGroupSelectionMessage(groups) {
    if (!groups.length) {
        return "Tidak ada grup yang bisa dipilih.";
    }

    let list = "Pilih grup yang ingin disimpan kontak membernya:\n\n";

    groups.forEach((group, index) => {
        list += `${index + 1}. ${group.name}\n`;
        list += `   ID: ${group.id}\n`;
    });

    list += "\nBalas dengan nomor grup, bisa lebih dari satu.\nContoh: 1,2 atau 1 2\nKetik 0 atau batal jika mau membatalkan.";

    return list;
}

function buildSaveNameFormatMessage() {
    return [
        "Pilih format nama kontak yang mau dipakai:",
        "",
        "1. Nama WhatsApp saja",
        "2. Nomor saja",
        "3. Nama - Nomor",
        "4. Nomor - Nama",
        "5. Prefix custom",
        "",
        "Balas dengan angka 1-5.",
    ].join("\n");
}

function buildAddSourceGroupSelectionMessage(groups) {
    if (!groups.length) {
        return "Tidak ada grup yang bisa dipilih.";
    }

    let list = "Pilih grup sumber member (grup 1):\n\n";

    groups.forEach((group, index) => {
        list += `${index + 1}. ${group.name}\n`;
        list += `   ID: ${group.id}\n`;
    });

    list += "\nBalas dengan 1 nomor grup sumber.\nKetik 0 atau batal untuk membatalkan.";

    return list;
}

function buildAddTargetGroupSelectionMessage(groups, sourceNumber) {
    if (!groups.length) {
        return "Tidak ada grup yang bisa dipilih.";
    }

    let list = "Pilih grup tujuan (grup 2):\n\n";

    groups.forEach((group, index) => {
        const marker = index + 1 === sourceNumber ? " (sumber)" : "";
        list += `${index + 1}. ${group.name}${marker}\n`;
        list += `   ID: ${group.id}\n`;
    });

    list += "\nBalas dengan 1 nomor grup tujuan.\nKetik 0 atau batal untuk membatalkan.";

    return list;
}

function formatSavedContactName(contact) {
    const candidates = [
        contact && contact.pushname,
        contact && contact.name,
        contact && contact.shortName,
        contact && contact.verifiedName,
    ];

    for (const candidate of candidates) {
        const text = String(candidate || "").trim();
        if (text) {
            return text;
        }
    }

    return contact && contact.number ? contact.number : "Tidak ada nama";
}

function buildContactDisplayName(contact, nameMode, customPrefix = "") {
    const safeName = formatSavedContactName(contact);
    const safeNumber = contact && contact.number ? String(contact.number).trim() : "";

    switch (nameMode) {
        case "number":
            return safeNumber || safeName;
        case "name_number":
            return safeNumber ? `${safeName} - ${safeNumber}` : safeName;
        case "number_name":
            return safeNumber ? `${safeNumber} - ${safeName}` : safeName;
        case "custom_prefix": {
            const prefix = String(customPrefix || "").trim();
            if (!prefix) {
                return safeName;
            }

            return safeNumber ? `${prefix} ${safeNumber}` : `${prefix} ${safeName}`;
        }
        case "name":
        default:
            return safeName;
    }
}

async function getGroupChatById(groupId) {
    try {
        return await client.getChatById(groupId);
    } catch {
        const cachedGroup = groupDirectory.find((group) => group.id === groupId);
        if (cachedGroup) {
            return {
                isGroup: true,
                id: { _serialized: cachedGroup.id },
                name: cachedGroup.name,
                participants: [],
            };
        }

        const chats = await safeGetChats(3, 2500);
        return chats.find((chat) => chat.isGroup && chat.id && chat.id._serialized === groupId) || null;
    }
}

async function saveGroupContactsToDb(groupId, nameMode = "name", customPrefix = "") {
    const chat = await getGroupChatById(groupId);

    if (!chat || !chat.isGroup) {
        throw new Error("Grup tidak ditemukan.");
    }

    if (!Array.isArray(chat.participants)) {
        throw new Error("Daftar member grup belum bisa dibaca.");
    }

    const botId = client.info && client.info.wid && client.info.wid._serialized
        ? normalizeUserId(client.info.wid._serialized)
        : null;

    const membersById = new Map();

    for (const participant of chat.participants) {
        const participantId = participant && participant.id && participant.id._serialized
            ? normalizeUserId(participant.id._serialized)
            : null;

        if (!participantId || participantId === botId) {
            continue;
        }

        const number = participantId.split("@")[0];
        membersById.set(participantId, {
            id: participantId,
            number,
            name: formatSavedContactName(participant),
            displayName: buildContactDisplayName(participant, nameMode, customPrefix),
            isAdmin: Boolean(participant.isAdmin || participant.isSuperAdmin),
        });
    }

    const members = Array.from(membersById.values()).sort((left, right) => left.name.localeCompare(right.name, "id"));
    const savedAt = new Date().toISOString();

    const db = loadSavedContactsDb();
    const existingIndex = db.groups.findIndex((entry) => entry.groupId === groupId);
    const savedEntry = {
        groupId,
        groupName: chat.name || groupId,
        savedAt,
        memberCount: members.length,
        nameMode,
        customPrefix: String(customPrefix || "").trim() || null,
        members,
    };

    if (existingIndex >= 0) {
        db.groups[existingIndex] = savedEntry;
    } else {
        db.groups.push(savedEntry);
    }

    db.updatedAt = savedAt;
    saveSavedContactsDb(db);

    return savedEntry;
}

async function saveSelectedGroupsToDb(selectedNumbers, nameMode = "name", customPrefix = "") {
    const groups = await loadGroupDirectory();

    if (!groups.length) {
        return { ok: false, message: "Tidak ada grup yang ditemukan." };
    }

    const outOfRange = selectedNumbers.filter((number) => number > groups.length);

    if (outOfRange.length) {
        return {
            ok: false,
            message: `Ada nomor yang tidak tersedia (${outOfRange.join(", ")}). Pilih 1 sampai ${groups.length}.`,
        };
    }

    const savedGroups = [];
    const failedGroups = [];
    const mergedMembers = new Map();

    for (const selectedNumber of selectedNumbers) {
        const selectedGroup = groups[selectedNumber - 1];

        try {
            const savedEntry = await saveGroupContactsToDb(selectedGroup.id, nameMode, customPrefix);
            savedGroups.push(`${selectedNumber}. ${savedEntry.groupName} (${savedEntry.memberCount} kontak)`);

            (savedEntry.members || []).forEach((member) => {
                if (!member || !member.id) {
                    return;
                }

                if (!mergedMembers.has(member.id)) {
                    mergedMembers.set(member.id, member);
                }
            });
        } catch (error) {
            failedGroups.push(`${selectedNumber}. ${selectedGroup.name} (${error.message})`);
        }
    }

    let response = "";

    if (savedGroups.length) {
        response += `Kontak grup berhasil disimpan ke ${savedContactsFile}:\n${savedGroups.join("\n")}`;
    }

    if (failedGroups.length) {
        response += `${response ? "\n\n" : ""}Gagal menyimpan beberapa grup:\n${failedGroups.join("\n")}`;
    }

    if (!response) {
        response = "Tidak ada perubahan data kontak.";
    }

    let exportPath = null;
    let exportedCount = 0;

    if (mergedMembers.size > 0) {
        const exportedMembers = Array.from(mergedMembers.values());
        const vcfContent = buildVcfContentFromMembers(exportedMembers);

        if (vcfContent) {
            const fileName = `contacts-${buildTimestampFileToken()}.vcf`;
            exportPath = path.join(contactExportDir, fileName);
            fs.writeFileSync(exportPath, vcfContent, "utf8");
            exportedCount = exportedMembers.length;
        }
    }

    return { ok: true, message: response, exportPath, exportedCount };
}

async function addMembersFromSourceToTarget(sourceNumber, targetNumber) {
    const groups = await loadGroupDirectory();

    if (!groups.length) {
        return { ok: false, message: "Tidak ada grup yang ditemukan." };
    }

    if (sourceNumber < 1 || sourceNumber > groups.length || targetNumber < 1 || targetNumber > groups.length) {
        return {
            ok: false,
            message: `Nomor grup tidak valid. Pilih 1 sampai ${groups.length}.`,
        };
    }

    if (sourceNumber === targetNumber) {
        return { ok: false, message: "Grup sumber dan tujuan tidak boleh sama." };
    }

    const sourceGroup = groups[sourceNumber - 1];
    const targetGroup = groups[targetNumber - 1];

    const sourceChat = await getGroupChatById(sourceGroup.id);
    const targetChat = await getGroupChatById(targetGroup.id);

    if (!sourceChat || !sourceChat.isGroup || !Array.isArray(sourceChat.participants)) {
        return { ok: false, message: `Member grup sumber (${sourceGroup.name}) belum bisa dibaca.` };
    }

    if (!targetChat || !targetChat.isGroup || !Array.isArray(targetChat.participants)) {
        return { ok: false, message: `Member grup tujuan (${targetGroup.name}) belum bisa dibaca.` };
    }

    const botId = client.info && client.info.wid && client.info.wid._serialized
        ? normalizeUserId(client.info.wid._serialized)
        : null;

    if (botId) {
        const botParticipant = targetChat.participants.find((participant) => {
            const participantId = participant && participant.id && participant.id._serialized
                ? normalizeUserId(participant.id._serialized)
                : null;
            return participantId === botId;
        });

        if (!botParticipant || (!botParticipant.isAdmin && !botParticipant.isSuperAdmin)) {
            return {
                ok: false,
                message: `Bot harus jadi admin dulu di grup tujuan (${targetGroup.name}).`,
            };
        }
    }

    const existingTargetMembers = new Set();

    for (const participant of targetChat.participants) {
        const participantId = participant && participant.id && participant.id._serialized
            ? normalizeUserId(participant.id._serialized)
            : null;

        if (participantId) {
            existingTargetMembers.add(participantId);
        }
    }

    const candidates = [];

    for (const participant of sourceChat.participants) {
        const participantId = participant && participant.id && participant.id._serialized
            ? normalizeUserId(participant.id._serialized)
            : null;

        if (!participantId || participantId === botId || existingTargetMembers.has(participantId)) {
            continue;
        }

        if (!candidates.includes(participantId)) {
            candidates.push(participantId);
        }
    }

    if (!candidates.length) {
        return {
            ok: true,
            message: `Tidak ada member baru dari ${sourceGroup.name} yang perlu ditambahkan ke ${targetGroup.name}.`,
        };
    }

    let addedCount = 0;
    const failedMembers = [];

    for (const memberId of candidates) {
        try {
            await targetChat.addParticipants([memberId]);
            addedCount += 1;
        } catch (error) {
            failedMembers.push({
                memberId,
                reason: error && error.message ? error.message : "gagal ditambahkan",
            });
        }

        await sleep(400);
    }

    let resultMessage = [
        `Selesai proses add member:`,
        `Sumber: ${sourceGroup.name}`,
        `Tujuan: ${targetGroup.name}`,
        `Berhasil ditambahkan: ${addedCount}`,
        `Gagal: ${failedMembers.length}`,
    ].join("\n");

    if (failedMembers.length) {
        const failedPreview = failedMembers
            .slice(0, 10)
            .map((item, index) => `${index + 1}. ${item.memberId.split("@")[0]} (${item.reason})`)
            .join("\n");
        const moreText = failedMembers.length > 10 ? `\n...dan ${failedMembers.length - 10} lainnya` : "";
        resultMessage += `\n\nDetail gagal (maks 10):\n${failedPreview}${moreText}`;
    }

    return { ok: true, message: resultMessage };
}

function parseSaveNameMode(input) {
    const normalized = String(input || "").trim().toLowerCase();

    if (normalized === "1") {
        return { ok: true, nameMode: "name", requiresCustomPrefix: false };
    }

    if (normalized === "2") {
        return { ok: true, nameMode: "number", requiresCustomPrefix: false };
    }

    if (normalized === "3") {
        return { ok: true, nameMode: "name_number", requiresCustomPrefix: false };
    }

    if (normalized === "4") {
        return { ok: true, nameMode: "number_name", requiresCustomPrefix: false };
    }

    if (normalized === "5") {
        return { ok: true, nameMode: "custom_prefix", requiresCustomPrefix: true };
    }

    return { ok: false, message: "Pilihan tidak valid. Balas dengan angka 1-5." };
}

function getSaveNameModeLabel(nameMode) {
    const map = {
        name: "Nama WhatsApp saja",
        number: "Nomor saja",
        name_number: "Nama - Nomor",
        number_name: "Nomor - Nama",
        custom_prefix: "Prefix custom",
    };

    return map[nameMode] || "Nama WhatsApp saja";
}

function sanitizeVcfText(value) {
    return String(value || "")
        .replace(/\\/g, "\\\\")
        .replace(/;/g, "\\;")
        .replace(/,/g, "\\,")
        .replace(/\n/g, " ")
        .trim();
}

function buildVcfContentFromMembers(members, labelPrefix = "WWEBJS") {
    const lines = [];

    members.forEach((member, index) => {
        const number = String(member && member.number ? member.number : "").replace(/\D/g, "");
        if (!number) {
            return;
        }

        const baseName = member && member.displayName
            ? String(member.displayName)
            : (member && member.name ? String(member.name) : number);
        const finalName = sanitizeVcfText(baseName) || `${labelPrefix} ${index + 1}`;

        lines.push("BEGIN:VCARD");
        lines.push("VERSION:3.0");
        lines.push(`N:;${finalName};;;`);
        lines.push(`FN:${finalName}`);
        lines.push(`TEL;TYPE=CELL:+${number}`);
        lines.push("END:VCARD");
    });

    return lines.join("\n");
}

function buildTimestampFileToken() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const hh = String(now.getHours()).padStart(2, "0");
    const min = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");

    return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

function isLikelyTiktokUrl(url) {
    const text = String(url || "").trim().toLowerCase();
    if (!text) {
        return false;
    }

    return text.includes("tiktok.com") || text.includes("vt.tiktok.com");
}

function isLikelyInstagramUrl(url) {
    const text = String(url || "").trim().toLowerCase();
    if (!text) {
        return false;
    }

    return text.includes("instagram.com");
}

function getFileExtensionFromUrl(rawUrl, fallbackExt) {
    try {
        const parsed = new URL(rawUrl);
        const ext = path.extname(parsed.pathname || "").replace(".", "");
        if (ext) {
            return ext;
        }
    } catch {
        // Abaikan error URL.
    }

    return fallbackExt || "bin";
}

function pickTiktokVideoUrl(payload) {
    if (!payload || typeof payload !== "object") {
        return null;
    }

    const candidates = [];

    if (payload.video) {
        candidates.push(payload.video);
    }

    if (payload.result && typeof payload.result === "object") {
        candidates.push(payload.result.video);
        candidates.push(payload.result.video1);
        candidates.push(payload.result.video2);
        if (payload.result.play) {
            candidates.push(payload.result.play);
        }
        if (payload.result.wmplay) {
            candidates.push(payload.result.wmplay);
        }
    }

    if (payload.data && typeof payload.data === "object") {
        candidates.push(payload.data.video);
        if (payload.data.play) {
            candidates.push(payload.data.play);
        }
    }

    for (const item of candidates) {
        if (typeof item === "string" && item.startsWith("http")) {
            return item;
        }

        if (item && typeof item === "object") {
            const direct = item.noWatermark || item.no_watermark || item.nowm || item.download || item.url;
            if (typeof direct === "string" && direct.startsWith("http")) {
                return direct;
            }

            if (Array.isArray(item.url)) {
                const firstUrl = item.url.find((entry) => typeof entry === "string" && entry.startsWith("http"));
                if (firstUrl) {
                    return firstUrl;
                }
            }
        }
    }

    return null;
}

function downloadFile(url, filePath) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const client = parsed.protocol === "http:" ? http : https;

        const request = client.get(parsed, (response) => {
            if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                downloadFile(response.headers.location, filePath).then(resolve).catch(reject);
                return;
            }

            if (response.statusCode && response.statusCode >= 400) {
                response.resume();
                reject(new Error(`Gagal download media. Status ${response.statusCode}`));
                return;
            }

            const fileStream = fs.createWriteStream(filePath);
            response.pipe(fileStream);
            fileStream.on("finish", () => {
                fileStream.close(resolve);
            });
            fileStream.on("error", (error) => {
                fs.unlink(filePath, () => reject(error));
            });
        });

        request.on("error", reject);
    });
}

function safeDeleteFile(filePath) {
    try {
        if (filePath && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch {
        // Abaikan error hapus file sementara.
    }
}

let cachedInstagramGetter = null;

async function getInstagramGetter() {
    if (cachedInstagramGetter) {
        return cachedInstagramGetter;
    }

    const module = await import("instagram-url-direct");
    cachedInstagramGetter = module.instagramGetUrl;
    return cachedInstagramGetter;
}

async function handleTiktokDownload(message, url) {
    if (!isLikelyTiktokUrl(url)) {
        await message.reply("Gunakan format: !tiktok <url tiktok>");
        return;
    }

    const sanitizedUrl = String(url || "").trim();
    if (!sanitizedUrl) {
        await message.reply("URL TikTok tidak valid.");
        return;
    }

    await message.reply("Sedang ambil video TikTok... tunggu ya.");

    let result;
    try {
        result = await Tiktok.Downloader(sanitizedUrl, {
            version: "v1",
            showOriginalResponse: false,
        });
    } catch (error) {
        await message.reply(`Gagal memproses TikTok: ${error.message}`);
        return;
    }

    const mediaUrl = pickTiktokVideoUrl(result) || pickTiktokVideoUrl(result && result.result ? result.result : null);
    if (!mediaUrl) {
        await message.reply("Tidak menemukan URL video dari TikTok. Coba link lain atau ulangi.");
        return;
    }

    const fileName = `tiktok-${buildTimestampFileToken()}-${Math.random().toString(16).slice(2)}.mp4`;
    const outputPath = path.join(tiktokMediaDir, fileName);

    try {
        await downloadFile(mediaUrl, outputPath);
        const media = MessageMedia.fromFilePath(outputPath);
        await client.sendMessage(message.from, media, {
            caption: "✅ TikTok download selesai",
            sendMediaAsDocument: true,
        });
    } catch (error) {
        await message.reply(`Gagal download video: ${error.message}`);
    } finally {
        safeDeleteFile(outputPath);
    }
}

async function handleInstagramDownload(message, url) {
    if (!isLikelyInstagramUrl(url)) {
        await message.reply("Gunakan format: !instagram <url instagram>");
        return;
    }

    const sanitizedUrl = String(url || "").trim();
    if (!sanitizedUrl) {
        await message.reply("URL Instagram tidak valid.");
        return;
    }

    await message.reply("Sedang ambil media Instagram... tunggu ya.");

    let instagramGetUrl;
    try {
        instagramGetUrl = await getInstagramGetter();
    } catch (error) {
        await message.reply(`Gagal memuat modul Instagram: ${error.message}`);
        return;
    }

    let result;
    try {
        result = await instagramGetUrl(sanitizedUrl);
    } catch (error) {
        await message.reply(`Gagal memproses Instagram: ${error.message}`);
        return;
    }

    const urlList = Array.isArray(result && result.url_list) ? result.url_list : [];
    const mediaDetails = Array.isArray(result && result.media_details) ? result.media_details : [];
    const candidates = urlList.length ? urlList : mediaDetails.map((item) => item && item.url).filter(Boolean);

    if (!candidates.length) {
        await message.reply("Tidak menemukan media Instagram. Pastikan link post/reel valid.");
        return;
    }

    let sentCount = 0;

    for (const [index, mediaUrl] of candidates.entries()) {
        if (!mediaUrl || typeof mediaUrl !== "string") {
            continue;
        }

        const detail = mediaDetails[index] || null;
        const fallbackExt = detail && detail.type === "video" ? "mp4" : "jpg";
        const extension = getFileExtensionFromUrl(mediaUrl, fallbackExt);
        const fileName = `instagram-${buildTimestampFileToken()}-${index + 1}-${Math.random().toString(16).slice(2)}.${extension}`;
        const outputPath = path.join(instagramMediaDir, fileName);

        try {
            await downloadFile(mediaUrl, outputPath);
            const media = MessageMedia.fromFilePath(outputPath);
            await client.sendMessage(message.from, media, {
                caption: `✅ Instagram download ${index + 1}/${candidates.length}`,
                sendMediaAsDocument: true,
            });
            sentCount += 1;
        } catch (error) {
            await message.reply(`Gagal download media Instagram: ${error.message}`);
        } finally {
            safeDeleteFile(outputPath);
        }
    }

    if (sentCount === 0) {
        await message.reply("Tidak ada media Instagram yang berhasil dikirim.");
    }
}

// ================= STICKER FUNCTIONS =================

async function createImageSticker(imageBuffer) {
    try {
        // Resize image to 512x512 max
        const resizedBuffer = await sharp(imageBuffer)
            .resize(512, 512, {
                fit: 'inside',
                withoutEnlargement: true
            })
            .png()
            .toBuffer();

        return resizedBuffer;
    } catch (error) {
        console.log("Error processing image:", error);
        return null;
    }
}

async function createTextSticker(text, options = {}) {
    const width = 512;
    const height = 512;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Background
    const bgColors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8'];
    const bgColor = options.bgColor || bgColors[Math.floor(Math.random() * bgColors.length)];

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, width, height);

    // Text settings
    const fontSize = Math.min(width / text.length * 2, 120);
    ctx.font = `bold ${fontSize}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Text color
    const textColors = ['#FFFFFF', '#000000', '#FFD700', '#FF69B4', '#00FF00', '#FF4500'];
    ctx.fillStyle = options.textColor || textColors[Math.floor(Math.random() * textColors.length)];

    // Add text with shadow
    ctx.shadowColor = 'rgba(0,0,0,0.3)';
    ctx.shadowBlur = 10;
    ctx.fillText(text, width/2, height/2);

    return canvas.toBuffer('image/png');
}

async function loadGroupDirectory() {
    if (!isWhatsAppReady && !groupDirectory.length) {
        return [];
    }

    const chats = await safeGetChats(3, 2500);

    const nextGroups = chats
        .filter((chat) => chat.isGroup)
        .map((chat) => ({
            id: chat.id._serialized,
            name: chat.name,
        }));

    if (nextGroups.length) {
        const merged = new Map();
        groupDirectory.forEach((group) => {
            if (group && group.id) {
                merged.set(group.id, group);
            }
        });
        nextGroups.forEach((group) => {
            if (group && group.id) {
                merged.set(group.id, group);
            }
        });

        groupDirectory = Array.from(merged.values());
        saveGroupCache(groupDirectory);
    }

    return groupDirectory;
}

function buildGroupListMessage(groups) {
    if (!groups.length) {
        return "Tidak ada grup yang bisa ditampilkan.";
    }

    let list = "Daftar grup:\n\n";

    groups.forEach((group, index) => {
        const isBlocked = blockedGroups.includes(group.id);
        list += `${index + 1}. ${group.name}${isBlocked ? " (dilarang)" : ""}\n`;
        list += `   ID: ${group.id}\n`;
    });

    list += "\nGunakan: !larang <nomor> atau !larang <nomor1,nomor2>\nContoh: !larang 1 atau !larang 1,2";

    return list;
}

function parseGroupNumberSelection(rawInput) {
    const tokens = rawInput
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

    if (!tokens.length) {
        return { isValid: false, numbers: [], reason: "empty" };
    }

    const numbers = [];

    for (const token of tokens) {
        const parsed = Number(token);
        if (!Number.isInteger(parsed) || parsed < 1) {
            return { isValid: false, numbers: [], reason: "invalid_number" };
        }

        if (!numbers.includes(parsed)) {
            numbers.push(parsed);
        }
    }

    return { isValid: true, numbers, reason: null };
}

function buildShareBlockSelectionMessage(groups) {
    if (!groups.length) {
        return "Tidak ada grup yang bisa dipilih.";
    }

    let list = "Pilih grup yang ingin dilarang untuk sesi broadcast ini:\n\n";

    groups.forEach((group, index) => {
        list += `${index + 1}. ${group.name}\n`;
        list += `   ID: ${group.id}\n`;
    });

    list += "\nBalas dengan nomor grup, bisa lebih dari satu.\nContoh: 1,2 atau 1 2\nKetik 0 atau skip jika tidak ada yang dilarang.";

    return list;
}

async function sendBroadcastMessageWithRetry(group, messageText, maxRetry = 3) {
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetry; attempt += 1) {
        try {
            await client.sendMessage(group.id, messageText);
            return { ok: true };
        } catch (error) {
            lastError = error;
            const msg = error && error.message ? error.message : String(error);
            console.log(`Gagal kirim ke ${group.name} (percobaan ${attempt}/${maxRetry}): ${msg}`);
            await sleep(800 * attempt);
        }
    }

    return { ok: false, error: lastError };
}

async function sendBroadcastOnce() {
    if (broadcastState.isSending) {
        console.log("Skip broadcast tick karena pengiriman sebelumnya masih berjalan");
        return { sentCount: 0, failedCount: 0, skippedCount: 0 };
    }

    broadcastState.isSending = true;

    try {
        const sourceGroups = broadcastState.targetGroups.length
            ? broadcastState.targetGroups
            : await loadGroupDirectory();
        const targetGroups = sourceGroups.filter(
            (group) => !blockedGroups.includes(group.id) && !broadcastState.sessionBlockedGroupIds.includes(group.id)
        );

        let sentCount = 0;
        let failedCount = 0;
        let skippedCount = sourceGroups.length - targetGroups.length;

        if (!targetGroups.length) {
            console.log("Tidak ada target grup aktif untuk broadcast");
            return { sentCount, failedCount, skippedCount };
        }

        for (let index = 0; index < targetGroups.length; index += 1) {
            const group = targetGroups[index];
            const result = await sendBroadcastMessageWithRetry(group, broadcastState.message, 3);

            if (result && result.ok) {
                sentCount += 1;
                console.log("Terkirim ke:", group.name);
            } else {
                failedCount += 1;
                const error = result && result.error ? result.error : null;
                const msg = error && error.message ? error.message : String(error || "unknown error");
                console.log("Gagal kirim ke:", group.name, msg);
            }

            if (index + 1 < targetGroups.length && broadcastBatchDelayMs > 0) {
                await sleep(broadcastBatchDelayMs);
            }
        }

        return { sentCount, failedCount, skippedCount };
    } finally {
        broadcastState.isSending = false;
    }
}

async function startBroadcast(hours, messageText, starterChatId, sessionBlockedGroupIds = []) {
    if (broadcastState.intervalId) {
        throw new Error("Broadcast sudah berjalan. Gunakan !stop dulu.");
    }

    const groups = await loadGroupDirectory();
    if (!groups.length) {
        throw new Error("Tidak ada grup yang ditemukan untuk broadcast.");
    }

    broadcastState.intervalHours = hours;
    broadcastState.message = messageText;
    broadcastState.starterChatId = starterChatId;
    broadcastState.targetGroups = groups;
    broadcastState.sessionBlockedGroupIds = [...new Set(sessionBlockedGroupIds)];

    // Jalankan pengiriman pertama di background agar bot cepat membalas command.
    sendBroadcastOnce()
        .then(async (result) => {
            if (!broadcastState.starterChatId) {
                return;
            }

            await client.sendMessage(
                broadcastState.starterChatId,
                `Putaran pertama selesai.\nTerkirim: ${result.sentCount}\nGagal: ${result.failedCount}\nDilewati (larang): ${result.skippedCount}`
            );
        })
        .catch((error) => {
        console.log("Error saat pengiriman awal broadcast:", error.message);
    });

    broadcastState.intervalId = setInterval(async () => {
        try {
            const result = await sendBroadcastOnce();

            if (broadcastState.starterChatId) {
                await client.sendMessage(
                    broadcastState.starterChatId,
                    `Broadcast putaran baru selesai.\nTerkirim: ${result.sentCount}\nGagal: ${result.failedCount}\nDilewati (larang): ${result.skippedCount}`
                );
            }
        } catch (error) {
            console.log("Error saat interval broadcast:", error.message);
        }
    }, hours * 3600000);
}

function stopBroadcast() {
    if (!broadcastState.intervalId) {
        return false;
    }

    clearInterval(broadcastState.intervalId);
    broadcastState.intervalId = null;
    broadcastState.intervalHours = 0;
    broadcastState.message = "";
    broadcastState.starterChatId = null;
    broadcastState.targetGroups = [];
    broadcastState.sessionBlockedGroupIds = [];

    return true;
}

function buildMenuByRole() {
    return [
        "╭━━━〔 🤖 BOT MENU 〕━━━╮",
        "┃",
        "┃ 📌 GENERAL",
        "┃ ├ !menu     → Menampilkan semua daftar menu bot",
        "┃ ├ !help     → Bantuan penggunaan bot",
        "┃ ├ !ping     → Cek kecepatan / status bot",
        "┃ ├ !info     → Informasi tentang bot",
        "┃ ├ !owner    → Kontak owner / admin bot",
        "┃",
        "┃ 💳 PAYMENT & SHARE",
        "┃ ├ !pay      → Informasi pembayaran",
        "┃ ├ !deposit  → Buat transaksi deposit",
        "┃ ├ !share    → Membagikan sesuatu ke user lain",
        "┃ ├ !shares   → Melihat daftar share",
        "┃ ├ !save     → Menyimpan data / pesan",
        "┃",
        "┃ 👤 USER & ID",
        "┃ ├ !id       → Melihat ID grup / chat",
        "┃ ├ !myid     → Melihat ID akun sendiri",
        "┃ ├ !userid   → Melihat ID user tertentu",
        "┃",
        "┃ 👥 GROUP MANAGEMENT",
        "┃ ├ !add      → Menambahkan member ke grup",
        "┃ ├ !kick     → Mengeluarkan member dari grup",
        "┃ ├ !tagall   → Mention semua anggota grup",
        "┃ ├ !larang   → Mengatur larangan di grup",
        "┃ ├ !stop     → Menghentikan fitur tertentu",
        "┃",
        "┃ 📂 DATA & STORAGE",
        "┃ ├ !data     → Menampilkan data tertentu",
        "┃ ├ !datas    → Menampilkan semua data",
        "┃ ├ !del      → Menghapus data / pesan",
        "┃",
        "┃ 🎨 TOOLS & FUN",
        "┃ ├ !sticker  → Mengubah gambar jadi sticker",
        "┃ ├ !rangkum  → Merangkum teks otomatis",
        "┃ ├ !tugas    → Membantu tugas / catatan",
        "┃ ├ !tiktok   → Download video TikTok",
        "┃ ├ !instagram → Download media Instagram",
        "┃ ├ !gb       → Fitur tambahan bot",
        "┃ ├ *!shop     → Menampilkan menu shop*",
        "┃ └ !list     → Menampilkan daftar tertentu",
        "┃",
        "╰━━━━━━━━━━━━━━━━━━━━━━╯",
    ].join("\n");
}

function buildShopMenu() {
    return [
        "╭━━━〔 🛒 SHOP MENU 〕━━━╮",
        "┃",
        "┃ 📦 PRODUK & LAYANAN",
        "┃ ├ !deposit    → Isi saldo / deposit",
        "┃ ├ !nokos      → Membeli nomor kosong",
        "┃ ├ !server     → Membeli server / panel",
        "┃ ├ !web        → Jasa pembuatan website",
        "┃ ├ !hosting    → Jasa hosting website",
        "┃ ├ !tugas      → Jasa bantuan tugas",
        "┃",
        "┃ 💡 INFORMASI",
        "┃ ├ Ketik salah satu menu",
        "┃ ├ untuk melihat detail",
        "┃ ├ harga dan cara order.",
        "┃",
        "╰━━━━━━━━━━━━━━━━━━━━━━╯",
    ].join("\n");
}

function buildNokosMenu() {
    return [
        "╭━━━〔 📱 NOKOS MENU 〕━━━╮",
        "┃",
        "┃ 📦 PILIHAN NOKOS",
        "┃ ├ !server1 → High Stock",
        "┃ ├ !server2 → Tele Luar Negeri",
        "┃ ├ !server3 → Full Text",
        "┃ ├ !server4 → WA Luar Negeri",
        "┃",
        "┃ 💡 Ketik salah satu server",
        "┃ 💡 untuk melihat detail & harga",
        "┃",
        "╰━━━━━━━━━━━━━━━━━━━━━━╯",
    ].join("\n");
}

function buildServer1Menu() {
    return [
        "╭━━━〔 🟢 SERVER1 - HIGH STOCK 〕━━━╮",
        "┃",
        "┃ 📦 PILIHAN APLIKASI",
        "┃ ├ !whatsapp   → Nokos WhatsApp",
        "┃ ├ !telegram   → Nokos Telegram",
        "┃ ├ !shopee     → Nokos Shopee",
        "┃ ├ !tiktoknokos → Nokos TikTok",
        "┃ ├ !facebook   → Nokos Facebook",
        "┃ ├ !instagram  → Nokos Instagram",
        "┃ ├ !google     → Nokos Google/Gmail/Youtube",
        "┃ ├ !vercel     → Nokos Vercel",
        "┃ ├ !uangme     → Nokos UangMe",
        "┃ ├ !dana       → Nokos DANA",
        "┃ ├ !gojek      → Nokos Gojek",
        "┃ ├ !ovo        → Nokos OVO",
        "┃ ├ !kopi       → Nokos Kopi Kenangan",
        "┃ ├ !tokopedia  → Nokos Tokopedia",
        "┃ ├ !lazada     → Nokos Lazada",
        "┃ └ !discord    → Nokos Discord",
        "┃",
        "┃ 💡 Ketik salah satu aplikasi",
        "┃ 💡 untuk melihat harga & stok",
        "┃",
        "╰━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
    ].join("\n");
}

const serverPacketCatalog = {
    packet1: {
        label: "PACKAGE S",
        spec: "2GB RAM / 1 CPU / 10GB",
        prices: {
            oneDay: { label: "Rp2.500", amount: 2500 },
            sevenDays: { label: "Rp4.000", amount: 4000 },
            thirtyDays: { label: "Rp12.000", amount: 12000 },
        },
    },
    packet2: {
        label: "PACKAGE M",
        spec: "4GB RAM / 2 CPU / 25GB",
        prices: {
            oneDay: { label: "Rp3.500", amount: 3500 },
            sevenDays: { label: "Rp9.000", amount: 9000 },
            thirtyDays: { label: "Rp22.000", amount: 22000 },
        },
    },
    packet3: {
        label: "PACKAGE L",
        spec: "6GB RAM / 3 CPU / 40GB",
        prices: {
            oneDay: { label: "Rp4.500", amount: 4500 },
            sevenDays: { label: "Rp12.000", amount: 12000 },
            thirtyDays: { label: "Rp32.000", amount: 32000 },
        },
    },
    packet4: {
        label: "PACKAGE XL",
        spec: "8GB RAM / 4 CPU / 60GB",
        prices: {
            oneDay: { label: "Rp6.000", amount: 6000 },
            sevenDays: { label: "Rp17.000", amount: 17000 },
            thirtyDays: { label: "Rp47.000", amount: 47000 },
        },
    },
};

function buildServerMenu() {
    return [
        "╭━━━〔 💾 SERVER MENU 〕━━━╮",
        "┃",
        "┃ 📦 PILIHAN PAKET",
        "┃ ├ !packet1 → PACKAGE S",
        "┃ ├ !packet2 → PACKAGE M",
        "┃ ├ !packet3 → PACKAGE L",
        "┃ └ !packet4 → PACKAGE XL",
        "┃",
        "┃ 💡 Ketik salah satu paket",
        "┃ 💡 untuk lihat harga & order",
        "┃",
        "╰━━━━━━━━━━━━━━━━━━━━━━╯",
    ].join("\n");
}

function buildServerPacketMenu(packetKey) {
    const packet = serverPacketCatalog[packetKey];
    if (!packet) {
        return "Paket tidak ditemukan. Coba !server untuk lihat daftar paket.";
    }

    return [
        `╭━━━〔 ${packet.label} 〕━━━╮`,
        "┃ 📦 Spesifikasi",
        `┃ (${packet.spec})`,
        "┃",
        "┃ 💰 Harga",
        `┃ 1H  : ${packet.prices.oneDay.label}`,
        `┃ 7H  : ${packet.prices.sevenDays.label}`,
        `┃ 30H : ${packet.prices.thirtyDays.label}`,
        "┃",
        "┃ 💡 Order:",
        `┃ !buyserver ${packetKey}`,
        "╰━━━━━━━━━━━━━━━━━━╯",
    ].join("\n");
}

function parseBuyServerCommand(text) {
    const normalized = String(text || "").trim().toLowerCase();
    if (!normalized.startsWith("!buyserver")) {
        return { ok: false, reason: "not_buyserver" };
    }

    const argsText = normalized.replace(/^!buyserver\s*/i, "").trim();
    if (!argsText) {
        return { ok: false, reason: "missing_packet" };
    }

    const tokens = argsText.split(/\s+/).filter(Boolean);
    const packetKey = tokens[0].replace(/[^a-z0-9]/g, "");
    const durationToken = tokens[1] || "";

    if (!serverPacketCatalog[packetKey]) {
        return { ok: false, reason: "invalid_packet" };
    }

    if (!durationToken) {
        return { ok: true, packetKey, duration: "30h" };
    }

    const durationMatch = durationToken.match(/^(1|7|30)h?$/i);
    if (!durationMatch) {
        return { ok: false, reason: "invalid_duration" };
    }

    return { ok: true, packetKey, duration: `${durationMatch[1]}h` };
}

function resolveServerPacketPrice(packetKey, duration) {
    const packet = serverPacketCatalog[packetKey];
    if (!packet) {
        return null;
    }

    if (duration === "1h") {
        return packet.prices.oneDay;
    }

    if (duration === "7h") {
        return packet.prices.sevenDays;
    }

    return packet.prices.thirtyDays;
}

function buildNokosAppPriceMenu(appLabel, orderCommand) {
    const safeLabel = String(appLabel || "").toUpperCase();
    const safeOrder = String(orderCommand || "").trim() || "!buy";

    return [
        `╭━━━〔 📱 NOKOS ${safeLabel} 〕━━━╮`,
        "┃",
        "┃ 💳 LIST HARGA",
        "┃",
        "┃ ├ Rp 6.000  (Stok: Unlimited)",
        "┃ ├ Rp 7.000  (Stok: Unlimited)",
        "┃ ├ Rp 8.000  (Stok: Unlimited)",
        "┃ ├ Rp 9.000  (Stok: Unlimited)",
        "┃ ├ Rp 10.000 (Stok: Unlimited)",
        "┃ ├ Rp 12.000 (Stok: Unlimited)",
        "┃ ├ Rp 15.000 (Stok: Unlimited)",
        "┃ └ Rp 20.000 (Stok: Unlimited)",
        "┃",
        "┃ 💡 Ketik format order:",
        `┃ 💡 ${safeOrder} jumlah`,
        "┃",
        "╰━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
    ].join("\n");
}

const nokosAppCatalog = {
    whatsapp: { label: "Nokos WhatsApp", buyCommand: "!buywhatsapp" },
    telegram: { label: "Nokos Telegram", buyCommand: "!buytelegram" },
    shopee: { label: "Nokos Shopee", buyCommand: "!buyshopee" },
    tiktok: { label: "Nokos TikTok", buyCommand: "!buytiktok" },
    facebook: { label: "Nokos Facebook", buyCommand: "!buyfacebook" },
    instagram: { label: "Nokos Instagram", buyCommand: "!buyinstagram" },
    google: { label: "Nokos Google", buyCommand: "!buygoogle" },
    vercel: { label: "Nokos Vercel", buyCommand: "!buyvercel" },
    uangme: { label: "Nokos UangMe", buyCommand: "!buyuangme" },
    dana: { label: "Nokos DANA", buyCommand: "!buydana" },
    gojek: { label: "Nokos Gojek", buyCommand: "!buygojek" },
    ovo: { label: "Nokos OVO", buyCommand: "!buyovo" },
    kopi: { label: "Nokos Kopi Kenangan", buyCommand: "!buykopi" },
    tokopedia: { label: "Nokos Tokopedia", buyCommand: "!buytokopedia" },
    lazada: { label: "Nokos Lazada", buyCommand: "!buylazada" },
    discord: { label: "Nokos Discord", buyCommand: "!buydiscord" },
};

const nokosPaketPrices = [6000, 7000, 8000, 9000, 10000, 12000, 15000, 20000];

function normalizeNokosBuyInput(text) {
    return String(text || "").trim().toLowerCase();
}

function parseNokosBuyCommand(text) {
    const normalized = normalizeNokosBuyInput(text);

    if (!normalized.startsWith("!buy")) {
        return { ok: false, reason: "not_buy" };
    }

    const body = normalized.replace(/^!buy/, "").trim();
    if (!body) {
        return { ok: false, reason: "missing_app" };
    }

    const tokens = body.split(/\s+/).filter(Boolean);
    if (tokens.length < 2) {
        return { ok: false, reason: "missing_args" };
    }

    const appKey = tokens[0].replace(/[^a-z0-9]/g, "");
    const paketToken = tokens[1];
    const qtyToken = tokens[2] || "";

    const paketMatch = paketToken.match(/^paket\s*(\d+)$/i) || paketToken.match(/^(\d+)$/);
    const paketNumber = paketMatch ? Number(paketMatch[1]) : NaN;
    const qtyNumber = Number(String(qtyToken).replace(/[^0-9]/g, ""));

    if (!appKey || !Number.isInteger(paketNumber) || paketNumber < 1 || paketNumber > nokosPaketPrices.length) {
        return { ok: false, reason: "invalid_paket" };
    }

    if (!Number.isInteger(qtyNumber) || qtyNumber < 1) {
        return { ok: false, reason: "invalid_qty" };
    }

    return { ok: true, appKey, paketNumber, qtyNumber };
}

function buildNokosBuyReply(appKey, paketNumber, qtyNumber, remainingBalance) {
    const appInfo = nokosAppCatalog[appKey];
    const unitPrice = nokosPaketPrices[paketNumber - 1];
    const total = unitPrice * qtyNumber;

    const balanceText = Number.isFinite(remainingBalance)
        ? `\n💳 Sisa saldo: ${formatRupiah(remainingBalance)}`
        : "";

    return [
        "✅ *Pesanan diterima*",
        `📦 Produk: ${appInfo.label}`,
        `📄 Paket: ${paketNumber}`,
        `📦 Jumlah: ${qtyNumber}`,
        `💰 Total: ${formatRupiah(total)}${balanceText}`,
        "",
        "Saldo otomatis terpotong sesuai total.",
        "Admin akan memproses order kamu.",
    ].join("\n");
}

function denyAccessMessage() {
    return "❌ Kamu tidak memiliki akses ke fitur ini";
}

function formatRupiah(amount) {
    const numeric = Number(amount) || 0;
    return `Rp ${numeric.toLocaleString("id-ID")}`;
}

function parseDepositAmount(rawInput) {
    const text = String(rawInput || "").trim();
    if (!text) {
        return { ok: false, message: "Gunakan: !deposit <nominal>" };
    }

    const numericText = text.replace(/[^0-9]/g, "");
    const amount = Number(numericText);

    if (!Number.isInteger(amount) || amount <= 0) {
        return { ok: false, message: "Nominal deposit tidak valid." };
    }

    return { ok: true, amount };
}

function generateDepositId(existingIds) {
    for (let attempt = 0; attempt < 25; attempt += 1) {
        const random = Math.floor(1000 + Math.random() * 9000);
        const id = `DEP${random}`;
        if (!existingIds.has(id)) {
            return id;
        }
    }

    return `DEP${Date.now()}`;
}

function getDepositById(db, id) {
    const normalized = String(id || "").trim().toUpperCase();
    if (!normalized) {
        return null;
    }

    return db.transactions.find((tx) => String(tx.id || "").toUpperCase() === normalized) || null;
}

function getPendingDepositForUser(db, senderId, userKey) {
    return db.transactions.find((tx) => {
        if (tx.status !== "pending") {
            return false;
        }

        return tx.userId === senderId
            || tx.userNumberId === senderId
            || (userKey && (tx.userId === userKey || tx.userNumberId === userKey));
    }) || null;
}

// ================= COMMAND =================

const commands = {

    "!ping": async (message) => {
        const contact = await safeGetContact(message);
        const name = contact && (contact.pushname || contact.number) ? (contact.pushname || contact.number) : "User";
        message.reply(`${name} Bot aktif dan berjalan 😎`);
    },

    "!menu": async (message) => {
        message.reply(buildMenuByRole());
    },

    "!help": async (message) => {
        message.reply(buildMenuByRole());
    },

    "!shop": async (message) => {
        message.reply(buildShopMenu());
    },

    "!server": async (message) => {
        message.reply(buildServerMenu());
    },

    "!nokos": async (message) => {
        message.reply(buildNokosMenu());
    },

    "!server1": async (message) => {
        message.reply(buildServer1Menu());
    },

    "!packet1": async (message) => {
        message.reply(buildServerPacketMenu("packet1"));
    },

    "!packet2": async (message) => {
        message.reply(buildServerPacketMenu("packet2"));
    },

    "!packet3": async (message) => {
        message.reply(buildServerPacketMenu("packet3"));
    },

    "!packet4": async (message) => {
        message.reply(buildServerPacketMenu("packet4"));
    },

    "!whatsapp": async (message) => {
        message.reply(buildNokosAppPriceMenu("WhatsApp", "!buywhatsapp"));
    },

    "!telegram": async (message) => {
        message.reply(buildNokosAppPriceMenu("Telegram", "!buytelegram"));
    },

    "!shopee": async (message) => {
        message.reply(buildNokosAppPriceMenu("Shopee", "!buyshopee"));
    },

    "!tiktoknokos": async (message) => {
        message.reply(buildNokosAppPriceMenu("TikTok", "!buytiktok"));
    },

    "!facebook": async (message) => {
        message.reply(buildNokosAppPriceMenu("Facebook", "!buyfacebook"));
    },

    "!instagram": async (message) => {
        message.reply(buildNokosAppPriceMenu("Instagram", "!buyinstagram"));
    },

    "!google": async (message) => {
        message.reply(buildNokosAppPriceMenu("Google", "!buygoogle"));
    },

    "!vercel": async (message) => {
        message.reply(buildNokosAppPriceMenu("Vercel", "!buyvercel"));
    },

    "!uangme": async (message) => {
        message.reply(buildNokosAppPriceMenu("UangMe", "!buyuangme"));
    },

    "!dana": async (message) => {
        message.reply(buildNokosAppPriceMenu("DANA", "!buydana"));
    },

    "!gojek": async (message) => {
        message.reply(buildNokosAppPriceMenu("Gojek", "!buygojek"));
    },

    "!ovo": async (message) => {
        message.reply(buildNokosAppPriceMenu("OVO", "!buyovo"));
    },

    "!kopi": async (message) => {
        message.reply(buildNokosAppPriceMenu("Kopi Kenangan", "!buykopi"));
    },

    "!tokopedia": async (message) => {
        message.reply(buildNokosAppPriceMenu("Tokopedia", "!buytokopedia"));
    },

    "!lazada": async (message) => {
        message.reply(buildNokosAppPriceMenu("Lazada", "!buylazada"));
    },

    "!discord": async (message) => {
        message.reply(buildNokosAppPriceMenu("Discord", "!buydiscord"));
    },

    "!info": async (message) => {
        message.reply(`Bot Broadcast System 🚀
Developer : VeganTENG`);
    },

    "!id": async (message) => {

        const chat = await safeGetChat(message);

        if (!chat) {
            message.reply("Gagal membaca data chat.");
            return;
        }

        if (chat.isGroup) {

            message.reply(`ID Grup ini:\n${chat.id._serialized}`);

        } else {

            const chats = await safeGetChats(3, 2500);

            let list = "📋 DAFTAR SEMUA GRUP\n\n";

            chats.forEach(c => {

                if (c.isGroup) {
                    list += `${c.name}\n${c.id._serialized}\n\n`;
                }

            });

            message.reply(list);

        }

    },

    "!myid": async (message) => {
        const contact = await safeGetContact(message);
        const userId = resolveSenderId(message);
        const chat = await safeGetChat(message);
        const fallbackNumber = userId ? userId.split("@")[0] : "-";
        const number = contact && contact.number ? contact.number : fallbackNumber;
        const name = contact && contact.pushname ? contact.pushname : "Tidak ada nama";
        const groupInfo = chat && chat.isGroup ? `ID Grup: ${chat.id._serialized}\nNama Grup: ${chat.name}` : "";
        
        message.reply(`👤 Data User Kamu:

ID User: ${userId}
Nomor: ${number}
Nama: ${name}

${groupInfo}`);
    },

    "!userid": async (message) => {
        const args = message.body.slice(8).trim();
        
        if (args) {
            // Jika ada argument, format sebagai user ID
            let nomor = args.replace(/\D/g, ''); // Hapus karakter non-digit
            
            if (!nomor.startsWith('62')) {
                nomor = '62' + nomor;
            }
            
            const userId = nomor + '@c.us';
            message.reply(`👤 ID User dari nomor ${args}:

ID User: ${userId}
Nomor: ${nomor}`);
        } else {
            // Jika tidak ada argument, perlu reply ke pesan
            const quotedMsg = await message.getQuotedMessage();
            
            if (!quotedMsg) {
                message.reply("Gunakan: !userid <nomor telp>\nAtau reply ke pesan orang lain terus kirim !userid");
                return;
            }

            const contact = await safeGetContact(quotedMsg);
            let userId = quotedMsg.author || quotedMsg.from;
            
            // Normalize
            if (userId.includes("@lid")) {
                userId = userId.replace("@lid", "@c.us");
            }

            const fallbackNumber = userId ? userId.split("@")[0] : "-";
            const number = contact && contact.number ? contact.number : fallbackNumber;
            const name = contact && contact.pushname ? contact.pushname : "Tidak ada nama";
            
            message.reply(`👤 Data User:

ID User: ${userId}
Nomor: ${number}
Nama: ${name}`);
        }
    },

    "!owner": async (message, _name, senderId) => {
        const args = message.body.slice(7).trim();
        if (!args) {
            message.reply("Gunakan: !owner <nomor wa>");
            return;
        }

        const normalized = normalizeUserId(args);
        if (!normalized) {
            message.reply("Format nomor owner tidak valid.");
            return;
        }

        const db = loadContentDb();
        db.owner = normalized;
        saveContentDb(db);
        message.reply(`✅ Owner bot diset ke: ${normalized}`);
    },

    "!kick": async (message, _name, senderId, roleContext) => {
        const resolvedRole = roleContext || await getRoleContext(message, senderId);
        if (!ensureAdminAccess(resolvedRole)) {
            message.reply(denyAccessMessage());
            return;
        }

        message.reply("Fitur !kick siap dipakai untuk role admin/owner. Implementasi target user belum ditambahkan.");
    },

    "!add": async (message, _name, senderId, roleContext) => {
        const resolvedRole = roleContext || await getRoleContext(message, senderId);
        if (!ensureAdminAccess(resolvedRole)) {
            message.reply(denyAccessMessage());
            return;
        }

        const args = message.body.slice(4).trim();

        if (!args) {
            const groups = await loadGroupDirectory();
            if (!groups.length) {
                message.reply("Tidak ada grup yang ditemukan.");
                return;
            }

            addSessions.set(senderId, {
                step: "waiting_source_group",
                sourceNumber: null,
            });

            message.reply(buildAddSourceGroupSelectionMessage(groups));
            return;
        }

        const selectedNumbersResult = parseGroupNumberSelection(args);
        if (!selectedNumbersResult.isValid || selectedNumbersResult.numbers.length !== 2) {
            message.reply("Format tidak valid. Gunakan !add <no_grup_sumber> <no_grup_tujuan>. Contoh: !add 1 2");
            return;
        }

        const [sourceNumber, targetNumber] = selectedNumbersResult.numbers;

        try {
            const addResult = await addMembersFromSourceToTarget(sourceNumber, targetNumber);
            message.reply(addResult.message);
        } catch (error) {
            message.reply(`Gagal menambahkan member: ${error.message}`);
        }
    },

    "!tagall": async (message, _name, senderId, roleContext) => {
        const resolvedRole = roleContext || await getRoleContext(message, senderId);
        if (!ensureAdminAccess(resolvedRole)) {
            message.reply(denyAccessMessage());
            return;
        }

        const chat = await message.getChat();
        if (!chat.isGroup || !Array.isArray(chat.participants)) {
            message.reply("Command ini hanya bisa dipakai di grup.");
            return;
        }

        const mentions = [];
        let text = "📢 TAG ALL\n\n";

        chat.participants.forEach((participant, index) => {
            const participantId = participant.id && participant.id._serialized ? participant.id._serialized : null;
            if (!participantId) {
                return;
            }

            mentions.push(participantId);
            text += `${index + 1}. @${participantId.split("@")[0]}\n`;
        });

        await chat.sendMessage(text.trim(), { mentions });
    },

    "!share": async (message, name, senderId) => {
        if (broadcastState.intervalId) {
            message.reply("Broadcast sedang aktif. Gunakan !stop jika ingin mengganti sesi.");
            return;
        }

        shareSessions.set(senderId, {
            step: "waiting_duration_hours",
            durationHours: null,
            messageText: "",
            selectedSessionBlockedGroupIds: [],
        });

        message.reply("Masukkan durasi dalam jam (contoh: 1 atau 0.5):");
    },

    "!stop": async (message) => {
        const isStopped = stopBroadcast();

        if (!isStopped) {
            message.reply("Saat ini tidak ada broadcast yang aktif.");
            return;
        }

        message.reply("Broadcast berhasil dihentikan.");
    },

    "!larang": async (message) => {
        const args = message.body.slice(7).trim();

        if (!args) {
            const groups = await loadGroupDirectory();
            message.reply(buildGroupListMessage(groups));
            return;
        }

        const selectedNumbersResult = parseGroupNumberSelection(args);

        if (!selectedNumbersResult.isValid) {
            message.reply("Format tidak valid. Gunakan !larang 1 atau !larang 1,2");
            return;
        }

        const groups = await loadGroupDirectory();
        const selectedNumbers = selectedNumbersResult.numbers;

        const outOfRange = selectedNumbers.filter((number) => number > groups.length);
        if (outOfRange.length) {
            message.reply(`Ada nomor yang tidak tersedia (${outOfRange.join(", ")}). Pilih 1 sampai ${groups.length}.`);
            return;
        }

        const newlyBlocked = [];
        const alreadyBlocked = [];

        for (const selectedNumber of selectedNumbers) {
            const selectedGroup = groups[selectedNumber - 1];

            if (blockedGroups.includes(selectedGroup.id)) {
                alreadyBlocked.push(`${selectedNumber}. ${selectedGroup.name}`);
                continue;
            }

            blockedGroups.push(selectedGroup.id);
            newlyBlocked.push(`${selectedNumber}. ${selectedGroup.name} (${selectedGroup.id})`);
        }

        let response = "";

        if (newlyBlocked.length) {
            response += `Berhasil ditambahkan ke daftar larang:\n${newlyBlocked.join("\n")}`;
        }

        if (alreadyBlocked.length) {
            response += `${response ? "\n\n" : ""}Sudah ada di daftar larang:\n${alreadyBlocked.join("\n")}`;
        }

        if (!response) {
            response = "Tidak ada perubahan daftar larang.";
        }

        message.reply(response);
    },

    "!rangkum": async (message) => {
        const args = message.body.slice(8).trim();
        if (!args) {
            message.reply("Gunakan: !rangkum <tugas>");
            return;
        }
        const rangkuman = `REMINDER TUGAS\n\n${args}\n\n⏰ Deadline: ${new Date().toLocaleDateString('id-ID')}`;
        message.reply(rangkuman);
    },

    "!shares": async (message) => {
        const args = message.body.slice(8).trim();
        const parts = args.split(' ');
        if (parts.length < 2) {
            message.reply("Gunakan: !shares <text> <grup id>");
            return;
        }
        const text = parts.slice(0, -1).join(' ');
        const groupId = parts[parts.length - 1];
        try {
            await client.sendMessage(groupId, text);
            message.reply("Pesan berhasil dikirim ke grup");
        } catch (error) {
            message.reply("Gagal mengirim pesan ke grup");
        }
    },

    "!datas": async (message, _name, senderId, roleContext) => {
        const resolvedRole = roleContext || await getRoleContext(message, senderId);
        if (!ensureOwnerAccess(resolvedRole)) {
            message.reply(denyAccessMessage());
            return;
        }

        const rawArgs = message.body.slice(7).trim();
        if (!rawArgs) {
            message.reply("Gunakan: !datas <payment|gb> <isi>\nContoh: !datas payment Dana 08xxxx");
            return;
        }

        const [rawCategory, ...contentParts] = rawArgs.split(/\s+/);
        const category = (rawCategory || "").toLowerCase();
        const contentText = contentParts.join(" ").trim();

        if (!allowedDataCategories.includes(category)) {
            message.reply("Kategori tidak valid. Gunakan payment atau gb.");
            return;
        }

        try {
            const entry = await buildDataEntryFromMessage(message, contentText);
            const db = loadContentDb();
            db.data[category].push(entry);
            saveContentDb(db);

            message.reply(`✅ Data berhasil disimpan ke kategori ${category}`);
        } catch (error) {
            message.reply(`❌ Gagal menyimpan data: ${error.message}`);
        }
    },

    "!pay": async (message) => {
        await sendCategoryEntries(message.from, "payment");
    },

    "!deposit": async (message, _name, senderId) => {
        const args = message.body.slice(8).trim();
        const parsedAmount = parseDepositAmount(args);

        if (!parsedAmount.ok) {
            message.reply(parsedAmount.message);
            return;
        }

        const db = loadDepositDb();
        const userKey = await resolveUserKey(message, senderId);
        const pending = getPendingDepositForUser(db, senderId, userKey);

        if (pending) {
            message.reply(
                `❗ Kamu masih punya deposit pending.\n`
                + `ID: ${pending.id}\n`
                + `Nominal: ${formatRupiah(pending.amount)}`
            );
            return;
        }

        const existingIds = new Set(db.transactions.map((tx) => tx.id));
        const id = generateDepositId(existingIds);
        const now = new Date().toISOString();

        const transaction = {
            id,
            userId: senderId,
            userNumberId: userKey,
            amount: parsedAmount.amount,
            status: "pending",
            createdAt: now,
            updatedAt: now,
            proof: null,
        };

        db.transactions.push(transaction);
        saveDepositDb(db);

        const replyLines = [
            "✅ Deposit berhasil dibuat.",
            `ID transaksi: ${id}`,
            `Nominal: ${formatRupiah(parsedAmount.amount)}`,
            "Instruksi transfer: silakan lakukan transfer sesuai informasi pembayaran di bawah ini.",
            "Setelah transfer, kirim foto bukti pembayaran ke chat ini.",
        ];

        await message.reply(replyLines.join("\n"));
        await sendCategoryEntries(message.from, "payment");
    },

    "!gb": async (message) => {
        await sendCategoryEntries(message.from, "gb");
    },

    "!ceksaldo": async (message, _name, senderId) => {
        const db = loadDepositDb();
        const isOwner = await isDepositOwnerFromMessage(message, senderId);

        if (isOwner) {
            const lastUserId = db.meta ? db.meta.lastActiveUserId : null;
            if (!lastUserId) {
                message.reply("Belum ada user yang chat bot.");
                return;
            }

            const userRecord = db.users[lastUserId] || { balance: 0 };
            const lastUserNumber = lastUserId.split("@")[0];

            message.reply(
                `Saldo terakhir (user terakhir chat):\n`
                + `User: ${lastUserNumber}\n`
                + `Saldo: ${formatRupiah(userRecord.balance || 0)}`
            );
            return;
        }

        const userKey = await resolveUserKey(message, senderId);
        const userRecord = db.users[userKey] || db.users[senderId] || { balance: 0 };
        message.reply(
            `Saldo kamu saat ini: ${formatRupiah(userRecord.balance || 0)}`
        );
    },

    "!asli": async (message, _name, senderId) => {
        if (!await isDepositOwnerFromMessage(message, senderId)) {
            message.reply(denyAccessMessage());
            return;
        }

        const args = message.body.slice(5).trim();
        if (!args) {
            message.reply("Gunakan: !asli <ID>");
            return;
        }

        const db = loadDepositDb();
        const transaction = getDepositById(db, args);

        if (!transaction) {
            message.reply("ID transaksi tidak ditemukan.");
            return;
        }

        if (transaction.status !== "pending") {
            message.reply(`Transaksi ${transaction.id} sudah berstatus ${transaction.status}.`);
            return;
        }

        const now = new Date().toISOString();
        transaction.status = "success";
        transaction.updatedAt = now;

        const balanceKey = transaction.userId || transaction.userNumberId;
        const userRecord = db.users[balanceKey] || { balance: 0, updatedAt: null };
        userRecord.balance = Number(userRecord.balance || 0) + Number(transaction.amount || 0);
        userRecord.updatedAt = now;
        db.users[balanceKey] = userRecord;

        db.history.push({
            id: transaction.id,
            userId: transaction.userId,
            amount: transaction.amount,
            status: "success",
            actionBy: senderId,
            actionAt: now,
        });

        saveDepositDb(db);

        await message.reply(`✅ Transaksi ${transaction.id} diset sukses.`);
        const targetUserId = transaction.userId || transaction.userNumberId;
        await client.sendMessage(
            targetUserId,
            [
                "╭━━━〔 ✅ DEPOSIT BERHASIL 〕━━━╮",
                "┃",
                "┃ 💰 Deposit berhasil diverifikasi",
                "┃ saldo telah ditambahkan",
                "┃",
                `┃ 🆔 ID: ${transaction.id}`,
                `┃ 💵 Nominal: ${formatRupiah(transaction.amount)}`,
                "┃ 📌 Status: Berhasil",
                "┃",
                "┃ ✅ Saldo sudah masuk",
                "┃ silakan cek saldo:",
                "┃ ketik *!ceksaldo*",
                "┃",
                "┃ 🙏 Terima kasih",
                "┃",
                "╰━━━━━━━━━━━━━━━━━━━━╯",
            ].join("\n")
        );
    },

    "!tolak": async (message, _name, senderId) => {
        if (!await isDepositOwnerFromMessage(message, senderId)) {
            message.reply(denyAccessMessage());
            return;
        }

        const args = message.body.slice(6).trim();
        if (!args) {
            message.reply("Gunakan: !tolak <ID>");
            return;
        }

        const db = loadDepositDb();
        const transaction = getDepositById(db, args);

        if (!transaction) {
            message.reply("ID transaksi tidak ditemukan.");
            return;
        }

        if (transaction.status !== "pending") {
            message.reply(`Transaksi ${transaction.id} sudah berstatus ${transaction.status}.`);
            return;
        }

        const now = new Date().toISOString();
        transaction.status = "rejected";
        transaction.updatedAt = now;

        db.history.push({
            id: transaction.id,
            userId: transaction.userId,
            amount: transaction.amount,
            status: "rejected",
            actionBy: senderId,
            actionAt: now,
        });

        saveDepositDb(db);

        await message.reply(`❌ Transaksi ${transaction.id} ditolak.`);
        const targetUserId = transaction.userId || transaction.userNumberId;
        await client.sendMessage(
            targetUserId,
            `❌ Deposit kamu ditolak.\nID: ${transaction.id}\nNominal: ${formatRupiah(transaction.amount)}`
        );
    },

    "!save": async (message, _name, senderId) => {
        const args = message.body.slice(5).trim();

        if (!args) {
            saveSessions.set(senderId, {
                step: "waiting_group_selection",
                selectedNumbers: [],
                nameMode: "name",
                customPrefix: "",
            });

            const groups = await loadGroupDirectory();
            if (!groups.length) {
                saveSessions.delete(senderId);
                message.reply("Tidak ada grup yang ditemukan.");
                return;
            }

            message.reply(buildSaveGroupSelectionMessage(groups));
            return;
        }

        const selectedNumbersResult = parseGroupNumberSelection(args);

        if (!selectedNumbersResult.isValid) {
            message.reply("Format tidak valid. Gunakan !save 1 atau !save 1,2");
            return;
        }

        const groups = await loadGroupDirectory();
        if (!groups.length) {
            message.reply("Tidak ada grup yang ditemukan.");
            return;
        }

        const selectedNumbers = selectedNumbersResult.numbers;
        const outOfRange = selectedNumbers.filter((number) => number > groups.length);

        if (outOfRange.length) {
            message.reply(`Ada nomor yang tidak tersedia (${outOfRange.join(", ")}). Pilih 1 sampai ${groups.length}.`);
            return;
        }

        saveSessions.set(senderId, {
            step: "waiting_name_format",
            selectedNumbers,
            nameMode: "name",
            customPrefix: "",
        });

        message.reply(buildSaveNameFormatMessage());
        return;
    },

    "!list": async (message, _name, senderId, roleContext) => {
        const resolvedRole = roleContext || await getRoleContext(message, senderId);
        if (!ensureOwnerAccess(resolvedRole)) {
            message.reply(denyAccessMessage());
            return;
        }

        const category = message.body.slice(6).trim().toLowerCase();

        if (!allowedDataCategories.includes(category)) {
            message.reply("Gunakan: !list payment atau !list gb");
            return;
        }

        message.reply(buildListCategoryMessage(category));
    },

    "!del": async (message, _name, senderId, roleContext) => {
        const resolvedRole = roleContext || await getRoleContext(message, senderId);
        if (!ensureOwnerAccess(resolvedRole)) {
            message.reply(denyAccessMessage());
            return;
        }

        const args = message.body.slice(5).trim();
        const [categoryRaw, indexRaw] = args.split(/\s+/);
        const category = (categoryRaw || "").toLowerCase();
        const index = Number(indexRaw);

        if (!allowedDataCategories.includes(category) || !Number.isInteger(index) || index < 1) {
            message.reply("Gunakan: !del <payment|gb> <nomor>\nContoh: !del payment 1");
            return;
        }

        const db = loadContentDb();
        const entries = db.data[category];

        if (index > entries.length) {
            message.reply(`Nomor data tidak tersedia. Total data ${category}: ${entries.length}`);
            return;
        }

        const removed = entries.splice(index - 1, 1)[0];
        if (removed && removed.path && fs.existsSync(removed.path)) {
            try {
                fs.unlinkSync(removed.path);
            } catch {
                // Biarkan lanjut jika file media gagal dihapus.
            }
        }

        saveContentDb(db);
        message.reply(`✅ Data ${category} nomor ${index} berhasil dihapus.`);
    },

    "!tiktok": async (message) => {
        const args = message.body.slice(8).trim();
        if (!args) {
            message.reply("Gunakan: !tiktok <url>");
            return;
        }

        await handleTiktokDownload(message, args);
    },

    "!instagram": async (message) => {
        const args = message.body.slice(11).trim();
        if (!args) {
            message.reply("Gunakan: !instagram <url>");
            return;
        }

        await handleInstagramDownload(message, args);
    }

};

client.on("message", async (message) => {

    try {

    if (message.fromMe && !allowSelfCommands) {
        return;
    }

    if (message.from === "status@broadcast") {
        return;
    }

    const messageId = message.id && message.id._serialized ? message.id._serialized : null;
    if (!messageId) {
        return;
    }

    if (processedMessages.has(messageId)) {
        if (debugMessageLogs) {
            console.log("Duplicate skipped:", messageId);
        }
        return;
    }

    markMessageAsProcessed(messageId);
    const text = typeof message.body === "string" ? message.body : "";

    if (debugMessageLogs && text.trim().startsWith("!")) {
        console.log("Processed:", messageId);
    }

    // Delay kecil untuk menghindari race condition saat event datang hampir bersamaan.
    await sleep(100);

    const lowerText = text.toLowerCase();
    const senderId = resolveSenderId(message);
    let roleContextCache = null;

    async function getRoleContextCached() {
        if (!roleContextCache) {
            roleContextCache = await getRoleContext(message, senderId);
        }

        return roleContextCache;
    }

    async function runCommand(commandKey) {
        let roleContext;

        try {
            roleContext = await getRoleContextCached();
        } catch (error) {
            console.log("Gagal membaca role context:", error.message);
            roleContext = { isOwner: false, isAdmin: false, isUser: true };
        }

        await commands[commandKey](message, null, senderId, roleContext);
    }

    if (!text.trim() && !message.hasMedia) {
        return;
    }

    const chatContext = await safeGetChat(message);
    if (chatContext && !chatContext.isGroup && !lowerText.startsWith("!")) {
        await message.reply([
            "Halo kak 👋",
            "",
            "Terima kasih sudah menghubungi bot kami.",
            "",
            "Silakan ketik:",
            "🛒 *!shop* → untuk melihat produk",
            "🤖 *!menu* → untuk fitur bot",
            "",
            "Pesan ini hanya muncul di chat pribadi ya 🙌",
        ].join("\n"));
    }

    // ================= COMMAND NORMAL =================

    if (commands[lowerText]) {
        await runCommand(lowerText);
        return;
    }

    // ================= COMMAND DENGAN ARGUMENT =================

    if (lowerText.startsWith("!userid ") && commands["!userid"]) {
        await runCommand("!userid");
        return;
    }

    if (lowerText.startsWith("!rangkum ") && commands["!rangkum"]) {
        await runCommand("!rangkum");
        return;
    }

    if (lowerText.startsWith("!shares ") && commands["!shares"]) {
        await runCommand("!shares");
        return;
    }

    if (lowerText.startsWith("!buyserver")) {
        const parsedBuyServer = parseBuyServerCommand(text);

        if (!parsedBuyServer.ok) {
            const usage = "Gunakan: !buyserver packet1 1h|7h|30h (durasi opsional, default 30h)";
            message.reply(usage);
            return;
        }

        const priceInfo = resolveServerPacketPrice(parsedBuyServer.packetKey, parsedBuyServer.duration);
        if (!priceInfo || !Number.isInteger(priceInfo.amount)) {
            message.reply("Harga paket tidak ditemukan. Coba !server untuk lihat daftar paket.");
            return;
        }

        const db = loadDepositDb();
        const userKey = await resolveUserKey(message, senderId);
        const balanceKey = userKey || senderId;
        const userRecord = db.users[balanceKey] || { balance: 0, updatedAt: null };
        const currentBalance = Number(userRecord.balance || 0);

        if (currentBalance < priceInfo.amount) {
            message.reply("Maaf saldo anda kurang, segera mengisi !deposit <nominal>");
            return;
        }

        const now = new Date().toISOString();
        userRecord.balance = currentBalance - priceInfo.amount;
        userRecord.updatedAt = now;
        db.users[balanceKey] = userRecord;
        saveDepositDb(db);

        const packet = serverPacketCatalog[parsedBuyServer.packetKey];
        const replyLines = [
            "✅ Pembelian paket berhasil.",
            `📦 Paket: ${packet.label}`,
            `⏱️ Durasi: ${parsedBuyServer.duration.toUpperCase()}`,
            `💰 Total: ${formatRupiah(priceInfo.amount)}`,
            `💳 Sisa saldo: ${formatRupiah(userRecord.balance)}`,
            "Admin akan memproses order kamu.",
        ];

        message.reply(replyLines.join("\n"));
        return;
    }

    if (lowerText.startsWith("!buy")) {
        const parsedBuy = parseNokosBuyCommand(text);

        if (!parsedBuy.ok) {
            const sample = "Contoh: !buywhatsapp paket1 2";
            message.reply(`Format order tidak valid. ${sample}`);
            return;
        }

        const appInfo = nokosAppCatalog[parsedBuy.appKey];

        if (!appInfo) {
            message.reply("Aplikasi tidak ditemukan. Cek daftar aplikasi di !server1.");
            return;
        }

        const unitPrice = nokosPaketPrices[parsedBuy.paketNumber - 1];
        const totalPrice = unitPrice * parsedBuy.qtyNumber;

        const db = loadDepositDb();
        const userKey = await resolveUserKey(message, senderId);
        const balanceKey = userKey || senderId;
        const userRecord = db.users[balanceKey] || { balance: 0, updatedAt: null };
        const currentBalance = Number(userRecord.balance || 0);

        if (currentBalance < totalPrice) {
            message.reply("Maaf saldo anda kurang, segera mengisi !deposit <nominal>");
            return;
        }

        const now = new Date().toISOString();
        userRecord.balance = currentBalance - totalPrice;
        userRecord.updatedAt = now;
        db.users[balanceKey] = userRecord;
        saveDepositDb(db);

        message.reply(buildNokosBuyReply(parsedBuy.appKey, parsedBuy.paketNumber, parsedBuy.qtyNumber, userRecord.balance));
        return;
    }

    if (lowerText.startsWith("!owner ") && commands["!owner"]) {
        await runCommand("!owner");
        return;
    }

    if (lowerText.startsWith("!larang ") && commands["!larang"]) {
        await runCommand("!larang");
        return;
    }

    if (lowerText.startsWith("!datas ") && commands["!datas"]) {
        await runCommand("!datas");
        return;
    }

    if (lowerText.startsWith("!deposit ") && commands["!deposit"]) {
        await runCommand("!deposit");
        return;
    }

    if (lowerText.startsWith("!list ") && commands["!list"]) {
        await runCommand("!list");
        return;
    }

    if (lowerText.startsWith("!del ") && commands["!del"]) {
        await runCommand("!del");
        return;
    }

    if (lowerText.startsWith("!save ") && commands["!save"]) {
        await runCommand("!save");
        return;
    }

    if (lowerText.startsWith("!add ") && commands["!add"]) {
        await runCommand("!add");
        return;
    }

    if (lowerText.startsWith("!tiktok ") && commands["!tiktok"]) {
        await runCommand("!tiktok");
        return;
    }

    if (lowerText.startsWith("!instagram ") && commands["!instagram"]) {
        await runCommand("!instagram");
        return;
    }

    if (lowerText.startsWith("!asli ") && commands["!asli"]) {
        await runCommand("!asli");
        return;
    }

    if (lowerText.startsWith("!tolak ") && commands["!tolak"]) {
        await runCommand("!tolak");
        return;
    }

    if (lowerText === "!ceksaldo" && commands["!ceksaldo"]) {
        await runCommand("!ceksaldo");
        return;
    }

    if (lowerText === "!shop" && commands["!shop"]) {
        await runCommand("!shop");
        return;
    }

    // ================= TRACK LAST USER =================

    if (senderId && !senderId.endsWith("@g.us")) {
        const ownerId = getDepositOwnerId();
        if (normalizeUserId(senderId) !== ownerId) {
            const db = loadDepositDb();
            const now = new Date().toISOString();
            if (!db.meta) {
                db.meta = { lastActiveUserId: senderId, lastActiveAt: now };
            } else {
                db.meta.lastActiveUserId = senderId;
                db.meta.lastActiveAt = now;
            }
            saveDepositDb(db);
        }
    }

    // ================= DEPOSIT PROOF =================

    if (message.hasMedia && senderId) {
        const isImage = message.type === "image" || (message._data && message._data.mimetype || "").startsWith("image/");
        if (isImage) {
            const db = loadDepositDb();
            const userKey = await resolveUserKey(message, senderId);
            const pending = getPendingDepositForUser(db, senderId, userKey);

            if (pending) {
                const ownerId = getDepositOwnerId();
                const now = new Date().toISOString();
                pending.proof = {
                    receivedAt: now,
                    messageId: message.id && message.id._serialized ? message.id._serialized : null,
                };
                pending.updatedAt = now;
                saveDepositDb(db);

                if (ownerId) {
                    try {
                        await message.forward(ownerId);
                    } catch (error) {
                        console.log("Gagal forward bukti deposit:", error.message);
                    }

                    const userNumber = (pending.userId || senderId).split("@")[0];
                    const contact = await safeGetContact(message);
                    const contactName = contact && (contact.pushname || contact.name || contact.verifiedName)
                        ? (contact.pushname || contact.name || contact.verifiedName)
                        : "Tidak ada nama";
                    const contactNumber = contact && contact.number ? contact.number : userNumber;
                    const readableTime = new Date(now).toLocaleString("id-ID");
                    const infoLines = [
                        "📥 Bukti deposit masuk",
                        `ID: ${pending.id}`,
                        `User: ${userNumber}`,
                        `Nama: ${contactName}`,
                        `Nomor: ${contactNumber}`,
                        `Nominal: ${formatRupiah(pending.amount)}`,
                        `Waktu: ${readableTime}`,
                        "",
                        "Command verifikasi:",
                        `!asli ${pending.id}`,
                        `!tolak ${pending.id}`,
                    ];

                    await client.sendMessage(ownerId, infoLines.join("\n"));
                }

                await message.reply("✅ Bukti transfer diterima. Admin akan memverifikasi.");
                return;
            }
        }
    }

    // ================= SHARE SESSION INPUT =================

    const activeShareSession = shareSessions.get(senderId);

    if (activeShareSession && !lowerText.startsWith("!")) {
        if (activeShareSession.step === "waiting_duration_hours") {
            const durationHours = Number(text.trim().replace(",", "."));

            if (!Number.isFinite(durationHours) || durationHours <= 0) {
                message.reply("Durasi tidak valid. Masukkan angka jam lebih dari 0.");
                return;
            }

            activeShareSession.step = "waiting_message";
            activeShareSession.durationHours = durationHours;
            shareSessions.set(senderId, activeShareSession);

            message.reply("Masukkan pesan yang ingin di-share:");
            return;
        }

        if (activeShareSession.step === "waiting_message") {
            const broadcastMessage = text.trim();

            if (!broadcastMessage) {
                message.reply("Pesan tidak boleh kosong. Masukkan pesan yang ingin di-share:");
                return;
            }

            if (broadcastState.intervalId) {
                shareSessions.delete(senderId);
                message.reply("Broadcast sedang aktif. Gunakan !stop terlebih dahulu.");
                return;
            }

            try {
                const groups = await loadGroupDirectory();
                if (!groups.length) {
                    shareSessions.delete(senderId);
                    message.reply("Tidak ada grup yang ditemukan untuk broadcast.");
                    return;
                }

                activeShareSession.step = "waiting_block_selection";
                activeShareSession.messageText = broadcastMessage;
                activeShareSession.groupOptions = groups;
                shareSessions.set(senderId, activeShareSession);

                message.reply(buildShareBlockSelectionMessage(groups));
            } catch (error) {
                shareSessions.delete(senderId);
                message.reply(`Gagal menyiapkan pilihan grup: ${error.message}`);
            }

            return;
        }

        if (activeShareSession.step === "waiting_block_selection") {
            const input = text.trim().toLowerCase();

            let selectedSessionBlockedGroupIds = [];
            let blockedGroupNames = [];

            if (input !== "0" && input !== "skip") {
                const selectedNumbersResult = parseGroupNumberSelection(input);
                if (!selectedNumbersResult.isValid) {
                    message.reply("Format pilihan tidak valid. Contoh: 1,2 atau ketik 0 untuk lanjut tanpa larang.");
                    return;
                }

                const groups = activeShareSession.groupOptions || [];
                const selectedNumbers = selectedNumbersResult.numbers;
                const outOfRange = selectedNumbers.filter((number) => number > groups.length);

                if (outOfRange.length) {
                    message.reply(`Nomor tidak tersedia: ${outOfRange.join(", ")}. Pilih 1 sampai ${groups.length}, atau 0 untuk skip.`);
                    return;
                }

                selectedSessionBlockedGroupIds = selectedNumbers.map((number) => groups[number - 1].id);
                blockedGroupNames = selectedNumbers.map((number) => groups[number - 1].name);
            }

            if (broadcastState.intervalId) {
                shareSessions.delete(senderId);
                message.reply("Broadcast sedang aktif. Gunakan !stop terlebih dahulu.");
                return;
            }

            try {
                await startBroadcast(
                    activeShareSession.durationHours,
                    activeShareSession.messageText,
                    message.from,
                    selectedSessionBlockedGroupIds
                );
                shareSessions.delete(senderId);

                const blockedInfo = blockedGroupNames.length
                    ? `Grup yang dilarang untuk sesi ini: ${blockedGroupNames.join(", ")}`
                    : "Tidak ada grup yang dilarang untuk sesi ini.";

                message.reply(`Broadcast aktif.\n\nDurasi: setiap ${activeShareSession.durationHours} jam\n${blockedInfo}\nPengiriman pertama sedang diproses ke grup target.\nLaporan hasil kirim akan dikirim ke chat ini.\n\nGunakan !stop untuk menghentikan broadcast.`);
            } catch (error) {
                shareSessions.delete(senderId);
                message.reply(`Gagal memulai broadcast: ${error.message}`);
            }

            return;
        }
    }

    // ================= ADD SESSION INPUT =================

    const activeAddSession = addSessions.get(senderId);

    if (activeAddSession && !lowerText.startsWith("!")) {
        const input = String(text || "").trim().toLowerCase();

        if (!input || input === "0" || input === "batal" || input === "cancel") {
            addSessions.delete(senderId);
            message.reply("Proses add member dibatalkan.");
            return;
        }

        const selectedNumbersResult = parseGroupNumberSelection(input);
        if (!selectedNumbersResult.isValid || selectedNumbersResult.numbers.length !== 1) {
            message.reply("Input tidak valid. Balas dengan 1 nomor grup, atau ketik 0 untuk batal.");
            return;
        }

        const selectedNumber = selectedNumbersResult.numbers[0];

        if (activeAddSession.step === "waiting_source_group") {
            try {
                const groups = await loadGroupDirectory();
                if (selectedNumber > groups.length) {
                    message.reply(`Nomor tidak tersedia. Pilih 1 sampai ${groups.length}.`);
                    return;
                }

                activeAddSession.step = "waiting_target_group";
                activeAddSession.sourceNumber = selectedNumber;
                addSessions.set(senderId, activeAddSession);
                message.reply(buildAddTargetGroupSelectionMessage(groups, selectedNumber));
            } catch (error) {
                addSessions.delete(senderId);
                message.reply(`Gagal menyiapkan grup tujuan: ${error.message}`);
            }

            return;
        }

        if (activeAddSession.step === "waiting_target_group") {
            const sourceNumber = Number(activeAddSession.sourceNumber || 0);

            if (selectedNumber === sourceNumber) {
                message.reply("Grup tujuan tidak boleh sama dengan grup sumber. Pilih nomor grup lain.");
                return;
            }

            try {
                const addResult = await addMembersFromSourceToTarget(sourceNumber, selectedNumber);
                addSessions.delete(senderId);
                message.reply(addResult.message);
            } catch (error) {
                addSessions.delete(senderId);
                message.reply(`Gagal menambahkan member: ${error.message}`);
            }

            return;
        }
    }

    // ================= SAVE SESSION INPUT =================

    const activeSaveSession = saveSessions.get(senderId);

    if (activeSaveSession && !lowerText.startsWith("!")) {
        if (activeSaveSession.step === "waiting_group_selection") {
            try {
                const input = String(text || "").trim().toLowerCase();

                if (!input || input === "0" || input === "skip" || input === "batal" || input === "cancel") {
                    saveSessions.delete(senderId);
                    message.reply("Proses save dibatalkan.");
                    return;
                }

                const selectedNumbersResult = parseGroupNumberSelection(input);

                if (!selectedNumbersResult.isValid) {
                    message.reply("Format pilihan tidak valid. Contoh: 1,2 atau ketik 0 untuk batal.");
                    return;
                }

                const groups = await loadGroupDirectory();
                const selectedNumbers = selectedNumbersResult.numbers;
                const outOfRange = selectedNumbers.filter((number) => number > groups.length);

                if (outOfRange.length) {
                    message.reply(`Nomor tidak tersedia: ${outOfRange.join(", ")}. Pilih 1 sampai ${groups.length}.`);
                    return;
                }

                activeSaveSession.step = "waiting_name_format";
                activeSaveSession.selectedNumbers = selectedNumbers;
                saveSessions.set(senderId, activeSaveSession);

                message.reply(buildSaveNameFormatMessage());
            } catch (error) {
                saveSessions.delete(senderId);
                message.reply(`Gagal menyiapkan pilihan grup: ${error.message}`);
            }

            return;
        }

        if (activeSaveSession.step === "waiting_name_format") {
            const result = parseSaveNameMode(text);

            if (!result.ok) {
                message.reply(result.message);
                return;
            }

            if (result.requiresCustomPrefix) {
                activeSaveSession.step = "waiting_custom_prefix";
                activeSaveSession.nameMode = result.nameMode;
                saveSessions.set(senderId, activeSaveSession);
                message.reply("Masukkan prefix custom untuk nama kontak. Contoh: TEAM, VIP, atau JUAL");
                return;
            }

            try {
                const saveResult = await saveSelectedGroupsToDb(
                    activeSaveSession.selectedNumbers,
                    result.nameMode,
                    ""
                );

                saveSessions.delete(senderId);
                if (!saveResult.ok) {
                    message.reply(saveResult.message);
                    return;
                }

                message.reply(`${saveResult.message}\n\nFormat nama: ${getSaveNameModeLabel(result.nameMode)}`);

                if (saveResult.exportPath && fs.existsSync(saveResult.exportPath)) {
                    const vcfMedia = MessageMedia.fromFilePath(saveResult.exportPath);
                    await client.sendMessage(message.from, vcfMedia, {
                        sendMediaAsDocument: true,
                        caption: `VCF siap di-import. Total kontak: ${saveResult.exportedCount}`,
                    });
                }
            } catch (error) {
                saveSessions.delete(senderId);
                message.reply(`Gagal menyimpan kontak grup: ${error.message}`);
            }

            return;
        }

        if (activeSaveSession.step === "waiting_custom_prefix") {
            const prefix = text.trim();

            if (!prefix) {
                message.reply("Prefix tidak boleh kosong. Masukkan prefix custom untuk nama kontak.");
                return;
            }

            try {
                const saveResult = await saveSelectedGroupsToDb(
                    activeSaveSession.selectedNumbers,
                    activeSaveSession.nameMode || "custom_prefix",
                    prefix
                );

                saveSessions.delete(senderId);
                if (!saveResult.ok) {
                    message.reply(saveResult.message);
                    return;
                }

                message.reply(`${saveResult.message}\n\nFormat nama: ${getSaveNameModeLabel(activeSaveSession.nameMode || "custom_prefix")}\nPrefix custom: ${prefix}`);

                if (saveResult.exportPath && fs.existsSync(saveResult.exportPath)) {
                    const vcfMedia = MessageMedia.fromFilePath(saveResult.exportPath);
                    await client.sendMessage(message.from, vcfMedia, {
                        sendMediaAsDocument: true,
                        caption: `VCF siap di-import. Total kontak: ${saveResult.exportedCount}`,
                    });
                }
            } catch (error) {
                saveSessions.delete(senderId);
                message.reply(`Gagal menyimpan kontak grup: ${error.message}`);
            }

            return;
        }
    }

    // ================= SEND ULANG =================

    if (lowerText.startsWith("!send ")) {

        const ulang = text.slice(6);
        message.reply(ulang);

    }

    // ================= SIMPAN TUGAS =================

    if (lowerText.startsWith("!data")) {

        const isi = text.replace("!data", "").trim();

        const lines = isi.split("\n").filter(l => l.trim() !== "");

        const tanggal = lines[lines.length - 1].trim();
        const tugas = lines.slice(0, -1).join("\n");

        let data;

        try {
            data = JSON.parse(fs.readFileSync(file));
        } catch {
            data = [];
        }

        data.push({
            tanggal: tanggal,
            tugas: tugas
        });

        fs.writeFileSync(file, JSON.stringify(data, null, 2));

        message.reply(`Tugas berhasil disimpan untuk tanggal ${tanggal}`);

    }

    // ================= AMBIL TUGAS =================

    if (lowerText.startsWith("!tugas ")) {

        const tanggal = text.slice(7).trim();

        let data;

        try {
            data = JSON.parse(fs.readFileSync(file));
        } catch {
            data = [];
        }

        const hasil = data.filter(d => d.tanggal === tanggal);

        if (hasil.length === 0) {

            message.reply("Tidak ada tugas di tanggal itu");

        } else {

            let list = `📚 Tugas tanggal ${tanggal}\n\n`;

            hasil.forEach((d, i) => {

                list += `Tugas ${i + 1}:\n${d.tugas}\n\n`;

            });

            message.reply(list);

        }

    }

    // ================= STICKER DARI TEKS =================

    if (lowerText.startsWith("!sticker ")) {
        const stickerText = text.slice(9).trim();
        try {
            const stickerBuffer = await createTextSticker(stickerText);
            const base64 = stickerBuffer.toString('base64');
            const media = new MessageMedia('image/png', base64);
            
            // Kirim sticker
            await message.reply(media, null, { sendMediaAsSticker: true });
        } catch (error) {
            console.log("Error membuat sticker teks:", error);
            message.reply("❌ Gagal membuat sticker teks");
        }
    }

    // ================= STICKER DARI GAMBAR =================

    if (lowerText === "!sticker" && message.hasMedia) {
        try {
            const media = await message.downloadMedia();
            const imageBuffer = Buffer.from(media.data, 'base64');
            
            const resizedBuffer = await sharp(imageBuffer)
                .resize(512, 512, {
                    fit: 'inside',
                    withoutEnlargement: true,
                    background: { r: 255, g: 255, b: 255, alpha: 0 }
                })
                .png()
                .toBuffer();

            const base64 = resizedBuffer.toString('base64');
            const stickerMedia = new MessageMedia('image/png', base64);
            
            // Kirim sticker
            await message.reply(stickerMedia, null, { sendMediaAsSticker: true });
        } catch (error) {
            console.log("Error membuat sticker gambar:", error);
            message.reply("❌ Gagal membuat sticker dari gambar");
        }
    }

    } catch (error) {
        console.log("Error di message handler:", error.message);
        try {
            await message.reply("Terjadi error internal. Coba ulang beberapa detik lagi.");
        } catch {
            // Hindari error berantai jika reply juga gagal.
        }
    }

});

process.on("unhandledRejection", (reason) => {
    const reasonText = String(reason && reason.message ? reason.message : reason);
    const normalizedReason = reasonText.toLowerCase();

    if (reasonText.includes("The browser is already running")) {
        console.log("❌ Browser session sedang dipakai proses lain.");
        console.log("Tutup proses bot/chrome lama dulu, lalu jalankan ulang node main.js.");
        return;
    }

    if (normalizedReason.includes("unsafe is not a function") || normalizedReason.includes("execution context was destroyed")) {
        console.log("⚠️ WA Web sedang reload context. Error transient diabaikan, bot tetap lanjut jalan.");
        return;
    }

    console.log("Unhandled Rejection:", reason);
});

process.on("uncaughtException", (error) => {
    console.log("Uncaught Exception:", error.message);
});

async function initializeBotClient() {
    const maxRetry = 3;

    for (let attempt = 1; attempt <= maxRetry; attempt += 1) {
        try {
            console.log("Initializing WhatsApp client...");
            await client.initialize();
            console.log("Client initialize() dipanggil.");
            return;
        } catch (error) {
            const errorText = String(error && error.message ? error.message : error);

            if (errorText.includes("The browser is already running")) {
                clearInterval(startupKeepAlive);
                console.log("⚠️ Session browser masih digunakan proses lain.");
                console.log("Tutup proses bot lain, lalu jalankan ulang node main.js.");
                return;
            }

            if (isTransientWwebError(error) && attempt < maxRetry) {
                const waitMs = 1500 * attempt;
                console.log(`[init] retry ${attempt}/${maxRetry} karena error transient: ${errorText}`);
                await sleep(waitMs);
                continue;
            }

            clearInterval(startupKeepAlive);
            console.log("Gagal initialize client:", errorText);
            process.exitCode = 1;
            return;
        }
    }
}

setupLocalEmergencyCommands();

initializeBotClient().catch((error) => {
    clearInterval(startupKeepAlive);
    console.log("Fatal initialize error:", error && error.message ? error.message : error);
    process.exitCode = 1;
});