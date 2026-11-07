// 🐊 «Крокодил» — Telegram-бот для групп + Супер-игра (Арена)
// Cloudflare Workers + Durable Objects:
//   CrocodileGame — по одному объекту на каждую группу (раунды, рейтинг группы)
//   ArenaRegistry — один общий объект: все группы, их лидеры, лобби Супер-игры

import { DurableObject } from "cloudflare:workers";
import { WORDS_BY_LEVEL } from "./words.js";

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

// ================== НАСТРОЙКИ СУПЕР-ИГРЫ ==================
// Можно переопределить переменными в Cloudflare (Settings → Variables):
// ARENA_MIN_POINTS, ARENA_MIN_PLAYERS, ARENA_LOBBY_SIZE — удобно для теста
const ARENA_SETTINGS = { level: "ultimate", timed: true, timeSec: 180 };
const LOBBY_TTL_MS = 48 * 60 * 60 * 1000;   // сколько лобби ждёт соперников
const INVITE_LIMIT = 30;                     // максимум групп, куда рассылается вызов
const MIN_GUESS_SEC = 4;                     // угадал быстрее — очки "на сложном" не идут (защита от сговора)
const PAIR_DAILY_LIMIT = 5;                  // одна пара ведущий→угадавший: максимум N зачётных раундов в день
const minPoints = (env) => Number(env.ARENA_MIN_POINTS) || 1000;
const minPlayers = (env) => Number(env.ARENA_MIN_PLAYERS) || 5;
const lobbySize = (env) => Number(env.ARENA_LOBBY_SIZE) || 4;

const COMMANDS = [
  { command: "game", description: "🐊 Начать игру" },
  { command: "top", description: "🏆 Таблица лидеров группы" },
  { command: "me", description: "📊 Моя статистика" },
  { command: "challenge", description: "⚔️ Вызов на Супер-игру (для лидера группы)" },
  { command: "settings", description: "⚙️ Сложность и время (админы)" },
  { command: "stop", description: "🛑 Остановить игру" },
  { command: "rules", description: "📖 Правила и очки" },
];

const HOW_TO_PLAY =
  "<b>Как играть:</b>\n" +
  "1. Один игрок становится ведущим и получает секретное слово — его видит только он.\n" +
  "2. Ведущий объясняет слово в чате, не называя его и однокоренные слова.\n" +
  "3. Остальные пишут догадки. Падежи и мелкие опечатки засчитываются.\n" +
  "4. Кто первым угадал — получает очки. Ведущий тоже получает очки за хорошее объяснение.\n" +
  "5. Очки копятся, у каждой группы своя таблица лидеров — /top.";

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
        allowed_updates: ["message", "callback_query", "chat_join_request"],
        drop_pending_updates: true,
      });
      const commands = await tg(env, "setMyCommands", { commands: COMMANDS });

      if (me.ok && webhook.ok && commands.ok) {
        return text(
          `✅ Готово! Бот @${me.result.username} подключён.\n` +
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
        update.message?.chat || update.callback_query?.message?.chat || update.chat_join_request?.chat;
      try {
        if (!chat) {
          if (update.callback_query) await tg(env, "answerCallbackQuery", { callback_query_id: update.callback_query.id });
        } else if (chat.type === "group" || chat.type === "supergroup") {
          const stub = env.GAME.get(env.GAME.idFromName(String(chat.id)));
          await stub.fetch("https://game/update", { method: "POST", body: JSON.stringify(update) });
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
};

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

  const me = await tg(env, "getMe", {});
  const username = me.result?.username;
  await tg(env, "sendMessage", {
    chat_id: msg.chat.id,
    parse_mode: "HTML",
    text:
      "🐊 <b>Привет! Я бот для игры «Крокодил».</b>\n\n" +
      "Добавь меня в группу, сделай админом и напиши там /game.\n\n" +
      HOW_TO_PLAY +
      "\n\n🏟 Лучшие игроки групп встречаются в Супер-игре на Арене — подробнее в /rules внутри группы.",
    reply_markup: username
      ? { inline_keyboard: [[{ text: "➕ Добавить в группу", url: `https://t.me/${username}?startgroup=true` }]] }
      : undefined,
  });
}

function isOwnerId(env, userId) {
  return !!env.OWNER_ID && String(userId) === String(env.OWNER_ID).trim();
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
    ctx.blockConcurrencyWhile(async () => {
      this.round = (await ctx.storage.get("round")) || { status: "idle" };
      this.recent = (await ctx.storage.get("recent")) || [];
      this.settings = (await ctx.storage.get("settings")) || null;
      this.meta = (await ctx.storage.get("meta")) || {};
      this.isArena = !!(await ctx.storage.get("arena"));
      this.allowed = new Set((await ctx.storage.get("allowed")) || []);
    });
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = await request.json();
    try {
      if (path === "/allow") return Response.json(await this.allowPlayers(body.ids || []));
      await this.rememberChat(body.message?.chat || body.callback_query?.message?.chat || body.chat_join_request?.chat);
      if (body.callback_query) await this.onCallback(body.callback_query);
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
    return this.round.status === "waiting" || this.round.status === "playing";
  }
  cfg() {
    if (this.isArena) return ARENA_SETTINGS;
    return this.settings || DEFAULT_SETTINGS;
  }

  async rememberChat(chat) {
    if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;
    if (this.meta.chatId !== chat.id || this.meta.title !== chat.title) {
      this.meta = { chatId: chat.id, title: chat.title || "" };
      await this.ctx.storage.put("meta", this.meta);
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

  pickWord(level) {
    const all = WORDS_BY_LEVEL[level] || WORDS_BY_LEVEL.medium;
    const recent = new Set(this.recent);
    let pool = all.filter((w) => !recent.has(w));
    if (!pool.length) {
      this.recent = this.recent.filter((w) => !all.includes(w));
      pool = all;
    }
    const w = pool[Math.floor(Math.random() * pool.length)];
    this.recent.push(w);
    if (this.recent.length > RECENT_LIMIT) this.recent = this.recent.slice(-RECENT_LIMIT);
    return w;
  }

  async addStats(userId, name, delta) {
    const keys = ["u:" + userId];
    if (this.isArena) keys.push("m:" + userId); // отдельный зачёт текущего матча Арены
    for (const key of keys) {
      const s = (await this.ctx.storage.get(key)) || { name, points: 0, hardPoints: 0, guessed: 0, explained: 0, led: 0 };
      s.name = name;
      for (const k of Object.keys(delta)) s[k] = (s[k] || 0) + delta[k];
      await this.ctx.storage.put(key, s);
    }
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
      players: players.length,
      leader: top ? { id: top.id, name: top.name, points: top.points, hardPoints: top.hardPoints || 0 } : null,
    };
  }

  async report() {
    if (this.isArena || !this.meta.chatId) return;
    try {
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

  async restrict(chatId, userId, allow) {
    const v = !!allow;
    return this.tg("restrictChatMember", {
      chat_id: chatId,
      user_id: userId,
      use_independent_chat_permissions: true,
      permissions: {
        can_send_messages: v, can_send_audios: v, can_send_documents: v, can_send_photos: v,
        can_send_videos: v, can_send_video_notes: v, can_send_voice_notes: v, can_send_polls: v,
        can_send_other_messages: v, can_add_web_page_previews: v,
      },
    });
  }

  async allowPlayers(ids) {
    for (const id of ids) this.allowed.add(id);
    await this.ctx.storage.put("allowed", [...this.allowed]);
    if (this.isArena && this.meta.chatId) {
      for (const id of ids) await this.restrict(this.meta.chatId, id, true); // снять ограничения, если были
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
        if (this.settings) {
          return this.send(chatId, "🐊 <b>Я снова с вами!</b>\n\n" + (await this.introHeader()) + "\n\nНачать игру — /game");
        }
        if (this.round.status === "idle") return this.startSetup(chatId, msg.from?.id || null, true);
      }
      return;
    }

    // Арена: писать могут только участники Супер-игры и владелец
    if (this.isArena && !anonAdmin && msg.from && !msg.from.is_bot) {
      const uid = msg.from.id;
      if (!this.isOwner(uid) && !this.canPlayInArena(uid)) {
        await this.tg("deleteMessage", { chat_id: chatId, message_id: msg.message_id });
        await this.restrict(chatId, uid, false);
        return;
      }
    }

    if (!msg.text) return;
    if (msg.from?.is_bot && !anonAdmin) return;

    if (msg.text.startsWith("/")) return this.onCommand(msg, anonAdmin);
    if (this.round.status === "playing" && !msg.from?.is_bot) return this.onPlayingText(msg);
  }

  async onCommand(msg, anonAdmin) {
    const first = msg.text.trim().split(/\s+/)[0];
    const [cmdRaw, target] = first.split("@");
    if (target) {
      const me = await this.getMe();
      if (me.username && target.toLowerCase() !== me.username.toLowerCase()) return; // команда другому боту
    }
    switch (cmdRaw.toLowerCase()) {
      case "/game":
      case "/start":
      case "/croc":
      case "/crocodile":
        return this.cmdGame(msg, anonAdmin);
      case "/top":
        return this.cmdTop(msg);
      case "/me":
      case "/stats":
        return this.cmdMe(msg);
      case "/challenge":
        return this.cmdChallenge(msg);
      case "/settings":
        return this.cmdSettings(msg, anonAdmin);
      case "/stop":
        return this.cmdStop(msg, anonAdmin);
      case "/rules":
      case "/help":
        return this.send(msg.chat.id, rulesText(this.cfg(), this.env));
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
    if (r.status === "waiting") {
      return this.send(chatId, "☝️ Раунд уже ждёт ведущего — нажми «🙋 Я буду ведущим».", {
        reply_parameters: { message_id: r.msgId, allow_sending_without_reply: true },
      });
    }
    if (r.status === "playing") {
      return this.send(chatId, `🎤 Сейчас объясняет <b>${esc(r.leaderName)}</b> — угадывайте!`);
    }
    if (r.status === "ended") return; // прямо сейчас подводятся итоги

    if (this.isArena) {
      if (!this.isOwner(msg.from?.id) && !this.canPlayInArena(msg.from?.id) && !anonAdmin) return;
      if (!this.allowed.size) return this.send(chatId, "🏟 На Арене пока нет участников. Ждём, когда соберётся лобби.");
      return this.openRound(chatId, await this.introHeader());
    }

    // Первый запуск в группе → правила + настройка
    if (!this.settings) return this.startSetup(chatId, anonAdmin ? null : msg.from?.id, true);
    return this.openRound(chatId, await this.introHeader());
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
    await this.edit(r.chatId, r.msgId, "✅ <b>Игра настроена!</b>\n" + settingsLine(s) + "\n\nИзменить настройки — /settings (админы)");
    return this.openRound(r.chatId, await this.introHeader());
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

    const res = await this.send(chatId, (header ? header + "\n\n" : "") + "🐊 <b>Новый раунд!</b> Кто будет объяснять слово?", {
      reply_markup: kb([[["🙋 Я буду ведущим", "lead"]]]),
    });
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
    const tokens = tokenize(msg.text);
    const hit = tokens.some((t) => matches(t, r.word));
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
      return this.openRound(
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
    return this.openRound(r.chatId, header, r.msgId);
  }

  // ---------- кнопки ----------
  async onCallback(cq) {
    const data = String(cq.data || "");
    if (data === "chal" || data.startsWith("acc:")) return this.onArenaCallback(cq, data);

    const r = this.round;
    const msgId = cq.message?.message_id;
    const valid = r.msgId && msgId === r.msgId && (this.isActive() || r.status === "setup");
    if (!valid) {
      await this.answer(cq, "⌛ Это сообщение уже неактуально. Новая игра — /game");
      if (cq.message && msgId !== r.msgId) await this.removeButtons(cq.message.chat.id, msgId);
      return;
    }

    if (r.status === "setup") return this.handleSetup(cq);

    const isLeader = r.status === "playing" && cq.from.id === r.leaderId;

    switch (data) {
      case "lead": {
        if (r.status !== "waiting") return this.answer(cq, "Ведущий уже выбран 🙂");
        if (this.isArena && !this.canPlayInArena(cq.from.id)) {
          return this.answer(cq, "🏟 Вести могут только участники Супер-игры", true);
        }
        const s = this.cfg();
        const roundMs = s.timed ? s.timeSec * 1000 : UNTIMED_LIMIT_MS;
        const word = this.pickWord(s.level);
        Object.assign(r, {
          status: "playing",
          leaderId: cq.from.id,
          leaderName: displayName(cq.from),
          word,
          level: s.level,
          timed: s.timed,
          roundMs,
          skips: 0,
          leaderMsgs: 0,
          startedAt: Date.now(),
          deadline: Date.now() + roundMs,
        });
        await this.save();
        await this.answer(cq, wordAlert(word), true);
        await this.addStats(cq.from.id, r.leaderName, { led: 1 });
        await this.renderPlaying();
        await this.ctx.storage.setAlarm(r.deadline);
        return;
      }

      case "word":
        if (r.status !== "playing") return this.answer(cq, "Сначала выберите ведущего");
        if (!isLeader) return this.answer(cq, "🤫 Слово видит только ведущий. Угадывай!", true);
        return this.answer(cq, wordAlert(r.word), true);

      case "skip": {
        if (!isLeader) return this.answer(cq, "Менять слово может только ведущий", true);
        if (r.skips >= MAX_SKIPS) return this.answer(cq, "Больше менять слово нельзя — объясняй это 💪", true);
        r.word = this.pickWord(r.level);
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
        return this.openRound(
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
    if (st !== "waiting" && st !== "playing" && st !== "setup") {
      return this.send(chatId, "Сейчас нет активной игры. Начать — /game");
    }

    const uid = msg.from?.id;
    const isLeader = st === "playing" && uid === this.round.leaderId;
    const isInitiator = st === "setup" && uid && uid === this.round.initiatorId;
    const allowed = isLeader || isInitiator || anonAdmin || this.isOwner(uid) || (await this.isAdmin(chatId, uid));
    if (!allowed) return this.send(chatId, "🛑 Остановить игру может ведущий или админ группы.");

    const cur = this.round;
    if (!["waiting", "playing", "setup"].includes(cur.status)) return; // пока проверяли права, всё уже закончилось
    const word = cur.status === "playing" ? cur.word : null;
    this.round = { status: "idle" };
    await this.save();
    await this.ctx.storage.deleteAlarm();
    await this.removeButtons(chatId, cur.msgId);
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
    if (!["waiting", "playing", "setup"].includes(r.status)) return;
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
    return this.openRound(r.chatId, `${why}\nСлово было: <b>${upper(r.word)}</b>`, r.msgId);
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
    g.players = snap.players || 0;
    g.leader = snap.leader || null;
    g.updated = Date.now();
    await this.ctx.storage.put(key, g);
    return g;
  }

  eligible(g) {
    return !!(g && g.leader && g.leader.hardPoints >= minPoints(this.env) && g.players >= minPlayers(this.env));
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
      await stub.fetch("https://game/allow", { method: "POST", body: JSON.stringify({ ids }) });
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
              "Когда все зайдут — напиши /game в Арене. В конце — /arena_finish."
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

function wordAlert(w) {
  return `🤫 Твоё слово: ${upper(w)}\n\nОбъясняй, не называя его и однокоренные слова! Посмотреть ещё раз — кнопка «👁».`;
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

// ---------- проверка угадывания ----------
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
