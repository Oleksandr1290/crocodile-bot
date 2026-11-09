// 🐊 «Крокодил» — Telegram-бот для групп + Супер-игра (Арена)
// Cloudflare Workers + Durable Objects:
//   CrocodileGame — по одному объекту на каждую группу (раунды, рейтинг группы)
//   ArenaRegistry — один общий объект: все группы, их лидеры, лобби Супер-игры

import { DurableObject } from "cloudflare:workers";
import { WORDS_BY_LEVEL } from "./words.js";
import { CATEGORIES, CATEGORY_ORDER } from "./categories.js";
import { FLAGS, FLAG_VALUE, flagImage } from "./flags.js";
import { HINTS } from "./hints.js";

// ================== НАСТРОЙКИ ИГРЫ ==================
const LEVELS = {
  easy: { name: "🟢 Лёгкий", mult: 1, about: "простые предметы, животные, еда" },
  medium: { name: "🟡 Средний", mult: 1.5, about: "профессии, места, техника" },
  hard: { name: "🔴 Сложный", mult: 2, about: "редкие слова и понятия" },
  ultimate: { name: "💀 Ультимейт", mult: 3, about: "абстрактные понятия, для профи" },
};
const TIME_OPTIONS = [60, 120, 180, 300, 600];   // варианты времени на слово (сек)
const UNTIMED_LIMIT_MS = 30 * 60 * 1000;          // "без времени": раунд всё же закроется через 30 мин
const WAIT_MS = 3 * 60 * 1000;                    // сколько ждать, пока кто-то вызовется ведущим
const SETUP_MS = 10 * 60 * 1000;                  // сколько ждать завершения настройки
const MAX_SKIPS = 5;                              // сколько раз ведущий может сменить слово
const RECENT_LIMIT = 150;                         // не повторять последние N слов в группе
const LEADER_PENALTY = 3;                         // штраф ведущему, если он сам написал слово
const DEFAULT_SETTINGS = { level: "medium", timed: true, timeSec: 300 };
const SESSION_WORDS = 10;         // слов в раунде по умолчанию
const WORD_OPTIONS = [5, 10, 15, 20];
const TIME_VOTE_OPTIONS = [60, 120, 180, 300, 0]; // 0 = без ограничения времени
const VOTE_IDLE_MS = 15 * 60 * 1000; // настройку никто не трогает 15 минут → закрываем (ограничения по времени на выбор нет)
const VOTE_ANYONE_MS = 2 * 60 * 1000; // если запустивший игру пропал — через 2 минуты «Начать» может любой игрок
const LOBBY_MS = 15 * 1000;       // сбор игроков после /game
const ROSTER_IDLE_MS = 10 * 60 * 1000; // кто 10 минут ничего не делал — выбывает из состава
const CLASSIC_MIN = 2;            // классике нужно минимум 2 игрока
const ANY_CAT = { name: "🎲 Любая" };
const FLAG_CAT = "flags";
const catName = (key) => (key === FLAG_CAT ? "🏳️ Флаги" : (CATEGORIES[key] || ANY_CAT).name);

// ================== ФЛАГИ ==================
const FLAG_UNLOCK_MS = 60 * 1000;      // минута тишины → подсказки и пропуск доступны
const FLAG_AUTOSKIP_MS = 2 * 60 * 1000; // ещё 2 минуты тишины → флаг пропускается сам
const FLAG_REQUEUE = 3;
const FLAG_TEAMS_MIN = 4;               // с 4 игроков во флагах можно играть команда на команду                // пропущенный флаг вернётся через столько флагов
const flagLetterNeed = (players) => Math.min(8, 3 + Math.max(0, players - 2)); // промахов до покупки буквы
const flagBasePrice = (level) => Math.max(1, Math.round((FLAG_VALUE[level] || 8) / 4));

// ================== НАСТРОЙКИ СУПЕР-ИГРЫ ==================
// Можно переопределить переменными в Cloudflare (Settings → Variables):
// ARENA_MIN_POINTS, ARENA_MIN_PLAYERS, ARENA_LOBBY_SIZE — удобно для теста
const ARENA_SETTINGS = { level: "ultimate", timed: true, timeSec: 180 };
const ARENA_READY_MS = 30 * 60 * 1000;   // сколько ждём готовности участников
const ARENA_COUNTDOWN_MS = 60 * 1000;    // отсчёт перед стартом
const ARENA_WORDS_EACH = 2;              // этап 1: каждый ведёт столько слов
const ARENA_FLAGS = 10;                  // этап 2: флагов на скорость
const ARENA_FLAG_MS = 45 * 1000;         // время на флаг
const ARENA_FLAG_POINTS = 9;             // очков за флаг
const ARENA_REVIEW_MS = 3 * 60 * 1000;   // сколько судья думает над итогами, потом — автоматически
const arenaStakes = (n) => (n >= 4 ? [0, 5, 10, 15] : n === 3 ? [0, 5, 10] : [0, 5]); // % рейтинга, который отдаёт место 1, 2, 3, 4
const LOBBY_TTL_MS = 48 * 60 * 60 * 1000;   // сколько лобби ждёт соперников
const INVITE_LIMIT = 30;                     // максимум групп, куда рассылается вызов
const MIN_GUESS_SEC = 4;                     // угадал быстрее — очки "на сложном" не идут (защита от сговора)
const PAIR_DAILY_LIMIT = 5;                  // одна пара ведущий→угадавший: максимум N зачётных раундов в день
const minPoints = (env) => Number(env.ARENA_MIN_POINTS) || 1000;
const minPlayers = (env) => Number(env.ARENA_MIN_PLAYERS) || 5;
const lobbySize = (env) => Number(env.ARENA_LOBBY_SIZE) || 4;

const COMMANDS = [
  { command: "game", description: "🐊 Начать игру" },
  { command: "catalog", description: "📋 Показать группу в каталоге игр (админы)" },
  { command: "moderation", description: "🛡 Фильтр мата, рекламы и ссылок (админы)" },
  { command: "alive", description: "🌱 Живая группа: загадка дня, вечерняя игра (админы)" },
  { command: "stop", description: "🛑 Остановить игру" },
  { command: "rules", description: "📖 Правила и очки" },
];

const PRIVATE_COMMANDS = [
  { command: "start", description: "🐊 Главное меню" },
  { command: "myid", description: "🆔 Мой Telegram ID" },
];
const CATALOG_PAGE = 8; // групп на одной странице каталога

// ================== ЖИВАЯ ГРУППА (расписание) ==================
// Время — по Москве (UTC+3). Можно поменять переменной ALIVE_TZ в Cloudflare (например 2 для Бухареста/Киева зимой)
const tzOffset = (env) => (env.ALIVE_TZ !== undefined && env.ALIVE_TZ !== "" ? Number(env.ALIVE_TZ) : 3);
const RIDDLE_HOURS = { start: 10, hint2: 14, hint3: 18, reveal: 22 };
const EVENING_HOUR = 20;
const WEEKLY = { dow: 0, hour: 21 };          // воскресенье 21:00
const NUDGE = { from: 12, to: 21, silenceMs: 4 * 3600 * 1000, everyMs: 6 * 3600 * 1000 };
const DEAD_MS = 3 * 24 * 3600 * 1000;           // группа молчит 3 дня — не беспокоим (кроме официальной)
const RIDDLE_POINTS = 5;
// ================== 🐊 КРОКОДИЛ ВЕДЁТ ==================
const CROC_SILENCE_MS = 2 * 60 * 1000;   // 2 минуты тишины → следующая подсказка; ещё 2 → Крокодил расстраивается
const CROC_POINTS = [5, 4, 3, 2, 1];     // очки за угадывание после 1-й…5-й подсказки (× множитель сложности)
const crocNeed = (players) => Math.min(20, 7 + 2 * Math.max(0, players - 2)); // промахов до следующей подсказки
const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const MIN_ACTIVE = 3;                  // минимум разных людей, писавших за 7 дней, чтобы звать на игру
const MIN_ACTIVE_RIDDLE = 2;           // для загадки дня хватит двоих
const ACTIVE_WINDOW_MS = 7 * 24 * 3600 * 1000;
const GATHER_NEED = 3;                 // сколько игроков нужно собрать, чтобы начать
const GATHER_MS = 15 * 60 * 1000;      // сколько ждать сбора

// ================== РЕЗЕРВНАЯ КОПИЯ В D1 ==================
// Если в Cloudflare подключена база D1 с именем привязки DB — бот сам создаёт таблицы
// и после каждого изменения очков сохраняет туда копию. Без DB всё работает как раньше.
let dbReady = false;
async function dbInit(env) {
  if (!env.DB || dbReady) return !!env.DB;
  await env.DB.batch([
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS players (chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, name TEXT, points INTEGER DEFAULT 0, " +
        "hard_points INTEGER DEFAULT 0, guessed INTEGER DEFAULT 0, explained INTEGER DEFAULT 0, led INTEGER DEFAULT 0, updated_at INTEGER, " +
        "PRIMARY KEY (chat_id, user_id))"
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS groups (chat_id INTEGER PRIMARY KEY, title TEXT, username TEXT, level TEXT, players INTEGER, updated_at INTEGER)"
    ),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS hints (word TEXT PRIMARY KEY, data TEXT, created_at INTEGER)"),
  ]);
  dbReady = true;
  return true;
}

function dbPlayerStmt(env, chatId, userId, s) {
  return env.DB.prepare(
    "INSERT INTO players (chat_id, user_id, name, points, hard_points, guessed, explained, led, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) " +
      "ON CONFLICT(chat_id, user_id) DO UPDATE SET name = excluded.name, points = excluded.points, hard_points = excluded.hard_points, " +
      "guessed = excluded.guessed, explained = excluded.explained, led = excluded.led, updated_at = excluded.updated_at"
  ).bind(chatId, userId, s.name || "", s.points || 0, s.hardPoints || 0, s.guessed || 0, s.explained || 0, s.led || 0, Date.now());
}

// ================== МОДЕРАЦИЯ ==================
const MAX_WARNS = 3;                          // 1 — предупреждение, 2 — мут, 3 — бан
const MUTE_SEC = 24 * 60 * 60;                // мут на сутки
const WARN_RESET_MS = 30 * 24 * 60 * 60 * 1000; // предупреждения сгорают через 30 дней
const NEWCOMER_MS = 24 * 60 * 60 * 1000;      // новичок со ссылкой в первые сутки — бан сразу
const GROUP_RULES =
  "📜 <b>Правила группы:</b>\n" +
  "🚫 Мат и оскорбления\n" +
  "🚫 Реклама и самопиар\n" +
  "🚫 Ссылки и пересылки из каналов\n\n" +
  "⚠️ Нарушение: 1-е — предупреждение, 2-е — мут на сутки, 3-е — бан.\n" +
  "⛔ Новички, которые сразу кидают ссылки, банятся без предупреждения.";

const HOW_TO_PLAY =
  "<b>Как играть:</b>\n" +
  "0. /game → сбор игроков (15 сек), затем голосование: категория, сложность, количество слов и время.\n" +
  "1. Один игрок становится ведущим и получает секретное слово — его видит только он.\n" +
  "2. Ведущий объясняет слово в чате, не называя его и однокоренные слова.\n" +
  "3. Остальные пишут догадки. Падежи и мелкие опечатки засчитываются.\n" +
  "4. Кто первым угадал — получает очки. Ведущий тоже получает очки за хорошее объяснение.\n" +
  "5. Очки копятся, у каждой группы своя таблица лидеров. Статистика и рейтинги — в меню бота (личка → /start).";

function rulesText(s, env) {
  s = s || DEFAULT_SETTINGS;
  return (
    "📖 <b>Правила «Крокодила»</b>\n\n" +
    HOW_TO_PLAY +
    "\n\n" +
    `⚠️ Если ведущий напишет загаданное слово — раунд аннулируется и −${LEADER_PENALTY} очка.\n` +
    `🔄 Слово можно сменить до ${MAX_SKIPS} раз.\n\n` +
    "<b>Очки</b>\n" +
    "🎯 Угадавший: 3, +2 если за 30 сек, +1 если за минуту.\n" +
    "🎤 Ведущий: 2, +2 если хватило 3 сообщений (+1 если до 6), +1 если угадали за минуту.\n" +
    "✖️ Множитель сложности: 🟢 ×1 · 🟡 ×1.5 · 🔴 ×2 · 💀 ×3\n\n" +
    "<b>🏟 Супер-игра</b>\n" +
    `Лидер группы (№1 в /top), набравший ${minPoints(env)}+ очков на 🔴 Сложном или 💀 Ультимейте, ` +
    `может бросить вызов лидерам других групп — /challenge. В группе должно быть минимум ${minPlayers(env)} игроков.\n\n` +
    "<b>Сейчас в группе:</b>\n" +
    settingsLine(s)
  );
}

// ================== ВХОД: WORKER ==================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Разовая настройка: открыть в браузере /setup?secret=ТВОЙ_WEBHOOK_SECRET
    if (url.pathname === "/setup") {
      if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET) {
        return text("❌ Не заданы секреты BOT_TOKEN и WEBHOOK_SECRET (Settings → Variables and Secrets)", 500);
      }
      if (url.searchParams.get("secret") !== env.WEBHOOK_SECRET) return text("❌ Неверный secret", 403);

      const me = await tg(env, "getMe", {});
      const webhook = await tg(env, "setWebhook", {
        url: `${url.origin}/webhook`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query", "chat_join_request", "my_chat_member"],
        drop_pending_updates: true,
      });
      const commands = await tg(env, "setMyCommands", { commands: COMMANDS });
      await tg(env, "setMyCommands", { commands: PRIVATE_COMMANDS, scope: { type: "all_private_chats" } });

      const reindex = await registry(env, "reindex_all", {}).catch(() => ({}));
      if (me.ok && webhook.ok && commands.ok) {
        return text(
          `✅ Готово! Бот @${me.result.username} подключён.\n` +
            `📊 Статистика групп обновлена: ${reindex.done ?? 0} из ${reindex.total ?? 0}\n` +
            (env.DB ? "💾 Резервная копия в D1: подключена\n" : "⚠️ Резервная копия в D1 не подключена (нет привязки DB)\n") +
            (env.OWNER_ID ? `👑 Владелец: ${env.OWNER_ID}` : "⚠️ OWNER_ID не задан — команды Арены работать не будут.")
        );
      }
      return text("⚠️ Что-то пошло не так:\n" + JSON.stringify({ me, webhook, commands }, null, 2), 500);
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return text("forbidden", 403);
      }
      let update;
      try {
        update = await request.json();
      } catch {
        return text("ok");
      }

      const chat =
        update.message?.chat ||
        update.callback_query?.message?.chat ||
        update.chat_join_request?.chat ||
        update.my_chat_member?.chat;
      try {
        if (!chat) {
          if (update.callback_query) await tg(env, "answerCallbackQuery", { callback_query_id: update.callback_query.id });
        } else if (chat.type === "group" || chat.type === "supergroup") {
          const stub = env.GAME.get(env.GAME.idFromName(String(chat.id)));
          await stub.fetch("https://game/update", { method: "POST", body: JSON.stringify(update) });
        } else if (chat.type === "private" && update.callback_query) {
          await handlePrivateCallback(env, update.callback_query);
        } else if (chat.type === "private" && update.message?.text) {
          await handlePrivate(env, update.message);
        }
      } catch (e) {
        console.log("webhook error", e?.stack || String(e));
      }
      return text("ok"); // всегда 200, чтобы Telegram не повторял апдейт
    }

    return text("🐊 Crocodile bot работает");
  },

  // Каждый час (cron): оживляем группы
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runTick(env));
  },
};

async function runTick(env) {
  const local = new Date(Date.now() + tzOffset(env) * 3600 * 1000);
  const tick = { hour: local.getUTCHours(), dow: local.getUTCDay(), day: local.toISOString().slice(0, 10) };
  const res = await registry(env, "alive_groups", {});
  for (const chatId of res.chats || []) {
    try {
      const stub = env.GAME.get(env.GAME.idFromName(String(chatId)));
      await stub.fetch("https://game/tick", { method: "POST", body: JSON.stringify(tick) });
    } catch (e) {
      console.log("tick failed", chatId, String(e));
    }
  }
}

async function handlePrivate(env, msg) {
  const cmd = msg.text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();

  if (cmd === "/myid") {
    return tg(env, "sendMessage", {
      chat_id: msg.chat.id,
      parse_mode: "HTML",
      text: `🆔 Твой ID: <code>${msg.from.id}</code>\n\nВладелец бота вставляет это число в секрет OWNER_ID в Cloudflare.`,
    });
  }

  if (cmd === "/arena_status" && isOwnerId(env, msg.from.id)) {
    const res = await registry(env, "status", {});
    return tg(env, "sendMessage", { chat_id: msg.chat.id, parse_mode: "HTML", text: res.text });
  }

  // /start с параметром из группы: me, top_<id>, arena
  const payload = cmd === "/start" ? (msg.text.trim().split(/\s+/)[1] || "") : "";
  if (payload === "me") return screenMe(env, msg.chat.id, msg.from, null);
  if (payload === "arena") return screenArena(env, msg.chat.id, msg.from, null);
  if (payload.startsWith("top_")) return screenGroupTop(env, msg.chat.id, msg.from, payload.slice(4), null);
  if (payload === "catalog") return sendCatalog(env, msg.chat.id, 0, null);
  if (payload === "rules") return screenRules(env, msg.chat.id, null, null);
  if (payload.startsWith("rules_")) return screenRules(env, msg.chat.id, null, payload.slice(6));
  return screenMain(env, msg.chat.id, msg.from, null);
}

// ---------- Меню в личке ----------
const BACK = [{ text: "⬅️ Меню", callback_data: "menu" }];

function showScreen(env, chatId, msgId, html, rows) {
  const body = { chat_id: chatId, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: rows } };
  if (msgId) return tg(env, "editMessageText", { ...body, message_id: msgId });
  return tg(env, "sendMessage", body);
}

function gameStub(env, chatId) {
  return env.GAME.get(env.GAME.idFromName(String(chatId)));
}

async function groupCall(env, chatId, path, body = {}) {
  const res = await gameStub(env, chatId).fetch("https://game/" + path, { method: "POST", body: JSON.stringify(body) });
  return res.json();
}

async function screenMain(env, chatId, user, msgId) {
  const me = await tg(env, "getMe", {});
  const username = me.result?.username;
  const rows = [
    [{ text: "🎮 Найти группу для игры", callback_data: "cat:0" }],
    [{ text: "📊 Моя статистика", callback_data: "me" }, { text: "🏆 Рейтинги", callback_data: "tops" }],
    [{ text: "🏟 Супер-игра", callback_data: "arena" }, { text: "📖 Правила", callback_data: "rules" }],
  ];
  if (username) rows.push([{ text: "➕ Добавить бота в свою группу", url: `https://t.me/${username}?startgroup=true` }]);
  if (isOwnerId(env, user.id)) rows.push([{ text: "🎛 Пульт Арены", callback_data: "ap:status" }]);
  return showScreen(
    env,
    chatId,
    msgId,
    `🐊 <b>Крокодил — главное меню</b>\n\nПривет, <b>${esc(displayName(user))}</b>! 👋\n` +
      "Играем в группах, а здесь — твоя статистика, рейтинги и Супер-игра.\n\nВыбирай 👇",
    rows
  );
}

async function userGroupsInfo(env, uid) {
  const res = await registry(env, "user_groups", { uid });
  const out = [];
  for (const g of res.groups || []) {
    try {
      const info = await groupCall(env, g.chatId, "user", { uid });
      if (info.stats || info.croc || info.series) out.push({ ...info, no: g.no });
    } catch (e) {
      console.log("user info failed", g.chatId, String(e));
    }
  }
  return out.sort((a, b) => (b.stats?.points || 0) - (a.stats?.points || 0));
}

async function screenMe(env, chatId, user, msgId) {
  const groups = await userGroupsInfo(env, user.id);
  if (!groups.length) {
    return showScreen(env, chatId, msgId, "📊 <b>Моя статистика</b>\n\nТы ещё не набрал очков ни в одной группе.\nНайди группу и сыграй первый раунд 👇", [
      [{ text: "🎮 Найти группу для игры", callback_data: "cat:0" }],
      BACK,
    ]);
  }
  const total = groups.reduce((a, g) => a + (g.stats?.points || 0), 0);
  const guessed = groups.reduce((a, g) => a + (g.stats?.guessed || 0), 0);
  const explained = groups.reduce((a, g) => a + (g.stats?.explained || 0), 0);
  const crocPts = groups.reduce((a, g) => a + (g.croc?.points || 0), 0);
  const serLine = (ser) => Object.entries(ser).map(([lv, n]) => `${(LEVELS[lv] || LEVELS.medium).name} ${n}`).join(" · ");
  let html =
    `📊 <b>Статистика: ${esc(displayName(user))}</b>\n\n` +
    `⭐ Всего очков: <b>${total}</b>\n🎯 Угадано слов: ${guessed} · 🎤 Объяснено: ${explained}\n` +
    (crocPts ? `🐊 Очки охотника на Крокодила: <b>${crocPts}</b>\n` : "") +
    "\n";
  for (const g of groups.slice(0, 8)) {
    const s = g.stats;
    html +=
      `<b>${esc(g.title || "Группа")}</b>\n` +
      (s
        ? `   🏅 ${g.place} место из ${g.total} · ⭐ ${s.points} · 🔥 ${s.hardPoints || 0}/${minPoints(env)}` + (g.place === 1 ? " · 👑 лидер" : "") + "\n"
        : "") +
      (g.croc ? `   🐊 охотник: ${g.croc.points} очков · ${g.croc.wins} слов\n` : "") +
      (g.series ? `   🏳️ лучшие серии: ${serLine(g.series)}\n` : "");
  }
  const rows = [[{ text: "🏆 Рейтинги моих групп", callback_data: "tops" }]];
  if (groups.some((g) => g.eligible)) rows.push([{ text: "⚔️ Бросить вызов на Супер-игру", callback_data: "arena" }]);
  rows.push(BACK);
  return showScreen(env, chatId, msgId, html + "\n🔥 — очки на 🔴 Сложном и 💀 Ультимейте (для Супер-игры)", rows);
}

async function screenTops(env, chatId, user, msgId) {
  const groups = await userGroupsInfo(env, user.id);
  const rows = groups.slice(0, 10).map((g) => [{ text: `🏆 ${String(g.title || "Группа").slice(0, 40)}`, callback_data: "gt:" + g.chatId }]);
  rows.push([{ text: "🌍 Лучшие игроки всех групп", callback_data: "gtop" }]);
  rows.push(BACK);
  return showScreen(
    env,
    chatId,
    msgId,
    "🏆 <b>Рейтинги</b>\n\n" + (groups.length ? "Выбери группу, чтобы увидеть её таблицу лидеров:" : "Ты пока не играл в группах — но можно посмотреть общий топ 👇"),
    rows
  );
}

async function screenGroupTop(env, chatId, user, groupId, msgId) {
  const mine = await registry(env, "user_groups", { uid: user.id });
  if (!(mine.groups || []).some((g) => String(g.chatId) === String(groupId))) {
    return showScreen(env, chatId, msgId, "Эта таблица доступна только игрокам группы.", [BACK]);
  }
  const res = await groupCall(env, groupId, "topdata", {});
  return showScreen(
    env,
    chatId,
    msgId,
    `🏆 <b>${esc(res.title || "Группа")}</b> — таблица лидеров\n\n` + (res.lines || "Пока пусто") + "\n\n🎯 угадал · 🎤 объяснил" +
      (res.croc ? "\n\n🐊 <b>Охотники на Крокодила</b>\n" + res.croc : "") +
      (res.series ? "\n\n🏳️ <b>Рекорды серий (флаги подряд)</b>\n" + res.series : ""),
    [[{ text: "⬅️ Все рейтинги", callback_data: "tops" }], BACK]
  );
}

async function screenGlobalTop(env, chatId, msgId) {
  const res = await registry(env, "global_top", {});
  const medals = ["🥇", "🥈", "🥉"];
  const lines = (res.items || []).map(
    (x, i) => `${medals[i] || i + 1 + "."} <b>${esc(x.name)}</b> — ${x.points} (Группа #${x.no}${x.titles ? " · 👑 " + x.titles : ""})`
  );
  return showScreen(
    env,
    chatId,
    msgId,
    "🌍 <b>Лучшие игроки всех групп</b>\n<i>лидеры своих групп по очкам</i>\n\n" + (lines.join("\n") || "Пока пусто"),
    [[{ text: "⬅️ Все рейтинги", callback_data: "tops" }], BACK]
  );
}

async function screenArena(env, chatId, user, msgId, note = "") {
  const groups = await userGroupsInfo(env, user.id);
  const lobby = await registry(env, "lobby_public", {});
  const need = minPoints(env);
  const best = groups.filter((g) => g.stats).sort((a, b) => (b.stats.hardPoints || 0) - (a.stats.hardPoints || 0))[0];
  let html =
    "🏟 <b>Супер-игра</b>\n\n" +
    `Лидеры групп (№1 в своей группе), набравшие <b>${need}+ 🔥 очков</b> на 🔴 Сложном или 💀 Ультимейте, ` +
    `бросают вызов друг другу и сражаются на Арене за звание чемпиона 👑\n\n`;
  html += best
    ? `🔥 Твой лучший прогресс: <b>${best.stats.hardPoints || 0}/${need}</b> (${esc(best.title || "группа")}, ${best.place} место)\n`
    : "🔥 Ты пока не набрал очков на сложном уровне.\n";
  html += lobby.status
    ? `\n⚔️ Лобби: ${lobby.status === "open" ? "набирается" : "собрано, скоро матч"} (${lobby.count}/${lobby.size})\n`
    : "\n⚔️ Открытого лобби сейчас нет.\n";
  const rows = [];
  for (const g of groups.filter((x) => x.eligible).slice(0, 3)) {
    rows.push([{ text: `⚔️ Бросить вызов (от «${String(g.title || "группы").slice(0, 25)}»)`, callback_data: "pch:" + g.chatId }]);
  }
  if (!rows.length && best) html += "\nЧтобы бросить вызов, стань №1 в группе и набери нужные 🔥 очки.";
  rows.push(BACK);
  return showScreen(env, chatId, msgId, html + (note ? "\n\n" + note : ""), rows);
}

// ---------- 🎛 Пульт Арены (только владелец) ----------
async function screenPanel(env, chatId, msgId, cmd) {
  const info = await registry(env, "arena_info", {});
  if (!info.arena) {
    return showScreen(env, chatId, msgId, "🎛 <b>Пульт Арены</b>\n\nАрена не назначена. Создай группу, добавь бота админом и напиши в ней /arena_here.", [BACK]);
  }
  const [action, arg] = String(cmd || "status").split(":");
  const res = await groupCall(env, info.arena.chatId, "panel", { action, arg });
  let view = res;
  if (action !== "status" && !(res.buttons && res.buttons.length && action === "kick" && !arg)) {
    view = await groupCall(env, info.arena.chatId, "panel", { action: "status" });
  }
  const rows = (view.buttons || []).map((row) => row.map(([t, d]) => ({ text: t, callback_data: d })));
  rows.push(BACK);
  return showScreen(env, chatId, msgId, view.text + (res.note ? `\n\n✅ ${esc(res.note)}` : ""), rows);
}

// ---------- Правила по режимам ----------
const RULES = {
  classic: {
    button: "🙋 Классика (ведущий из игроков)",
    text:
      "🙋 <b>Классика — ведущий из игроков</b>\n\n" +
      "1. Кто-то жмёт «🙋 Я буду ведущим» и получает секретное слово — его видит только он (кнопка «👁»).\n" +
      "2. Ведущий объясняет слово в чате, не называя его и однокоренные слова.\n" +
      "3. Остальные пишут догадки. Падежи и мелкие опечатки засчитываются.\n" +
      "4. Кто первым угадал — получает очки, ведущий тоже.\n\n" +
      "🔄 Слово можно сменить до 5 раз, 🏳 «Сдаюсь» — закончить слово.\n" +
      "⚠️ Ведущий написал загаданное слово — слово аннулируется, −3 очка.\n" +
      "👥 Нужно минимум 2 игрока. Играешь один — выбирай 🏳️ Флаги.",
  },
  vote: {
    button: "🗳 Как начинается игра",
    text:
      "🗳 <b>Как начинается игра</b>\n\n" +
      "1. Кто-то пишет /game — 15 секунд идёт сбор: жмите «🙋 Я играю». «▶️ Поехали» может нажать тот, кто запустил игру.\n" +
      "2. Игроки голосуют за настройки раунда: 📂 категория, 🎚 сложность, 🔢 количество слов (5–20) и ⏱ время на слово.\n" +
      "3. Ограничения по времени на настройку нет. Когда все выбрали — тот, кто запустил игру, жмёт «▶️ Начать игру» (если он пропал — через 2 минуты может любой игрок).\n" +
      "4. После раунда: «▶️ Продолжить с теми же настройками» или «🔧 Изменить настройки».\n\n" +
      "⏰ Опоздал? Просто напиши вариант ответа — ты в игре.\n" +
      "💤 Кто 10 минут ничего не делает, выбывает из состава.",
  },
  points: {
    button: "🏆 Очки и рейтинг",
    text:
      "🏆 <b>Очки и рейтинг</b>\n\n" +
      "🎯 Угадавший: 3, +2 если за 30 сек, +1 если за минуту.\n" +
      "🎤 Ведущий: 2, +2 если хватило 3 сообщений (+1 если до 6), +1 если угадали за минуту.\n" +
      "✖️ Множитель сложности: 🟢 ×1 · 🟡 ×1.5 · 🔴 ×2 · 💀 ×3\n\n" +
      "📉 Рейтинг не опускается ниже 0.\n" +
      "🔥 Очки на 🔴 Сложном и 💀 Ультимейте открывают дорогу в Супер-игру.\n" +
      "📊 Свою статистику и рейтинги групп смотри в меню бота.",
  },
  arena: {
    button: "🏟 Супер-игра",
    text:
      "🏟 <b>Супер-игра</b>\n\n" +
      "Лидер группы (№1 в рейтинге группы), набравший 1000+ 🔥 очков на 🔴 Сложном или 💀 Ультимейте, " +
      "бросает вызов лидерам других групп (меню → 🏟 Супер-игра).\n\n" +
      "Когда лобби соберётся, участники получают вход на Арену — отдельную группу, где писать могут только они. " +
      "Соперники видят друг друга как «Группа #N».\n\n" +
      "<b>Матч</b> начинается сам, когда все нажмут «✅ Готов»:\n" +
      "1️⃣ Классика на 💀 Ультимейте — бот назначает ведущих по кругу, каждый объясняет по 2 слова.\n" +
      "2️⃣ 10 флагов на скорость — каждый сам за себя, +9 за флаг.\n" +
      "Судья (владелец бота) может добавить доп. раунд классики, если посчитает нужным.\n\n" +
      "💰 <b>Ставка:</b> 2-е место отдаёт победителю 5% своего рейтинга, 3-е — 10%, 4-е — 15%. Не пришёл — как последнее место.\n" +
      "👑 Победитель получает звание Чемпиона Арены, а его группа — титул.",
  },
};
RULES.flags = {
  button: "🏳️ Флаги",
  text:
    "🏳️ <b>Флаги</b>\n\n" +
    "Ведущего нет: бот показывает флаг, все пишут название страны. Очки за флаг: 🟢 4 · 🟡 8 · 🔴 12 · 💀 20.\n" +
    "Проверка строгая: «Нигерия» на флаг Нигера — промах. Режим выбирается сам по числу игроков:\n\n" +
    "👤 <b>Один игрок — серия на рекорд</b>\n" +
    "Сколько флагов подряд угадаешь без ошибки? Ошибка — назвать другую страну. Букв и пропусков нет. " +
    "Серия — тренировка: в рейтинг не идёт, но личные рекорды и рекорд группы видны в «🏆 Рейтинги». Побил рекорд группы — бот объявит об этом в чате!\n\n" +
    "⚡ <b>2–3 игрока — каждый сам за себя</b>\n" +
    "Кто первым угадал — забирает очки себе (в рейтинг). " +
    "🔤 Букву можно купить за <b>свой рейтинг</b> (четверть ценности флага, каждая следующая на 1 дороже) — её видишь <b>только ты</b> во всплывающем окне. " +
    "Купить или рискнуть и ждать? Пока думаешь — соперник может угадать.\n\n" +
    "⚔️ <b>4+ игроков — на выбор при настройке:</b> каждый сам за себя или <b>🔴 против 🔵</b>. " +
    "В командах у каждой свой банк (стартовый капитал на 1 букву — только на первый флаг), буквы покупаются из банка и видны только своей команде («👁 Наши буквы»). " +
    "В конце банк команды делится поровну между её игроками, которые отвечали. Банк не уходит ниже 0.\n\n" +
    "🔒 Буквы открываются после нескольких неправильных ответов (3 при 1–2 игроках, +1 за игрока, максимум 8) или минуты тишины.\n" +
    "⏭ Пропуск — бесплатный, флаг вернётся позже. При 3+ игроках нужен второй голос, в командах — по голосу от каждой.\n" +
    "😴 2 минуты тишины после открытия кнопок — флаг пропускается. Два таких подряд — игра останавливается.\n" +
    "🔥 На 🔴/💀 при 3+ игроках очки идут и в зачёт Супер-игры.",
};
RULES.croc = {
  button: "🐊 Крокодил ведёт",
  text:
    "🐊 <b>Крокодил ведёт</b>\n\n" +
    "Объясняет сам бот: загадывает слово из выбранной категории и даёт хитрые подсказки — от размытой к узнаваемой. " +
    "Все пишут догадки в чат. Можно играть даже одному.\n\n" +
    "💬 Следующая подсказка открывается после нескольких неправильных ответов: 7 при 1–2 игроках, +2 за каждого следующего (максимум 20). " +
    "Повторы, болтовня длиннее 3 слов и частые ответы одного игрока не считаются.\n" +
    "😴 2 минуты тишины → подсказка откроется сама. Ещё 2 минуты тишины — Крокодил расстроится и закончит игру.\n\n" +
    "🏆 Очки: угадал после 1-й подсказки — 5, после 2-й — 4 … после 5-й — 1 (× множитель сложности). " +
    "Никто не угадал после 5-й — очко получает Крокодил 🐊.\n" +
    "📊 Эти очки идут в отдельный счёт «🐊 Охотники на Крокодила» и не влияют на рейтинг группы и Супер-игру.",
};
const RULES_ORDER = ["vote", "classic", "croc", "flags", "points", "arena"];

async function screenRules(env, chatId, msgId, key) {
  const r = RULES[key];
  if (r) {
    return showScreen(env, chatId, msgId, r.text, [[{ text: "⬅️ Все правила", callback_data: "rules" }], BACK]);
  }
  const rows = RULES_ORDER.map((k) => [{ text: RULES[k].button, callback_data: "rules:" + k }]);
  rows.push([{ text: "🎮 Найти группу для игры", callback_data: "cat:0" }]);
  rows.push(BACK);
  return showScreen(env, chatId, msgId, "📖 <b>Правила</b>\n\nВыбери, о чём рассказать:", rows);
}

// ---------- Меню в личке: каталог групп ----------
async function sendCatalog(env, chatId, page, editMsgId) {
  const me = await tg(env, "getMe", {});
  const username = me.result?.username;
  const cat = await registry(env, "catalog", { page });

  let html = "🐊 <b>Крокодил — игра в группах Telegram</b>\n\n";
  const rows = [];
  if (cat.official && cat.page === 0) {
    const o = cat.official;
    html +=
      "⭐ <b>ОФИЦИАЛЬНАЯ ГРУППА</b> ⭐\n" +
      `<b>${esc(o.title || "Крокодил")}</b>${o.members ? " · 👥 " + o.members : ""}\n` +
      "Здесь всегда есть с кем поиграть, порядок и модерация 🛡\n\n";
    rows.push([{ text: `⭐ ${String(o.title || "Официальная группа").slice(0, 36)} ⭐`, url: o.link }]);
  }
  if (!cat.total && !cat.official) {
    html += "Пока нет открытых групп для игры 😔\n\nДобавь бота в свою группу — и играйте с друзьями!";
  } else if (cat.total) {
    html += cat.total ? `🎮 Другие группы для игры (всего ${cat.total}):\n\n` : "";
    cat.items.forEach((g, i) => {
      const n = cat.page * CATALOG_PAGE + i + 1;
      const lvl = LEVELS[g.level]?.name || LEVELS.medium.name;
      html +=
        `${n}. <b>${esc(g.title || "Группа")}</b>\n` +
        `     ${g.members ? "👥 " + g.members + " · " : ""}${lvl}${g.players ? " · 🎮 " + g.players + " игроков" : ""}${g.titles ? " · 👑 " + g.titles : ""}\n`;
      rows.push([{ text: `${n}. ${String(g.title || "Группа").slice(0, 40)}`, url: g.link }]);
    });
    html += "\nНажми на группу, чтобы перейти в неё и вступить.";
  }
  if (cat.total) {
    if (cat.pages > 1) {
      const nav = [];
      if (cat.page > 0) nav.push({ text: "◀️", callback_data: "cat:" + (cat.page - 1) });
      nav.push({ text: `${cat.page + 1} / ${cat.pages}`, callback_data: "noop" });
      if (cat.page < cat.pages - 1) nav.push({ text: "▶️", callback_data: "cat:" + (cat.page + 1) });
      rows.push(nav);
    }
  }
  if (username) rows.push([{ text: "➕ Добавить бота в свою группу", url: `https://t.me/${username}?startgroup=true` }]);
  rows.push([{ text: "🔄 Обновить", callback_data: "cat:" + (cat.page || 0) }, { text: "⬅️ Меню", callback_data: "menu" }]);

  const body = { chat_id: chatId, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: rows } };
  if (editMsgId) return tg(env, "editMessageText", { ...body, message_id: editMsgId });
  return tg(env, "sendMessage", body);
}

async function handlePrivateCallback(env, cq) {
  const data = String(cq.data || "");
  const chatId = cq.message.chat.id;
  const msgId = cq.message.message_id;
  const user = cq.from;
  const ack = (t = "", alert = false) => tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: t, show_alert: alert });

  if (data.startsWith("cat:")) {
    await ack();
    return sendCatalog(env, chatId, Math.max(0, Number(data.slice(4)) || 0), msgId);
  }
  if (data === "menu") return ack().then(() => screenMain(env, chatId, user, msgId));
  if (data === "me") return ack().then(() => screenMe(env, chatId, user, msgId));
  if (data === "tops") return ack().then(() => screenTops(env, chatId, user, msgId));
  if (data === "gtop") return ack().then(() => screenGlobalTop(env, chatId, msgId));
  if (data === "arena") return ack().then(() => screenArena(env, chatId, user, msgId));
  if (data === "howto" || data === "rules") return ack().then(() => screenRules(env, chatId, msgId, null));
  if (data.startsWith("rules:")) return ack().then(() => screenRules(env, chatId, msgId, data.slice(6)));
  if (data.startsWith("gt:")) return ack().then(() => screenGroupTop(env, chatId, user, data.slice(3), msgId));
  if (data.startsWith("ap:")) {
    if (!isOwnerId(env, user.id)) return ack("Только для владельца");
    await ack();
    return screenPanel(env, chatId, msgId, data.slice(3));
  }
  if (data.startsWith("pch:")) {
    await ack("⚔️ Отправляем вызов…");
    const snap = await groupCall(env, data.slice(4), "snapshot", {});
    const res = await registry(env, "challenge", { snap, userId: user.id });
    return screenArena(env, chatId, user, msgId, res.text || "");
  }
  return ack();
}

function isOwnerId(env, userId) {
  return !!env.OWNER_ID && String(userId) === String(env.OWNER_ID).trim();
}

async function registryGroupRating(env, chatId, uid) {
  try {
    const stub = env.GAME.get(env.GAME.idFromName(String(chatId)));
    const res = await stub.fetch("https://game/rating", { method: "POST", body: JSON.stringify({ uid }) });
    return (await res.json()).points || 0;
  } catch {
    return 0;
  }
}

async function registry(env, path, body) {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName("main"));
  const res = await stub.fetch("https://registry/" + path, { method: "POST", body: JSON.stringify(body) });
  return res.json();
}

// ================== ИГРА: ОДИН ОБЪЕКТ НА ГРУППУ ==================
// round.status: "idle" | "setup" (настройка) | "waiting" (ждём ведущего) | "playing" | "ended" (подводим итоги)
export class CrocodileGame extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.round = { status: "idle" };
    this.recent = [];
    this.settings = null;
    this.meta = {};          // { chatId, title }
    this.isArena = false;    // эта группа — Арена Супер-игры
    this.allowed = new Set(); // ID участников Супер-игры (только для Арены)
    this.mod = { on: false };  // модерация: мат, реклама, ссылки
    this.alive = { on: false }; // живая группа: расписание событий
    this.lastAct = 0;           // когда последний раз писали люди
    this.admins = null;        // кэш админов группы
    this.adminsAt = 0;
    ctx.blockConcurrencyWhile(async () => {
      this.round = (await ctx.storage.get("round")) || { status: "idle" };
      this.recent = (await ctx.storage.get("recent")) || [];
      this.settings = (await ctx.storage.get("settings")) || null;
      this.meta = (await ctx.storage.get("meta")) || {};
      this.isArena = !!(await ctx.storage.get("arena"));
      this.allowed = new Set((await ctx.storage.get("allowed")) || []);
      this.mod = (await ctx.storage.get("mod")) || { on: false };
      this.alive = (await ctx.storage.get("alive")) || { on: false };
      this.lastAct = (await ctx.storage.get("lastAct")) || 0;
      this.act = (await ctx.storage.get("act")) || {}; // кто когда писал: { userId: время }
      this.session = (await ctx.storage.get("session")) || null; // текущий раунд: { cat, n, p, words, level, timed, timeSec }
      this.game = (await ctx.storage.get("game")) || null;       // состав игры: { roster: {id: {name, at}}, initiator }
      this.last = (await ctx.storage.get("last")) || null;       // последние выбранные сложность и время
      this.recentFlags = (await ctx.storage.get("recentFlags")) || [];
      this.match = (await ctx.storage.get("match")) || null; // матч Супер-игры (только на Арене)
    });
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = await request.json();
    try {
      if (path === "/allow") return Response.json(await this.allowPlayers(body.ids || [], body.participants, body.lobbyId));
      if (path === "/adjust") {
        await this.addStats(Number(body.uid), body.name || "Игрок", { points: Number(body.delta) || 0 });
        await this.report();
        return Response.json({ ok: true });
      }
      if (path === "/rating") return Response.json({ points: ((await this.ctx.storage.get("u:" + body.uid)) || {}).points || 0 });
      if (path === "/panel") return Response.json(await this.arenaPanel(body.action, body.arg));
      if (path === "/tick") return Response.json(await this.onTick(body));
      if (path === "/user") return Response.json(await this.userInfo(Number(body.uid)));
      if (path === "/topdata") return Response.json({ title: this.meta.title, lines: await this.topLines(10), croc: await this.crocTop(5), series: await this.seriesTop() });
      if (path === "/snapshot") return Response.json(await this.snapshot());
      if (path === "/reindex") {
        await this.dbRestore();
        await this.report();
        return Response.json({ ok: true });
      }
      await this.rememberChat(
        body.message?.chat || body.callback_query?.message?.chat || body.chat_join_request?.chat || body.my_chat_member?.chat
      );
      if (!this.reported && this.meta.chatId && !this.isArena) {
        this.reported = true; // раз за "пробуждение": проверить копию, обновить реестр, подтянуть игроков в меню
        await this.dbRestore();
        await this.report();
      }
      if (body.my_chat_member) await this.onMyChatMember(body.my_chat_member);
      else if (body.callback_query) await this.onCallback(body.callback_query);
      else if (body.message) await this.onMessage(body.message);
      else if (body.chat_join_request) await this.onJoinRequest(body.chat_join_request);
    } catch (e) {
      console.log("game error", e?.stack || String(e));
    }
    return new Response("ok");
  }

  // ---------- утилиты ----------
  tg(method, body) {
    return tg(this.env, method, body);
  }
  registry(path, body) {
    return registry(this.env, path, body);
  }
  isOwner(uid) {
    return isOwnerId(this.env, uid);
  }
  save() {
    return this.ctx.storage.put({ round: this.round, recent: this.recent });
  }
  send(chatId, html, extra = {}) {
    return this.tg("sendMessage", {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...extra,
    });
  }
  edit(chatId, msgId, html, keyboard) {
    return this.tg("editMessageText", {
      chat_id: chatId,
      message_id: msgId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: keyboard || { inline_keyboard: [] },
    });
  }
  answer(cq, txt = "", alert = false) {
    return this.tg("answerCallbackQuery", { callback_query_id: cq.id, text: String(txt).slice(0, 200), show_alert: alert });
  }
  removeButtons(chatId, msgId) {
    if (!msgId) return;
    return this.tg("editMessageReplyMarkup", { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
  }
  isActive() {
    return ["waiting", "playing", "gather", "vote", "choice", "lobby", "flag", "croc", "aready", "acount", "aflag", "areview"].includes(this.round.status);
  }
  activeCount() {
    const now = Date.now();
    return Object.values(this.act || {}).filter((t) => now - t < ACTIVE_WINDOW_MS).length;
  }
  cfg() {
    if (this.isArena) return ARENA_SETTINGS;
    return this.last || this.settings || DEFAULT_SETTINGS;
  }

  // ---------- состав игры ----------
  async touchPlayer(user) {
    if (this.isArena || !user || user.is_bot) return;
    if (!this.game) this.game = { roster: {}, initiator: null };
    const now = Date.now();
    const p = this.game.roster[user.id];
    if (p && now - p.at < 60 * 1000) return;
    this.game.roster[user.id] = { name: displayName(user), at: now };
    await this.ctx.storage.put("game", this.game);
  }

  activePlayers() {
    if (!this.game) return [];
    const now = Date.now();
    return Object.entries(this.game.roster)
      .filter(([, p]) => now - p.at < ROSTER_IDLE_MS)
      .map(([id, p]) => ({ id: Number(id), name: p.name }));
  }

  async rememberChat(chat) {
    if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;
    const username = chat.username || "";
    if (this.meta.chatId !== chat.id || this.meta.title !== (chat.title || "") || this.meta.username !== username) {
      this.meta = { chatId: chat.id, title: chat.title || "", username };
      await this.ctx.storage.put("meta", this.meta);
      await this.report(); // название/ссылка изменились — обновить каталог
    }
  }

  // Бота добавили/удалили из группы
  async onMyChatMember(u) {
    const st = u.new_chat_member?.status;
    if (st === "left" || st === "kicked") {
      await this.registry("remove", { chatId: u.chat.id });
    } else {
      await this.report();
    }
  }

  async getMe() {
    let me = await this.ctx.storage.get("me2");
    if (!me) {
      const res = await this.tg("getMe", {});
      if (res.ok) {
        me = { id: res.result.id, username: res.result.username };
        await this.ctx.storage.put("me2", me);
      }
    }
    return me || {};
  }

  async isAdmin(chatId, userId) {
    if (!userId) return false;
    const res = await this.tg("getChatMember", { chat_id: chatId, user_id: userId });
    return ["creator", "administrator"].includes(res.result?.status);
  }

  // Выбор слова: из категории (с вариантами ответа) или из обычной базы по сложности
  pickWord(level, cat) {
    const hardOk = level === "hard" || level === "ultimate";
    let all;
    if (cat && CATEGORIES[cat]) {
      const entries = CATEGORIES[cat].words.map(parseEntry);
      all = hardOk ? entries : entries.filter((e) => !e.hard);
      const hard = entries.filter((e) => e.hard);
      if (hardOk && hard.length && Math.random() < 0.6) all = hard; // на сложном чаще сложные
    } else {
      all = (WORDS_BY_LEVEL[level] || WORDS_BY_LEVEL.medium).map((w) => ({ word: w, answers: [w], hard: false }));
    }
    const recent = new Set(this.recent);
    let pool = all.filter((e) => !recent.has(e.word));
    if (!pool.length) {
      const words = new Set(all.map((e) => e.word));
      this.recent = this.recent.filter((w) => !words.has(w));
      pool = all;
    }
    const e = pool[Math.floor(Math.random() * pool.length)];
    this.recent.push(e.word);
    if (this.recent.length > RECENT_LIMIT) this.recent = this.recent.slice(-RECENT_LIMIT);
    return e;
  }

  async addStats(userId, name, delta) {
    if (!this.isArena && delta.points) {
      const wid = weekId(this.env);
      let wk = (await this.ctx.storage.get("week")) || { id: wid, p: {} };
      if (wk.id !== wid) wk = { id: wid, p: {} };
      const e = wk.p[userId] || { name, points: 0 };
      e.name = name;
      e.points += delta.points;
      wk.p[userId] = e;
      await this.ctx.storage.put("week", wk);
    }
    if (!this.isArena) await this.indexUser(userId);
    const keys = ["u:" + userId];
    if (this.isArena) keys.push("m:" + userId); // отдельный зачёт текущего матча Арены
    for (const key of keys) {
      const s = (await this.ctx.storage.get(key)) || { name, points: 0, hardPoints: 0, guessed: 0, explained: 0, led: 0 };
      s.name = name;
      for (const k of Object.keys(delta)) s[k] = (s[k] || 0) + delta[k];
      s.points = Math.max(0, s.points || 0);         // рейтинг не опускается ниже 0
      s.hardPoints = Math.max(0, s.hardPoints || 0);
      await this.ctx.storage.put(key, s);
      if (key.startsWith("u:")) await this.dbSave(userId, s);
    }
  }

  // ---------- резервная копия в D1 ----------
  async dbSave(userId, s) {
    if (!this.meta.chatId) return;
    try {
      if (await dbInit(this.env)) await dbPlayerStmt(this.env, this.meta.chatId, userId, s).run();
    } catch (e) {
      console.log("D1 save failed", String(e));
    }
  }

  // Разово выгрузить всю статистику группы в D1 (для данных, набранных до подключения базы)
  async dbSyncAll() {
    if (!this.meta.chatId || (await this.ctx.storage.get("dbSynced"))) return;
    try {
      if (!(await dbInit(this.env))) return;
      const all = await this.ctx.storage.list({ prefix: "u:" });
      const stmts = [...all.entries()].map(([k, s]) => dbPlayerStmt(this.env, this.meta.chatId, Number(k.slice(2)), s));
      for (let i = 0; i < stmts.length; i += 50) await this.env.DB.batch(stmts.slice(i, i + 50));
      await this.ctx.storage.put("dbSynced", true);
    } catch (e) {
      console.log("D1 sync failed", String(e));
    }
  }

  // Если локальная статистика пуста, а в D1 есть копия — восстановить
  async dbRestore() {
    if (!this.meta.chatId) return;
    try {
      if (!(await dbInit(this.env))) return;
      const local = await this.ctx.storage.list({ prefix: "u:", limit: 1 });
      if (local.size) return;
      const { results } = await this.env.DB.prepare("SELECT * FROM players WHERE chat_id = ?1").bind(this.meta.chatId).all();
      if (!results?.length) return;
      const entries = {};
      for (const r of results) {
        entries["u:" + r.user_id] = {
          name: r.name, points: r.points, hardPoints: r.hard_points, guessed: r.guessed, explained: r.explained, led: r.led,
        };
      }
      const keys = Object.keys(entries);
      for (let i = 0; i < keys.length; i += 100) {
        const part = {};
        for (const k of keys.slice(i, i + 100)) part[k] = entries[k];
        await this.ctx.storage.put(part);
      }
      await this.ctx.storage.put("dbSynced", true);
      console.log("restored from D1", this.meta.chatId, keys.length);
    } catch (e) {
      console.log("D1 restore failed", String(e));
    }
  }

  // Индекс "игрок → группы" в общем реестре (для меню в личке)
  async indexUser(userId) {
    if (!this.meta.chatId) return;
    if (!this.indexed) this.indexed = new Set((await this.ctx.storage.get("idx")) || []);
    if (this.indexed.has(userId)) return;
    this.indexed.add(userId);
    await this.ctx.storage.put("idx", [...this.indexed]);
    try {
      await this.registry("user_join", { uids: [userId], chatId: this.meta.chatId });
    } catch (e) {
      console.log("index failed", String(e));
    }
  }

  // Разово: проиндексировать игроков, набравших очки до обновления
  async backfillIndex() {
    if (this.isArena || !this.meta.chatId || (await this.ctx.storage.get("idxDone"))) return;
    const ids = [...(await this.ctx.storage.list({ prefix: "u:" })).keys()].map((k) => Number(k.slice(2)));
    if (ids.length) await this.registry("user_join", { uids: ids, chatId: this.meta.chatId });
    this.indexed = new Set(ids);
    await this.ctx.storage.put({ idx: ids, idxDone: true });
  }

  async userInfo(uid) {
    await this.backfillIndex();
    const sorted = await this.playersSorted();
    const idx = sorted.findIndex((s) => s.id === uid);
    const me = idx >= 0 ? sorted[idx] : null;
    const croc = (await this.ctx.storage.get("c:" + uid)) || null;
    return {
      croc,
      series: await this.seriesOf(uid),
      chatId: this.meta.chatId,
      title: this.meta.title,
      isArena: this.isArena,
      place: idx + 1,
      total: sorted.length,
      stats: me,
      eligible: !this.isArena && idx === 0 && (me?.hardPoints || 0) >= minPoints(this.env) && sorted.length >= minPlayers(this.env),
    };
  }

  // Защита от накрутки: одна пара "ведущий → угадавший" не больше N зачётных раундов в день
  async pairAllowed(leaderId, guesserId) {
    const day = new Date().toISOString().slice(0, 10);
    let pairs = (await this.ctx.storage.get("pairs")) || {};
    if (pairs.day !== day) pairs = { day, c: {} };
    const key = leaderId + ":" + guesserId;
    const count = pairs.c[key] || 0;
    pairs.c[key] = count + 1;
    await this.ctx.storage.put("pairs", pairs);
    return count < PAIR_DAILY_LIMIT;
  }

  async playersSorted() {
    const all = await this.ctx.storage.list({ prefix: "u:" });
    return [...all.entries()]
      .map(([k, s]) => ({ id: Number(k.slice(2)), ...s }))
      .filter((s) => s.points !== 0 || s.guessed || s.explained)
      .sort((a, b) => b.points - a.points);
  }

  // Снимок группы для общего реестра: лидер группы и число игроков
  async snapshot() {
    const players = await this.playersSorted();
    const top = players[0];
    return {
      chatId: this.meta.chatId,
      title: this.meta.title,
      username: this.meta.username || "",
      level: this.cfg().level,
      alive: !!this.alive.on,
      players: players.length,
      leader: top ? { id: top.id, name: top.name, points: top.points, hardPoints: top.hardPoints || 0 } : null,
    };
  }

  async report() {
    if (this.isArena || !this.meta.chatId) return;
    await this.dbSyncAll();
    try {
      if (await dbInit(this.env)) {
        const snap = await this.snapshot();
        await this.env.DB.prepare(
          "INSERT INTO groups (chat_id, title, username, level, players, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) " +
            "ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title, username = excluded.username, level = excluded.level, " +
            "players = excluded.players, updated_at = excluded.updated_at"
        ).bind(snap.chatId, snap.title || "", snap.username || "", snap.level || "", snap.players || 0, Date.now()).run();
      }
    } catch (e) {
      console.log("D1 group save failed", String(e));
    }
    try {
      await this.backfillIndex();
      await this.registry("report", { snap: await this.snapshot() });
    } catch (e) {
      console.log("report failed", String(e));
    }
  }

  // Таблица лидеров группы (берётся из сохранённой статистики)
  async topLines(limit, prefix = "u:") {
    const all = await this.ctx.storage.list({ prefix });
    const top = [...all.values()]
      .filter((s) => s.points !== 0 || s.guessed || s.explained)
      .sort((a, b) => b.points - a.points)
      .slice(0, limit);
    const medals = ["🥇", "🥈", "🥉"];
    return top
      .map((s, i) => `${medals[i] || i + 1 + "."} <b>${esc(s.name)}</b> — ${s.points} (🎯 ${s.guessed} · 🎤 ${s.explained})`)
      .join("\n");
  }

  // Шапка перед новой игрой: настройки + лидеры группы
  async introHeader() {
    if (this.isArena) {
      const top = await this.topLines(10, "m:");
      return "🏟 <b>Супер-игра на Арене</b>\n" + settingsLine(this.cfg()) + (top ? "\n\n📊 <b>Счёт матча</b>\n" + top : "");
    }
    const top = await this.topLines(5);
    return (
      settingsLine(this.cfg()) +
      (top ? "\n\n🏆 <b>Таблица лидеров группы</b>\n" + top + "\n\nПолный рейтинг — /top" : "\n\n🏆 Таблица лидеров пока пуста — станьте первыми!")
    );
  }

  // ---------- Арена: кто может писать ----------
  canPlayInArena(uid) {
    return this.allowed.has(uid);
  }

  async restrict(chatId, userId, allow, untilSec) {
    const v = !!allow;
    return this.tg("restrictChatMember", {
      chat_id: chatId,
      user_id: userId,
      use_independent_chat_permissions: true,
      ...(untilSec ? { until_date: Math.floor(Date.now() / 1000) + untilSec } : {}),
      permissions: {
        can_send_messages: v, can_send_audios: v, can_send_documents: v, can_send_photos: v,
        can_send_videos: v, can_send_video_notes: v, can_send_voice_notes: v, can_send_polls: v,
        can_send_other_messages: v, can_add_web_page_previews: v,
      },
    });
  }

  async allowPlayers(ids, participants, lobbyId) {
    for (const id of ids) this.allowed.add(id);
    await this.ctx.storage.put("allowed", [...this.allowed]);
    if (this.isArena && this.meta.chatId) {
      for (const id of ids) await this.restrict(this.meta.chatId, id, true); // снять ограничения, если были
      if (participants?.length) await this.createMatch(participants, lobbyId);
    }
    return { ok: true };
  }

  async onJoinRequest(req) {
    if (!this.isArena) return; // в обычных группах заявки не трогаем
    const uid = req.from.id;
    const method = this.canPlayInArena(uid) || this.isOwner(uid) ? "approveChatJoinRequest" : "declineChatJoinRequest";
    await this.tg(method, { chat_id: req.chat.id, user_id: uid });
  }

  // ---------- сообщения ----------
  async onMessage(msg) {
    const chatId = msg.chat.id;
    const anonAdmin = msg.sender_chat?.id === chatId; // анонимный админ группы

    // Кто-то вошёл в группу
    if (msg.new_chat_members?.length) {
      const me = await this.getMe();
      if (this.isArena) {
        for (const u of msg.new_chat_members) {
          if (u.is_bot || this.isOwner(u.id) || this.canPlayInArena(u.id)) continue;
          await this.restrict(chatId, u.id, false); // не участник — только читать
        }
        return;
      }
      if (msg.new_chat_members.some((u) => u.id === me.id)) {
        const top = await this.topLines(5);
        if (top) return this.send(chatId, "🐊 <b>Я снова с вами!</b>\n\n🏆 <b>Таблица лидеров группы</b>\n" + top + "\n\nНачать игру — /game");
        return this.send(
          chatId,
          "🐊 <b>Привет! Я бот для игры «Крокодил».</b>\n\n" +
            "Один объясняет слово, остальные угадывают. Перед игрой вы сами выбираете категорию, сложность и количество слов.\n\n" +
            "🎮 Начать игру — /game\n📖 Правила и статистика — в меню бота (личка → /start)"
        );
      }
      if (this.mod.on) await this.welcome(chatId, msg.new_chat_members.filter((u) => !u.is_bot));
      return;
    }

    // Группа стала супергруппой — у неё новый ID, старую запись убираем из каталога
    if (msg.migrate_to_chat_id) return this.registry("remove", { chatId });

    // Арена: писать могут только участники Супер-игры и владелец
    if (this.isArena && !anonAdmin && msg.from && !msg.from.is_bot) {
      const uid = msg.from.id;
      if (!this.isOwner(uid) && !this.canPlayInArena(uid)) {
        await this.tg("deleteMessage", { chat_id: chatId, message_id: msg.message_id });
        await this.restrict(chatId, uid, false);
        return;
      }
    }

    // Модерация: мат, реклама, ссылки
    if (this.mod.on && !anonAdmin && msg.from && !msg.from.is_bot) {
      const why = await this.findViolation(msg);
      if (why) return this.punish(msg, why);
    }

    if (msg.from && !msg.from.is_bot) {
      const now = Date.now();
      if (now - this.lastAct > 5 * 60 * 1000) {
        this.lastAct = now;
        await this.ctx.storage.put("lastAct", now);
      }
      if (now - (this.act[msg.from.id] || 0) > 10 * 60 * 1000) {
        this.act[msg.from.id] = now;
        for (const [id, t] of Object.entries(this.act)) if (now - t > ACTIVE_WINDOW_MS) delete this.act[id];
        await this.ctx.storage.put("act", this.act);
      }
    }

    if (!msg.text) return;
    if (msg.from?.is_bot && !anonAdmin) return;

    // Опоздавший входит в состав, просто написав вариант ответа (1–3 слова)
    if (
      !this.isArena && msg.from && !msg.text.startsWith("/") &&
      ["lobby", "vote", "waiting", "playing", "choice"].includes(this.round.status) &&
      (msg.text.trim().split(/\s+/).length <= 3 || this.game?.roster?.[msg.from.id])
    ) {
      await this.touchPlayer(msg.from);
    }

    if (msg.text.startsWith("/")) return this.onCommand(msg, anonAdmin);
    if (this.round.status === "flag" && msg.from && !msg.from.is_bot) return this.onFlagText(msg);
    if (this.round.status === "croc" && msg.from && !msg.from.is_bot) return this.onCrocText(msg);
    if (this.round.status === "aflag" && msg.from && !msg.from.is_bot) return this.onArenaFlagText(msg);
    if (this.round.status === "playing" && !msg.from?.is_bot) {
      const before = this.round;
      await this.onPlayingText(msg);
      if (this.round !== before || before.status !== "playing") return; // сообщение ушло в раунд
    }
    if (!msg.from?.is_bot) return this.checkRiddle(msg);
  }

  async onCommand(msg, anonAdmin) {
    const first = msg.text.trim().split(/\s+/)[0];
    const [cmdRaw, target] = first.split("@");
    if (target) {
      const me = await this.getMe();
      if (me.username && target.toLowerCase() !== me.username.toLowerCase()) return; // команда другому боту
    }
    switch (cmdRaw.toLowerCase()) {
      case "/start":
        if (!target) return; // голый /start в группе часто адресован другим ботам — молчим
        return this.cmdGame(msg, anonAdmin);
      case "/game":
      case "/croc":
      case "/crocodile":
        return this.cmdGame(msg, anonAdmin);
      case "/top":
        if (this.isArena) return this.cmdTop(msg);
        return; // статистика — только в личке бота
      case "/me":
      case "/stats":
        return; // статистика — только в личке бота
      case "/challenge":
        return; // вызов — только в личке бота
      case "/settings":
        if (this.isArena) return this.send(msg.chat.id, "🏟 На Арене настройки фиксированные:\n" + settingsLine(ARENA_SETTINGS));
        return this.send(
          msg.chat.id,
          "⚙️ Категорию, сложность, количество слов и время теперь выбирают игроки голосованием перед каждым раундом.\n\n" +
            "Настройки для админов: /moderation · /catalog · /alive"
        );
      case "/stop":
        return this.cmdStop(msg, anonAdmin);
      case "/rules":
      case "/help": {
        const me = await this.getMe();
        return this.send(msg.chat.id, "📖 Правила игры — в меню бота 👇" + (this.mod.on ? "\n\n" + GROUP_RULES : ""), {
          reply_markup: me.username ? { inline_keyboard: [[{ text: "📖 Открыть правила", url: `https://t.me/${me.username}?start=rules` }]] } : undefined,
        });
      }
      case "/catalog":
        return this.cmdCatalog(msg, anonAdmin);
      case "/moderation":
        return this.cmdModeration(msg, anonAdmin);
      case "/alive":
        return this.cmdAlive(msg, anonAdmin);
      case "/official":
        return this.cmdOfficial(msg);
      case "/arena_here":
        return this.cmdArenaHere(msg);
      case "/arena_finish":
        return this.cmdArenaFinish(msg);
      case "/arena_status":
        if (!this.isOwner(msg.from?.id)) return;
        return this.send(msg.chat.id, (await this.registry("status", {})).text);
    }
  }

  async cmdGame(msg, anonAdmin) {
    const r = this.round;
    const chatId = msg.chat.id;
    if (r.status === "setup") {
      return this.send(chatId, "⚙️ Сейчас идёт настройка — выберите варианты в сообщении выше ☝️", {
        reply_parameters: { message_id: r.msgId, allow_sending_without_reply: true },
      });
    }
    if (r.status === "gather") {
      // кто-то хочет играть прямо сейчас — не ждём сбора, записавшиеся переходят в сбор игры
      r.status = "ended";
      await this.removeButtons(chatId, r.msgId);
      return this.startLobby(chatId, anonAdmin ? null : msg.from, r.players);
    }
    if (r.status === "lobby" || r.status === "vote" || r.status === "choice") {
      const t = {
        lobby: "🙋 Идёт сбор игроков — жми «Я играю» выше ☝️",
        vote: "🗳 Идёт настройка раунда — голосуйте выше ☝️",
        choice: "☝️ Выберите выше: продолжить или изменить настройки",
      }[r.status];
      return this.send(chatId, t, { reply_parameters: { message_id: r.msgId, allow_sending_without_reply: true } });
    }
    if (r.status === "waiting") {
      return this.send(chatId, "☝️ Раунд уже ждёт ведущего — нажми «🙋 Я буду ведущим».", {
        reply_parameters: { message_id: r.msgId, allow_sending_without_reply: true },
      });
    }
    if (r.status === "playing") {
      return this.send(chatId, `🎤 Сейчас объясняет <b>${esc(r.leaderName)}</b> — угадывайте!`);
    }
    if (r.status === "flag") return this.send(chatId, "🏳️ Сейчас угадываем флаги — пишите ответы!");
    if (r.status === "croc") return this.send(chatId, "🐊 Крокодил загадал слово — угадывайте!");
    if (r.status === "ended") return; // прямо сейчас подводятся итоги

    if (this.isArena) {
      if (this.match && this.match.status !== "done") return this.send(chatId, "🏟 Идёт матч Супер-игры — смотрите выше ☝️");
      if (!this.isOwner(msg.from?.id) && !this.canPlayInArena(msg.from?.id) && !anonAdmin) return;
      if (!this.allowed.size) return this.send(chatId, "🏟 На Арене пока нет участников. Ждём, когда соберётся лобби.");
      return this.openRound(chatId, await this.introHeader());
    }

    return this.startLobby(chatId, anonAdmin ? null : msg.from);
  }

  // ---------- настройка: сложность → режим → время ----------
  async startSetup(chatId, initiatorId, welcome) {
    const old = this.round;
    const r = { status: "setup", chatId, initiatorId: initiatorId || null, draft: {}, msgId: null, deadline: Date.now() + SETUP_MS };
    this.round = r;
    await this.save();
    if (old.msgId && old.status === "waiting") await this.removeButtons(chatId, old.msgId);

    const intro = welcome
      ? "🐊 <b>Привет! Я бот для игры «Крокодил».</b>\n\n" + HOW_TO_PLAY + "\n\nДавайте настроим игру 👇\n\n"
      : "⚙️ <b>Настройка игры</b>\n\n";
    const res = await this.send(chatId, intro + setupStep1Text(), { reply_markup: levelKeyboard() });
    if (this.round !== r) return;
    if (!res.ok) {
      this.round = { status: "idle" };
      await this.save();
      return;
    }
    r.msgId = res.result.message_id;
    await this.save();
    await this.ctx.storage.setAlarm(r.deadline);
  }

  async handleSetup(cq) {
    const r = this.round;
    const uid = cq.from.id;
    if (r.initiatorId && uid !== r.initiatorId && !(await this.isAdmin(r.chatId, uid))) {
      return this.answer(cq, "Настраивает тот, кто запустил игру, или админ группы 🙂", true);
    }
    if (this.round !== r || r.status !== "setup") return this.answer(cq);

    const [key, val] = String(cq.data).split(":");

    if (key === "d" && LEVELS[val]) {
      r.draft.level = val;
      r.deadline = Date.now() + SETUP_MS;
      await this.save();
      await this.answer(cq, LEVELS[val].name);
      return this.edit(r.chatId, r.msgId, setupStep2Text(r.draft), modeKeyboard());
    }

    if (key === "m" && r.draft.level) {
      if (val === "free") return this.finishSetup(cq, { level: r.draft.level, timed: false });
      r.draft.timed = true;
      r.deadline = Date.now() + SETUP_MS;
      await this.save();
      await this.answer(cq, "⏱ На время");
      return this.edit(r.chatId, r.msgId, setupStep3Text(r.draft), timeKeyboard());
    }

    if (key === "t" && r.draft.level && TIME_OPTIONS.includes(Number(val))) {
      return this.finishSetup(cq, { level: r.draft.level, timed: true, timeSec: Number(val) });
    }

    if (key === "back") {
      r.draft = {};
      await this.save();
      await this.answer(cq);
      return this.edit(r.chatId, r.msgId, "⚙️ <b>Настройка игры</b>\n\n" + setupStep1Text(), levelKeyboard());
    }

    return this.answer(cq);
  }

  async finishSetup(cq, s) {
    const r = this.round;
    r.status = "ended"; // сразу, чтобы двойное нажатие не сработало
    this.settings = s;
    await this.ctx.storage.put("settings", s);
    await this.save();
    await this.answer(cq, "Настройки сохранены ✅");
    await this.edit(
      r.chatId,
      r.msgId,
      "✅ <b>Игра настроена!</b>\n" +
        settingsLine(s) +
        "\n\nИзменить настройки — /settings (админы)\n📋 Чтобы новые игроки находили вашу группу через меню бота — /catalog"
    );
    await this.report();
    return this.startGame(r.chatId, await this.introHeader());
  }

  async cmdSettings(msg, anonAdmin) {
    const chatId = msg.chat.id;
    if (this.isArena) return this.send(chatId, "🏟 На Арене настройки фиксированные:\n" + settingsLine(ARENA_SETTINGS));
    if (this.round.status === "playing") {
      return this.send(chatId, "Сейчас идёт раунд. Поменять настройки можно после него (или остановите игру — /stop).");
    }
    if (this.round.status === "ended") return;
    // Первую настройку может сделать любой, менять потом — только админы
    if (this.settings && !anonAdmin && !(await this.isAdmin(chatId, msg.from?.id))) {
      return this.send(chatId, "⚙️ Менять настройки могут только админы группы.\n\nСейчас: " + settingsLine(this.cfg()));
    }
    if (this.round.status === "playing" || this.round.status === "ended") return;
    return this.startSetup(chatId, anonAdmin ? null : msg.from?.id, false);
  }

  // ---------- раунд ----------
  // Новый раунд: сообщение с кнопкой «Я буду ведущим». header — итоги прошлого раунда / лидеры.
  async openRound(chatId, header = "", oldMsgId = null) {
    const r = { status: "waiting", chatId, header, msgId: null, deadline: Date.now() + WAIT_MS };
    this.round = r; // сначала меняем состояние, потом всё остальное
    await this.save();
    if (oldMsgId) await this.removeButtons(chatId, oldMsgId);

    const ses = !this.isArena && this.session ? this.session : null;
    const line = ses
      ? `🐊 <b>${catName(ses.cat)}</b> · слово ${ses.n + 1}/${ses.words || SESSION_WORDS}\nКто будет объяснять?`
      : "🐊 <b>Новый раунд!</b> Кто будет объяснять слово?";
    const rows = kb([[["🙋 Я буду ведущим", "lead"]]]).inline_keyboard;
    if (ses && ses.n === 0) {
      const me = await this.getMe();
      if (me.username) rows.push([{ text: "📖 Правила режима", url: `https://t.me/${me.username}?start=rules_classic` }]);
    }
    const res = await this.send(chatId, (header ? header + "\n\n" : "") + line, { reply_markup: { inline_keyboard: rows } });
    if (this.round !== r) return; // пока отправляли, игру остановили
    if (!res.ok) {
      this.round = { status: "idle" };
      await this.save();
      return;
    }
    r.msgId = res.result.message_id;
    await this.save();
    await this.ctx.storage.setAlarm(r.deadline);
  }

  async renderPlaying() {
    const r = this.round;
    await this.edit(
      r.chatId,
      r.msgId,
      (r.header ? r.header + "\n\n" : "") +
        `🎤 Ведущий: <b>${esc(r.leaderName)}</b>\n` +
        (r.cat ? `📂 Категория: <b>${catName(r.cat)}</b>\n` : "") +
        "Объясняет слово — пишите догадки прямо в чат!\n" +
        `${LEVELS[r.level]?.name || ""} · ${r.timed ? "⏱ " + fmtTime(r.roundMs / 1000) + " на слово" : "♾ Без ограничения времени"}`,
      kb([
        [["👁 Посмотреть слово", "word"]],
        [["🔄 Другое слово", "skip"], ["🏳 Сдаюсь", "giveup"]],
      ])
    );
  }

  // Текст в чате во время раунда
  async onPlayingText(msg) {
    const r = this.round;
    if (this.isArena && !this.canPlayInArena(msg.from.id)) return; // владелец не участвует
    if (r.paused) return; // пауза судьи
    const hit = answerHit(msg.text, r.answers || [r.word]);
    const hardLevel = r.level === "hard" || r.level === "ultimate";

    // Пишет ведущий
    if (msg.from.id === r.leaderId) {
      r.leaderMsgs++;
      if (!hit) return; // счётчик живёт в памяти, лишние записи в базу не нужны
      r.status = "ended";
      await this.addStats(r.leaderId, r.leaderName, {
        points: -LEADER_PENALTY,
        ...(hardLevel && !this.isArena ? { hardPoints: -LEADER_PENALTY } : {}),
      });
      await this.report();
      await this.sessionPoints(r.leaderId, r.leaderName, -LEADER_PENALTY);
      return this.nextRound(
        r.chatId,
        `🚫 Ведущий <b>${esc(r.leaderName)}</b> написал загаданное слово! Раунд аннулирован (−${LEADER_PENALTY} очка).\n` +
          `Слово было: <b>${upper(r.word)}</b>`,
        r.msgId
      );
    }

    if (!hit) return;

    // Угадали! Статус меняем сразу (до любого await) — второй угадавший очков уже не получит.
    r.status = "ended";
    const sec = Math.max(1, Math.round((Date.now() - r.startedAt) / 1000));
    const gName = displayName(msg.from);
    const mult = LEVELS[r.level]?.mult || 1;

    let gBase = 3;
    if (sec <= 30) gBase += 2;
    else if (sec <= 60) gBase += 1;

    let lBase = 2;
    if (r.leaderMsgs <= 3) lBase += 2;
    else if (r.leaderMsgs <= 6) lBase += 1;
    if (sec <= 60) lBase += 1;

    const gp = Math.round(gBase * mult);
    const lp = Math.round(lBase * mult);

    // Очки "на сложном" (для допуска к Супер-игре) — с защитой от накрутки
    let countsHard = hardLevel && !this.isArena && sec >= MIN_GUESS_SEC;
    if (countsHard) countsHard = await this.pairAllowed(r.leaderId, msg.from.id);

    await this.addStats(msg.from.id, gName, { points: gp, guessed: 1, ...(countsHard ? { hardPoints: gp } : {}) });
    await this.addStats(r.leaderId, r.leaderName, { points: lp, explained: 1, ...(countsHard ? { hardPoints: lp } : {}) });
    await this.tg("setMessageReaction", {
      chat_id: r.chatId,
      message_id: msg.message_id,
      reaction: [{ type: "emoji", emoji: "🎉" }],
    });
    await this.report();

    const header =
      `🎉 <b>${esc(gName)}</b> угадал(а) слово <b>${upper(r.word)}</b> за ${fmtTime(sec)}!\n` +
      `🎯 ${esc(gName)}: +${gp} ${plural(gp, "очко", "очка", "очков")}\n` +
      `🎤 ${esc(r.leaderName)}: +${lp} ${plural(lp, "очко", "очка", "очков")} (сообщений: ${r.leaderMsgs})` +
      (mult > 1 ? `\n✖️ Бонус сложности ×${mult}` : "");
    await this.sessionPoints(msg.from.id, gName, gp);
    await this.sessionPoints(r.leaderId, r.leaderName, lp);
    return this.nextRound(r.chatId, header, r.msgId);
  }

  // ---------- кнопки ----------
  async onCallback(cq) {
    const data = String(cq.data || "");
    if (data === "chal" || data.startsWith("acc:")) return this.onArenaCallback(cq, data);
    if (data.startsWith("catl:")) return this.onCatalogCallback(cq, data);
    if (data.startsWith("mod:")) return this.onModerationCallback(cq, data);
    if (data.startsWith("alive:")) return this.onAliveCallback(cq, data);

    const r = this.round;
    const msgId = cq.message?.message_id;
    const valid = r.msgId && msgId === r.msgId && (this.isActive() || r.status === "setup");
    if (!valid) {
      await this.answer(cq, "⌛ Это сообщение уже неактуально. Новая игра — /game");
      if (cq.message && msgId !== r.msgId) await this.removeButtons(cq.message.chat.id, msgId);
      return;
    }

    if (r.status === "setup") return this.handleSetup(cq);
    if (data === "noop") return this.answer(cq);
    if (r.status === "lobby") return this.onLobby(cq, data);
    if (r.status === "aready") return data === "aready" ? this.onArenaReady(cq) : this.answer(cq);
    if (r.status === "acount" || r.status === "aflag" || r.status === "areview") return this.answer(cq);
    if (!this.isArena) await this.touchPlayer(cq.from); // любое действие в игре = ты в составе

    const isLeader = r.status === "playing" && cq.from.id === r.leaderId;

    if (data === "join") return this.onGatherJoin(cq);
    if (r.status === "gather") return this.answer(cq);
    if (r.status === "vote") return this.onVote(cq, data);
    if (r.status === "choice") return this.onChoice(cq, data);
    if (r.status === "flag") return this.onFlagButton(cq, data);
    if (r.status === "croc") return this.answer(cq);

    switch (data) {
      case "lead": {
        if (r.status !== "waiting") return this.answer(cq, "Ведущий уже выбран 🙂");
        if (this.isArena && !this.canPlayInArena(cq.from.id)) {
          return this.answer(cq, "🏟 Вести могут только участники Супер-игры", true);
        }
        const ses = !this.isArena && this.session ? this.session : null;
        const s = ses ? { level: ses.level || this.cfg().level, timed: ses.timed, timeSec: ses.timeSec } : this.cfg();
        const roundMs = s.timed ? s.timeSec * 1000 : UNTIMED_LIMIT_MS;
        const cat = this.isArena ? null : this.session?.cat || null;
        const entry = this.pickWord(s.level, cat);
        const word = entry.word;
        Object.assign(r, {
          status: "playing",
          leaderId: cq.from.id,
          leaderName: displayName(cq.from),
          word,
          answers: entry.answers,
          cat,
          level: s.level,
          timed: s.timed,
          roundMs,
          skips: 0,
          leaderMsgs: 0,
          startedAt: Date.now(),
          deadline: Date.now() + roundMs,
        });
        await this.save();
        await this.answer(cq, wordAlert(word, cat), true);
        await this.addStats(cq.from.id, r.leaderName, { led: 1 });
        await this.renderPlaying();
        await this.ctx.storage.setAlarm(r.deadline);
        return;
      }

      case "word":
        if (r.status !== "playing") return this.answer(cq, "Сначала выберите ведущего");
        if (!isLeader) return this.answer(cq, "🤫 Слово видит только ведущий. Угадывай!", true);
        return this.answer(cq, wordAlert(r.word, r.cat), true);

      case "skip": {
        if (!isLeader) return this.answer(cq, "Менять слово может только ведущий", true);
        if (r.skips >= MAX_SKIPS) return this.answer(cq, "Больше менять слово нельзя — объясняй это 💪", true);
        const next = this.pickWord(r.level, r.cat);
        r.word = next.word;
        r.answers = next.answers;
        r.skips++;
        r.leaderMsgs = 0;
        r.startedAt = Date.now();
        r.deadline = Date.now() + r.roundMs;
        await this.save();
        await this.ctx.storage.setAlarm(r.deadline);
        return this.answer(cq, `🔄 Новое слово: ${upper(r.word)}\n\nОсталось смен: ${MAX_SKIPS - r.skips}`, true);
      }

      case "giveup": {
        if (!isLeader) return this.answer(cq, "Сдаться может только ведущий", true);
        r.status = "ended";
        await this.answer(cq, "Раунд завершён");
        return this.nextRound(
          r.chatId,
          `🏳 <b>${esc(r.leaderName)}</b> сдался(ась).\nСлово было: <b>${upper(r.word)}</b>`,
          r.msgId
        );
      }
    }
    return this.answer(cq);
  }

  // ---------- Супер-игра: вызов и принятие ----------
  async onArenaCallback(cq, data) {
    if (this.isArena) return this.answer(cq, "На Арене это не работает");
    const snap = await this.snapshot();
    const user = { id: cq.from.id, name: displayName(cq.from) };

    if (data === "chal") {
      const res = await this.registry("challenge", { snap, userId: user.id });
      await this.answer(cq, res.short || "⚔️", false);
      return this.send(cq.message.chat.id, res.text);
    }

    const res = await this.registry("accept", { snap, userId: user.id, lobbyId: data.slice(4) });
    await this.answer(cq, res.text, true);
    if (res.ok && res.edit) await this.edit(cq.message.chat.id, cq.message.message_id, res.edit);
    if (res.stale) await this.removeButtons(cq.message.chat.id, cq.message.message_id);
  }

  async cmdChallenge(msg) {
    const chatId = msg.chat.id;
    if (this.isArena) return;
    if (!msg.from || msg.from.is_bot) return;
    const res = await this.registry("challenge", { snap: await this.snapshot(), userId: msg.from.id });
    return this.send(chatId, res.text);
  }

  // ---------- живая группа ----------
  aliveText() {
    const tz = tzOffset(this.env);
    return (
      "🌱 <b>Живая группа</b>\n\n" +
      "Сейчас: " + (this.alive.on ? "✅ <b>включено</b>" : "🚫 <b>выключено</b>") +
      `\n\nКогда включено, бот сам оживляет чат (время UTC${tz >= 0 ? "+" : ""}${tz}):\n` +
      `🧩 ${RIDDLE_HOURS.start}:00 — загадка дня (подсказки в ${RIDDLE_HOURS.hint2}:00 и ${RIDDLE_HOURS.hint3}:00, ответ в ${RIDDLE_HOURS.reveal}:00)\n` +
      `🌙 ${EVENING_HOUR}:00 — сбор на вечернюю игру (старт, когда нажмут ${GATHER_NEED} человека)\n` +
      "😴 если днём 4 часа тишины — предложит собраться\n" +
      `🏆 воскресенье ${WEEKLY.hour}:00 — итоги недели и Игрок недели 👑\n\n` +
      `Бот зовёт играть, только если за неделю в группе писали минимум ${MIN_ACTIVE} разных человека ` +
      `(загадке дня хватит ${MIN_ACTIVE_RIDDLE}). Если 3 дня тишина — не беспокоит совсем.\n\n` +
      `Сейчас активных за неделю: ${this.activeCount()}`
    );
  }

  async cmdAlive(msg, anonAdmin) {
    const chatId = msg.chat.id;
    if (this.isArena) return;
    if (!anonAdmin && !this.isOwner(msg.from?.id) && !(await this.isAdmin(chatId, msg.from?.id))) {
      return this.send(chatId, "🌱 Включать «Живую группу» могут только админы.");
    }
    return this.send(chatId, this.aliveText(), {
      reply_markup: kb([[this.alive.on ? ["🚫 Выключить", "alive:off"] : ["✅ Включить", "alive:on"]]]),
    });
  }

  async onAliveCallback(cq, data) {
    const chatId = cq.message.chat.id;
    if (!this.isOwner(cq.from.id) && !(await this.isAdmin(chatId, cq.from.id))) return this.answer(cq, "Только для админов группы", true);
    this.alive = { on: data === "alive:on" };
    await this.ctx.storage.put("alive", this.alive);
    await this.report();
    await this.answer(cq, this.alive.on ? "🌱 Живая группа включена" : "Выключено");
    return this.edit(chatId, cq.message.message_id, this.aliveText(), kb([[this.alive.on ? ["🚫 Выключить", "alive:off"] : ["✅ Включить", "alive:on"]]]));
  }

  // Вызывается каждый час (cron)
  async onTick({ hour, dow, day }) {
    if (!this.alive.on || this.isArena || !this.meta.chatId) return { ok: true };
    const chatId = this.meta.chatId;
    const official = (await this.registry("is_official", { chatId })).official;
    const dead = !official && Date.now() - this.lastAct > DEAD_MS;

    let done = (await this.ctx.storage.get("ticks")) || { day, list: [] };
    if (done.day !== day) done = { day, list: [] };
    const once = async (tag, fn) => {
      if (done.list.includes(tag)) return;
      done.list.push(tag);
      await this.ctx.storage.put("ticks", done);
      await fn();
    };

    const active = this.activeCount();

    // 🧩 Загадка дня — если в группе за неделю писали хотя бы двое
    if (hour === RIDDLE_HOURS.start && !dead && active >= MIN_ACTIVE_RIDDLE) await once("riddle", () => this.startRiddle(day));
    if (hour === RIDDLE_HOURS.hint2) await once("hint2", () => this.riddleHint(2));
    if (hour === RIDDLE_HOURS.hint3) await once("hint3", () => this.riddleHint(3));
    if (hour === RIDDLE_HOURS.reveal) await once("reveal", () => this.revealRiddle());

    // 🌙 Вечерняя игра — сбор игроков (официальная группа зовёт всегда, остальные — если есть кому играть)
    if (hour === EVENING_HOUR && !dead && this.round.status === "idle" && (official || active >= MIN_ACTIVE)) {
      await once("evening", () => this.startGather(chatId, "🌙 <b>Вечерний Крокодил!</b> Кто сегодня играет? 🎮"));
    }

    // 🏆 Итоги недели
    if (dow === WEEKLY.dow && hour === WEEKLY.hour) await once("weekly", () => this.weeklySummary());

    // 😴 Тишина днём
    const lastNudge = (await this.ctx.storage.get("lastNudge")) || 0;
    if (
      hour >= NUDGE.from && hour <= NUDGE.to && hour !== EVENING_HOUR && !dead && active >= MIN_ACTIVE &&
      this.round.status === "idle" && Date.now() - this.lastAct > NUDGE.silenceMs && Date.now() - lastNudge > NUDGE.everyMs
    ) {
      await this.ctx.storage.put("lastNudge", Date.now());
      const phrases = [
        "😴 Что-то тихо в чате… Сыграем в Крокодила?",
        "🐊 Крокодил заскучал! Кто за пару раундов?",
        "🎮 Минутка на игру? Собираем команду!",
        "🧠 Проверим, кто тут самый сообразительный? Кто играет?",
      ];
      await this.startGather(chatId, phrases[Math.floor(Math.random() * phrases.length)]);
    }
    return { ok: true };
  }

  // ---------- сбор игроков после /game ----------
  async startGame(chatId, header = "") {
    if (this.isArena) return this.openRound(chatId, header);
    return this.startVote(chatId, header);
  }

  async lobbyText() {
    const players = this.activePlayers();
    const top = await this.topLines(5);
    return (
      (top ? "🏆 <b>Таблица лидеров группы</b>\n" + top + "\n\n" : "") +
      "🐊 <b>Собираем игру!</b> Кто играет?\n" +
      `Жми «🙋 Я играю» — сбор ${Math.round(LOBBY_MS / 1000)} секунд.` +
      (players.length ? `\n\n🙋 В игре (${players.length}): ${players.map((p) => esc(p.name)).join(", ")}` : "") +
      (this.game?.initiator ? "\n\n▶️ «Поехали» может нажать тот, кто запустил игру." : "")
    );
  }
  lobbyKeyboard() {
    return kb([[[`🙋 Я играю (${this.activePlayers().length})`, "ljoin"], ["▶️ Поехали", "lgo"]]]);
  }

  async startLobby(chatId, initiator, prefill = []) {
    this.game = { roster: {}, initiator: initiator?.id || null };
    const now = Date.now();
    for (const p of prefill) this.game.roster[p.id] = { name: p.name, at: now };
    if (initiator) this.game.roster[initiator.id] = { name: displayName(initiator), at: now };
    await this.ctx.storage.put("game", this.game);
    const r = { status: "lobby", chatId, msgId: null, deadline: now + LOBBY_MS };
    this.round = r;
    await this.save();
    const res = await this.send(chatId, await this.lobbyText(), { reply_markup: this.lobbyKeyboard() });
    if (this.round !== r) return;
    if (!res.ok) {
      this.round = { status: "idle" };
      return this.save();
    }
    r.msgId = res.result.message_id;
    await this.save();
    await this.ctx.storage.setAlarm(r.deadline);
  }

  async onLobby(cq, data) {
    const r = this.round;
    if (data === "ljoin") {
      const was = !!this.game?.roster?.[cq.from.id];
      await this.touchPlayer(cq.from);
      await this.answer(cq, was ? "Ты уже в игре 👍" : "Ты в игре! 🙋");
      if (!was) await this.edit(r.chatId, r.msgId, await this.lobbyText(), this.lobbyKeyboard());
      return;
    }
    if (data === "lgo") {
      const init = this.game?.initiator;
      if (init && cq.from.id !== init) return this.answer(cq, "Начать может только тот, кто запустил игру", true);
      if (!init && !this.game?.roster?.[cq.from.id]) return this.answer(cq, "Сначала нажми «Я играю»", true);
      await this.answer(cq, "Поехали!");
      return this.finishLobby();
    }
    return this.answer(cq);
  }

  async finishLobby() {
    const r = this.round;
    if (r.status !== "lobby") return;
    r.status = "ended";
    const players = this.activePlayers();
    if (!players.length) {
      this.round = { status: "idle" };
      await this.save();
      return this.edit(r.chatId, r.msgId, "😔 Никто не записался. Начать снова — /game");
    }
    await this.edit(r.chatId, r.msgId, `✅ <b>В игре ${players.length}:</b> ${players.map((p) => esc(p.name)).join(", ")}`);
    return this.startVote(r.chatId);
  }

  // ---------- настройка раунда: категория, сложность, слов, время ----------
  voteDefaults() {
    const c = this.cfg();
    const solo = this.activePlayers().length < CLASSIC_MIN;
    return {
      level: c.level || "medium", words: String(SESSION_WORDS), time: String(c.timed ? c.timeSec : 0),
      mode: solo ? "croc" : this.session?.mode || "classic",
    };
  }

  rowTally(votes) {
    const counts = {};
    for (const v of Object.values(votes)) counts[v] = (counts[v] || 0) + 1;
    return counts;
  }

  rowWinner(votes, def, pickRandom = true) {
    const counts = this.rowTally(votes);
    const max = Math.max(0, ...Object.values(counts));
    if (!max) return def;
    const leaders = Object.keys(counts).filter((k) => counts[k] === max);
    if (leaders.includes(def)) return def;
    return pickRandom ? leaders[Math.floor(Math.random() * leaders.length)] : leaders[0];
  }

  voteKeyboard(r) {
    const mark = (row, key, def) => {
      const counts = this.rowTally(r.votes[row] || {});
      const lead = this.rowWinner(r.votes[row] || {}, def, false);
      return (key === lead ? "✓ " : "") + (counts[key] ? ` · ${counts[key]}` : "");
    };
    const label = (row, key, text, def) => {
      const m = mark(row, key, def);
      return m.startsWith("✓ ") ? "✓ " + text + m.slice(2) : text + m;
    };
    const head = (t) => [[t, "noop"]];
    const rows = [head("— 📂 Категория —")];
    const cats = [...CATEGORY_ORDER, "any"];
    for (let i = 0; i < cats.length; i += 2) {
      rows.push(cats.slice(i, i + 2).map((k) => [label("cat", k, catName(k), "any"), "vc:" + k]));
    }
    rows.push(head("— 👤 Кто объясняет —"));
    rows.push(
      (r.solo ? ["croc"] : ["classic", "croc"]).map((m) => [label("mode", m, m === "croc" ? "🐊 Крокодил" : "🙋 Игроки", r.def.mode), "vm:" + m])
    );
    if (this.activePlayers().length >= FLAG_TEAMS_MIN) {
      rows.push(head("— 🏳️ Если флаги —"));
      rows.push([
        [label("fmode", "ffa", "👤 Каждый сам", this.session?.fpref || "ffa"), "vf:ffa"],
        [label("fmode", "teams", "⚔️ 🔴 против 🔵", this.session?.fpref || "ffa"), "vf:teams"],
      ]);
    }
    rows.push(head("— 🎚 Сложность —"));
    const lv = Object.keys(LEVELS);
    rows.push(lv.slice(0, 2).map((k) => [label("level", k, LEVELS[k].name, r.def.level), "vl:" + k]));
    rows.push(lv.slice(2).map((k) => [label("level", k, LEVELS[k].name, r.def.level), "vl:" + k]));
    rows.push(head("— 🔢 Слов в раунде —"));
    rows.push(WORD_OPTIONS.map((n) => [label("words", String(n), String(n), r.def.words), "vw:" + n]));
    rows.push(head("— ⏱ Время на слово —"));
    rows.push(TIME_VOTE_OPTIONS.map((t) => [label("time", String(t), t ? `${t / 60} мин` : "∞", r.def.time), "vt:" + t]));
    rows.push([["▶️ Начать игру", "vgo"]]);
    return kb(rows);
  }

  voteText(r) {
    const players = this.activePlayers();
    const voted = new Set(Object.values(r.votes).flatMap((v) => Object.keys(v)));
    return (
      (r.header ? r.header + "\n\n" : "") +
      `🗳 <b>Настройка раунда</b> · в игре ${players.length}\n` +
      "Голосуйте в каждой строке — не спешите, времени сколько угодно.\n" +
      (r.initiator ? `Когда все готовы — <b>${esc(r.initiatorName || "запустивший игру")}</b> жмёт «▶️ Начать игру».\n` : "Когда все готовы — жмите «▶️ Начать игру».\n") +
      "✓ — что выбрано сейчас (если не голосовать, останется так)." +
      (r.solo ? `\n\n👤 Ты один — объяснять будет 🐊 Крокодил (или выбирай 🏳️ Флаги — серия на рекорд). Чтобы объясняли игроки, нужно ${CLASSIC_MIN}+ человека.` : "") +
      (voted.size ? `\n\n🙋 Проголосовали: ${voted.size} из ${Math.max(players.length, voted.size)}` : "")
    );
  }

  // Голосование решено: все проголосовали за категорию, или у лидера уже не отнять первое место
  voteDecided(r) {
    const n = Math.max(this.activePlayers().length, Object.keys(r.votes.cat).length);
    const cast = Object.keys(r.votes.cat).length;
    if (!n || !cast) return false;
    if (cast >= n) return true;
    const c = Object.values(this.rowTally(r.votes.cat)).sort((a, b) => b - a);
    return (c[0] || 0) > (c[1] || 0) + (n - cast);
  }

  async startVote(chatId, header = "", oldMsgId = null) {
    const now = Date.now();
    const r = {
      status: "vote", chatId, header, msgId: null, startedAt: now, deadline: now + VOTE_IDLE_MS,
      initiator: this.game?.initiator || null, initiatorName: this.game?.roster?.[this.game?.initiator]?.name || null,
      votes: { cat: {}, level: {}, words: {}, time: {}, mode: {}, fmode: {} }, def: this.voteDefaults(),
      solo: this.activePlayers().length < CLASSIC_MIN,
    };
    this.round = r;
    await this.save();
    if (oldMsgId) await this.removeButtons(chatId, oldMsgId);
    const res = await this.send(chatId, this.voteText(r), { reply_markup: this.voteKeyboard(r) });
    if (this.round !== r) return;
    if (!res.ok) {
      this.round = { status: "idle" };
      return this.save();
    }
    r.msgId = res.result.message_id;
    await this.save();
    await this.ctx.storage.setAlarm(r.deadline);
  }

  async onVote(cq, data) {
    const r = this.round;
    if (data === "vgo") return this.onVoteGo(cq);
    const [row, val] = String(data).split(":");
    const map = { vc: "cat", vl: "level", vw: "words", vt: "time", vm: "mode", vf: "fmode" };
    const key = map[row];
    const ok =
      (key === "cat" && (val === "any" || val === FLAG_CAT || CATEGORIES[val])) ||
      (key === "level" && LEVELS[val]) ||
      (key === "words" && WORD_OPTIONS.includes(Number(val))) ||
      (key === "time" && TIME_VOTE_OPTIONS.includes(Number(val))) ||
      (key === "mode" && (val === "croc" || (val === "classic" && !r.solo))) ||
      (key === "fmode" && (val === "ffa" || val === "teams"));
    if (key === "fmode" && !r.votes.fmode) r.votes.fmode = {};
    if (!ok) return this.answer(cq);
    const prev = r.votes[key][cq.from.id];
    r.votes[key][cq.from.id] = val;
    await this.save();
    await this.answer(cq, prev === val ? "Голос уже учтён 👍" : "Голос учтён ✅");
    r.deadline = Date.now() + VOTE_IDLE_MS; // пока голосуют — настройка не закрывается
    await this.save();
    await this.ctx.storage.setAlarm(r.deadline);
    if (prev !== val) await this.edit(r.chatId, r.msgId, this.voteText(r), this.voteKeyboard(r));
  }

  // «▶️ Начать игру»: запустивший игру (или админ); если его нет — любой игрок через 2 минуты
  async onVoteGo(cq) {
    const r = this.round;
    const uid = cq.from.id;
    const may =
      !r.initiator ||
      uid === r.initiator ||
      this.isOwner(uid) ||
      Date.now() - r.startedAt >= VOTE_ANYONE_MS ||
      (await this.isAdmin(r.chatId, uid));
    if (!may) {
      const left = Math.ceil((VOTE_ANYONE_MS - (Date.now() - r.startedAt)) / 1000);
      return this.answer(cq, `Начать может ${r.initiatorName || "тот, кто запустил игру"}. Если он(а) пропал(а) — любой сможет через ${left} сек.`, true);
    }
    if (this.round.status !== "vote") return this.answer(cq);
    await this.answer(cq, "Поехали! 🚀");
    return this.finishVote();
  }

  sessionSummary(ses) {
    if (ses.cat === FLAG_CAT) {
      const lv = (LEVELS[ses.level] || LEVELS.medium).name;
      if (ses.fmode === "solo") return `${catName(FLAG_CAT)} · ${lv} · 🔥 серия`;
      return `${catName(FLAG_CAT)} · ${lv} · ${ses.words} флагов · ${ses.fmode === "teams" ? "⚔️ 🔴 против 🔵" : "👤 каждый сам за себя"}`;
    }
    if (ses.mode === "croc") return `🐊 Крокодил ведёт · ${catName(ses.cat)} · ${(LEVELS[ses.level] || LEVELS.medium).name} · ${ses.words} слов`;
    return (
      `${catName(ses.cat)} · ${(LEVELS[ses.level] || LEVELS.medium).name} · ${ses.words} слов · ` +
      (ses.timed ? `⏱ ${fmtTime(ses.timeSec)}` : "♾ без времени")
    );
  }

  async finishVote() {
    const r = this.round;
    if (r.status !== "vote") return;
    r.status = "ended";
    const catKey = this.rowWinner(r.votes.cat, "any");
    const mode = r.solo ? "croc" : this.rowWinner(r.votes.mode || {}, r.def.mode || "classic");
    const level = this.rowWinner(r.votes.level, r.def.level);
    const words = Number(this.rowWinner(r.votes.words, r.def.words)) || SESSION_WORDS;
    const time = Number(this.rowWinner(r.votes.time, r.def.time)) || 0;
    const fpref = this.rowWinner(r.votes.fmode || {}, this.session?.fpref || "ffa");
    this.session = { cat: catKey === "any" ? null : catKey, n: 0, p: {}, words, level, timed: time > 0, timeSec: time, mode, fpref };
    this.last = { level, timed: time > 0, timeSec: time || 300 };
    await this.ctx.storage.put({ session: this.session, last: this.last });
    await this.edit(r.chatId, r.msgId, (r.header ? r.header + "\n\n" : "") + "🗳 <b>Решено:</b> " + this.sessionSummary(this.session));
    if (catKey === FLAG_CAT) {
      this.flagSessionReset();
      await this.ctx.storage.put("session", this.session);
      return this.openFlag(r.chatId, `📂 <b>${this.sessionSummary(this.session)}</b>\nПоехали!`);
    }
    if (mode === "croc") {
      this.crocSessionReset();
      await this.ctx.storage.put("session", this.session);
      return this.openCroc(r.chatId, `📂 <b>${this.sessionSummary(this.session)}</b>\nПоехали!`);
    }
    return this.openRound(r.chatId, `📂 <b>${this.sessionSummary(this.session)}</b>\nПоехали!`);
  }

  async sessionPoints(userId, name, pts) {
    if (this.isArena || !this.session) return;
    const e = this.session.p[userId] || { name, points: 0 };
    e.name = name;
    e.points += pts;
    this.session.p[userId] = e;
    await this.ctx.storage.put("session", this.session);
  }

  // После каждого слова: следующее слово или итоги раунда
  async nextRound(chatId, header, oldMsgId) {
    if (this.isArena && this.match && ["stage1", "extra"].includes(this.match.status)) {
      this.match.turnIdx++;
      await this.ctx.storage.put("match", this.match);
      return this.arenaTurn(chatId, header, oldMsgId);
    }
    if (this.isArena || !this.session) return this.openRound(chatId, header, oldMsgId);
    this.session.n++;
    await this.ctx.storage.put("session", this.session);
    const total = this.session.words || SESSION_WORDS;
    if (this.session.n < total) return this.openRound(chatId, header, oldMsgId);

    const ses = this.session;
    const top = Object.values(ses.p).sort((a, b) => b.points - a.points);
    const medals = ["🥇", "🥈", "🥉"];
    const text =
      header +
      `\n\n🏁 <b>Раунд окончен!</b> ${this.sessionSummary(ses)}\n` +
      (top.length
        ? "📊 <b>Итоги раунда:</b>\n" + top.slice(0, 5).map((e, i) => `${medals[i] || i + 1 + "."} ${esc(e.name)} — ${e.points}`).join("\n")
        : "Никто не набрал очков 🤷") +
      "\n\nЧто дальше?";
    return this.showChoice(chatId, text, oldMsgId);
  }

  async showChoice(chatId, text, oldMsgId) {
    if (!/Что дальше\?$/.test(text)) text += "\n\nЧто дальше?";
    const r = { status: "choice", chatId, text, msgId: null, deadline: Date.now() + WAIT_MS };
    this.round = r;
    await this.save();
    if (oldMsgId) await this.removeButtons(chatId, oldMsgId);
    const me = await this.getMe();
    const rows = kb([[["▶️ Продолжить с теми же настройками", "cont"]], [["🔧 Изменить настройки", "newcat"]]]).inline_keyboard;
    if (me.username) rows.push([{ text: "📊 Моя статистика", url: `https://t.me/${me.username}?start=me` }]);
    const res = await this.send(chatId, text, { reply_markup: { inline_keyboard: rows } });
    if (this.round !== r) return;
    if (!res.ok) {
      this.round = { status: "idle" };
      return this.save();
    }
    r.msgId = res.result.message_id;
    await this.save();
    await this.ctx.storage.setAlarm(r.deadline);
  }

  async onChoice(cq, data) {
    const r = this.round;
    if (data !== "cont" && data !== "newcat") return this.answer(cq);
    r.status = "ended"; // первое нажатие решает
    await this.edit(r.chatId, r.msgId, r.text.replace(/\n\nЧто дальше\?$/, ""));
    if (data === "newcat") {
      await this.answer(cq, "🔧 Настраиваем новый раунд");
      return this.startVote(r.chatId);
    }
    this.session = { ...(this.session || {}), n: 0, p: {} };
    if (this.session.cat === FLAG_CAT) this.flagSessionReset();
    await this.ctx.storage.put("session", this.session);
    await this.answer(cq, "▶️ Продолжаем!");
    if (this.session.cat === FLAG_CAT) return this.openFlag(r.chatId, `▶️ Продолжаем: <b>${this.sessionSummary(this.session)}</b>`);
    if (this.session.mode === "croc") {
      this.crocSessionReset();
      await this.ctx.storage.put("session", this.session);
      return this.openCroc(r.chatId, `▶️ Продолжаем: <b>${this.sessionSummary(this.session)}</b>`);
    }
    return this.openRound(r.chatId, `▶️ Продолжаем: <b>${this.sessionSummary(this.session)}</b>`);
  }

  // ================== 🐊 КРОКОДИЛ ВЕДЁТ ==================
  crocSessionReset() {
    Object.assign(this.session, { n: 0, p: {}, people: 0, croc: 0 });
  }

  // Слово с подсказками: из категории (или любой категории для «🎲 Любая»)
  async pickCrocWord() {
    const ses = this.session;
    const cats = CATEGORY_ORDER.filter((k) => CATEGORIES[k]);
    for (let attempt = 0; attempt < 8; attempt++) {
      const cat = ses.cat && CATEGORIES[ses.cat] ? ses.cat : cats[Math.floor(Math.random() * cats.length)];
      const e = this.pickWord(ses.level, cat);
      const hints = await getHints(this.env, e);
      if (hints) return { ...e, cat, hints };
    }
    return null;
  }

  crocText(r) {
    const ses = this.session;
    return (
      (r.header ? r.header + "\n\n" : "") +
      (r.hintN === 1 ? "🐊 <b>Крокодил загадал слово!</b>\n" : "") +
      `📂 ${catName(r.cat)} · слово ${ses.n + 1}/${ses.words} · ${(LEVELS[r.level] || LEVELS.medium).name}\n\n` +
      `💬 <b>Подсказка ${r.hintN}/5:</b>\n<i>«${esc(r.hints[r.hintN - 1])}»</i>\n\n` +
      (r.hintN < 5
        ? `❌ Следующая подсказка — после ${crocNeed(Math.max(1, this.activePlayers().length))} неправильных ответов`
        : "⚠️ Это последняя подсказка! Не угадаете — очко Крокодилу 🐊")
    );
  }

  async sendCrocHint(r, extraHeader = "") {
    r.header = extraHeader;
    const rows = [];
    if (r.rulesUrl && this.session.n === 0 && r.hintN === 1) rows.push([{ text: "📖 Правила режима", url: r.rulesUrl }]);
    const res = await this.send(r.chatId, this.crocText(r), rows.length ? { reply_markup: { inline_keyboard: rows } } : {});
    if (res.ok) r.msgId = res.result.message_id;
  }

  async openCroc(chatId, header = "", oldMsgId = null) {
    const ses = this.session;
    if (oldMsgId) await this.removeButtons(chatId, oldMsgId);
    const e = await this.pickCrocWord();
    if (!e) {
      this.round = { status: "idle" };
      await this.save();
      return this.send(chatId, "😔 Не нашлось слов с подсказками для этой категории. Попробуйте другую — /game");
    }
    const now = Date.now();
    const r = {
      status: "croc", chatId, msgId: null, header: "", word: e.word, answers: e.answers, cat: e.cat, level: ses.level,
      hints: e.hints, hintN: 1, misses: 0, seen: [], lastGuess: {}, lastAct: now, silentHint: false,
      deadline: now + CROC_SILENCE_MS, rulesUrl: null,
    };
    if (ses.n === 0) {
      const me = await this.getMe();
      if (me.username) r.rulesUrl = `https://t.me/${me.username}?start=rules_croc`;
    }
    this.round = r;
    await this.ctx.storage.put({ round: r, session: ses, recent: this.recent });
    await this.sendCrocHint(r, header);
    if (this.round !== r) return;
    await this.save();
    await this.ctx.storage.setAlarm(r.deadline);
  }

  async onCrocText(msg) {
    const r = this.round;
    const ses = this.session;
    const text = msg.text.trim();
    if (!text || text.split(/\s+/).length > 3) return; // болтовня — не ответ
    const uid = msg.from.id;
    const now = Date.now();
    r.lastAct = now;
    r.silentHint = false;
    r.deadline = now + CROC_SILENCE_MS;

    if (answerHit(text, r.answers)) {
      r.status = "ended"; // до любого await — второй угадавший не получит
      const name = displayName(msg.from);
      const pts = Math.max(1, Math.round(CROC_POINTS[r.hintN - 1] * (LEVELS[r.level]?.mult || 1)));
      ses.people = (ses.people || 0) + 1;
      await this.addCrocStats(uid, name, pts);
      await this.sessionPoints(uid, name, pts);
      await this.tg("setMessageReaction", { chat_id: r.chatId, message_id: msg.message_id, reaction: [{ type: "emoji", emoji: "🎉" }] });
      return this.nextCroc(
        r.chatId,
        `🎉 <b>${esc(name)}</b> угадал(а): <b>${upper(r.word)}</b> после ${r.hintN}-й подсказки! +${pts} 🐊-очков`
      );
    }

    const key = tokenize(text).join(" ");
    if (key && !r.seen.includes(key) && now - (r.lastGuess[uid] || 0) >= 3000) {
      r.seen.push(key);
      r.lastGuess[uid] = now;
      r.misses++;
    }
    if (r.misses >= crocNeed(Math.max(1, this.activePlayers().length))) return this.crocAdvance(false);
    await this.ctx.storage.put("round", r);
    await this.ctx.storage.setAlarm(r.deadline);
  }

  // Следующая подсказка; после 5-й — слово достаётся Крокодилу
  async crocAdvance(bySilence) {
    const r = this.round;
    const ses = this.session;
    if (r.hintN >= 5) {
      r.status = "ended";
      ses.croc = (ses.croc || 0) + 1;
      return this.nextCroc(r.chatId, `🐊 <b>Крокодил победил!</b> Никто не угадал слово <b>${upper(r.word)}</b>.`);
    }
    r.hintN++;
    r.misses = 0;
    r.seen = [];
    r.silentHint = bySilence;
    r.lastAct = Date.now();
    r.deadline = r.lastAct + CROC_SILENCE_MS;
    await this.sendCrocHint(r, bySilence ? "😴 Что-то тихо… Держите ещё подсказку:" : "");
    await this.ctx.storage.put("round", r);
    await this.ctx.storage.setAlarm(r.deadline);
  }

  async crocAlarm() {
    const r = this.round;
    if (Date.now() < r.lastAct + CROC_SILENCE_MS - 1000) return this.ctx.storage.setAlarm(r.lastAct + CROC_SILENCE_MS);
    // Тишина после подсказки, открытой из-за тишины (или после последней) — Крокодил расстраивается
    if (r.silentHint || r.hintN >= 5) {
      r.status = "ended";
      return this.endCroc(
        r.chatId,
        `😢 <b>Крокодил расстроился</b> — с ним никто не играет.\nСлово было: <b>${upper(r.word)}</b>`,
        true
      );
    }
    return this.crocAdvance(true);
  }

  async nextCroc(chatId, header) {
    const ses = this.session;
    ses.n++;
    await this.ctx.storage.put("session", ses);
    if (ses.n >= ses.words) return this.endCroc(chatId, header, false);
    return this.openCroc(chatId, header);
  }

  async endCroc(chatId, header, final) {
    const ses = this.session;
    const top = Object.values(ses.p || {}).sort((a, b) => b.points - a.points);
    const medals = ["🥇", "🥈", "🥉"];
    const text =
      (header ? header + "\n\n" : "") +
      `🏁 <b>${final ? "Игра окончена" : "Раунд окончен"}!</b> ${this.sessionSummary(ses)}\n` +
      `👥 Люди <b>${ses.people || 0}</b> : <b>${ses.croc || 0}</b> Крокодил 🐊\n` +
      (top.length ? "🏹 <b>Лучшие охотники раунда:</b>\n" + top.slice(0, 5).map((e, i) => `${medals[i] || i + 1 + "."} ${esc(e.name)} — ${e.points}`).join("\n") : "");
    if (final) {
      this.round = { status: "idle" };
      await this.save();
      await this.ctx.storage.deleteAlarm();
      return this.send(chatId, text + "\n\nНовая игра — /game");
    }
    return this.showChoice(chatId, text);
  }

  // Отдельный счёт «Охотники на Крокодила» — не влияет на рейтинг группы и Супер-игру
  async addCrocStats(userId, name, pts) {
    const key = "c:" + userId;
    const s = (await this.ctx.storage.get(key)) || { name, points: 0, wins: 0 };
    s.name = name;
    s.points += pts;
    s.wins += 1;
    await this.ctx.storage.put(key, s);
    if (!this.isArena) await this.indexUser(userId);
  }

  async crocTop(limit) {
    const all = await this.ctx.storage.list({ prefix: "c:" });
    const medals = ["🥇", "🥈", "🥉"];
    return [...all.values()]
      .sort((a, b) => b.points - a.points)
      .slice(0, limit)
      .map((s, i) => `${medals[i] || i + 1 + "."} <b>${esc(s.name)}</b> — ${s.points} (слов: ${s.wins})`)
      .join("\n");
  }

  // ================== 🏳️ ФЛАГИ ==================
  // Три режима (выбираются сами по числу игроков):
  //   solo  — 1 игрок: серия «сколько подряд без ошибки», в рейтинг не идёт, свои рекорды
  //   ffa   — 2–3 игрока (или выбор при 4+): каждый сам за себя, буквы покупаются за свой рейтинг и видны только тебе
  //   teams — 4+ игроков по выбору: 🔴 против 🔵, у каждой команды свой банк
  flagModeFor(pref) {
    const n = this.activePlayers().length;
    if (n <= 1) return "solo";
    if (n < FLAG_TEAMS_MIN) return "ffa";
    return pref === "teams" ? "teams" : "ffa";
  }

  flagSessionReset() {
    const ses = this.session;
    const fmode = this.flagModeFor(ses.fpref);
    const players = this.activePlayers();
    Object.assign(ses, {
      n: 0, p: {}, fmode, answered: {}, guessedBy: {}, queue: [], used: [], silenceSkips: 0, paid: false,
      streak: 0, soloId: fmode === "solo" ? players[0]?.id || this.game?.initiator || null : null,
      soloName: fmode === "solo" ? players[0]?.name || null : null,
      teams: null,
    });
    if (fmode === "teams") {
      const sh = players.map((p) => p.id).sort(() => Math.random() - 0.5);
      const cap = flagBasePrice(ses.level);
      ses.teams = {
        r: { members: sh.filter((_, i) => i % 2 === 0), bank: 0, capital: cap },
        b: { members: sh.filter((_, i) => i % 2 === 1), bank: 0, capital: cap },
      };
    }
  }

  teamOf(uid) {
    const t = this.session?.teams;
    if (!t) return null;
    if (t.r.members.includes(uid)) return "r";
    if (t.b.members.includes(uid)) return "b";
    return null;
  }
  // Опоздавший попадает в меньшую команду
  joinTeam(uid) {
    const t = this.session.teams;
    let k = this.teamOf(uid);
    if (k) return k;
    k = t.r.members.length <= t.b.members.length ? "r" : "b";
    t[k].members.push(uid);
    return k;
  }
  teamFunds(k) {
    const t = this.session.teams[k];
    return (t.bank || 0) + (t.capital || 0);
  }
  teamNames(k) {
    const roster = this.game?.roster || {};
    const ses = this.session;
    return this.session.teams[k].members.map((id) => esc(ses.answered[id] || roster[id]?.name || "игрок")).join(", ");
  }

  pickFlag() {
    const ses = this.session;
    const due = (ses.queue || []).findIndex((q) => q.at <= ses.n);
    if (due >= 0) {
      const code = ses.queue.splice(due, 1)[0].code;
      const e = FLAG_LIST.find((x) => x.code === code);
      if (e) return e;
    }
    const pool = FLAG_LIST.filter((e) => e.level === ses.level);
    const recent = new Set(this.recentFlags || []);
    const queued = new Set((ses.queue || []).map((q) => q.code));
    let cand = pool.filter((e) => !ses.used.includes(e.code) && !recent.has(e.code) && !queued.has(e.code));
    if (!cand.length) cand = pool.filter((e) => !ses.used.includes(e.code) && !queued.has(e.code));
    if (!cand.length) {
      ses.used = []; // серия прошла все флаги уровня — начинаем круг заново
      cand = pool;
    }
    const e = cand[Math.floor(Math.random() * cand.length)];
    ses.used.push(e.code);
    this.recentFlags = [...(this.recentFlags || []), e.code].slice(-60);
    return e;
  }

  flagLetters(r) {
    return [...upper(r.name)].map((ch, i) => (/[А-ЯЁA-Z]/.test(ch) ? i : -1)).filter((i) => i >= 0);
  }
  flagMaskOf(r, revealed) {
    return [...upper(r.name)].map((ch, i) => (/[А-ЯЁA-Z]/.test(ch) ? (revealed.includes(i) ? ch : "_") : ch)).join(" ");
  }
  // чьи буквы: в ffa — игрока, в командах — команды
  flagOwner(uid) {
    return this.session.fmode === "teams" ? "t:" + this.joinTeam(uid) : "u:" + uid;
  }
  flagNeed() {
    return flagLetterNeed(Math.max(1, this.activePlayers().length));
  }
  flagUnlocks(r) {
    const need = this.flagNeed();
    return { letter: r.silent || r.misses >= need, skip: r.silent || r.misses >= need * 2, need };
  }

  flagCaption(r) {
    const ses = this.session;
    const u = this.flagUnlocks(r);
    const lvl = (LEVELS[r.level] || LEVELS.medium).name;
    let body = "";
    if (ses.fmode === "solo") {
      const best = r.best || 0;
      body =
        `🔥 Серия <b>${esc(ses.soloName || "")}</b>: <b>${ses.streak}</b> подряд · ${lvl}\n` +
        `🏅 Твой рекорд: ${best}` + (r.groupRec ? ` · рекорд группы: ${r.groupRec.best} (${esc(r.groupRec.name)})` : "") +
        "\nОдна ошибка — и серия заканчивается. Букв и пропусков нет.";
    } else if (ses.fmode === "teams") {
      body =
        `📂 Флаги · ${ses.n + 1}/${ses.words} · ${lvl} · ⚔️ Команда на команду\n` +
        `🔴 Банк: <b>${this.teamFunds("r")}</b> · 🔵 Банк: <b>${this.teamFunds("b")}</b>` +
        (ses.n === 0 ? " (стартовый капитал — только на этот флаг)" : "") +
        `\n🔴 ${this.teamNames("r")}\n🔵 ${this.teamNames("b")}` +
        (u.letter ? `\n🔤 Буква за банк команды — её видят только игроки твоей команды («👁 Наши буквы»)` : `\n🔒 Буквы откроются после ${u.need} неправильных ответов`);
    } else {
      body =
        `📂 Флаги · ${ses.n + 1}/${ses.words} · ${lvl} · 👤 Каждый сам за себя\n` +
        `🎯 Кто первый — +${r.value} себе` +
        (u.letter ? `\n🔤 Буква — за твой рейтинг (от ${flagBasePrice(r.level)}), видишь её только ты` : `\n🔒 Буквы откроются после ${u.need} неправильных ответов`);
    }
    return (
      (r.header ? r.header + "\n\n" : "") +
      "🏳️ <b>Чей это флаг?</b>\n" +
      body +
      (r.silent && ses.fmode !== "solo" ? "\n⏳ Тишина… кнопки открыты. Ещё 2 минуты — и флаг пропустится сам." : "") +
      (r.silent && ses.fmode === "solo" ? "\n⏳ Ты здесь? Ещё 2 минуты тишины — и серия закончится." : "")
    );
  }

  skipNeed() {
    const ses = this.session;
    if (ses.fmode === "teams") return 2; // по одному из каждой команды
    return this.activePlayers().length >= 3 ? 2 : 1;
  }

  flagKeyboard(r) {
    const ses = this.session;
    const rows = [];
    if (ses.fmode === "solo") {
      rows.push([{ text: "🏁 Закончить серию", callback_data: "fl:end" }]);
    } else {
      const u = this.flagUnlocks(r);
      const need = this.skipNeed();
      const btns = [];
      if (u.letter) {
        btns.push({ text: "🔤 Купить букву", callback_data: "fl:buy" });
        btns.push({ text: ses.fmode === "teams" ? "👁 Наши буквы" : "👁 Мои буквы", callback_data: "fl:see" });
      }
      if (btns.length) rows.push(btns);
      if (u.skip) rows.push([{ text: `⏭ Пропустить${need > 1 && r.pend.skip.length ? ` · ${r.pend.skip.length}/${need}` : ""}`, callback_data: "fl:skip" }]);
    }
    if (r.rulesUrl) rows.push([{ text: "📖 Правила режима", url: r.rulesUrl }]);
    return { inline_keyboard: rows };
  }

  async editFlag(r) {
    const base = { chat_id: r.chatId, message_id: r.msgId, parse_mode: "HTML", reply_markup: this.flagKeyboard(r) };
    if (r.isPhoto) return this.tg("editMessageCaption", { ...base, caption: this.flagCaption(r) });
    return this.tg("editMessageText", { ...base, text: flagEmoji(r.code) + "\n\n" + this.flagCaption(r) });
  }

  async openFlag(chatId, header = "", oldMsgId = null) {
    const ses = this.session;
    if (ses.n > 0 && ses.teams) ses.teams.r.capital = ses.teams.b.capital = 0; // стартовый капитал сгорает после первого флага
    const e = this.pickFlag();
    const now = Date.now();
    const r = {
      status: "flag", chatId, msgId: null, header, code: e.code, name: e.name, answers: e.answers,
      level: ses.level, value: FLAG_VALUE[ses.level] || 8, misses: 0, seen: [], lastGuess: {},
      priv: {}, buys: {}, pend: { skip: [] }, silent: false, lastAct: now, deadline: now + FLAG_UNLOCK_MS,
      isPhoto: true, rulesUrl: null,
    };
    if (ses.fmode === "solo") {
      const rec = (await this.ctx.storage.get(`s:${ses.soloId}:${ses.level}`)) || {};
      r.best = rec.best || 0;
      r.groupRec = (await this.ctx.storage.get("srec:" + ses.level)) || null;
    }
    if (ses.n === 0) {
      const me = await this.getMe();
      if (me.username) r.rulesUrl = `https://t.me/${me.username}?start=rules_flags`;
    }
    this.round = r;
    await this.ctx.storage.put({ round: r, session: ses, recentFlags: this.recentFlags || [] });
    if (oldMsgId) await this.removeButtons(chatId, oldMsgId);
    let res = await this.tg("sendPhoto", {
      chat_id: chatId, photo: flagImage(e.code), caption: this.flagCaption(r), parse_mode: "HTML", reply_markup: this.flagKeyboard(r),
    });
    if (!res.ok) {
      r.isPhoto = false; // картинка не загрузилась — показываем флаг эмодзи
      res = await this.send(chatId, flagEmoji(e.code) + "\n\n" + this.flagCaption(r), { reply_markup: this.flagKeyboard(r) });
    }
    if (this.round !== r) return;
    if (!res.ok) {
      this.round = { status: "idle" };
      return this.save();
    }
    r.msgId = res.result.message_id;
    await this.save();
    await this.ctx.storage.setAlarm(r.deadline);
  }

  flagNextDue(r) {
    if (!r.silent) return r.lastAct + FLAG_UNLOCK_MS;
    return Math.max(r.lastAct, r.silentAt || 0) + FLAG_AUTOSKIP_MS;
  }

  async onFlagText(msg) {
    const r = this.round;
    const ses = this.session;
    const text = msg.text.trim();
    if (!text || text.split(/\s+/).length > 3) return; // болтовня — не ответ
    const uid = msg.from.id;
    const name = displayName(msg.from);
    const now = Date.now();

    // ---- серия одного игрока: чужие ответы не считаются, ошибка = назвал другую страну
    if (ses.fmode === "solo") {
      if (uid !== ses.soloId) return;
      r.lastAct = now;
      if (flagGuess(text, r)) {
        r.status = "ended";
        ses.streak++;
        await this.tg("setMessageReaction", { chat_id: r.chatId, message_id: msg.message_id, reaction: [{ type: "emoji", emoji: "🔥" }] });
        ses.n++;
        await this.ctx.storage.put("session", ses);
        return this.openFlag(r.chatId, `✅ <b>${upper(r.name)}</b>! Серия: <b>${ses.streak}</b> 🔥`, r.msgId);
      }
      if (!flagAliasMap().has(tokenize(text).join(" "))) {
        await this.ctx.storage.put("round", r);
        return this.ctx.storage.setAlarm(this.flagNextDue(r)); // не название страны — не ошибка
      }
      r.status = "ended";
      return this.endSeries(r, `❌ Это не ${esc(text)} — это <b>${upper(r.name)}</b>.`);
    }

    ses.answered[uid] = name;
    if (ses.fmode === "teams") this.joinTeam(uid);
    r.lastAct = now;
    ses.silenceSkips = 0;

    if (flagGuess(text, r)) {
      r.status = "ended"; // до любого await — второй угадавший не получит
      const g = ses.guessedBy[uid] || { name, count: 0 };
      g.name = name;
      g.count++;
      ses.guessedBy[uid] = g;
      let line;
      if (ses.fmode === "teams") {
        const k = this.teamOf(uid);
        ses.teams[k].bank += r.value;
        await this.addStats(uid, name, { guessed: 1 });
        line = `🎉 <b>${esc(name)}</b> ${k === "r" ? "🔴" : "🔵"} угадал(а): <b>${upper(r.name)}</b>! +${r.value} в банк команды`;
      } else {
        const hard = (ses.level === "hard" || ses.level === "ultimate") && this.activePlayers().length >= 3;
        await this.addStats(uid, name, { points: r.value, guessed: 1, ...(hard ? { hardPoints: r.value } : {}) });
        await this.sessionPoints(uid, name, r.value);
        line = `🎉 <b>${esc(name)}</b> угадал(а): <b>${upper(r.name)}</b>! +${r.value}`;
      }
      await this.tg("setMessageReaction", { chat_id: r.chatId, message_id: msg.message_id, reaction: [{ type: "emoji", emoji: "🎉" }] });
      return this.nextFlag(r.chatId, line, r.msgId);
    }

    // Промах: повторы и частые ответы одного игрока не считаются
    const key = tokenize(text).join(" ");
    const before = JSON.stringify(this.flagKeyboard(r)) + this.flagCaption(r);
    if (key && !r.seen.includes(key) && now - (r.lastGuess[uid] || 0) >= 3000) {
      r.seen.push(key);
      r.lastGuess[uid] = now;
      r.misses++;
    }
    await this.ctx.storage.put({ round: r, session: ses });
    if (JSON.stringify(this.flagKeyboard(r)) + this.flagCaption(r) !== before) await this.editFlag(r); // открылись кнопки / новый игрок в команде
    await this.ctx.storage.setAlarm(this.flagNextDue(r));
  }

  async onFlagButton(cq, data) {
    const r = this.round;
    const ses = this.session;
    const uid = cq.from.id;
    const name = displayName(cq.from);

    if (ses.fmode === "solo") {
      if (data !== "fl:end") return this.answer(cq);
      if (uid !== ses.soloId && !this.isOwner(uid) && !(await this.isAdmin(r.chatId, uid))) return this.answer(cq, "Это серия другого игрока", true);
      if (r.status !== "flag") return this.answer(cq);
      r.status = "ended";
      await this.answer(cq, "🏁 Серия закончена");
      return this.endSeries(r, `🏁 Серия закончена. Это была <b>${upper(r.name)}</b>.`);
    }

    const u = this.flagUnlocks(r);
    if (data === "fl:see" || data === "fl:buy") {
      if (!u.letter) return this.answer(cq, "🔒 Буквы ещё не открыты", true);
      const owner = this.flagOwner(uid);
      const mine = r.priv[owner] || [];
      const total = this.flagLetters(r).length;
      if (data === "fl:see") {
        if (!mine.length) return this.answer(cq, `Букв пока нет. В названии ${total} букв.`, true);
        return this.answer(cq, `🔤 ${this.flagMaskOf(r, mine)}`, true);
      }
      const hidden = this.flagLetters(r).filter((i) => !mine.includes(i));
      if (hidden.length <= 1) return this.answer(cq, `🔤 ${this.flagMaskOf(r, mine)}\nОсталась одна буква — угадывай сам(а)! 😉`, true);
      const price = flagBasePrice(r.level) + (r.buys[owner] || 0);
      if (ses.fmode === "teams") {
        const k = owner.slice(2);
        const t = ses.teams[k];
        if (this.teamFunds(k) < price) return this.answer(cq, `💰 В банке команды ${this.teamFunds(k)}, а буква стоит ${price}. Угадайте флаг, чтобы пополнить банк!`, true);
        const fromCap = Math.min(t.capital || 0, price);
        t.capital -= fromCap;
        t.bank = Math.max(0, t.bank - (price - fromCap));
        ses.answered[uid] = name;
      } else {
        const s = (await this.ctx.storage.get("u:" + uid)) || {};
        if ((s.points || 0) < price) return this.answer(cq, `💰 Буква стоит ${price} очков рейтинга, а у тебя ${s.points || 0}. Угадай флаг — и сможешь купить!`, true);
        await this.addStats(uid, name, { points: -price });
        await this.sessionPoints(uid, name, -price);
      }
      r.buys[owner] = (r.buys[owner] || 0) + 1;
      mine.push(hidden[Math.floor(Math.random() * hidden.length)]); // случайная буква
      r.priv[owner] = mine;
      r.lastAct = Date.now();
      await this.ctx.storage.put({ round: r, session: ses });
      await this.answer(cq, `🔤 ${this.flagMaskOf(r, mine)}\n(−${price}${ses.fmode === "teams" ? " из банка команды" : " рейтинга"} · видишь только ${ses.fmode === "teams" ? "твоя команда" : "ты"})`, true);
      if (ses.fmode === "teams") await this.editFlag(r);
      return this.ctx.storage.setAlarm(this.flagNextDue(r));
    }

    if (data === "fl:skip") {
      if (!u.skip) return this.answer(cq, "🔒 Пропуск ещё недоступен", true);
      const need = this.skipNeed();
      if (ses.fmode === "teams") {
        const k = this.joinTeam(uid);
        if (!r.pend.skip.some((x) => this.teamOf(x) === k)) r.pend.skip.push(uid);
        const both = ["r", "b"].every((t) => r.pend.skip.some((x) => this.teamOf(x) === t));
        if (!both) {
          await this.ctx.storage.put({ round: r, session: ses });
          await this.answer(cq, `Голос за пропуск учтён. Нужно согласие ${k === "r" ? "🔵 синих" : "🔴 красных"}`);
          return this.editFlag(r);
        }
      } else {
        if (!r.pend.skip.includes(uid)) r.pend.skip.push(uid);
        if (r.pend.skip.length < need) {
          await this.ctx.storage.put("round", r);
          await this.answer(cq, `Голос за пропуск учтён. Нужен ещё ${need - r.pend.skip.length} игрок`);
          return this.editFlag(r);
        }
      }
      if (r.status !== "flag") return this.answer(cq);
      r.status = "ended";
      ses.queue.push({ code: r.code, at: ses.n + FLAG_REQUEUE });
      await this.answer(cq, "⏭ Пропускаем");
      return this.nextFlag(r.chatId, "⏭ Флаг пропущен — он ещё вернётся!", r.msgId);
    }
    return this.answer(cq);
  }

  async flagAlarm() {
    const r = this.round;
    const ses = this.session;
    const now = Date.now();
    if (!r.silent && now - r.lastAct >= FLAG_UNLOCK_MS - 1000) {
      r.silent = true;
      r.silentAt = now;
      await this.ctx.storage.put("round", r);
      await this.editFlag(r);
      return this.ctx.storage.setAlarm(this.flagNextDue(r));
    }
    if (r.silent && now >= this.flagNextDue(r) - 1000) {
      r.status = "ended";
      if (ses.fmode === "solo") return this.endSeries(r, `😴 Тишина… серия закончена. Это была <b>${upper(r.name)}</b>.`);
      ses.silenceSkips = (ses.silenceSkips || 0) + 1;
      ses.queue.push({ code: r.code, at: ses.n + FLAG_REQUEUE });
      if (ses.silenceSkips >= 2) {
        await this.removeButtons(r.chatId, r.msgId);
        return this.endFlags(r.chatId, "😴 Два флага подряд без ответов — игра остановлена.");
      }
      return this.nextFlag(r.chatId, "⏭ Тишина… флаг пропущен, он ещё вернётся.", r.msgId);
    }
    return this.ctx.storage.setAlarm(this.flagNextDue(r));
  }

  async nextFlag(chatId, header, oldMsgId) {
    const ses = this.session;
    ses.n++;
    await this.ctx.storage.put("session", ses);
    if (ses.n >= ses.words) {
      if (oldMsgId) await this.removeButtons(chatId, oldMsgId);
      return this.endFlags(chatId, header);
    }
    return this.openFlag(chatId, header, oldMsgId);
  }

  // ---- конец серии: личный рекорд и рекорд группы (в рейтинг не идёт)
  async saveSeries() {
    const ses = this.session;
    if (!ses || ses.fmode !== "solo" || ses.paid) return "";
    ses.paid = true;
    await this.ctx.storage.put("session", ses);
    const uid = ses.soloId;
    const name = ses.soloName || "Игрок";
    const lvl = ses.level;
    const n = ses.streak || 0;
    if (uid && !this.isArena) await this.indexUser(uid); // чтобы группа появилась в меню игрока
    const key = `s:${uid}:${lvl}`;
    const rec = (await this.ctx.storage.get(key)) || { name, best: 0, games: 0 };
    const personal = n > rec.best;
    rec.name = name;
    rec.games = (rec.games || 0) + 1;
    if (personal) rec.best = n;
    await this.ctx.storage.put(key, rec);
    const grec = (await this.ctx.storage.get("srec:" + lvl)) || null;
    const groupBest = n > 0 && (!grec || n > grec.best);
    if (groupBest) await this.ctx.storage.put("srec:" + lvl, { uid, name, best: n, at: Date.now() });
    const lvlName = (LEVELS[lvl] || LEVELS.medium).name;
    return (
      `🔥 Серия: <b>${n}</b> ${lvlName}` +
      (groupBest ? `\n\n🏆 <b>НОВЫЙ РЕКОРД ГРУППЫ!</b> ${esc(name)} — ${n} подряд (${lvlName})` + (grec ? ` (было ${grec.best}, ${esc(grec.name)})` : "") + "!"
        : personal && n > 0 ? `\n🏅 Новый личный рекорд!` : `\n🏅 Твой рекорд: ${rec.best}` + (grec ? ` · рекорд группы: ${grec.best} (${esc(grec.name)})` : "")) +
      "\n\n<i>Серия — тренировка: в рейтинг не идёт, зато рекорды видны всем в «🏆 Рейтинги».</i>"
    );
  }

  async endSeries(r, header) {
    const res = await this.saveSeries();
    if (r.msgId) await this.removeButtons(r.chatId, r.msgId);
    return this.showChoice(r.chatId, header + "\n\n🏁 <b>Серия окончена!</b>\n" + res);
  }

  // Итоги флагов (ffa и команды); для серии — рекорды
  async payoutFlags() {
    const ses = this.session;
    if (!ses || ses.cat !== FLAG_CAT || ses.paid) return "";
    if (ses.fmode === "solo") return this.saveSeries();
    ses.paid = true;
    await this.ctx.storage.put("session", ses);
    const guessed = Object.values(ses.guessedBy || {}).sort((a, b) => b.count - a.count);
    const guessLine = guessed.length ? "🎯 Угадали: " + guessed.map((g) => `${esc(g.name)} — ${g.count}`).join(", ") : "🎯 Никто не угадал ни одного флага";

    if (ses.fmode === "teams") {
      const countsHard = (ses.level === "hard" || ses.level === "ultimate") && Object.keys(ses.answered).length >= 3;
      const lines = [];
      for (const k of ["r", "b"]) {
        const t = ses.teams[k];
        const bank = Math.max(0, t.bank || 0);
        const ids = t.members.filter((id) => ses.answered[id]);
        const share = ids.length ? Math.floor(bank / ids.length) : 0;
        if (share > 0) {
          for (const id of ids) {
            await this.addStats(Number(id), ses.answered[id], { points: share, ...(countsHard ? { hardPoints: share } : {}) });
            await this.sessionPoints(Number(id), ses.answered[id], share);
          }
        }
        lines.push(`${k === "r" ? "🔴 Красные" : "🔵 Синие"}: банк <b>${bank}</b>` + (share ? ` → по ${share} (${ids.map((id) => esc(ses.answered[id])).join(", ")})` : ""));
      }
      await this.report();
      const rb = ses.teams.r.bank, bb = ses.teams.b.bank;
      const win = rb === bb ? "🤝 <b>Ничья!</b>" : rb > bb ? "🏆 Победили <b>🔴 Красные</b>!" : "🏆 Победили <b>🔵 Синие</b>!";
      return win + "\n" + lines.join("\n") + "\n" + guessLine + (countsHard ? "\n🔥 Очки идут в зачёт Супер-игры" : "");
    }

    // каждый сам за себя: очки уже начислены по ходу
    await this.report();
    const top = Object.values(ses.p).sort((a, b) => b.points - a.points);
    const medals = ["🥇", "🥈", "🥉"];
    return (
      (top.length ? "📊 <b>Итоги:</b>\n" + top.slice(0, 8).map((e, i) => `${medals[i] || i + 1 + "."} ${esc(e.name)} — ${e.points}`).join("\n") : "Никто не набрал очков 🤷") +
      "\n" + guessLine
    );
  }

  async endFlags(chatId, header) {
    const ses = this.session;
    const pay = await this.payoutFlags();
    const text = (header ? header + "\n\n" : "") + `🏁 <b>Раунд окончен!</b> ${this.sessionSummary(ses)}\n` + pay;
    return this.showChoice(chatId, text);
  }

  // рекорды серий группы (для меню)
  async seriesTop() {
    const out = [];
    for (const lv of Object.keys(LEVELS)) {
      const rec = await this.ctx.storage.get("srec:" + lv);
      if (rec) out.push(`${LEVELS[lv].name}: <b>${rec.best}</b> — ${esc(rec.name)}`);
    }
    return out.join("\n");
  }
  async seriesOf(uid) {
    const out = {};
    for (const lv of Object.keys(LEVELS)) {
      const rec = await this.ctx.storage.get(`s:${uid}:${lv}`);
      if (rec?.best) out[lv] = rec.best;
    }
    return Object.keys(out).length ? out : null;
  }

  // ---------- сбор игроков ----------
  gatherText(r) {
    const names = r.players.map((p) => esc(p.name)).join(", ");
    return (
      `${r.header}\n\n` +
      `Чтобы начать, нужно минимум <b>${GATHER_NEED}</b> игрока. Жми кнопку, если в деле!\n` +
      `⏳ Сбор открыт ${Math.round(GATHER_MS / 60000)} минут.` +
      (names ? `\n\n🙋 Уже играют: ${names}` : "")
    );
  }
  gatherKeyboard(r) {
    return kb([[[`🙋 Я играю (${r.players.length}/${GATHER_NEED})`, "join"]]]);
  }

  async startGather(chatId, header) {
    const r = { status: "gather", chatId, header, players: [], msgId: null, deadline: Date.now() + GATHER_MS };
    this.round = r;
    await this.save();
    const res = await this.send(chatId, this.gatherText(r), { reply_markup: this.gatherKeyboard(r) });
    if (this.round !== r) return;
    if (!res.ok) {
      this.round = { status: "idle" };
      return this.save();
    }
    r.msgId = res.result.message_id;
    await this.save();
    await this.ctx.storage.setAlarm(r.deadline);
  }

  async onGatherJoin(cq) {
    const r = this.round;
    if (r.status !== "gather") return this.answer(cq, "Сбор уже закончился");
    if (r.players.some((p) => p.id === cq.from.id)) return this.answer(cq, "Ты уже в игре 👍");
    r.players.push({ id: cq.from.id, name: displayName(cq.from) });
    if (r.players.length >= GATHER_NEED) {
      r.status = "ended"; // сразу, чтобы лишние нажатия не сработали
      await this.answer(cq, "🎉 Собрались! Начинаем");
      await this.edit(r.chatId, r.msgId, `${r.header}\n\n✅ Собрались: ${r.players.map((p) => esc(p.name)).join(", ")}!`);
      this.game = { roster: {}, initiator: null };
      for (const p of r.players) this.game.roster[p.id] = { name: p.name, at: Date.now() };
      await this.ctx.storage.put("game", this.game);
      return this.startVote(r.chatId, "🎮 <b>Игра начинается!</b>");
    }
    await this.save();
    await this.answer(cq, `Ты в игре! Ждём ещё ${GATHER_NEED - r.players.length}`);
    return this.edit(r.chatId, r.msgId, this.gatherText(r), this.gatherKeyboard(r));
  }

  riddleMask(word, level) {
    const w = upper(word);
    const show = new Set([0]);
    if (level >= 2) show.add(w.length - 1);
    if (level >= 3) for (let i = 2; i < w.length - 1; i += 2) show.add(i);
    return [...w].map((ch, i) => (show.has(i) ? ch : "_")).join(" ");
  }

  async startRiddle(day) {
    const level = (this.settings || DEFAULT_SETTINGS).level;
    const word = this.pickWord(level === "easy" ? "medium" : level).word;
    await this.save();
    const rd = { day, word, hint: 1, solved: false };
    await this.ctx.storage.put("riddle", rd);
    return this.send(
      this.meta.chatId,
      "🧩 <b>Загадка дня!</b>\n\n" +
        `Слово из <b>${word.length}</b> ${plural(word.length, "буквы", "букв", "букв")}:\n<code>${this.riddleMask(word, 1)}</code>\n\n` +
        `Первый, кто напишет его в чат, получит <b>+${RIDDLE_POINTS} очков</b> 🏆\n` +
        `Подсказки — в ${RIDDLE_HOURS.hint2}:00 и ${RIDDLE_HOURS.hint3}:00.`
    );
  }

  async riddleHint(n) {
    const rd = await this.ctx.storage.get("riddle");
    if (!rd || rd.solved) return;
    rd.hint = n;
    await this.ctx.storage.put("riddle", rd);
    return this.send(
      this.meta.chatId,
      `🧩 <b>Подсказка ${n - 1}/2 к загадке дня</b>\n\n<code>${this.riddleMask(rd.word, n)}</code>\n\nЕщё никто не угадал — твой шанс! +${RIDDLE_POINTS} очков`
    );
  }

  async revealRiddle() {
    const rd = await this.ctx.storage.get("riddle");
    if (!rd || rd.solved) return;
    await this.ctx.storage.delete("riddle");
    return this.send(this.meta.chatId, `🧩 Загадку дня никто не разгадал 😔\nЭто было слово <b>${upper(rd.word)}</b>.\n\nЗавтра в ${RIDDLE_HOURS.start}:00 — новая!`);
  }

  async checkRiddle(msg) {
    if (!this.alive.on) return;
    const rd = await this.ctx.storage.get("riddle");
    if (!rd || rd.solved) return;
    const tokens = tokenize(msg.text);
    if (!tokens.some((t) => t === normalize(rd.word) || (rd.word.length >= 5 && matches(t, rd.word)))) return;
    rd.solved = true;
    await this.ctx.storage.put("riddle", rd);
    const name = displayName(msg.from);
    await this.addStats(msg.from.id, name, { points: RIDDLE_POINTS });
    await this.tg("setMessageReaction", { chat_id: msg.chat.id, message_id: msg.message_id, reaction: [{ type: "emoji", emoji: "🏆" }] });
    return this.send(msg.chat.id, `🧩 <b>${esc(name)}</b> разгадал(а) загадку дня — <b>${upper(rd.word)}</b>! +${RIDDLE_POINTS} очков 🎉\n\nЗавтра в ${RIDDLE_HOURS.start}:00 — новая загадка.`);
  }

  async weeklySummary() {
    const wk = await this.ctx.storage.get("week");
    if (!wk || wk.id !== weekId(this.env)) return;
    const top = Object.values(wk.p).filter((e) => e.points > 0).sort((a, b) => b.points - a.points).slice(0, 5);
    if (!top.length) return;
    const medals = ["🥇", "🥈", "🥉", "4.", "5."];
    await this.ctx.storage.put("week", { id: wk.id + "-done", p: {} });
    return this.send(
      this.meta.chatId,
      "🏆 <b>Итоги недели!</b>\n\n" +
        top.map((e, i) => `${medals[i]} <b>${esc(e.name)}</b> — ${e.points}`).join("\n") +
        `\n\n👑 <b>Игрок недели — ${esc(top[0].name)}!</b> Поздравляем!\n\nНовая неделя — новый шанс. Начать игру — /game`
    );
  }

  // ---------- модерация ----------
  async adminIds(chatId) {
    if (this.admins && Date.now() - this.adminsAt < 10 * 60 * 1000) return this.admins;
    const res = await this.tg("getChatAdministrators", { chat_id: chatId });
    this.admins = new Set(res.ok ? res.result.map((m) => m.user.id) : []);
    this.adminsAt = Date.now();
    return this.admins;
  }

  async findViolation(msg) {
    const uid = msg.from.id;
    if (this.isOwner(uid)) return null;
    if ((await this.adminIds(msg.chat.id)).has(uid)) return null;
    const txt = (msg.text || "") + " " + (msg.caption || "");
    const entities = [...(msg.entities || []), ...(msg.caption_entities || [])];
    const fromChannel = msg.forward_origin?.type === "channel" || msg.forward_from_chat?.type === "channel";
    if (fromChannel) return "ad";
    if (entities.some((e) => e.type === "url" || e.type === "text_link") || hasLink(txt)) return "link";
    if (hasProfanity(txt)) return "mat";
    return null;
  }

  async punish(msg, why) {
    const chatId = msg.chat.id;
    const uid = msg.from.id;
    const name = esc(displayName(msg.from));
    const reasons = { mat: "мат", link: "ссылки запрещены", ad: "реклама / пересылка из канала" };
    await this.tg("deleteMessage", { chat_id: chatId, message_id: msg.message_id });

    const joined = await this.ctx.storage.get("j:" + uid);
    const newcomer = (why === "link" || why === "ad") && joined && Date.now() - joined < NEWCOMER_MS;

    const key = "w:" + uid;
    let w = (await this.ctx.storage.get(key)) || { count: 0, at: 0 };
    if (Date.now() - w.at > WARN_RESET_MS) w = { count: 0, at: 0 };
    w.count++;
    w.at = Date.now();

    if (newcomer || w.count >= MAX_WARNS) {
      await this.ctx.storage.delete(key);
      await this.tg("banChatMember", { chat_id: chatId, user_id: uid, revoke_messages: !!newcomer });
      return this.send(chatId, `⛔ <b>${name}</b> забанен(а). Причина: ${reasons[why]}${newcomer ? " (спам от нового участника)" : ""}.`);
    }
    await this.ctx.storage.put(key, w);
    if (w.count === MAX_WARNS - 1) {
      await this.restrict(chatId, uid, false, MUTE_SEC);
      return this.send(
        chatId,
        `🔇 <b>${name}</b>, мут на сутки. Причина: ${reasons[why]}.\nПредупреждение ${w.count}/${MAX_WARNS} — следующее нарушение = бан.`
      );
    }
    return this.send(chatId, `⚠️ <b>${name}</b>, предупреждение ${w.count}/${MAX_WARNS}. Причина: ${reasons[why]}.\nПравила группы — /rules`);
  }

  async welcome(chatId, users) {
    if (!users.length) return;
    for (const u of users) await this.ctx.storage.put("j:" + u.id, Date.now());
    const names = users.map((u) => `<b>${esc(displayName(u))}</b>`).join(", ");
    const prev = await this.ctx.storage.get("lastWelcome");
    if (prev) await this.tg("deleteMessage", { chat_id: chatId, message_id: prev }); // не засоряем чат
    const res = await this.send(
      chatId,
      `👋 Добро пожаловать, ${names}!\n\nЭто группа для игры в «Крокодил» 🐊\n` +
        "Один объясняет слово, остальные угадывают — кто быстрее, тот получает очки.\n\n" +
        GROUP_RULES +
        "\n\n🎮 Начать игру — /game · Как играть — /rules"
    );
    if (res.ok) await this.ctx.storage.put("lastWelcome", res.result.message_id);
  }

  async botRightsProblem(chatId) {
    const me = await this.getMe();
    const res = await this.tg("getChatMember", { chat_id: chatId, user_id: me.id });
    const m = res.result || {};
    if (m.status !== "administrator") return "Бот не админ группы.";
    const miss = [];
    if (!m.can_delete_messages) miss.push("Удаление сообщений");
    if (!m.can_restrict_members) miss.push("Блокировка пользователей");
    return miss.length ? "Боту не хватает прав: " + miss.join(", ") + "." : null;
  }

  modText(problem) {
    return (
      "🛡 <b>Модерация группы</b>\n\n" +
      "Сейчас: " + (this.mod.on ? "✅ <b>включена</b>" : "🚫 <b>выключена</b>") +
      "\n\nКогда включена, бот:\n• удаляет мат, ссылки и пересылки из каналов\n• наказывает: предупреждение → мут на сутки → бан\n" +
      "• приветствует новичков и знакомит с правилами\n• админов группы не трогает" +
      (problem ? "\n\n⚠️ " + problem + " Без этого модерация не сработает." : "")
    );
  }

  async cmdModeration(msg, anonAdmin) {
    const chatId = msg.chat.id;
    if (!anonAdmin && !this.isOwner(msg.from?.id) && !(await this.isAdmin(chatId, msg.from?.id))) {
      return this.send(chatId, "🛡 Включать модерацию могут только админы группы.");
    }
    const problem = await this.botRightsProblem(chatId);
    return this.send(chatId, this.modText(problem), {
      reply_markup: kb([[this.mod.on ? ["🚫 Выключить модерацию", "mod:off"] : ["✅ Включить модерацию", "mod:on"]]]),
    });
  }

  async onModerationCallback(cq, data) {
    const chatId = cq.message.chat.id;
    if (!this.isOwner(cq.from.id) && !(await this.isAdmin(chatId, cq.from.id))) return this.answer(cq, "Только для админов группы", true);
    this.mod = { on: data === "mod:on" };
    await this.ctx.storage.put("mod", this.mod);
    const problem = this.mod.on ? await this.botRightsProblem(chatId) : null;
    await this.answer(cq, this.mod.on ? "🛡 Модерация включена" : "Модерация выключена");
    return this.edit(chatId, cq.message.message_id, this.modText(problem), kb([[this.mod.on ? ["🚫 Выключить модерацию", "mod:off"] : ["✅ Включить модерацию", "mod:on"]]]));
  }

  // Владелец: сделать группу официальной (закреплена ⭐ в меню бота, модерация включена)
  async cmdOfficial(msg) {
    const chatId = msg.chat.id;
    if (!this.isOwner(msg.from?.id) || this.isArena) return;
    let invite = null;
    if (!this.meta.username) {
      const res = await this.tg("createChatInviteLink", { chat_id: chatId, name: "Официальная группа" });
      if (!res.ok) return this.send(chatId, "⚠️ Не получилось создать ссылку-приглашение. Дай боту право админа «Пригласительные ссылки» и повтори /official.");
      invite = res.result.invite_link;
    }
    this.mod = { on: true };
    await this.ctx.storage.put("mod", this.mod);
    this.alive = { on: true };
    await this.ctx.storage.put("alive", this.alive);
    await this.registry("set_official", { snap: await this.snapshot(), invite });
    const problem = await this.botRightsProblem(chatId);
    return this.send(
      chatId,
      "⭐ <b>Это официальная группа Крокодила!</b>\n\n" +
        "• Она закреплена первой в меню бота (/start в личке) и выделена ⭐\n" +
        "• Модерация включена: мат, реклама и ссылки — предупреждение → мут → бан\n" +
        "• Новички получают приветствие с правилами\n" +
        "• 🌱 Живая группа: загадка дня, вечерняя игра в 20:00, итоги недели по воскресеньям" +
        (problem ? "\n\n⚠️ " + problem : "")
    );
  }

  // Короткий ответ в группе с кнопкой в личку бота
  async toBot(msg, payload, text, button) {
    const me = await this.getMe();
    if (!me.username) return;
    return this.send(msg.chat.id, text, {
      reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
      reply_markup: { inline_keyboard: [[{ text: button, url: `https://t.me/${me.username}?start=${payload}` }]] },
    });
  }

  // ---------- каталог групп ----------
  catalogText(st) {
    return (
      "📋 <b>Каталог групп</b>\n\n" +
      "В меню бота (/start в личке) игроки видят список групп и могут зайти в них поиграть.\n\n" +
      "Ваша группа сейчас: " +
      (st.listed ? "✅ <b>видна в каталоге</b>" : "🚫 <b>скрыта</b>") +
      (st.public
        ? "\n\nГруппа публичная, поэтому по умолчанию видна."
        : "\n\nГруппа закрытая. Чтобы показать её, боту нужно право админа «Пригласительные ссылки» — он создаст ссылку для вступления.")
    );
  }

  async cmdCatalog(msg, anonAdmin) {
    const chatId = msg.chat.id;
    if (this.isArena) return;
    if (!anonAdmin && !(await this.isAdmin(chatId, msg.from?.id))) {
      return this.send(chatId, "📋 Управлять показом группы в каталоге могут только админы.");
    }
    const st = await this.registry("catalog_state", { snap: await this.snapshot() });
    return this.send(chatId, this.catalogText(st), {
      reply_markup: kb([[st.listed ? ["🚫 Скрыть из каталога", "catl:off"] : ["✅ Показать в каталоге", "catl:on"]]]),
    });
  }

  async onCatalogCallback(cq, data) {
    const chatId = cq.message.chat.id;
    if (this.isArena) return this.answer(cq);
    if (!(await this.isAdmin(chatId, cq.from.id))) return this.answer(cq, "Только для админов группы", true);
    const on = data === "catl:on";
    let invite = null;
    if (on && !this.meta.username) {
      const res = await this.tg("createChatInviteLink", { chat_id: chatId, name: "Каталог Крокодила" });
      if (!res.ok) {
        return this.answer(cq, "Не получилось создать ссылку. Сделай бота админом с правом «Пригласительные ссылки» и попробуй снова.", true);
      }
      invite = res.result.invite_link;
    }
    const st = await this.registry("set_listed", { snap: await this.snapshot(), listed: on, invite });
    await this.answer(cq, on ? "✅ Группа видна в каталоге" : "🚫 Группа скрыта");
    return this.edit(chatId, cq.message.message_id, this.catalogText(st), kb([[st.listed ? ["🚫 Скрыть из каталога", "catl:off"] : ["✅ Показать в каталоге", "catl:on"]]]));
  }

  // ---------- команды владельца: Арена ----------
  async cmdArenaHere(msg) {
    const chatId = msg.chat.id;
    if (!this.isOwner(msg.from?.id)) return;
    this.isArena = true;
    await this.ctx.storage.put("arena", true);
    const old = this.round;
    this.round = { status: "idle" };
    await this.save();
    await this.ctx.storage.deleteAlarm();
    if (old.msgId) await this.removeButtons(chatId, old.msgId);
    const res = await this.registry("set_arena", { chatId, title: msg.chat.title || "" });
    return this.send(
      chatId,
      "🏟 <b>Эта группа теперь Арена Супер-игры!</b>\n\n" +
        "Писать здесь могут только участники собранного лобби и владелец. " +
        "Остальные смогут только читать, их сообщения будут удаляться.\n\n" +
        "<b>Проверь, что бот — админ с правами:</b>\n" +
        "• Удаление сообщений\n• Блокировка пользователей\n• Пригласительные ссылки\n\n" +
        (res.text || "")
    );
  }

  async cmdArenaFinish(msg) {
    const chatId = msg.chat.id;
    if (!this.isOwner(msg.from?.id) || !this.isArena) return;
    if (this.match && this.match.status !== "done") {
      const res = await this.arenaPanel("final");
      return this.send(chatId, res.note || "Готово");
    }
    const all = await this.ctx.storage.list({ prefix: "m:" });
    const results = [...all.entries()]
      .map(([k, s]) => ({ id: Number(k.slice(2)), name: s.name, points: s.points, guessed: s.guessed || 0 }))
      .sort((a, b) => b.points - a.points || b.guessed - a.guessed); // ничья → кто больше угадал
    if (!results.length) return this.send(chatId, "Пока нет результатов матча — сыграйте хотя бы один раунд.");

    const cur = this.round;
    this.round = { status: "idle" };
    await this.save();
    await this.ctx.storage.deleteAlarm();
    if (cur.msgId) await this.removeButtons(chatId, cur.msgId);

    const medals = ["🥇", "🥈", "🥉"];
    await this.send(
      chatId,
      "🏆 <b>Супер-игра завершена!</b>\n\n" +
        results.map((r, i) => `${medals[i] || i + 1 + "."} <b>${esc(r.name)}</b> — ${r.points}`).join("\n") +
        `\n\n👑 Чемпион Арены — <b>${esc(results[0].name)}</b>!`
    );
    await this.registry("finish", { results });

    // Очистка: счёт матча и список участников
    await this.ctx.storage.delete([...all.keys()]);
    this.allowed = new Set();
    await this.ctx.storage.put("allowed", []);
  }

  // ================== 🏟 МАТЧ СУПЕР-ИГРЫ (на Арене) ==================
  saveMatch() {
    return this.ctx.storage.put("match", this.match);
  }
  mPlayer(id) {
    return this.match?.participants.find((p) => p.id === id);
  }
  mActive() {
    const m = this.match;
    return m.participants.filter((p) => m.ready.includes(p.id) && !m.kicked.includes(p.id));
  }

  async createMatch(participants, lobbyId) {
    const chatId = this.meta.chatId;
    const old = await this.ctx.storage.list({ prefix: "m:" });
    if (old.size) await this.ctx.storage.delete([...old.keys()]);
    this.match = {
      id: lobbyId || String(Date.now()), participants, ready: [], kicked: [], status: "ready",
      turns: [], turnIdx: 0, flagCodes: [], flagIdx: 0, extraQueued: false,
    };
    await this.saveMatch();
    const r = { status: "aready", chatId, msgId: null, deadline: Date.now() + ARENA_READY_MS };
    this.round = r;
    await this.save();
    const res = await this.send(chatId, this.readyText(), { reply_markup: this.readyKeyboard() });
    if (res.ok) r.msgId = res.result.message_id;
    await this.save();
    await this.ctx.storage.setAlarm(r.deadline);
  }

  readyText() {
    const m = this.match;
    return (
      "🏟 <b>Супер-игра!</b>\n\n" +
      m.participants.map((p) => `${m.ready.includes(p.id) ? "✅" : "⏳"} <b>${esc(p.name)}</b> — Группа #${p.no}`).join("\n") +
      "\n\n<b>Этап 1</b> — классика 💀: ведущие по кругу, каждый объясняет по " + ARENA_WORDS_EACH + " слова.\n" +
      "<b>Этап 2</b> — " + ARENA_FLAGS + " флагов на скорость, каждый сам за себя.\n\n" +
      "Матч начнётся сам, как только все нажмут «✅ Готов» (ждём до 30 минут).\n" +
      "💰 Ставка: 2-е место отдаёт победителю 5% рейтинга, 3-е — 10%, 4-е — 15%."
    );
  }
  readyKeyboard() {
    const m = this.match;
    return kb([[[`✅ Готов (${m.ready.length}/${m.participants.length})`, "aready"]]]);
  }

  async onArenaReady(cq) {
    const m = this.match;
    const r = this.round;
    if (!m || !this.mPlayer(cq.from.id)) return this.answer(cq, "Это кнопка для участников матча", true);
    if (m.ready.includes(cq.from.id)) return this.answer(cq, "Ты уже готов 👍");
    m.ready.push(cq.from.id);
    await this.saveMatch();
    await this.answer(cq, "✅ Готов!");
    await this.edit(r.chatId, r.msgId, this.readyText(), this.readyKeyboard());
    if (m.ready.length >= m.participants.length) return this.arenaCountdown();
  }

  async arenaCountdown() {
    const m = this.match;
    const chatId = this.meta.chatId;
    const prev = this.round;
    const order = this.mActive().map((p) => p.id).sort(() => Math.random() - 0.5);
    m.turns = [];
    for (let i = 0; i < ARENA_WORDS_EACH; i++) m.turns.push(...order);
    m.turnIdx = 0;
    m.status = "countdown";
    await this.saveMatch();
    if (prev.msgId) await this.edit(chatId, prev.msgId, this.readyText());
    const absent = m.participants.filter((p) => !m.ready.includes(p.id));
    const r = { status: "acount", chatId, msgId: null, deadline: Date.now() + ARENA_COUNTDOWN_MS };
    this.round = r;
    await this.save();
    const res = await this.send(
      chatId,
      "⏳ <b>Матч начнётся через 1 минуту!</b>\n\n🎤 Порядок ведущих: " +
        order.map((id) => esc(this.mPlayer(id).name)).join(" → ") +
        (absent.length ? "\n\n⚠️ Не пришли (техническое поражение): " + absent.map((p) => esc(p.name)).join(", ") : "")
    );
    if (res.ok) r.msgId = res.result.message_id;
    await this.save();
    await this.ctx.storage.setAlarm(r.deadline);
  }

  // Этап 1 и доп. раунд: ведущего назначает бот по кругу
  async arenaTurn(chatId, header = "", oldMsgId = null) {
    const m = this.match;
    if (oldMsgId) await this.removeButtons(chatId, oldMsgId);
    while (m.turnIdx < m.turns.length && m.kicked.includes(m.turns[m.turnIdx])) m.turnIdx++;
    if (m.turnIdx >= m.turns.length) {
      if (m.status === "stage1") return this.arenaStage2(chatId, header);
      return this.arenaReview(chatId, header);
    }
    const leader = this.mPlayer(m.turns[m.turnIdx]);
    const e = this.pickWord("ultimate", null);
    const now = Date.now();
    const roundMs = ARENA_SETTINGS.timeSec * 1000;
    const r = {
      status: "playing", chatId, msgId: null, header: "", leaderId: leader.id, leaderName: leader.name,
      word: e.word, answers: e.answers, cat: null, level: "ultimate", timed: true, roundMs,
      skips: 0, leaderMsgs: 0, startedAt: now, deadline: now + roundMs,
    };
    this.round = r;
    await this.save();
    await this.saveMatch();
    const stage = m.status === "extra" ? "➕ Доп. раунд" : "Этап 1";
    const res = await this.send(
      chatId,
      (header ? header + "\n\n" : "") +
        `🏟 <b>${stage}</b> · слово ${m.turnIdx + 1}/${m.turns.length}\n` +
        `🎤 Ведёт <b>${esc(leader.name)}</b> — нажми «👁 Посмотреть слово»\n⏱ 3 минуты`,
      { reply_markup: kb([[["👁 Посмотреть слово", "word"]], [["🔄 Другое слово", "skip"], ["🏳 Сдаюсь", "giveup"]]]) }
    );
    if (this.round !== r) return;
    if (res.ok) r.msgId = res.result.message_id;
    await this.save();
    await this.ctx.storage.setAlarm(r.deadline);
  }

  async arenaStage2(chatId, header = "") {
    const m = this.match;
    m.status = "stage2";
    const pool = FLAG_LIST.filter((e) => e.level === "hard" || e.level === "ultimate").sort(() => Math.random() - 0.5);
    m.flagCodes = pool.slice(0, ARENA_FLAGS).map((e) => e.code);
    m.flagIdx = 0;
    await this.saveMatch();
    return this.arenaFlag(
      chatId,
      (header ? header + "\n\n" : "") + `🏳️ <b>Этап 2 — флаги на скорость!</b> Первый правильный ответ: +${ARENA_FLAG_POINTS}`
    );
  }

  async arenaFlag(chatId, header = "") {
    const m = this.match;
    if (m.flagIdx >= m.flagCodes.length) return this.arenaReview(chatId, header);
    const e = FLAG_LIST.find((x) => x.code === m.flagCodes[m.flagIdx]);
    const now = Date.now();
    const r = { status: "aflag", chatId, msgId: null, code: e.code, name: e.name, answers: e.answers, deadline: now + ARENA_FLAG_MS };
    this.round = r;
    await this.save();
    const caption = (header ? header + "\n\n" : "") + `🏟 <b>Этап 2</b> · флаг ${m.flagIdx + 1}/${m.flagCodes.length}\nЧей флаг? Кто первый — +${ARENA_FLAG_POINTS}`;
    let res = await this.tg("sendPhoto", { chat_id: chatId, photo: flagImage(e.code), caption, parse_mode: "HTML" });
    if (!res.ok) res = await this.send(chatId, flagEmoji(e.code) + "\n\n" + caption);
    if (this.round !== r) return;
    if (res.ok) r.msgId = res.result.message_id;
    await this.save();
    await this.ctx.storage.setAlarm(r.deadline);
  }

  async onArenaFlagText(msg) {
    const r = this.round;
    if (r.paused || !this.canPlayInArena(msg.from.id)) return;
    const text = msg.text.trim();
    if (!text || text.split(/\s+/).length > 3 || !flagGuess(text, r)) return;
    r.status = "ended";
    const name = displayName(msg.from);
    await this.addStats(msg.from.id, name, { points: ARENA_FLAG_POINTS, guessed: 1 });
    await this.tg("setMessageReaction", { chat_id: r.chatId, message_id: msg.message_id, reaction: [{ type: "emoji", emoji: "🎉" }] });
    this.match.flagIdx++;
    await this.saveMatch();
    return this.arenaFlag(r.chatId, `🎉 <b>${esc(name)}</b>: <b>${upper(r.name)}</b>! +${ARENA_FLAG_POINTS}`);
  }

  async matchStandings() {
    const m = this.match;
    const all = await this.ctx.storage.list({ prefix: "m:" });
    const played = this.mActive().map((p) => {
      const s = all.get("m:" + p.id) || {};
      return { ...p, points: s.points || 0, guessed: s.guessed || 0, absent: false };
    });
    played.sort((a, b) => b.points - a.points || b.guessed - a.guessed); // ничья → кто больше угадал
    const out = m.participants
      .filter((p) => !played.some((x) => x.id === p.id))
      .map((p) => ({ ...p, points: 0, guessed: 0, absent: true }));
    return [...played, ...out];
  }

  async arenaReview(chatId, header = "") {
    const m = this.match;
    if (m.extraQueued) {
      m.extraQueued = false;
      m.status = "extra";
      m.turns = this.mActive().map((p) => p.id);
      m.turnIdx = 0;
      await this.saveMatch();
      return this.arenaTurn(chatId, (header ? header + "\n\n" : "") + "➕ <b>Дополнительный раунд классики</b> — каждый ведёт ещё по слову!");
    }
    m.status = "review";
    await this.saveMatch();
    const st = await this.matchStandings();
    const lines = st.map((p, i) => `${i + 1}. ${esc(p.name)} — ${p.absent ? "не пришёл(ла)" : p.points}`).join("\n");
    const r = { status: "areview", chatId, msgId: null, deadline: Date.now() + ARENA_REVIEW_MS };
    this.round = r;
    await this.save();
    const res = await this.send(chatId, (header ? header + "\n\n" : "") + "⏳ <b>Судья подводит итоги…</b>\n\nПредварительно:\n" + lines);
    if (res.ok) r.msgId = res.result.message_id;
    await this.save();
    await this.ctx.storage.setAlarm(r.deadline);
    if (this.env.OWNER_ID) {
      await this.send(this.env.OWNER_ID, "🎛 <b>Матч сыгран.</b> Предварительно:\n" + lines + "\n\nЧерез 3 минуты итоги подведутся сами.", {
        reply_markup: kb([[["✅ Подвести итоги", "ap:final"]], [["➕ Доп. раунд классики", "ap:extra"]]]),
      });
    }
  }

  async arenaAlarm() {
    const r = this.round;
    const m = this.match;
    if (!m) return;
    if (Date.now() < r.deadline - 1000) return this.ctx.storage.setAlarm(r.deadline);
    if (r.status === "aready") {
      const minStart = Math.min(3, m.participants.length);
      if (m.ready.length >= minStart) return this.arenaCountdown();
      return this.cancelMatch("😔 Матч не состоялся — участники не собрались за 30 минут.");
    }
    if (r.status === "acount") {
      m.status = "stage1";
      await this.saveMatch();
      return this.arenaTurn(r.chatId, "🚀 <b>Матч начался!</b>");
    }
    if (r.status === "aflag") {
      r.status = "ended";
      m.flagIdx++;
      await this.saveMatch();
      return this.arenaFlag(r.chatId, `⏰ Никто не угадал — это была <b>${upper(r.name)}</b>`);
    }
    if (r.status === "areview") return this.finalizeMatch();
  }

  // Итоги: проигравшие отдают % рейтинга (в группе, которую представляли) победителю
  async finalizeMatch() {
    const m = this.match;
    if (!m || m.status === "done") return { note: "Матча нет" };
    if (m.status === "ready" || m.status === "countdown") return this.cancelMatch("🛑 Матч остановлен до начала.");
    const chatId = this.meta.chatId;
    const st = await this.matchStandings();
    if (!st.length || st[0].absent) return this.cancelMatch("Матч не сыгран — результаты не засчитаны.");
    m.status = "done";
    await this.saveMatch();
    const stakes = arenaStakes(m.participants.length);
    const lastPct = stakes[stakes.length - 1];
    let pot = 0;
    const results = [];
    for (let i = 0; i < st.length; i++) {
      const p = st[i];
      const pct = i === 0 ? 0 : p.absent ? lastPct : stakes[Math.min(i, stakes.length - 1)];
      let delta = 0;
      if (pct) {
        const rating = await registryGroupRating(this.env, p.chatId, p.id);
        delta = -Math.floor((rating * pct) / 100);
        pot += -delta;
      }
      results.push({ id: p.id, name: p.name, chatId: p.chatId, no: p.no, points: p.points, pct, delta, absent: p.absent, place: i + 1 });
    }
    results[0].delta = pot;
    await this.registry("arena_result", { results, winnerId: results[0].id });

    const medals = ["🥇", "🥈", "🥉"];
    const cur = this.round;
    this.round = { status: "idle" };
    await this.save();
    await this.ctx.storage.deleteAlarm();
    if (cur.msgId) await this.removeButtons(chatId, cur.msgId);
    await this.send(
      chatId,
      "🏆 <b>Супер-игра завершена!</b>\n\n" +
        results
          .map((r, i) => `${medals[i] || i + 1 + "."} <b>${esc(r.name)}</b> — ${r.absent ? "не пришёл(ла)" : r.points}` +
            (r.delta > 0 ? ` · +${r.delta} рейтинга` : r.delta < 0 ? ` · ${r.delta} рейтинга (${r.pct}%)` : ""))
          .join("\n") +
        `\n\n👑 Чемпион Арены — <b>${esc(results[0].name)}</b>!`
    );
    await this.arenaCleanup();
    return { note: "✅ Итоги подведены" };
  }

  async cancelMatch(reason) {
    const chatId = this.meta.chatId;
    if (this.match) {
      this.match.status = "done";
      await this.saveMatch();
    }
    const cur = this.round;
    this.round = { status: "idle" };
    await this.save();
    await this.ctx.storage.deleteAlarm();
    if (cur.msgId) await this.removeButtons(chatId, cur.msgId);
    await this.send(chatId, reason + "\nРейтинг никто не потерял.");
    await this.registry("arena_cancel", { reason });
    await this.arenaCleanup();
    return { note: "🛑 Матч отменён" };
  }

  async arenaCleanup() {
    const all = await this.ctx.storage.list({ prefix: "m:" });
    if (all.size) await this.ctx.storage.delete([...all.keys()]);
    this.allowed = new Set();
    this.match = null;
    await this.ctx.storage.put({ allowed: [] });
    await this.ctx.storage.delete("match");
  }

  // ---------- 🎛 пульт владельца ----------
  async arenaPanel(action, arg) {
    if (!this.isArena) return { text: "Это не Арена", buttons: [] };
    const m = this.match;
    const r = this.round;
    const chatId = this.meta.chatId;
    const post = (t) => this.send(chatId, t);
    if (!m || m.status === "done") return { text: "🎛 <b>Пульт Арены</b>\n\nСейчас матча нет. Он появится, когда соберётся лобби.", buttons: [] };

    let note = "";
    const playing = ["playing", "aflag"].includes(r.status);
    switch (action) {
      case "pause":
        if (playing && !r.paused) {
          r.paused = true;
          r.remaining = Math.max(5000, r.deadline - Date.now());
          await this.save();
          await this.ctx.storage.deleteAlarm();
          await post("⏸ <b>Пауза</b> — судья остановил игру.");
          note = "⏸ Пауза";
        }
        break;
      case "resume":
        if (r.paused) {
          r.paused = false;
          r.deadline = Date.now() + (r.remaining || 60000);
          await this.save();
          await this.ctx.storage.setAlarm(r.deadline);
          await post("▶️ <b>Продолжаем!</b>");
          note = "▶️ Продолжили";
        }
        break;
      case "time":
        if (playing) {
          if (r.paused) r.remaining = (r.remaining || 0) + 60000;
          else {
            r.deadline += 60000;
            await this.ctx.storage.setAlarm(r.deadline);
          }
          await this.save();
          await post("➕ Судья добавил минуту.");
          note = "➕ +1 минута";
        }
        break;
      case "skip":
        if (r.status === "playing") {
          r.status = "ended";
          await this.nextRound(chatId, `⏭ Судья пропустил слово. Это было <b>${upper(r.word)}</b>`, r.msgId);
          note = "⏭ Слово пропущено";
        } else if (r.status === "aflag") {
          r.status = "ended";
          m.flagIdx++;
          await this.saveMatch();
          await this.arenaFlag(chatId, `⏭ Судья пропустил флаг — это была <b>${upper(r.name)}</b>`);
          note = "⏭ Флаг пропущен";
        }
        break;
      case "redo":
        if (r.status === "playing") {
          r.status = "ended";
          await this.arenaTurn(chatId, "🔄 Судья: переигрываем — новое слово тому же ведущему", r.msgId);
          note = "🔄 Новое слово";
        } else if (r.status === "aflag") {
          r.status = "ended";
          const pool = FLAG_LIST.filter((e) => (e.level === "hard" || e.level === "ultimate") && !m.flagCodes.includes(e.code));
          m.flagCodes[m.flagIdx] = pool[Math.floor(Math.random() * pool.length)].code;
          await this.saveMatch();
          await this.arenaFlag(chatId, "🔄 Судья: переигрываем — другой флаг");
          note = "🔄 Новый флаг";
        }
        break;
      case "kick": {
        if (!arg) {
          return {
            text: "🚫 <b>Кого снять с матча?</b>\nСнятый получает техническое поражение.",
            buttons: m.participants.filter((p) => !m.kicked.includes(p.id)).map((p) => [[`🚫 ${p.name}`, "ap:kick:" + p.id]]).concat([[["⬅️ Пульт", "ap:status"]]]),
          };
        }
        const id = Number(arg);
        const p = this.mPlayer(id);
        if (p && !m.kicked.includes(id)) {
          m.kicked.push(id);
          this.allowed.delete(id);
          await this.ctx.storage.put("allowed", [...this.allowed]);
          await this.saveMatch();
          await post(`🚫 Судья снял <b>${esc(p.name)}</b> с матча — техническое поражение.`);
          if (r.status === "playing" && r.leaderId === id) {
            r.status = "ended";
            await this.nextRound(chatId, `⏭ Слово было <b>${upper(r.word)}</b>`, r.msgId);
          }
          if (this.mActive().length < 2 && !["ready", "countdown"].includes(m.status)) await this.finalizeMatch();
          note = `🚫 ${p.name} снят(а)`;
        }
        break;
      }
      case "startnow":
        if (r.status === "aready" && m.ready.length >= Math.min(2, m.participants.length)) {
          await this.arenaCountdown();
          note = "🚀 Отсчёт запущен";
        } else note = "Нужно хотя бы 2 готовых участника";
        break;
      case "extra":
        if (m.status === "review") {
          m.extraQueued = true;
          await this.saveMatch();
          await this.arenaReview(chatId, "➕ Судья назначил дополнительный раунд!");
          note = "➕ Доп. раунд начался";
        } else if (!m.extraQueued) {
          m.extraQueued = true;
          await this.saveMatch();
          note = "➕ Доп. раунд будет в конце матча";
        }
        break;
      case "final":
        return { ...(await this.finalizeMatch()), text: "🎛 <b>Пульт Арены</b>\n\nМатч завершён.", buttons: [] };
      case "stop":
        return { ...(await this.cancelMatch("🛑 Судья остановил матч — результаты не засчитываются.")), text: "🎛 <b>Пульт Арены</b>\n\nМатч отменён.", buttons: [] };
    }

    // статус + кнопки
    const st = await this.matchStandings();
    const now = this.round;
    const stageName = { ready: "ждём готовности", countdown: "отсчёт", stage1: "этап 1 — классика", stage2: "этап 2 — флаги", extra: "доп. раунд", review: "подведение итогов" }[m.status] || m.status;
    let cur = "";
    if (now.status === "playing") cur = `\n🎤 Ведёт ${esc(now.leaderName)} · слово «${esc(now.word)}» · слово ${m.turnIdx + 1}/${m.turns.length}`;
    if (now.status === "aflag") cur = `\n🏳️ Флаг ${m.flagIdx + 1}/${m.flagCodes.length}: ${esc(now.name)}`;
    const text =
      "🎛 <b>Пульт Арены</b>\n\n" +
      `Стадия: <b>${stageName}</b>${now.paused ? " · ⏸ пауза" : ""}${m.extraQueued ? " · ➕ доп. раунд в конце" : ""}` +
      cur +
      "\n\n" +
      st.map((p, i) => `${i + 1}. ${esc(p.name)} — ${p.absent ? (m.status === "ready" ? (m.ready.includes(p.id) ? "готов" : "ждём") : "нет") : p.points}${m.kicked.includes(p.id) ? " 🚫" : ""}`).join("\n");
    const buttons = [];
    if (["playing", "aflag"].includes(now.status)) {
      buttons.push([now.paused ? ["▶️ Продолжить", "ap:resume"] : ["⏸ Пауза", "ap:pause"], ["➕ +1 минута", "ap:time"]]);
      buttons.push([["⏭ Пропустить", "ap:skip"], ["🔄 Переиграть", "ap:redo"]]);
    }
    if (m.status === "ready") buttons.push([["🚀 Начать с готовыми", "ap:startnow"]]);
    if (m.status === "review") buttons.push([["✅ Подвести итоги", "ap:final"]]);
    if (!m.extraQueued && m.status !== "ready") buttons.push([["➕ Доп. раунд классики", "ap:extra"]]);
    buttons.push([["🚫 Снять игрока", "ap:kick"], ["🛑 Остановить матч", "ap:stop"]]);
    buttons.push([["🔄 Обновить", "ap:status"]]);
    return { text, buttons, note };
  }

  // ---------- команды ----------
  async cmdTop(msg) {
    const lines = await this.topLines(10);
    if (!lines) return this.send(msg.chat.id, "🏆 Таблица лидеров пока пуста. Сыграйте — /game");
    const title = this.isArena ? "🏟 <b>Общий рейтинг Арены</b>" : "🏆 <b>Таблица лидеров группы</b>";
    return this.send(msg.chat.id, title + "\n\n" + lines + "\n\n🎯 угадал · 🎤 объяснил");
  }

  async cmdMe(msg) {
    const chatId = msg.chat.id;
    if (!msg.from || msg.from.is_bot) return;
    const sorted = await this.playersSorted();
    const idx = sorted.findIndex((s) => s.id === msg.from.id);
    if (idx < 0) return this.send(chatId, `📊 <b>${esc(displayName(msg.from))}</b>, у тебя пока нет очков. Сыграй — /game`);
    const me = sorted[idx];
    const hp = me.hardPoints || 0;
    const need = minPoints(this.env);

    let arena = "";
    let keyboard;
    if (!this.isArena) {
      arena = `\n\n🔥 Очки на 🔴/💀 (для Супер-игры): ${hp} / ${need}`;
      if (idx === 0 && hp >= need && sorted.length >= minPlayers(this.env)) {
        arena += "\n⚔️ Ты лидер группы и можешь бросить вызов лидерам других групп!";
        keyboard = kb([[["⚔️ Бросить вызов топам", "chal"]]]);
      } else if (idx === 0 && hp >= need) {
        arena += `\nДля вызова в группе нужно минимум ${minPlayers(this.env)} игроков (сейчас ${sorted.length}).`;
      }
    }

    return this.send(
      chatId,
      `📊 <b>${esc(me.name)}</b>\n\n` +
        `🏅 Место в группе: ${idx + 1} из ${sorted.length}\n` +
        `⭐ Очки: ${me.points}\n` +
        `🎯 Угадано слов: ${me.guessed}\n` +
        `🎤 Объяснено слов: ${me.explained} (был ведущим: ${me.led})` +
        arena,
      keyboard ? { reply_markup: keyboard } : {}
    );
  }

  async cmdStop(msg, anonAdmin) {
    const chatId = msg.chat.id;
    const st = this.round.status;
    if (this.isArena && this.match && this.match.status !== "done") {
      if (!this.isOwner(msg.from?.id)) return;
      return this.send(chatId, "🎛 Идёт матч Супер-игры. Управлять им — меню бота → 🎛 Пульт Арены (там есть «🛑 Остановить матч»).");
    }
    if (!["waiting", "playing", "setup", "gather", "vote", "choice", "lobby", "flag", "croc"].includes(st)) {
      return this.send(chatId, "Сейчас нет активной игры. Начать — /game");
    }

    const uid = msg.from?.id;
    const isLeader = st === "playing" && uid === this.round.leaderId;
    const isInitiator = (st === "setup" && uid && uid === this.round.initiatorId) || (uid && uid === this.game?.initiator);
    const allowed = isLeader || isInitiator || anonAdmin || this.isOwner(uid) || (await this.isAdmin(chatId, uid));
    if (!allowed) return this.send(chatId, "🛑 Остановить игру может ведущий или админ группы.");

    const cur = this.round;
    if (!["waiting", "playing", "setup", "gather", "vote", "choice", "lobby", "flag", "croc"].includes(cur.status)) return; // пока проверяли права, всё уже закончилось
    const word = cur.status === "playing" || cur.status === "croc" ? cur.word : null;
    const flagPay = cur.status === "flag" ? await this.payoutFlags() : "";
    this.round = { status: "idle" };
    await this.save();
    await this.ctx.storage.deleteAlarm();
    await this.removeButtons(chatId, cur.msgId);
    if (flagPay) await this.send(chatId, "🛑 Игра во флаги остановлена.\n\n" + flagPay);
    const top = await this.topLines(5, this.isArena ? "m:" : "u:");
    return this.send(
      chatId,
      "🛑 Игра остановлена." +
        (word ? `\nСлово было: <b>${upper(word)}</b>` : "") +
        (top ? `\n\n🏆 <b>${this.isArena ? "Счёт матча" : "Таблица лидеров группы"}</b>\n` + top : "") +
        "\n\nНовая игра — /game"
    );
  }

  // ---------- таймер ----------
  async alarm() {
    const r = this.round;
    if (r.status === "vote") {
      if (Date.now() < r.deadline - 1000) return this.ctx.storage.setAlarm(r.deadline);
      // 15 минут никто ничего не нажимал — тихо закрываем настройку
      this.round = { status: "idle" };
      await this.save();
      return this.edit(r.chatId, r.msgId, (r.header ? r.header + "\n\n" : "") + "💤 Настройку игры никто не трогал 15 минут — закрыл. Начать заново — /game");
    }
    if (r.status === "lobby") {
      if (Date.now() >= r.deadline - 1000) return this.finishLobby();
      return this.ctx.storage.setAlarm(r.deadline);
    }
    if (r.paused) return; // пауза судьи — таймеры стоят
    if (["aready", "acount", "aflag", "areview"].includes(r.status)) return this.arenaAlarm();
    if (r.status === "flag") return this.flagAlarm();
    if (r.status === "croc") return this.crocAlarm();
    if (!["waiting", "playing", "setup", "gather", "vote", "choice"].includes(r.status)) return;
    if (Date.now() < r.deadline - 1000) {
      await this.ctx.storage.setAlarm(r.deadline);
      return;
    }

    if (r.status === "setup") {
      this.round = { status: "idle" };
      await this.save();
      if (r.msgId) await this.edit(r.chatId, r.msgId, "⌛ Настройка не завершена. Начать заново — /game");
      return;
    }

    if (r.status === "choice") {
      this.round = { status: "idle" };
      await this.save();
      if (r.msgId) await this.edit(r.chatId, r.msgId, r.text + "\n\n😴 Игра на паузе. Продолжить — /game");
      return;
    }

    if (r.status === "gather") {
      this.round = { status: "idle" };
      await this.save();
      if (r.msgId) {
        await this.edit(
          r.chatId,
          r.msgId,
          `${r.header}\n\n😔 Не собрались (${r.players.length}/${GATHER_NEED}). Ничего страшного — сыграть можно в любое время: /game`
        );
      }
      return;
    }

    if (r.status === "waiting") {
      this.round = { status: "idle" };
      await this.save();
      if (r.msgId) {
        const top = await this.topLines(5, this.isArena ? "m:" : "u:");
        const already = (r.header || "").includes("Таблица лидеров") || (r.header || "").includes("Счёт матча");
        await this.edit(
          r.chatId,
          r.msgId,
          (r.header ? r.header + "\n\n" : "") +
            "😴 Никто не вызвался вести — игра на паузе." +
            (top && !already ? `\n\n🏆 <b>${this.isArena ? "Счёт матча" : "Таблица лидеров группы"}</b>\n` + top : "") +
            "\n\nСыграть ещё — /game"
        );
      }
      return;
    }

    r.status = "ended";
    const why = r.timed ? "⏰ Время вышло — никто не угадал." : "⏰ Раунд закрыт: 30 минут никто не угадал.";
    return this.nextRound(r.chatId, `${why}\nСлово было: <b>${upper(r.word)}</b>`, r.msgId);
  }
}

// ================== РЕЕСТР СУПЕР-ИГРЫ: ОДИН НА ВЕСЬ БОТ ==================
// Хранит: g:<chatId> — группы (номер, лидер, очки), lobby — текущее лобби, arena — группа-Арена
// lobby.status: "open" (набираем) | "ready" (собрано, ждём матча)
export class ArenaRegistry extends DurableObject {
  async fetch(request) {
    const path = new URL(request.url).pathname.slice(1);
    const body = await request.json().catch(() => ({}));
    let out = { ok: true };
    try {
      if (path === "report") out = { ok: true, group: await this.report(body.snap) };
      else if (path === "challenge") out = await this.challenge(body.snap, body.userId);
      else if (path === "accept") out = await this.accept(body.snap, body.userId, body.lobbyId);
      else if (path === "set_arena") out = await this.setArena(body.chatId, body.title);
      else if (path === "finish") out = await this.finish(body.results || []);
      else if (path === "status") out = await this.status();
      else if (path === "remove") out = await this.removeGroup(body.chatId);
      else if (path === "catalog") out = await this.catalog(Number(body.page) || 0);
      else if (path === "catalog_state") out = this.catalogState(await this.report(body.snap));
      else if (path === "set_listed") out = await this.setListed(body.snap, body.listed, body.invite);
      else if (path === "set_official") out = await this.setOfficial(body.snap, body.invite);
      else if (path === "alive_groups") out = await this.aliveGroups();
      else if (path === "user_join") out = await this.userJoin(body.uids || [], body.chatId);
      else if (path === "user_groups") out = await this.userGroups(Number(body.uid));
      else if (path === "global_top") out = await this.globalTop();
      else if (path === "lobby_public") out = await this.lobbyPublic();
      else if (path === "reindex_all") out = await this.reindexAll();
      else if (path === "arena_result") out = await this.arenaResult(body.results || [], body.winnerId);
      else if (path === "arena_cancel") out = await this.arenaCancel(body.reason || "");
      else if (path === "arena_info") out = { arena: (await this.ctx.storage.get("arena")) || null };
      else if (path === "is_official") out = { official: String((await this.ctx.storage.get("official")) || "") === String(body.chatId) };
    } catch (e) {
      console.log("registry error", e?.stack || String(e));
      out = { ok: false, text: "⚠️ Ошибка, попробуйте позже." };
    }
    return Response.json(out);
  }

  tg(method, body) {
    return tg(this.env, method, body);
  }
  send(chatId, html, extra = {}) {
    return this.tg("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra });
  }

  async report(snap) {
    if (!snap?.chatId) return null;
    const arena = await this.ctx.storage.get("arena");
    if (arena && String(arena.chatId) === String(snap.chatId)) return null;
    const key = "g:" + snap.chatId;
    let g = await this.ctx.storage.get(key);
    if (!g) {
      const seq = ((await this.ctx.storage.get("seq")) || 0) + 1;
      await this.ctx.storage.put("seq", seq);
      g = { chatId: snap.chatId, no: seq, titles: 0 };
    }
    g.title = snap.title || g.title || "";
    g.username = snap.username || "";
    g.level = snap.level || g.level || "medium";
    g.alive = !!snap.alive;
    g.players = snap.players || 0;
    g.leader = snap.leader || null;
    g.updated = Date.now();
    g.removed = false;
    if (!g.membersAt || Date.now() - g.membersAt > 24 * 60 * 60 * 1000) {
      const res = await this.tg("getChatMemberCount", { chat_id: snap.chatId });
      if (res.ok) g.members = res.result;
      g.membersAt = Date.now();
    }
    await this.ctx.storage.put(key, g);
    return g;
  }

  // ---------- каталог групп ----------
  groupLink(g) {
    return g.username ? `https://t.me/${g.username}` : g.invite || null;
  }

  isListed(g) {
    if (!g || g.removed || !this.groupLink(g)) return false;
    if (g.listed === true) return true;
    return g.listed !== false && !!g.username; // публичные — видны по умолчанию
  }

  catalogState(g) {
    return { listed: this.isListed(g), public: !!g?.username };
  }

  async setListed(snap, listed, invite) {
    const g = await this.report(snap);
    if (!g) return { listed: false, public: false };
    g.listed = !!listed;
    if (invite) g.invite = invite;
    await this.ctx.storage.put("g:" + g.chatId, g);
    return this.catalogState(g);
  }

  // ---------- игроки и их группы (для меню в личке) ----------
  async userJoin(uids, chatId) {
    for (const uid of uids) {
      const key = "ug:" + uid;
      const list = (await this.ctx.storage.get(key)) || [];
      if (!list.some((c) => String(c) === String(chatId))) {
        list.push(chatId);
        await this.ctx.storage.put(key, list);
      }
    }
    return { ok: true };
  }

  async userGroups(uid) {
    const list = (await this.ctx.storage.get("ug:" + uid)) || [];
    const arena = await this.ctx.storage.get("arena");
    const groups = [];
    for (const chatId of list) {
      if (arena && String(arena.chatId) === String(chatId)) continue;
      const g = await this.ctx.storage.get("g:" + chatId);
      if (g && !g.removed) groups.push({ chatId, title: g.title, no: g.no });
    }
    return { groups };
  }

  async globalTop() {
    const all = [...(await this.ctx.storage.list({ prefix: "g:" })).values()].filter((g) => !g.removed && g.leader && g.leader.points > 0);
    const items = all
      .sort((a, b) => b.leader.points - a.leader.points)
      .slice(0, 10)
      .map((g) => ({ name: g.leader.name, points: g.leader.points, no: g.no, titles: g.titles || 0 }));
    return { items };
  }

  // Подтянуть игроков всех известных групп в меню (после обновления)
  async reindexAll() {
    const all = [...(await this.ctx.storage.list({ prefix: "g:" })).values()].filter((g) => !g.removed);
    let done = 0;
    for (const g of all) {
      try {
        const stub = this.env.GAME.get(this.env.GAME.idFromName(String(g.chatId)));
        await stub.fetch("https://game/reindex", { method: "POST", body: "{}" });
        done++;
      } catch (e) {
        console.log("reindex failed", g.chatId, String(e));
      }
    }
    return { ok: true, done, total: all.length };
  }

  async lobbyPublic() {
    const lobby = await this.ctx.storage.get("lobby");
    if (!lobby) return {};
    return { status: lobby.status, count: lobby.participants.length, size: lobbySize(this.env) };
  }

  async aliveGroups() {
    const all = [...(await this.ctx.storage.list({ prefix: "g:" })).values()];
    return { chats: all.filter((g) => g.alive && !g.removed).map((g) => g.chatId) };
  }

  async setOfficial(snap, invite) {
    const g = await this.report(snap);
    if (!g) return { ok: false };
    if (invite) g.invite = invite;
    g.listed = true;
    await this.ctx.storage.put("g:" + g.chatId, g);
    await this.ctx.storage.put("official", g.chatId);
    return { ok: true };
  }

  async removeGroup(chatId) {
    const g = await this.ctx.storage.get("g:" + chatId);
    if (g) {
      g.removed = true;
      await this.ctx.storage.put("g:" + chatId, g);
    }
    return { ok: true };
  }

  async catalog(page) {
    const officialId = await this.ctx.storage.get("official");
    const og = officialId ? await this.ctx.storage.get("g:" + officialId) : null;
    const official =
      og && !og.removed && this.groupLink(og) ? { title: og.title, link: this.groupLink(og), members: og.members || 0 } : null;
    const all = [...(await this.ctx.storage.list({ prefix: "g:" })).values()]
      .filter((g) => this.isListed(g) && String(g.chatId) !== String(officialId))
      .sort((a, b) => (b.updated || 0) - (a.updated || 0)); // сначала активные
    const pages = Math.max(1, Math.ceil(all.length / CATALOG_PAGE));
    page = Math.min(Math.max(0, page), pages - 1);
    const items = all.slice(page * CATALOG_PAGE, (page + 1) * CATALOG_PAGE).map((g) => ({
      title: g.title,
      link: this.groupLink(g),
      members: g.members || 0,
      level: g.level,
      players: g.players || 0,
      titles: g.titles || 0,
    }));
    return { items, page, pages, total: all.length, official };
  }

  eligible(g) {
    return !!(g && !g.removed && g.leader && g.leader.hardPoints >= minPoints(this.env) && g.players >= minPlayers(this.env));
  }

  whyNot(g, userId) {
    if (!g || !g.leader || g.leader.id !== userId) {
      return "⚔️ Бросить вызов может только лидер группы — игрок №1 в /top.";
    }
    const need = minPoints(this.env);
    const lines = [];
    if (g.leader.hardPoints < need) lines.push(`• очки на 🔴 Сложном / 💀 Ультимейте: ${g.leader.hardPoints} из ${need}`);
    if (g.players < minPlayers(this.env)) lines.push(`• игроков в группе: ${g.players} из ${minPlayers(this.env)}`);
    return "⚔️ Пока рано для Супер-игры. Не хватает:\n" + lines.join("\n");
  }

  participant(g) {
    return { userId: g.leader.id, name: g.leader.name, chatId: g.chatId, no: g.no, hardPoints: g.leader.hardPoints };
  }

  async challenge(snap, userId) {
    const g = await this.report(snap);
    if (!g) return { text: "Здесь это не работает." };
    if (!this.eligible(g) || g.leader.id !== userId) return { text: this.whyNot(g, userId), short: "Пока рано" };

    const size = lobbySize(this.env);
    let lobby = await this.ctx.storage.get("lobby");

    if (lobby?.status === "ready") {
      return { text: "🏟 Сейчас готовится Супер-игра. Новые вызовы — после её завершения.", short: "Арена занята" };
    }
    if (lobby?.status === "open") {
      if (lobby.participants.some((p) => p.userId === userId)) {
        return { text: `⏳ Ты уже в лобби (${lobby.participants.length}/${size}). Ждём соперников.`, short: "Ты уже в лобби" };
      }
      if (lobby.participants.some((p) => String(p.chatId) === String(g.chatId))) {
        return { text: "От вашей группы уже есть участник лобби.", short: "Уже есть участник" };
      }
      const ready = await this.addParticipant(lobby, g);
      return {
        text: ready
          ? "✅ Ты в лобби! Лобби собрано — инструкции придут сюда же."
          : `✅ Ты присоединился к открытому лобби Супер-игры (${lobby.participants.length}/${size}).`,
        short: "Ты в лобби!",
      };
    }

    // Новое лобби
    lobby = {
      id: crypto.randomUUID().slice(0, 8),
      status: "open",
      participants: [this.participant(g)],
      invited: [],
      createdAt: Date.now(),
      expires: Date.now() + LOBBY_TTL_MS,
    };
    const all = await this.ctx.storage.list({ prefix: "g:" });
    const targets = [...all.values()]
      .filter((x) => String(x.chatId) !== String(g.chatId) && this.eligible(x))
      .sort((a, b) => b.leader.hardPoints - a.leader.hardPoints)
      .slice(0, INVITE_LIMIT);
    lobby.invited = targets.map((x) => x.chatId);
    await this.ctx.storage.put("lobby", lobby);
    await this.ctx.storage.setAlarm(lobby.expires);

    for (const x of targets) {
      await this.send(
        x.chatId,
        "⚔️ <b>Вызов на Супер-игру!</b>\n\n" +
          `Лидер <b>Группы #${g.no}</b> (🔥 ${g.leader.hardPoints} очков на сложном) вызывает лучших игроков на Арену за звание чемпиона.\n\n` +
          `Лидер вашей группы — <b>${esc(x.leader.name)}</b> (🔥 ${x.leader.hardPoints}). Принять вызов может только он(а).\n` +
          `Лобби: 1/${size} · открыто 48 часов`,
        { reply_markup: kb([[["⚔️ Принять вызов", "acc:" + lobby.id]]]) }
      );
    }

    return {
      short: "Вызов брошен!",
      text: targets.length
        ? `⚔️ <b>Вызов брошен!</b>\nПриглашения отправлены лидерам ${targets.length} ${plural(targets.length, "группы", "групп", "групп")}.\nЛобби: 1/${size} · ждём 48 часов.`
        : `⚔️ <b>Лобби открыто!</b> (1/${size})\nСейчас других групп с лидерами ${minPoints(this.env)}+ нет. ` +
          "Как только появятся — смогут присоединиться командой /challenge. Лобби ждёт 48 часов.",
    };
  }

  async accept(snap, userId, lobbyId) {
    const g = await this.report(snap);
    const lobby = await this.ctx.storage.get("lobby");
    const size = lobbySize(this.env);
    if (!lobby || lobby.id !== lobbyId || lobby.status !== "open") {
      return { ok: false, stale: true, text: "⌛ Этот вызов уже неактуален." };
    }
    if (!g || !g.leader || g.leader.id !== userId) return { ok: false, text: "Принять вызов может только лидер группы (№1 в /top)." };
    if (!this.eligible(g)) return { ok: false, text: this.whyNot(g, userId) };
    if (lobby.participants.some((p) => p.userId === userId)) return { ok: false, text: "Ты уже в лобби 👍" };
    if (lobby.participants.some((p) => String(p.chatId) === String(g.chatId))) {
      return { ok: false, text: "От вашей группы уже есть участник." };
    }
    const ready = await this.addParticipant(lobby, g);
    return {
      ok: true,
      text: "✅ Вызов принят!",
      edit:
        `⚔️ <b>${esc(g.leader.name)}</b> принял(а) вызов на Супер-игру!\n` +
        `Лобби: ${lobby.participants.length}/${size}` +
        (ready ? "\n\n🏟 Лобби собрано — инструкции ниже." : "\nЖдём остальных соперников."),
    };
  }

  // Добавить участника; если лобби заполнилось — запустить подготовку
  async addParticipant(lobby, g) {
    lobby.participants.push(this.participant(g));
    const ready = lobby.participants.length >= lobbySize(this.env);
    if (ready) lobby.status = "ready";
    await this.ctx.storage.put("lobby", lobby);
    if (ready) {
      await this.ctx.storage.deleteAlarm();
      await this.onReady(lobby);
    }
    return ready;
  }

  async onReady(lobby) {
    const arena = await this.ctx.storage.get("arena");
    const ids = lobby.participants.map((p) => p.userId);
    let link = null;

    if (arena) {
      const stub = this.env.GAME.get(this.env.GAME.idFromName(String(arena.chatId)));
      await stub.fetch("https://game/allow", {
        method: "POST",
        body: JSON.stringify({
          ids,
          lobbyId: lobby.id,
          participants: lobby.participants.map((p) => ({ id: p.userId, name: p.name, chatId: p.chatId, no: p.no })),
        }),
      });
      const res = await this.tg("createChatInviteLink", {
        chat_id: arena.chatId,
        name: "Super game " + lobby.id,
        creates_join_request: true,
      });
      link = res.result?.invite_link || null;
    }

    const groupsList = lobby.participants.map((p) => `Группа #${p.no}`).join(", ");
    for (const p of lobby.participants) {
      await this.send(
        p.chatId,
        "🏟 <b>Лобби Супер-игры собрано!</b>\n\n" +
          `Соперники: ${groupsList}\n\n` +
          `<b>${esc(p.name)}</b>, ты представляешь свою группу! 💪\n` +
          (link
            ? `\n👉 Вход на Арену: ${link}\nНажми «Подать заявку» — бот пустит только участников.`
            : "\nВладелец бота скоро пришлёт приглашение на Арену.")
      );
    }

    if (this.env.OWNER_ID) {
      await this.send(
        this.env.OWNER_ID,
        `🏟 <b>Лобби Супер-игры готово</b> (${lobby.participants.length} игроков)\n\n` +
          lobby.participants
            .map((p) => `• <b>${esc(p.name)}</b> — Группа #${p.no}${p.chatId ? "" : ""}, 🔥 ${p.hardPoints}, id <code>${p.userId}</code>`)
            .join("\n") +
          (arena
            ? `\n\nСсылка-заявка отправлена участникам: ${link || "⚠️ не удалось создать (проверь права бота в Арене)"}\n` +
              "Матч начнётся сам, когда все участники зайдут и нажмут «✅ Готов». Управлять — меню бота → 🎛 Пульт Арены."
            : "\n\n⚠️ Арена не назначена. Создай группу, добавь туда бота админом и напиши в ней /arena_here — участники получат ссылку автоматически.")
      );
    }
  }

  async setArena(chatId, title) {
    await this.ctx.storage.put("arena", { chatId, title });
    await this.ctx.storage.delete("g:" + chatId); // Арена не участвует в рейтинге групп
    const lobby = await this.ctx.storage.get("lobby");
    if (lobby?.status === "ready") {
      await this.onReady(lobby);
      return { text: "✅ Лобби уже собрано — участники получили ссылку на вход." };
    }
    return { text: "Когда соберётся лобби, участники получат ссылку на вход, а ты — уведомление в личку." };
  }

  async finish(results) {
    const lobby = await this.ctx.storage.get("lobby");
    if (lobby) {
      const byId = new Map(lobby.participants.map((p) => [p.userId, p]));
      const medals = ["🥇", "🥈", "🥉"];
      const winner = byId.get(results[0]?.id);
      if (winner) {
        const g = await this.ctx.storage.get("g:" + winner.chatId);
        if (g) {
          g.titles = (g.titles || 0) + 1;
          await this.ctx.storage.put("g:" + winner.chatId, g);
        }
      }
      for (const p of lobby.participants) {
        const lines = results.map((r, i) => {
          const rp = byId.get(r.id);
          const who = r.id === p.userId ? `<b>${esc(p.name)}</b> (ваша группа)` : `Лидер Группы #${rp ? rp.no : "?"}`;
          return `${medals[i] || i + 1 + "."} ${who} — ${r.points}`;
        });
        await this.send(
          p.chatId,
          "🏆 <b>Итоги Супер-игры</b>\n\n" +
            lines.join("\n") +
            (winner && winner.userId === p.userId ? `\n\n👑 <b>${esc(p.name)}</b> — Чемпион Арены! Поздравляем вашу группу!` : "")
        );
      }
    }
    await this.ctx.storage.delete("lobby");
    await this.ctx.storage.deleteAlarm();
    return { ok: true };
  }

  // Итоги матча: перевод рейтинга, титул группы, рассылка по группам
  async arenaResult(results, winnerId) {
    const medals = ["🥇", "🥈", "🥉"];
    for (const r of results) {
      if (!r.delta || !r.chatId) continue;
      const stub = this.env.GAME.get(this.env.GAME.idFromName(String(r.chatId)));
      await stub.fetch("https://game/adjust", { method: "POST", body: JSON.stringify({ uid: r.id, name: r.name, delta: r.delta }) });
    }
    const winner = results.find((r) => r.id === winnerId);
    if (winner) {
      const g = await this.ctx.storage.get("g:" + winner.chatId);
      if (g) {
        g.titles = (g.titles || 0) + 1;
        await this.ctx.storage.put("g:" + winner.chatId, g);
      }
    }
    const sent = new Set();
    for (const p of results) {
      if (!p.chatId || sent.has(String(p.chatId))) continue;
      sent.add(String(p.chatId));
      const lines = results.map((r, i) => {
        const who = String(r.chatId) === String(p.chatId) ? `<b>${esc(r.name)}</b> (ваша группа)` : `Лидер Группы #${r.no}`;
        const d = r.delta > 0 ? ` · +${r.delta} рейтинга` : r.delta < 0 ? ` · ${r.delta} рейтинга (${r.pct}%)` : "";
        return `${medals[i] || i + 1 + "."} ${who} — ${r.absent ? "не пришёл(ла)" : r.points + " очк."}${d}`;
      });
      await this.send(
        p.chatId,
        "🏆 <b>Итоги Супер-игры</b>\n\n" +
          lines.join("\n") +
          (winner && String(winner.chatId) === String(p.chatId) ? `\n\n👑 <b>${esc(winner.name)}</b> — Чемпион Арены! Поздравляем вашу группу!` : "")
      );
    }
    await this.ctx.storage.delete("lobby");
    await this.ctx.storage.deleteAlarm();
    return { ok: true };
  }

  async arenaCancel(reason) {
    const lobby = await this.ctx.storage.get("lobby");
    if (lobby) {
      for (const p of lobby.participants) await this.send(p.chatId, "🏟 Супер-игра отменена." + (reason ? "\n" + reason : "") + "\nРейтинг никто не потерял.");
    }
    await this.ctx.storage.delete("lobby");
    await this.ctx.storage.deleteAlarm();
    return { ok: true };
  }

  async status() {
    const lobby = await this.ctx.storage.get("lobby");
    const arena = await this.ctx.storage.get("arena");
    const all = [...(await this.ctx.storage.list({ prefix: "g:" })).values()];
    const eligible = all.filter((g) => this.eligible(g));
    let t =
      "🏟 <b>Статус Супер-игры</b>\n\n" +
      `Арена: ${arena ? esc(arena.title || String(arena.chatId)) : "не назначена (/arena_here в группе)"}\n` +
      `Групп в реестре: ${all.length}\n` +
      `Лидеров, готовых к вызову: ${eligible.length}\n` +
      `Порог: ${minPoints(this.env)} очков на сложном, ${minPlayers(this.env)}+ игроков, лобби на ${lobbySize(this.env)}\n\n`;
    if (!lobby) t += "Лобби: нет";
    else
      t +=
        `Лобби: ${lobby.status === "open" ? "набирается" : "собрано"} (${lobby.participants.length}/${lobbySize(this.env)})\n` +
        lobby.participants.map((p) => `• ${esc(p.name)} — Группа #${p.no}, id <code>${p.userId}</code>`).join("\n");
    return { text: t };
  }

  // Лобби не набралось за 48 часов
  async alarm() {
    const lobby = await this.ctx.storage.get("lobby");
    if (!lobby || lobby.status !== "open") return;
    if (Date.now() < lobby.expires - 1000) {
      await this.ctx.storage.setAlarm(lobby.expires);
      return;
    }
    await this.ctx.storage.delete("lobby");
    for (const p of lobby.participants) {
      await this.send(p.chatId, "⌛ Лобби Супер-игры не набралось за 48 часов. Попробуйте снова — /challenge");
    }
  }
}

// ================== ТЕКСТЫ И КНОПКИ НАСТРОЙКИ ==================
function settingsLine(s) {
  const lvl = LEVELS[s.level] || LEVELS.medium;
  return `⚙️ Сложность: ${lvl.name} · ${s.timed ? "⏱ " + fmtTime(s.timeSec) + " на слово" : "♾ Без ограничения времени"}`;
}

function setupStep1Text() {
  return (
    "<b>Шаг 1.</b> Выберите уровень сложности слов:\n\n" +
    Object.values(LEVELS)
      .map((l) => `${l.name} — ${l.about} (очки ×${l.mult})`)
      .join("\n") +
    "\n\n🔥 Для Супер-игры засчитываются только очки на 🔴 Сложном и 💀 Ультимейте."
  );
}

function setupStep2Text(d) {
  return (
    "⚙️ <b>Настройка игры</b>\n\n" +
    `Сложность: ${LEVELS[d.level].name} ✅\n\n` +
    "<b>Шаг 2.</b> Как играем?\n\n" +
    "⏱ <b>На время</b> — на каждое слово даётся ограниченное время.\n" +
    "♾ <b>Без времени</b> — объясняем, пока кто-то не угадает."
  );
}

function setupStep3Text(d) {
  return (
    "⚙️ <b>Настройка игры</b>\n\n" +
    `Сложность: ${LEVELS[d.level].name} ✅\n` +
    "Режим: ⏱ На время ✅\n\n" +
    "<b>Шаг 3.</b> Сколько времени даётся на угадывание одного слова?"
  );
}

function levelKeyboard() {
  return kb([
    [[LEVELS.easy.name, "d:easy"], [LEVELS.medium.name, "d:medium"]],
    [[LEVELS.hard.name, "d:hard"], [LEVELS.ultimate.name, "d:ultimate"]],
  ]);
}

function modeKeyboard() {
  return kb([
    [["⏱ На время", "m:timed"], ["♾ Без времени", "m:free"]],
    [["⬅️ Назад", "back"]],
  ]);
}

function timeKeyboard() {
  const btns = TIME_OPTIONS.map((sec) => [fmtTime(sec), "t:" + sec]);
  return kb([btns.slice(0, 3), btns.slice(3), [["⬅️ Назад", "back"]]]);
}

// ================== ПОМОЩНИКИ ==================
async function tg(env, method, body) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) console.log("TG error", method, JSON.stringify(data));
    return data;
  } catch (e) {
    console.log("TG fetch failed", method, String(e));
    return { ok: false };
  }
}

function text(body, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function kb(rows) {
  return { inline_keyboard: rows.map((row) => row.map(([t, data]) => ({ text: t, callback_data: data }))) };
}

function esc(s = "") {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function displayName(u = {}) {
  const n = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return (n || (u.username ? "@" + u.username : "Игрок")).slice(0, 40);
}

function upper(w) {
  return String(w).toUpperCase();
}

function wordAlert(w, cat) {
  return (
    `🤫 Твоё слово: ${upper(w)}` +
    (cat ? `\n📂 ${catName(cat)}` : "") +
    `\n\nОбъясняй, не называя его и однокоренные слова! Посмотреть ещё раз — «👁».`
  );
}

function fmtTime(sec) {
  sec = Math.round(sec);
  if (sec < 60) return `${sec} сек`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m} мин ${s} сек` : `${m} мин`;
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

// Номер недели (неделя начинается в понедельник, по времени ALIVE_TZ)
function weekId(env) {
  const local = Date.now() + tzOffset(env) * 3600 * 1000;
  const days = Math.floor(local / 86400000);
  return Math.floor((days + 3) / 7); // 1 янв 1970 — четверг → сдвиг на понедельник
}

// ---------- фильтр мата и ссылок ----------
const LOOKALIKE = { a: "а", e: "е", o: "о", p: "р", c: "с", x: "х", y: "у", k: "к", m: "м", t: "т", h: "н", "3": "з", "0": "о", "6": "б" };
const BAD_WORDS = [
  /^(на|за|вы|у|от|по|при|раз|рас|до|об|пере|недо|долбо|съ|подъ|объ|разъ|въ|изъ)?еб(?!ол)/, // ебать, заебал, выебон…
  /^(на|по|ни|от|за|до|о)?ху[йеияю]/,                                                       // хуй, нахуй, охуеть…
  /пизд/,
  /^(вы|раз|по|за|на)?бля(д|т)|^бля$/,
  /^сук(а|и|у|ой|ам|ами|ах)?$/,
  /^суч(ка|ки|ку|кой|ара|ий|ье)/,
  /^муд(ак|ил|озвон|ач)/,
  /^(пидор|пидар|пидр)/,
  /^залуп/,
  /^г[ао]ндон/,
  /^шлюх/,
  /^(за|по|на|от|пере)?дроч/,
  /^манд(а|у|ой|ы)$/,
  /^мраз(ь|и|ота)/,
  /^ублюд/,
];

function profanityTokens(t) {
  let s = String(t).toLowerCase().replace(/ё/g, "е");
  s = s.replace(/[aeopcxykmth306]/g, (ch) => LOOKALIKE[ch] || ch);         // латиница-двойники → кириллица
  s = s.replace(/([а-я])[*.\-_@#$%!]+(?=[а-я])/g, "$1");                   // х*й, х.у.й → хуй
  s = s.replace(/([а-я])\1+/g, "$1");                                       // хуууй → хуй
  return s.split(/[^а-я]+/).filter(Boolean);
}

function hasProfanity(t) {
  const variants = [String(t)];
  if (String(t).includes("*")) for (const ch of "уиеаоб") variants.push(String(t).replace(/\*/g, ch)); // х*й, п*здец, е*ать
  return variants.some((v) => profanityTokens(v).some((w) => BAD_WORDS.some((re) => re.test(w))));
}

function hasLink(t) {
  return /(https?:\/\/|www\.|t\.me\/|telegram\.(me|dog)\/|\b[a-z0-9-]+\.(ru|com|net|org|io|me|xyz|top|site|online|shop|info|biz|club|link|ly)\b)/i.test(String(t));
}

// ---------- флаги: список и строгая проверка названий стран ----------
const FLAG_LIST = Object.entries(FLAGS).flatMap(([level, list]) =>
  list.map((s) => {
    const [code, ...names] = s.split("|");
    return { code, name: names[0], answers: names, level };
  })
);
let FLAG_ALIAS = null; // "нормализованное название" → код страны
function flagAliasMap() {
  if (!FLAG_ALIAS) {
    FLAG_ALIAS = new Map();
    for (const e of FLAG_LIST) for (const a of e.answers) FLAG_ALIAS.set(tokenize(a).join(" "), e.code);
  }
  return FLAG_ALIAS;
}

// Правильно, если назвали эту страну; если точно назвали ДРУГУЮ страну — промах (Нигер ≠ Нигерия, Ирак ≠ Иран)
function flagGuess(text, entry) {
  const map = flagAliasMap();
  const toks = tokenize(text);
  const hits = new Set();
  for (let i = 0; i < toks.length; ) {
    let found = 0;
    for (let len = Math.min(5, toks.length - i); len >= 1; len--) {
      const code = map.get(toks.slice(i, i + len).join(" "));
      if (code) {
        hits.add(code);
        found = len;
        break;
      }
    }
    i += found || 1;
  }
  if (hits.has(entry.code)) return true;
  if (hits.size) return false;
  // падежи и опечатки — только для своей страны и только для длинных названий
  const fuzzy = entry.answers.filter((a) => tokenize(a).every((t) => t.length >= 5));
  return answerHit(text, fuzzy);
}

function flagEmoji(code) {
  return String.fromCodePoint(...code.toUpperCase().split("").map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

// ---------- подсказки для «Крокодил ведёт» ----------
const hintCache = new Map();

// Нет ли в подсказке самого слова или однокоренного
function hintLeaks(hint, answers) {
  if (answerHit(hint, answers)) return true;
  const roots = answers.flatMap((a) => tokenize(a)).filter((t) => t.length >= 4).map((t) => t.slice(0, Math.max(4, Math.min(5, t.length - 3))));
  return tokenize(hint).some((t) => roots.some((r) => t.startsWith(r)));
}

// Готовые подсказки из hints.js; для новых слов — один раз просим нейросеть Cloudflare и сохраняем в D1
async function getHints(env, entry) {
  if (HINTS[entry.word]) return HINTS[entry.word];
  if (hintCache.has(entry.word)) return hintCache.get(entry.word);
  try {
    if (await dbInit(env)) {
      const row = await env.DB.prepare("SELECT data FROM hints WHERE word = ?1").bind(entry.word).first();
      if (row?.data) {
        const h = JSON.parse(row.data);
        hintCache.set(entry.word, h);
        return h;
      }
    }
  } catch (e) {
    console.log("hints D1 read failed", String(e));
  }
  if (!env.AI) return null;
  try {
    const res = await env.AI.run(AI_MODEL, {
      messages: [
        {
          role: "system",
          content:
            "Ты ведущий игры «Крокодил». Пиши по-русски. Отвечай ровно пятью строками без нумерации и без пояснений.",
        },
        {
          role: "user",
          content:
            `Придумай 5 подсказок к слову «${entry.word}». Первая — очень размытая и хитрая, каждая следующая чуть понятнее, ` +
            "пятая узнаваемая, но не очевидная. Нельзя использовать само слово, однокоренные слова, буквы слова и рифмы. " +
            "Каждая подсказка — одно короткое предложение до 10 слов.",
        },
      ],
      max_tokens: 400,
    });
    const lines = String(res?.response || "")
      .split("\n")
      .map((l) => l.replace(/^\s*(\d+[.)]|[-•*])\s*/, "").replace(/^[«"]|[»"]$/g, "").trim())
      .filter((l) => l.length >= 5 && l.length <= 140 && !hintLeaks(l, entry.answers));
    if (lines.length < 5) {
      hintCache.set(entry.word, null); // не мучаем нейросеть повторно до перезапуска
      return null;
    }
    const h = lines.slice(0, 5);
    hintCache.set(entry.word, h);
    if (await dbInit(env)) {
      await env.DB.prepare("INSERT OR REPLACE INTO hints (word, data, created_at) VALUES (?1, ?2, ?3)")
        .bind(entry.word, JSON.stringify(h), Date.now()).run();
    }
    return h;
  } catch (e) {
    console.log("AI hints failed", String(e));
    hintCache.set(entry.word, null);
    return null;
  }
}

function parseEntry(s) {
  const hard = s.startsWith("!");
  const answers = s.replace(/^!/, "").split("|").map((x) => x.trim()).filter(Boolean);
  return { word: answers[0], answers, hard };
}

// Засчитывается любой вариант ответа; для ответов из нескольких слов — все слова подряд
function answerHit(text, answers) {
  const tokens = tokenize(text);
  return answers.some((a) => {
    const at = tokenize(a);
    if (!at.length) return false;
    if (at.length === 1) return tokens.some((t) => matches(t, at[0]));
    for (let i = 0; i + at.length <= tokens.length; i++) {
      if (at.every((w, j) => matches(tokens[i + j], w))) return true;
    }
    return false;
  });
}

function normalize(s) {
  return String(s).toLowerCase().replace(/ё/g, "е");
}

function tokenize(t) {
  return normalize(t).split(/[^a-zа-я0-9]+/).filter(Boolean);
}

// Основа слова: убираем окончание-гласную ("кошка" → "кошк", "мороженое" → "морожен")
function stemOf(w) {
  const s = w.replace(/[аеиоуыэюяьй]+$/, "");
  return s.length >= 3 ? s : w;
}

// Засчитываем: точное совпадение, другие падежи ("кошку", "телефоном"), 1–2 опечатки
function matches(token, word) {
  const w = normalize(word);
  if (token === w) return true;
  const stem = stemOf(w);
  const maxLonger = w.length <= 4 ? 1 : 3;
  if (token.startsWith(stem) && token.length <= w.length + maxLonger) return true;
  if (w.length >= 5 && Math.abs(token.length - w.length) <= 1 && lev(token, w) <= (w.length >= 9 ? 2 : 1)) return true;
  return false;
}

function lev(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}
