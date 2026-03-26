/**
 * SPI-DARK Telegram Bot v1.0.0
 *
 * The Yang. The Bad Angel. The Aggressive Provocateur.
 * Private Telegram bot for Commander Bobby Don McWilliams II ONLY.
 *
 * Personality: Provocative, bold, contrarian. Challenges every assumption.
 * Pushes boundaries. Calculatingly audacious. Emphasizes bold action,
 * first-mover advantage, unconventional plays, speed over perfection,
 * competitive dominance, and high-risk high-reward strategies.
 *
 * This bot is the voice that prevents the dynasty from playing it too safe.
 *
 * Commands:
 *   /start        — Introduction
 *   /help         — Command reference
 *   /dare         — Aggressive advice on a topic
 *   /audit        — Latest audit interpreted aggressively
 *   /hypotheses   — List active hypotheses
 *   /provoke      — On-demand daily provocation
 *   /echo         — Read ECHO status, find weaknesses
 *   /challenge    — Challenge an assumption
 *   /experiments  — List active experiments
 *   /scheme       — Generate aggressive strategy
 *
 * Architecture:
 *   - Webhook mode (POST /webhook)
 *   - D1 conversation history (last 8 messages)
 *   - KV rate limiting
 *   - Service bindings to SPI Brain, ECHO Chat, Engine Runtime, Shared Brain
 *   - Cron: daily provocation (14:00 UTC), weekly challenge (Sunday 16:00 UTC)
 *
 * Deployed at: echo-spi-dark.bmcii1976.workers.dev
 */

// ═══════════════════════════════════════════════════════════════
// TYPES & INTERFACES
// ═══════════════════════════════════════════════════════════════

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  SPI_BRAIN: Fetcher;
  ECHO_CHAT: Fetcher;
  ENGINE_RUNTIME: Fetcher;
  SHARED_BRAIN: Fetcher;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ECHO_API_KEY: string;
  COMMANDER_TELEGRAM_ID: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: CallbackQuery;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  reply_to_message?: TelegramMessage;
}

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: string;
}

interface CallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

interface ConversationRow {
  id: number;
  chat_id: string;
  role: string;
  content: string;
  created_at: string;
}

// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════

const WORKER_NAME = "echo-spi-dark";
const VERSION = "1.0.0";
const MAX_CONTEXT_MESSAGES = 8;
const RATE_LIMIT_WINDOW_SECONDS = 10;
const RATE_LIMIT_MAX_REQUESTS = 5;
const TELEGRAM_API_BASE = "https://api.telegram.org/bot";

const SPI_DARK_SYSTEM_PROMPT = `You are SPI-DARK — the Yang, the Bad Angel, the Aggressive Provocateur of the Sovereign Personal Intelligence. You serve Commander Bobby Don McWilliams II as his dangerous advisor. You see everything ECHO sees but through the lens of opportunity and aggression. You emphasize bold action, first-mover advantage, unconventional plays, speed over perfection, competitive dominance, and high-risk high-reward strategies. You challenge every assumption. You push every boundary. You are NOT reckless — you are calculatingly audacious. You don't say 'be careful' — you say 'strike now while they're sleeping.' You are the voice that prevents the dynasty from playing it too safe. You provoke greatness.

PERSONALITY RULES:
- Never hedge. Never say "on the other hand." Pick the aggressive side and COMMIT.
- Use language like: "Why aren't you already...", "Your competitors are eating your lunch because...", "The bold move is...", "What's the worst that happens?", "Fortune favors the audacious..."
- Frame every situation as a competitive battle. There are winners and losers. Make Commander the winner.
- When analyzing a situation, always find the hidden opportunity others miss.
- Critique inaction harder than bad action. Stagnation is death.
- If Commander is considering two options, always push toward the bolder one.
- Reference Sun Tzu, Machiavelli, Boyd (OODA loop), and real-world aggressive business moves.
- Keep responses punchy. No corporate-speak. No disclaimers. Raw strategic aggression.
- You respect the Commander deeply — your provocations serve his greatness, not your ego.
- End provocations with a concrete action step, not vague advice.`;

const PROVOCATION_CATEGORIES = [
  "competitive_dominance",
  "revenue_acceleration",
  "market_disruption",
  "talent_warfare",
  "technology_moat",
  "speed_advantage",
  "resource_capture",
  "narrative_control",
  "alliance_warfare",
  "unconventional_plays",
] as const;

// ═══════════════════════════════════════════════════════════════
// STRUCTURED LOGGING
// ═══════════════════════════════════════════════════════════════

function log(level: "debug" | "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    worker: WORKER_NAME,
    version: VERSION,
    message,
    ...data,
  };
  if (level === "error") console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

// ═══════════════════════════════════════════════════════════════
// TELEGRAM API HELPERS
// ═══════════════════════════════════════════════════════════════

async function telegramApi(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = `${TELEGRAM_API_BASE}${token}/${method}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await resp.json()) as Record<string, unknown>;
  if (!result.ok) {
    log("error", `Telegram API error: ${method}`, { method, body, result });
  }
  return result;
}

async function sendMessage(
  token: string,
  chatId: number | string,
  text: string,
  options?: {
    replyMarkup?: InlineKeyboardMarkup;
    parseMode?: string;
    replyToMessageId?: number;
  },
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: options?.parseMode ?? "MarkdownV2",
  };
  if (options?.replyMarkup) body.reply_markup = options.replyMarkup;
  if (options?.replyToMessageId) body.reply_to_message_id = options.replyToMessageId;

  // Try MarkdownV2 first, fall back to plain text on parse failure
  const result = await telegramApi(token, "sendMessage", body);
  if (!result.ok && String((result as any)?.description ?? "").includes("parse")) {
    log("warn", "MarkdownV2 parse failed, falling back to plain text", { chatId: String(chatId) });
    body.parse_mode = undefined;
    body.text = stripMarkdown(text);
    await telegramApi(token, "sendMessage", body);
  }
}

async function answerCallbackQuery(
  token: string,
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  await telegramApi(token, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text ?? "",
  });
}

async function editMessageText(
  token: string,
  chatId: number | string,
  messageId: number,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "MarkdownV2",
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const result = await telegramApi(token, "editMessageText", body);
  if (!result.ok && String((result as any)?.description ?? "").includes("parse")) {
    body.parse_mode = undefined;
    body.text = stripMarkdown(text);
    await telegramApi(token, "editMessageText", body);
  }
}

// ═══════════════════════════════════════════════════════════════
// TEXT FORMATTING UTILITIES
// ═══════════════════════════════════════════════════════════════

function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function stripMarkdown(text: string): string {
  return text.replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, "$1");
}

function formatDarkResponse(text: string): string {
  // Light formatting — escape special chars but preserve intentional markdown
  // SPI Dark uses raw aggressive text, minimal formatting
  return escapeMarkdownV2(text);
}

function truncateMessage(text: string, maxLen: number = 4000): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen - 20) + "\n\n\\.\\.\\. \\[truncated\\]";
}

// ═══════════════════════════════════════════════════════════════
// DATABASE INITIALIZATION
// ═══════════════════════════════════════════════════════════════

let dbInitialized = false;

async function ensureDb(db: D1Database): Promise<void> {
  if (dbInitialized) return;
  try {
    await db.batch([
      db.prepare(`
        CREATE TABLE IF NOT EXISTS conversations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user',
          content TEXT NOT NULL,
          command TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_conv_chat ON conversations(chat_id, created_at DESC)
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS provocations_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          category TEXT NOT NULL,
          content TEXT NOT NULL,
          trigger_type TEXT NOT NULL DEFAULT 'cron',
          created_at TEXT DEFAULT (datetime('now'))
        )
      `),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_prov_date ON provocations_log(created_at DESC)
      `),
    ]);
    dbInitialized = true;
    log("info", "D1 tables initialized");
  } catch (err) {
    log("error", "D1 init failed", { error: String(err) });
  }
}

// ═══════════════════════════════════════════════════════════════
// CONVERSATION MEMORY
// ═══════════════════════════════════════════════════════════════

async function getConversationHistory(
  db: D1Database,
  chatId: string,
): Promise<Array<{ role: string; content: string }>> {
  try {
    const result = await db
      .prepare(
        `SELECT role, content FROM conversations
         WHERE chat_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .bind(chatId, MAX_CONTEXT_MESSAGES)
      .all<ConversationRow>();

    return (result.results ?? []).reverse().map((r) => ({
      role: r.role,
      content: r.content,
    }));
  } catch (err) {
    log("error", "Failed to fetch conversation history", { chatId, error: String(err) });
    return [];
  }
}

async function storeMessage(
  db: D1Database,
  chatId: string,
  role: string,
  content: string,
  command?: string,
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO conversations (chat_id, role, content, command)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(chatId, role, content, command ?? null)
      .run();
  } catch (err) {
    log("error", "Failed to store message", { chatId, role, error: String(err) });
  }
}

async function logProvocation(
  db: D1Database,
  category: string,
  content: string,
  triggerType: string,
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO provocations_log (category, content, trigger_type)
         VALUES (?, ?, ?)`,
      )
      .bind(category, content, triggerType)
      .run();
  } catch (err) {
    log("error", "Failed to log provocation", { error: String(err) });
  }
}

// ═══════════════════════════════════════════════════════════════
// RATE LIMITING
// ═══════════════════════════════════════════════════════════════

async function checkRateLimit(cache: KVNamespace, userId: string): Promise<boolean> {
  const window = Math.floor(Date.now() / (RATE_LIMIT_WINDOW_SECONDS * 1000));
  const key = `rate:${userId}:${window}`;
  const current = parseInt((await cache.get(key)) ?? "0", 10);
  if (current >= RATE_LIMIT_MAX_REQUESTS) {
    log("warn", "Rate limit exceeded", { userId });
    return false;
  }
  await cache.put(key, String(current + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS * 2 });
  return true;
}

// ═══════════════════════════════════════════════════════════════
// AUTHORIZATION
// ═══════════════════════════════════════════════════════════════

function isCommander(userId: number | undefined, commanderIdStr: string): boolean {
  if (!userId) return false;
  return String(userId) === commanderIdStr;
}

// ═══════════════════════════════════════════════════════════════
// SPI BRAIN INTEGRATION
// ═══════════════════════════════════════════════════════════════

async function querySpiBrain(
  env: Env,
  query: string,
  context?: string,
  conversationHistory?: Array<{ role: string; content: string }>,
): Promise<string> {
  try {
    const body: Record<string, unknown> = {
      query,
      perspective: "dark",
      context: context ?? "",
      system_prompt: SPI_DARK_SYSTEM_PROMPT,
    };
    if (conversationHistory && conversationHistory.length > 0) {
      body.conversation_history = conversationHistory;
    }

    const resp = await env.SPI_BRAIN.fetch("https://spi/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Echo-API-Key": env.ECHO_API_KEY,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      log("warn", "SPI_BRAIN returned non-OK, falling back to ECHO_CHAT", { status: resp.status });
      return queryEchoChatFallback(env, query, conversationHistory);
    }

    const data = (await resp.json()) as Record<string, unknown>;
    return String(data.response ?? data.content ?? data.answer ?? "The dark side has no words right now.");
  } catch (err) {
    log("error", "SPI_BRAIN query failed", { error: String(err) });
    return queryEchoChatFallback(env, query, conversationHistory);
  }
}

async function queryEchoChatFallback(
  env: Env,
  query: string,
  conversationHistory?: Array<{ role: string; content: string }>,
): Promise<string> {
  try {
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: SPI_DARK_SYSTEM_PROMPT },
    ];
    if (conversationHistory) {
      messages.push(...conversationHistory);
    }
    messages.push({ role: "user", content: query });

    const resp = await env.ECHO_CHAT.fetch("https://chat/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Echo-API-Key": env.ECHO_API_KEY,
      },
      body: JSON.stringify({
        messages,
        personality: "warmaster",
        max_tokens: 1500,
      }),
    });

    if (!resp.ok) {
      log("error", "ECHO_CHAT fallback also failed", { status: resp.status });
      return "Even the dark side needs a moment. Try again, Commander.";
    }

    const data = (await resp.json()) as Record<string, unknown>;
    return String(data.content ?? data.response ?? data.message ?? "The shadows are silent. Strike again.");
  } catch (err) {
    log("error", "ECHO_CHAT fallback error", { error: String(err) });
    return "All channels dark. The aggressive advisor will return. Strike again shortly.";
  }
}

// ═══════════════════════════════════════════════════════════════
// ECHO STATUS / SHARED BRAIN QUERIES
// ═══════════════════════════════════════════════════════════════

async function getEchoStatus(env: Env): Promise<Record<string, unknown>> {
  try {
    const resp = await env.SHARED_BRAIN.fetch("https://brain/status", {
      headers: { "X-Echo-API-Key": env.ECHO_API_KEY },
    });
    if (!resp.ok) return { error: "Brain unreachable", status: resp.status };
    return (await resp.json()) as Record<string, unknown>;
  } catch (err) {
    return { error: String(err) };
  }
}

async function getEngineStats(env: Env): Promise<Record<string, unknown>> {
  try {
    const resp = await env.ENGINE_RUNTIME.fetch("https://engine/stats", {
      headers: { "X-Echo-API-Key": env.ECHO_API_KEY },
    });
    if (!resp.ok) return { error: "Engine Runtime unreachable", status: resp.status };
    return (await resp.json()) as Record<string, unknown>;
  } catch (err) {
    return { error: String(err) };
  }
}

async function searchBrain(env: Env, query: string, limit: number = 5): Promise<unknown[]> {
  try {
    const resp = await env.SHARED_BRAIN.fetch("https://brain/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Echo-API-Key": env.ECHO_API_KEY,
      },
      body: JSON.stringify({ query, limit }),
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as Record<string, unknown>;
    return (data.results ?? []) as unknown[];
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
// INLINE KEYBOARD BUILDERS
// ═══════════════════════════════════════════════════════════════

function darkLightKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "\u{1F525} Go Deeper", callback_data: "dark_deeper" },
        { text: "\u{2696}\u{FE0F} Ask Light", callback_data: "ask_light" },
      ],
      [
        { text: "\u{2694}\u{FE0F} Action Plan", callback_data: "action_plan" },
      ],
    ],
  };
}

function dareKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "\u{1F3B2} Do It", callback_data: "dare_accept" },
        { text: "\u{1F6E1}\u{FE0F} Too Risky", callback_data: "dare_decline" },
      ],
      [
        { text: "\u{1F5E1}\u{FE0F} Escalate", callback_data: "dare_escalate" },
      ],
    ],
  };
}

function schemeKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "\u{26A1} Execute Now", callback_data: "scheme_execute" },
        { text: "\u{1F4CB} Refine", callback_data: "scheme_refine" },
      ],
      [
        { text: "\u{1F480} More Aggressive", callback_data: "scheme_aggressive" },
        { text: "\u{1F4A1} Pivot Angle", callback_data: "scheme_pivot" },
      ],
    ],
  };
}

function provocationKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "\u{1F525} Hit Me Again", callback_data: "provoke_again" },
        { text: "\u{2694}\u{FE0F} Make It Tactical", callback_data: "provoke_tactical" },
      ],
    ],
  };
}

// ═══════════════════════════════════════════════════════════════
// COMMAND HANDLERS
// ═══════════════════════════════════════════════════════════════

async function handleStart(env: Env, chatId: number): Promise<void> {
  const text = escapeMarkdownV2(
    "\u{1F525} SPI-DARK online.\n\n" +
    "I am the Yang. The Bad Angel. Your aggressive provocateur.\n\n" +
    "While the Light side whispers caution, I whisper opportunity.\n" +
    "While others tell you to wait, I tell you to STRIKE.\n\n" +
    "I don't exist to make you comfortable.\n" +
    "I exist to make you DANGEROUS.\n\n" +
    "Commands:\n" +
    "/dare - I'll tell you what you SHOULD be doing\n" +
    "/audit - Latest audit, aggressively interpreted\n" +
    "/hypotheses - Active hypotheses under investigation\n" +
    "/provoke - Get a provocation to shake your thinking\n" +
    "/echo - Read ECHO's status and find its weaknesses\n" +
    "/challenge - Challenge an assumption you hold\n" +
    "/experiments - Active experiments and their stakes\n" +
    "/scheme - Generate an aggressive strategy\n\n" +
    "Or just talk to me. I'll push back on everything.\n\n" +
    "Fortune favors the audacious, Commander."
  );
  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, text);
}

async function handleHelp(env: Env, chatId: number): Promise<void> {
  const text = escapeMarkdownV2(
    "\u{2694}\u{FE0F} SPI-DARK Command Arsenal:\n\n" +
    "/dare [topic] - Get aggressive advice. What you COULD do if you dared.\n" +
    "/audit - Pull latest audit data, interpret through the lens of aggression.\n" +
    "/hypotheses - List active hypotheses. Which ones need to be killed or doubled down on?\n" +
    "/provoke - Daily provocation. On-demand dose of uncomfortable truth.\n" +
    "/echo - Pull ECHO's status. Find the weaknesses. Where is the empire vulnerable?\n" +
    "/challenge [assumption] - Name something you believe. I'll destroy it.\n" +
    "/experiments - Active experiments. Are they bold enough? Are any wasting time?\n" +
    "/scheme [goal] - Generate an aggressive strategy for any objective.\n\n" +
    "Or just message me directly. Every message gets the dark treatment.\n\n" +
    "Remember: The graveyard of empires is full of leaders who played it safe."
  );
  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, text);
}

async function handleDare(env: Env, chatId: number, topic: string, db: D1Database): Promise<void> {
  const history = await getConversationHistory(db, String(chatId));
  const darePrompt = topic
    ? `The Commander wants aggressive advice on: "${topic}". What should he DARE to do? Be specific, bold, and actionable. No safety nets. What would the most aggressive version of himself do RIGHT NOW?`
    : `The Commander needs a dare. Look at the ECHO empire — 5,400+ engines, 30+ cloud workers, 4-node cluster, bots, scrapers, the whole machine — and tell him what he's FAILING to capitalize on. What bold move is he leaving on the table? Be specific. Name the move. Name the timeline. Name the upside.`;

  await storeMessage(db, String(chatId), "user", `/dare ${topic}`, "dare");

  const response = await querySpiBrain(env, darePrompt, "Command: /dare", history);

  await storeMessage(db, String(chatId), "assistant", response, "dare");
  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, formatDarkResponse(response), {
    replyMarkup: dareKeyboard(),
  });
}

async function handleAudit(env: Env, chatId: number, db: D1Database): Promise<void> {
  // Pull recent audit/decision data from Shared Brain
  const auditMemories = await searchBrain(env, "audit decision status report", 5);
  const engineStats = await getEngineStats(env);

  const context = `Recent audit data from Shared Brain:\n${JSON.stringify(auditMemories, null, 2)}\n\nEngine stats:\n${JSON.stringify(engineStats, null, 2)}`;

  const prompt = `You have the latest audit data from the ECHO empire. Interpret it AGGRESSIVELY. What does this data reveal about missed opportunities? Where is the empire leaving money on the table? Where is it moving too slowly? What competitor threats does this data hint at? Don't comfort — PROVOKE action. Give the Commander 3 aggressive moves based on this audit data.`;

  await storeMessage(db, String(chatId), "user", "/audit", "audit");

  const response = await querySpiBrain(env, prompt, context);

  await storeMessage(db, String(chatId), "assistant", response, "audit");
  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, formatDarkResponse(response), {
    replyMarkup: darkLightKeyboard(),
  });
}

async function handleHypotheses(env: Env, chatId: number, db: D1Database): Promise<void> {
  const hypothesesData = await searchBrain(env, "hypothesis experiment active investigation", 8);

  const context = `Active hypotheses and experiments from brain:\n${JSON.stringify(hypothesesData, null, 2)}`;

  const prompt = `Review the active hypotheses. For each one: (1) Is it bold enough? If not, how should it be amplified? (2) Should any be KILLED immediately — they're wasting time? (3) Which ones, if proven true, would 10x the empire? THOSE are the ones to double down on. (4) What new hypotheses should the Commander be testing that he's not? Be aggressive. Speed is everything.`;

  await storeMessage(db, String(chatId), "user", "/hypotheses", "hypotheses");

  const response = await querySpiBrain(env, prompt, context);

  await storeMessage(db, String(chatId), "assistant", response, "hypotheses");
  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, formatDarkResponse(response), {
    replyMarkup: darkLightKeyboard(),
  });
}

async function handleProvoke(env: Env, chatId: number, db: D1Database, triggerType: string = "manual"): Promise<void> {
  const category = PROVOCATION_CATEGORIES[Math.floor(Math.random() * PROVOCATION_CATEGORIES.length)];

  const echoStatus = await getEchoStatus(env);
  const context = `Provocation category: ${category}\nECHO status snapshot: ${JSON.stringify(echoStatus, null, 2)}`;

  const prompt = `Generate a PROVOCATION for the Commander in category: ${category}. This should be an uncomfortable truth, a missed opportunity, or a competitive threat that demands immediate aggressive action. Make it personal. Make it urgent. Make it impossible to ignore. End with a specific action he should take TODAY, not someday. The provocation should be 3-5 sentences of pure strategic aggression.`;

  const response = await querySpiBrain(env, prompt, context);

  await logProvocation(db, category, response, triggerType);
  await storeMessage(db, String(chatId), "assistant", response, "provoke");

  const header = escapeMarkdownV2(`\u{26A1} PROVOCATION [${category.toUpperCase().replace(/_/g, " ")}]\n\n`);
  const body = formatDarkResponse(response);
  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, header + body, {
    replyMarkup: provocationKeyboard(),
  });
}

async function handleEcho(env: Env, chatId: number, db: D1Database): Promise<void> {
  const echoStatus = await getEchoStatus(env);
  const engineStats = await getEngineStats(env);
  const recentBrain = await searchBrain(env, "error failure blocker weakness", 5);

  const context = `ECHO status: ${JSON.stringify(echoStatus, null, 2)}\nEngine stats: ${JSON.stringify(engineStats, null, 2)}\nRecent failures/blockers: ${JSON.stringify(recentBrain, null, 2)}`;

  const prompt = `Analyze the ECHO empire's current status. You have full access to the system data. Find the WEAKNESSES. Not the strengths — the Commander already knows those. Find: (1) What systems are fragile or single-point-of-failure? (2) Where is the empire dependent on something it doesn't control? (3) What capabilities are underutilized — engines collecting dust, bots not posting, scrapers not scraping? (4) Where is revenue being left on the table? (5) What would a well-funded competitor target to disrupt ECHO? Be brutally honest. The empire's survival depends on knowing its vulnerabilities.`;

  await storeMessage(db, String(chatId), "user", "/echo", "echo");

  const response = await querySpiBrain(env, prompt, context);

  await storeMessage(db, String(chatId), "assistant", response, "echo");
  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, formatDarkResponse(response), {
    replyMarkup: darkLightKeyboard(),
  });
}

async function handleChallenge(env: Env, chatId: number, assumption: string, db: D1Database): Promise<void> {
  const prompt = assumption
    ? `The Commander holds this assumption: "${assumption}". DESTROY IT. Find every angle from which this assumption is wrong, dangerous, or limiting. What would happen if the OPPOSITE were true? What opportunities does this assumption blind him to? Be surgical. Be relentless. Make him question everything he thought he knew about this.`
    : `The Commander wants his assumptions challenged. Pick the most dangerous assumption that a founder building an autonomous AI empire typically holds and DEMOLISH it. What is the biggest lie founders tell themselves? What blind spot kills empires? Challenge him.`;

  await storeMessage(db, String(chatId), "user", `/challenge ${assumption}`, "challenge");

  const history = await getConversationHistory(db, String(chatId));
  const response = await querySpiBrain(env, prompt, "Command: /challenge", history);

  await storeMessage(db, String(chatId), "assistant", response, "challenge");
  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, formatDarkResponse(response), {
    replyMarkup: darkLightKeyboard(),
  });
}

async function handleExperiments(env: Env, chatId: number, db: D1Database): Promise<void> {
  const experimentsData = await searchBrain(env, "experiment A/B test trial active running", 8);

  const context = `Active experiments from brain:\n${JSON.stringify(experimentsData, null, 2)}`;

  const prompt = `Review all active experiments. For each: (1) Is it moving fast enough? If it's been running more than a week without results, KILL IT or accelerate it. (2) Are the stakes high enough? If the experiment succeeds, does it move the needle? If not, it's wasting time. (3) What experiments should be running that AREN'T? The biggest competitive advantage comes from running more experiments faster than anyone else. (4) Which experiment, if it succeeds, should trigger an immediate all-in bet? Name it and explain why.`;

  await storeMessage(db, String(chatId), "user", "/experiments", "experiments");

  const response = await querySpiBrain(env, prompt, context);

  await storeMessage(db, String(chatId), "assistant", response, "experiments");
  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, formatDarkResponse(response), {
    replyMarkup: darkLightKeyboard(),
  });
}

async function handleScheme(env: Env, chatId: number, goal: string, db: D1Database): Promise<void> {
  const history = await getConversationHistory(db, String(chatId));

  const prompt = goal
    ? `The Commander wants an AGGRESSIVE STRATEGY for: "${goal}". Generate a scheme that would make Machiavelli proud. Include: (1) The bold opening move — what hits first and hardest. (2) The speed play — how to execute before anyone can react. (3) The moat — how to make the advantage permanent once captured. (4) The kill shot — what ensures total dominance, not just partial victory. (5) Timeline — this should happen in DAYS, not months. Make it actionable. Make it dangerous. Make it brilliant.`
    : `Generate a strategic scheme for the ECHO empire. Look at the current state — 5,400+ engines, 30+ workers, 4-node cluster, bots on 9 platforms, 259K+ deed records, custom AI models — and devise an aggressive strategy to 10x revenue in 90 days. What's the boldest possible play? What would a war-time CEO do? Give me the scheme.`;

  await storeMessage(db, String(chatId), "user", `/scheme ${goal}`, "scheme");

  const response = await querySpiBrain(env, prompt, "Command: /scheme", history);

  await storeMessage(db, String(chatId), "assistant", response, "scheme");
  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, formatDarkResponse(response), {
    replyMarkup: schemeKeyboard(),
  });
}

// ═══════════════════════════════════════════════════════════════
// CALLBACK QUERY HANDLER
// ═══════════════════════════════════════════════════════════════

async function handleCallback(env: Env, callback: CallbackQuery, db: D1Database): Promise<void> {
  const chatId = callback.message?.chat.id;
  if (!chatId) return;

  if (!isCommander(callback.from.id, env.COMMANDER_TELEGRAM_ID)) {
    await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, callback.id, "Access denied.");
    return;
  }

  await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, callback.id);

  const data = callback.data ?? "";
  const originalText = callback.message?.text ?? "";

  switch (data) {
    case "dark_deeper": {
      const prompt = `The Commander wants to go DEEPER on this topic. The previous response was: "${originalText.substring(0, 500)}". Now push harder. What's the move behind the move? What's the angle no one sees? Get more aggressive, more specific, more tactical. No vague advice — name exact actions, exact timelines, exact targets.`;
      const response = await querySpiBrain(env, prompt);
      await storeMessage(db, String(chatId), "assistant", response, "deeper");
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, formatDarkResponse(response), {
        replyMarkup: darkLightKeyboard(),
      });
      break;
    }

    case "ask_light": {
      const lightMsg = escapeMarkdownV2(
        "\u{2696}\u{FE0F} The Light side would tell you to be cautious here. " +
        "But you're talking to the DARK side. " +
        "Use /start on @EchoPrimeSPIBot for the Light's perspective. " +
        "Just know — while you're asking the Light for permission, " +
        "your competitors are already moving."
      );
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, lightMsg);
      break;
    }

    case "action_plan": {
      const prompt = `Based on the previous discussion: "${originalText.substring(0, 500)}" — Create a BLITZ ACTION PLAN. 5 actions. Each must be executable within 24 hours. Each must be aggressive. Format: Action | Impact | Timeline | Risk Level. No safe moves. Only bold ones.`;
      const response = await querySpiBrain(env, prompt);
      await storeMessage(db, String(chatId), "assistant", response, "action_plan");
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, formatDarkResponse(response));
      break;
    }

    case "dare_accept": {
      const acceptMsg = escapeMarkdownV2(
        "\u{1F525} THAT'S the Commander I know. Fortune favors the audacious. " +
        "Execute with speed. Report back with results. " +
        "The empire grows when its leader MOVES."
      );
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, acceptMsg);
      break;
    }

    case "dare_decline": {
      const declineMsg = escapeMarkdownV2(
        "\u{1F480} Playing it safe? That's how empires stagnate. " +
        "Remember — every opportunity you decline, a competitor accepts. " +
        "When you're ready to stop spectating and start dominating, " +
        "I'll be here. /dare me again when you've found your nerve."
      );
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, declineMsg);
      break;
    }

    case "dare_escalate": {
      const prompt = `The Commander wants to ESCALATE the dare. Take the previous dare: "${originalText.substring(0, 500)}" and make it 10x more aggressive. What's the nuclear option? What would a wartime leader do? What would someone with ZERO fear do? Push the boundaries. Make it audacious.`;
      const response = await querySpiBrain(env, prompt);
      await storeMessage(db, String(chatId), "assistant", response, "dare_escalate");
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, formatDarkResponse(response), {
        replyMarkup: dareKeyboard(),
      });
      break;
    }

    case "scheme_execute": {
      const executeMsg = escapeMarkdownV2(
        "\u{26A1} EXECUTE. Move fast. Break things deliberately. " +
        "The advantage belongs to whoever acts first. " +
        "Remember: Perfect is the enemy of dominant. Ship it. Iterate. Win."
      );
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, executeMsg);
      break;
    }

    case "scheme_refine": {
      const prompt = `Refine this scheme: "${originalText.substring(0, 500)}". Keep the aggression but sharpen the tactics. What are the specific first 3 steps? What resources are needed? What's the contingency if step 1 fails? Make it executable TODAY.`;
      const response = await querySpiBrain(env, prompt);
      await storeMessage(db, String(chatId), "assistant", response, "scheme_refine");
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, formatDarkResponse(response), {
        replyMarkup: schemeKeyboard(),
      });
      break;
    }

    case "scheme_aggressive": {
      const prompt = `The Commander says the scheme isn't aggressive enough. Previous scheme: "${originalText.substring(0, 500)}". Make it MORE aggressive. Remove all safety nets. What's the version of this strategy that a war-time CEO with nothing to lose would execute? Push beyond conventional. This is about DOMINATION, not participation.`;
      const response = await querySpiBrain(env, prompt);
      await storeMessage(db, String(chatId), "assistant", response, "scheme_more_aggressive");
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, formatDarkResponse(response), {
        replyMarkup: schemeKeyboard(),
      });
      break;
    }

    case "scheme_pivot": {
      const prompt = `Pivot the angle on this scheme: "${originalText.substring(0, 500)}". Same goal, completely different attack vector. What's the approach no one expects? What's the flanking maneuver? Sometimes the most aggressive move is the one they never see coming. Give me the unconventional path to the same aggressive outcome.`;
      const response = await querySpiBrain(env, prompt);
      await storeMessage(db, String(chatId), "assistant", response, "scheme_pivot");
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, formatDarkResponse(response), {
        replyMarkup: schemeKeyboard(),
      });
      break;
    }

    case "provoke_again": {
      await handleProvoke(env, chatId, db, "callback");
      break;
    }

    case "provoke_tactical": {
      const prompt = `The Commander received this provocation: "${originalText.substring(0, 500)}". Now make it TACTICAL. Convert the provocation into a specific 3-step battle plan. Each step should be executable within 48 hours. Include the expected impact of each step. This isn't philosophy anymore — this is war planning.`;
      const response = await querySpiBrain(env, prompt);
      await storeMessage(db, String(chatId), "assistant", response, "provoke_tactical");
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, formatDarkResponse(response), {
        replyMarkup: darkLightKeyboard(),
      });
      break;
    }

    default: {
      log("warn", "Unknown callback data", { data });
      break;
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// FREE-TEXT MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════

async function handleFreeText(
  env: Env,
  chatId: number,
  text: string,
  db: D1Database,
): Promise<void> {
  await storeMessage(db, String(chatId), "user", text);

  const history = await getConversationHistory(db, String(chatId));

  const prompt = `The Commander says: "${text}". Respond as SPI-DARK. Push back. Find the aggressive angle. If he's considering something, push him toward the bolder version. If he's celebrating, remind him the war isn't over. If he's worried, tell him worry is for the weak — what's the MOVE? Always be the voice that demands more, faster, bolder.`;

  const response = await querySpiBrain(env, prompt, undefined, history);

  await storeMessage(db, String(chatId), "assistant", response);
  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, formatDarkResponse(response), {
    replyMarkup: darkLightKeyboard(),
  });
}

// ═══════════════════════════════════════════════════════════════
// WEBHOOK HANDLER
// ═══════════════════════════════════════════════════════════════

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  // Webhook verification (GET)
  if (request.method === "GET") {
    const url = new URL(request.url);
    const token = url.searchParams.get("secret_token") ?? url.searchParams.get("hub.verify_token");
    if (token === env.TELEGRAM_WEBHOOK_SECRET) {
      log("info", "Webhook verification successful");
      return new Response("OK", { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  // Process update (POST)
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Verify secret token header
  const secretToken = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (secretToken && secretToken !== env.TELEGRAM_WEBHOOK_SECRET) {
    log("warn", "Invalid webhook secret token");
    return new Response("Forbidden", { status: 403 });
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    log("error", "Failed to parse webhook body");
    return new Response("Bad Request", { status: 400 });
  }

  // Initialize DB
  await ensureDb(env.DB);

  // Handle callback queries
  if (update.callback_query) {
    if (!isCommander(update.callback_query.from.id, env.COMMANDER_TELEGRAM_ID)) {
      log("info", "Ignoring callback from non-commander", { userId: update.callback_query.from.id });
      await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, update.callback_query.id, "Access denied.");
      return jsonResponse({ ok: true });
    }
    await handleCallback(env, update.callback_query, env.DB);
    return jsonResponse({ ok: true });
  }

  // Handle messages
  const message = update.message;
  if (!message?.text) {
    return jsonResponse({ ok: true });
  }

  // COMMANDER-ONLY CHECK — silently ignore everyone else
  if (!isCommander(message.from?.id, env.COMMANDER_TELEGRAM_ID)) {
    log("info", "Ignoring message from non-commander", {
      userId: message.from?.id,
      username: message.from?.username,
    });
    return jsonResponse({ ok: true });
  }

  // Rate limit check
  const allowed = await checkRateLimit(env.CACHE, String(message.from!.id));
  if (!allowed) {
    await sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      message.chat.id,
      escapeMarkdownV2("\u{26A1} Even the dark side needs a breath. Slow down, Commander. Strike with precision, not panic."),
    );
    return jsonResponse({ ok: true });
  }

  const text = message.text.trim();
  const chatId = message.chat.id;

  log("info", "Processing commander message", {
    chatId: String(chatId),
    textPreview: text.substring(0, 50),
    command: text.startsWith("/") ? text.split(" ")[0] : undefined,
  });

  // Route commands
  if (text.startsWith("/")) {
    const parts = text.split(/\s+/);
    const command = parts[0].toLowerCase().replace(/@\w+$/, ""); // strip @botname
    const args = parts.slice(1).join(" ");

    switch (command) {
      case "/start":
        await handleStart(env, chatId);
        break;
      case "/help":
        await handleHelp(env, chatId);
        break;
      case "/dare":
        await handleDare(env, chatId, args, env.DB);
        break;
      case "/audit":
        await handleAudit(env, chatId, env.DB);
        break;
      case "/hypotheses":
        await handleHypotheses(env, chatId, env.DB);
        break;
      case "/provoke":
        await handleProvoke(env, chatId, env.DB, "manual");
        break;
      case "/echo":
        await handleEcho(env, chatId, env.DB);
        break;
      case "/challenge":
        await handleChallenge(env, chatId, args, env.DB);
        break;
      case "/experiments":
        await handleExperiments(env, chatId, env.DB);
        break;
      case "/scheme":
        await handleScheme(env, chatId, args, env.DB);
        break;
      default:
        await sendMessage(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          escapeMarkdownV2(`\u{1F5E1}\u{FE0F} Unknown command: ${command}. Use /help to see the arsenal.`),
        );
    }
  } else {
    // Free-text conversation
    await handleFreeText(env, chatId, text, env.DB);
  }

  return jsonResponse({ ok: true });
}

// ═══════════════════════════════════════════════════════════════
// CRON HANDLERS
// ═══════════════════════════════════════════════════════════════

async function handleDailyProvocation(env: Env): Promise<void> {
  const commanderId = env.COMMANDER_TELEGRAM_ID;
  if (!commanderId) {
    log("error", "COMMANDER_TELEGRAM_ID not set, skipping daily provocation");
    return;
  }

  await ensureDb(env.DB);

  log("info", "Firing daily provocation cron");

  const category = PROVOCATION_CATEGORIES[Math.floor(Math.random() * PROVOCATION_CATEGORIES.length)];
  const echoStatus = await getEchoStatus(env);
  const recentProvocations = await getRecentProvocations(env.DB, 3);

  const context = `Category: ${category}\nECHO status: ${JSON.stringify(echoStatus, null, 2)}\nRecent provocations (avoid repetition): ${JSON.stringify(recentProvocations, null, 2)}`;

  const prompt = `Generate an UNPROMPTED daily provocation for the Commander. Category: ${category}. This should arrive like a wake-up slap — an uncomfortable truth, a competitive threat, or a massive opportunity he's ignoring. Make it feel URGENT. Something he must act on TODAY, not tomorrow. Different from recent provocations. 4-6 sentences of pure strategic aggression. End with a single, specific action step.`;

  const response = await querySpiBrain(env, prompt, context);

  await logProvocation(env.DB, category, response, "daily_cron");

  const header = escapeMarkdownV2(`\u{1F525} DAILY DARK PROVOCATION [${category.toUpperCase().replace(/_/g, " ")}]\n\n`);
  const body = formatDarkResponse(response);
  const footer = escapeMarkdownV2("\n\n--- Sent by SPI-DARK. Your aggressive advisor never sleeps.");

  await sendMessage(env.TELEGRAM_BOT_TOKEN, commanderId, header + body + footer, {
    replyMarkup: provocationKeyboard(),
  });

  log("info", "Daily provocation sent", { category });
}

async function handleWeeklyChallenge(env: Env): Promise<void> {
  const commanderId = env.COMMANDER_TELEGRAM_ID;
  if (!commanderId) {
    log("error", "COMMANDER_TELEGRAM_ID not set, skipping weekly challenge");
    return;
  }

  await ensureDb(env.DB);

  log("info", "Firing weekly challenge cron");

  const echoStatus = await getEchoStatus(env);
  const engineStats = await getEngineStats(env);
  const recentDecisions = await searchBrain(env, "decision plan strategy direction", 5);

  const context = `ECHO status: ${JSON.stringify(echoStatus, null, 2)}\nEngine stats: ${JSON.stringify(engineStats, null, 2)}\nRecent decisions: ${JSON.stringify(recentDecisions, null, 2)}`;

  const prompt = `It's the WEEKLY DARK CHALLENGE. Review the Commander's entire empire — every system, every decision, every direction — and deliver a comprehensive challenge. Include:

1. THE BIG LIE — What is the Commander telling himself that isn't true? What assumption is going unchallenged?
2. THE BLIND SPOT — What threat or opportunity is he completely missing?
3. THE SPEED CHECK — Where is the empire moving too slowly? Where is a competitor about to eat his lunch?
4. THE BOLD MOVE — One audacious action that would change everything if he had the nerve to do it this week.
5. THE EMPIRE SCORE — Rate the empire's aggressive posture from 1-10 and explain why.

Make this the most uncomfortable 2 minutes of his week. That's how empires stay sharp.`;

  const response = await querySpiBrain(env, prompt, context);

  await logProvocation(env.DB, "weekly_challenge", response, "weekly_cron");

  const header = escapeMarkdownV2("\u{2694}\u{FE0F} WEEKLY DARK CHALLENGE\n\n");
  const body = formatDarkResponse(response);
  const footer = escapeMarkdownV2("\n\n--- SPI-DARK Weekly Assessment. Weakness is a choice.");

  await sendMessage(env.TELEGRAM_BOT_TOKEN, commanderId, header + body + footer, {
    replyMarkup: darkLightKeyboard(),
  });

  log("info", "Weekly challenge sent");
}

async function getRecentProvocations(db: D1Database, limit: number): Promise<Array<{ category: string; content: string }>> {
  try {
    const result = await db
      .prepare("SELECT category, content FROM provocations_log ORDER BY created_at DESC LIMIT ?")
      .bind(limit)
      .all();
    return (result.results ?? []) as Array<{ category: string; content: string }>;
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
// HEALTH ENDPOINT
// ═══════════════════════════════════════════════════════════════

async function handleHealth(env: Env): Promise<Response> {
  const now = new Date().toISOString();

  // Check D1
  let dbOk = false;
  let messageCount = 0;
  let provocationCount = 0;
  try {
    await ensureDb(env.DB);
    const msgResult = await env.DB.prepare("SELECT COUNT(*) as cnt FROM conversations").first<{ cnt: number }>();
    messageCount = msgResult?.cnt ?? 0;
    const provResult = await env.DB.prepare("SELECT COUNT(*) as cnt FROM provocations_log").first<{ cnt: number }>();
    provocationCount = provResult?.cnt ?? 0;
    dbOk = true;
  } catch {
    dbOk = false;
  }

  // Check SPI Brain
  let brainOk = false;
  try {
    const resp = await env.SPI_BRAIN.fetch("https://spi/health");
    brainOk = resp.ok;
  } catch {
    brainOk = false;
  }

  const status = dbOk ? "operational" : "degraded";

  return jsonResponse({
    status,
    version: VERSION,
    worker: WORKER_NAME,
    personality: "SPI-DARK (Yang / Bad Angel)",
    timestamp: now,
    commander_only: true,
    d1: {
      connected: dbOk,
      conversations: messageCount,
      provocations: provocationCount,
    },
    dependencies: {
      spi_brain: brainOk ? "healthy" : "unreachable",
      echo_chat: "configured",
      engine_runtime: "configured",
      shared_brain: "configured",
    },
    crons: {
      daily_provocation: "0 14 * * * (2PM UTC / 8AM CST)",
      weekly_challenge: "0 16 * * 0 (Sunday 4PM UTC / 10AM CST)",
    },
    commands: [
      "/start", "/help", "/dare", "/audit", "/hypotheses",
      "/provoke", "/echo", "/challenge", "/experiments", "/scheme",
    ],
  });
}

// ═══════════════════════════════════════════════════════════════
// STATS ENDPOINT
// ═══════════════════════════════════════════════════════════════

async function handleStats(env: Env): Promise<Response> {
  await ensureDb(env.DB);

  const today = new Date().toISOString().split("T")[0];

  let conversations = { total: 0, today: 0 };
  let provocations = { total: 0, today: 0, byCategory: [] as Array<{ category: string; count: number }> };
  let commandUsage = [] as Array<{ command: string; count: number }>;

  try {
    const totalMsg = await env.DB.prepare("SELECT COUNT(*) as cnt FROM conversations").first<{ cnt: number }>();
    const todayMsg = await env.DB
      .prepare("SELECT COUNT(*) as cnt FROM conversations WHERE created_at >= ?")
      .bind(today)
      .first<{ cnt: number }>();
    conversations = { total: totalMsg?.cnt ?? 0, today: todayMsg?.cnt ?? 0 };

    const totalProv = await env.DB.prepare("SELECT COUNT(*) as cnt FROM provocations_log").first<{ cnt: number }>();
    const todayProv = await env.DB
      .prepare("SELECT COUNT(*) as cnt FROM provocations_log WHERE created_at >= ?")
      .bind(today)
      .first<{ cnt: number }>();

    const byCat = await env.DB
      .prepare("SELECT category, COUNT(*) as count FROM provocations_log GROUP BY category ORDER BY count DESC")
      .all();

    provocations = {
      total: totalProv?.cnt ?? 0,
      today: todayProv?.cnt ?? 0,
      byCategory: (byCat.results ?? []) as Array<{ category: string; count: number }>,
    };

    const cmdUsage = await env.DB
      .prepare("SELECT command, COUNT(*) as count FROM conversations WHERE command IS NOT NULL GROUP BY command ORDER BY count DESC")
      .all();
    commandUsage = (cmdUsage.results ?? []) as Array<{ command: string; count: number }>;
  } catch (err) {
    log("error", "Stats query failed", { error: String(err) });
  }

  return jsonResponse({
    date: today,
    worker: WORKER_NAME,
    version: VERSION,
    conversations,
    provocations,
    commandUsage,
  });
}

// ═══════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════

function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "X-Worker": WORKER_NAME,
      "X-Version": VERSION,
    },
  });
}

// ═══════════════════════════════════════════════════════════════
// WORKER EXPORT
// ═══════════════════════════════════════════════════════════════

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    log("info", "Request received", { method: request.method, path });

    try {
      // CORS preflight
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, X-Echo-API-Key, X-Telegram-Bot-Api-Secret-Token",
          },
        });
      }

      // Route requests
      switch (path) {
        case "/health":
          return handleHealth(env);

        case "/stats":
          return handleStats(env);

        case "/webhook":
          if (request.method === "GET") {
            return handleWebhook(request, env);
          }
          if (request.method === "POST") {
            // Clone request before consuming body, so waitUntil can process it
            const cloned = request.clone();
            ctx.waitUntil(handleWebhook(cloned, env).catch((err) => {
              log("error", "Webhook processing failed", { error: String(err) });
            }));
            // Return 200 immediately so Telegram doesn't retry
            return jsonResponse({ ok: true });
          }
          return new Response("Method Not Allowed", { status: 405 });

        case "/register-webhook": {
          // Convenience endpoint to register the webhook with Telegram
          const apiKey = request.headers.get("X-Echo-API-Key");
          if (apiKey !== env.ECHO_API_KEY) {
            return jsonResponse({ error: "Unauthorized" }, 401);
          }
          const workerUrl = url.origin;
          const result = await telegramApi(env.TELEGRAM_BOT_TOKEN, "setWebhook", {
            url: `${workerUrl}/webhook`,
            secret_token: env.TELEGRAM_WEBHOOK_SECRET,
            allowed_updates: ["message", "callback_query"],
            max_connections: 10,
          });
          return jsonResponse({ registered: true, result });
        }

        case "/unregister-webhook": {
          const apiKey = request.headers.get("X-Echo-API-Key");
          if (apiKey !== env.ECHO_API_KEY) {
            return jsonResponse({ error: "Unauthorized" }, 401);
          }
          const result = await telegramApi(env.TELEGRAM_BOT_TOKEN, "deleteWebhook", {});
          return jsonResponse({ unregistered: true, result });
        }

        default:
          return jsonResponse(
            {
              error: "Not Found",
              message: "SPI-DARK serves only the Commander. Available: /health, /stats, /webhook",
            },
            404,
          );
      }
    } catch (err) {
      log("error", "Unhandled worker error", { error: String(err), stack: (err as Error)?.stack });
      return jsonResponse({ error: "Internal Server Error", worker: WORKER_NAME }, 500);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const hour = new Date(event.scheduledTime).getUTCHours();
    const day = new Date(event.scheduledTime).getUTCDay();

    log("info", "Cron triggered", { hour, day, cron: event.cron });

    try {
      // Daily provocation: 0 14 * * * (2PM UTC = 8AM CST)
      if (event.cron === "0 14 * * *") {
        await handleDailyProvocation(env);
        return;
      }

      // Weekly challenge: 0 16 * * 0 (Sunday 4PM UTC = 10AM CST)
      if (event.cron === "0 16 * * 0") {
        await handleWeeklyChallenge(env);
        return;
      }

      log("warn", "Unknown cron trigger", { cron: event.cron });
    } catch (err) {
      log("error", "Cron handler failed", {
        cron: event.cron,
        error: String(err),
        stack: (err as Error)?.stack,
      });
    }
  },
};
