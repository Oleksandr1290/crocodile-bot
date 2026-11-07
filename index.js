// 🐊 «Крокодил» — Telegram-бот для групп
// Cloudflare Workers + Durable Objects: по одному объекту на каждую группу.
// Объект группы обрабатывает её события строго по очереди, поэтому
// два игрока не могут "угадать одновременно" и получить очки дважды.

import { DurableObject } from "cloudflare:workers";
import { WORDS_BY_LEVEL } from "./words.js";

// ================== НАСТРОЙКИ ==================
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

const COMMANDS = [
  { command: "game", description: "🐊 Начать игру" },
  { command: "top", description: "🏆 Таблица лидеров группы" },
  { command: "me", description: "📊 Моя статистика" },
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

function rulesText(s) {
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
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: true,
      });
      const commands = await tg(env, "setMyCommands", { commands: COMMANDS });

      if (me.ok && webhook.ok && commands.ok) {
        return text(`✅ Готово! Бот @${me.result.username} подключён.\nДобавь его в группу, сделай админом и напиши /game`);
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

      const chat = update.message?.chat || update.callback_query?.message?.chat;
      try {
        if (!chat) {
          if (update.callback_query) await tg(env, "answerCallbackQuery", { callback_query_id: update.callback_query.id });
        } else if (chat.type === "group" || chat.type === "supergroup") {
          const stub = env.GAME.get(env.GAME.idFromName(String(chat.id)));
          await stub.fetch("https://game/update", { method: "POST", body: JSON.stringify(update) });
        } else if (chat.type === "private" && update.message?.text) {
          await sendPrivateHelp(env, chat.id);
        }
      } catch (e) {
        console.log("webhook error", e?.stack || String(e));
      }
      return text("ok"); // всегда 200, чтобы Telegram не повторял апдейт
    }

    return text("🐊 Crocodile bot работает");
  },
};

async function sendPrivateHelp(env, chatId) {
  const me = await tg(env, "getMe", {});
  const username = me.result?.username;
  await tg(env, "sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text:
      "🐊 <b>Привет! Я бот для игры «Крокодил».</b>\n\n" +
      "Добавь меня в группу, сделай админом и напиши там /game.\n\n" +
      HOW_TO_PLAY,
    reply_markup: username
      ? { inline_keyboard: [[{ text: "➕ Добавить в группу", url: `https://t.me/${username}?startgroup=true` }]] }
      : undefined,
  });
}

// ================== ИГРА: ОДИН ОБЪЕКТ НА ГРУППУ ==================
// round.status: "idle" | "setup" (настройка) | "waiting" (ждём ведущего) | "playing" | "ended" (подводим итоги)
export class CrocodileGame extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.round = { status: "idle" };
    this.recent = [];
    this.settings = null;
    ctx.blockConcurrencyWhile(async () => {
      this.round = (await ctx.storage.get("round")) || { status: "idle" };
      this.recent = (await ctx.storage.get("recent")) || [];
      this.settings = (await ctx.storage.get("settings")) || null;
    });
  }

  async fetch(request) {
    const update = await request.json();
    try {
      if (update.callback_query) await this.onCallback(update.callback_query);
      else if (update.message) await this.onMessage(update.message);
    } catch (e) {
      console.log("game error", e?.stack || String(e));
    }
    return new Response("ok");
  }

  // ---------- утилиты ----------
  tg(method, body) {
    return tg(this.env, method, body);
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
    return this.tg("answerCallbackQuery", { callback_query_id: cq.id, text: txt.slice(0, 200), show_alert: alert });
  }
  removeButtons(chatId, msgId) {
    if (!msgId) return;
    return this.tg("editMessageReplyMarkup", { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
  }
  isActive() {
    return this.round.status === "waiting" || this.round.status === "playing";
  }
  cfg() {
    return this.settings || DEFAULT_SETTINGS;
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
    const key = "u:" + userId;
    const s = (await this.ctx.storage.get(key)) || { name, points: 0, guessed: 0, explained: 0, led: 0 };
    s.name = name;
    for (const k of Object.keys(delta)) s[k] = (s[k] || 0) + delta[k];
    await this.ctx.storage.put(key, s);
  }

  // Таблица лидеров группы (берётся из сохранённой статистики)
  async topLines(limit) {
    const all = await this.ctx.storage.list({ prefix: "u:" });
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
    const top = await this.topLines(5);
    return (
      settingsLine(this.cfg()) +
      (top ? "\n\n🏆 <b>Таблица лидеров группы</b>\n" + top + "\n\nПолный рейтинг — /top" : "\n\n🏆 Таблица лидеров пока пуста — станьте первыми!")
    );
  }

  // ---------- сообщения ----------
  async onMessage(msg) {
    const chatId = msg.chat.id;

    // Бота добавили в группу → приветствие, правила и настройка
    if (msg.new_chat_members?.length) {
      const me = await this.getMe();
      if (msg.new_chat_members.some((u) => u.id === me.id)) {
        if (this.settings) {
          return this.send(chatId, "🐊 <b>Я снова с вами!</b>\n\n" + (await this.introHeader()) + "\n\nНачать игру — /game");
        }
        if (this.round.status === "idle") return this.startSetup(chatId, msg.from?.id || null, true);
      }
      return;
    }

    if (!msg.text) return;
    const anonAdmin = msg.sender_chat?.id === chatId; // анонимный админ группы
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
      case "/settings":
        return this.cmdSettings(msg, anonAdmin);
      case "/stop":
        return this.cmdStop(msg, anonAdmin);
      case "/rules":
      case "/help":
        return this.send(msg.chat.id, rulesText(this.cfg()));
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
    const tokens = tokenize(msg.text);
    const hit = tokens.some((t) => matches(t, r.word));

    // Пишет ведущий
    if (msg.from.id === r.leaderId) {
      r.leaderMsgs++;
      if (!hit) return; // счётчик живёт в памяти, лишние записи в базу не нужны
      r.status = "ended";
      await this.addStats(r.leaderId, r.leaderName, { points: -LEADER_PENALTY });
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

    await this.addStats(msg.from.id, gName, { points: gp, guessed: 1 });
    await this.addStats(r.leaderId, r.leaderName, { points: lp, explained: 1 });
    await this.tg("setMessageReaction", {
      chat_id: r.chatId,
      message_id: msg.message_id,
      reaction: [{ type: "emoji", emoji: "🎉" }],
    });

    const header =
      `🎉 <b>${esc(gName)}</b> угадал(а) слово <b>${upper(r.word)}</b> за ${fmtTime(sec)}!\n` +
      `🎯 ${esc(gName)}: +${gp} ${plural(gp, "очко", "очка", "очков")}\n` +
      `🎤 ${esc(r.leaderName)}: +${lp} ${plural(lp, "очко", "очка", "очков")} (сообщений: ${r.leaderMsgs})` +
      (mult > 1 ? `\n✖️ Бонус сложности ×${mult}` : "");
    return this.openRound(r.chatId, header, r.msgId);
  }

  // ---------- кнопки ----------
  async onCallback(cq) {
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

    switch (cq.data) {
      case "lead": {
        if (r.status !== "waiting") return this.answer(cq, "Ведущий уже выбран 🙂");
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

  // ---------- команды ----------
  async cmdTop(msg) {
    const lines = await this.topLines(10);
    if (!lines) return this.send(msg.chat.id, "🏆 Таблица лидеров пока пуста. Сыграйте — /game");
    return this.send(msg.chat.id, "🏆 <b>Таблица лидеров группы</b>\n\n" + lines + "\n\n🎯 угадал · 🎤 объяснил");
  }

  async cmdMe(msg) {
    const chatId = msg.chat.id;
    if (!msg.from || msg.from.is_bot) return;
    const all = await this.ctx.storage.list({ prefix: "u:" });
    const me = all.get("u:" + msg.from.id);
    if (!me) return this.send(chatId, `📊 <b>${esc(displayName(msg.from))}</b>, у тебя пока нет очков. Сыграй — /game`);
    const sorted = [...all.values()].sort((a, b) => b.points - a.points);
    const place = sorted.findIndex((s) => s === me) + 1;
    return this.send(
      chatId,
      `📊 <b>${esc(me.name)}</b>\n\n` +
        `🏅 Место в группе: ${place} из ${sorted.length}\n` +
        `⭐ Очки: ${me.points}\n` +
        `🎯 Угадано слов: ${me.guessed}\n` +
        `🎤 Объяснено слов: ${me.explained} (был ведущим: ${me.led})`
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
    const allowed = isLeader || isInitiator || anonAdmin || (await this.isAdmin(chatId, uid));
    if (!allowed) return this.send(chatId, "🛑 Остановить игру может ведущий или админ группы.");

    const cur = this.round;
    if (!["waiting", "playing", "setup"].includes(cur.status)) return; // пока проверяли права, всё уже закончилось
    const word = cur.status === "playing" ? cur.word : null;
    this.round = { status: "idle" };
    await this.save();
    await this.ctx.storage.deleteAlarm();
    await this.removeButtons(chatId, cur.msgId);
    const top = await this.topLines(5);
    return this.send(
      chatId,
      "🛑 Игра остановлена." +
        (word ? `\nСлово было: <b>${upper(word)}</b>` : "") +
        (top ? "\n\n🏆 <b>Таблица лидеров группы</b>\n" + top : "") +
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
        const top = await this.topLines(5);
        await this.edit(
          r.chatId,
          r.msgId,
          (r.header ? r.header + "\n\n" : "") +
            "😴 Никто не вызвался вести — игра на паузе." +
            (top && !r.header.includes("Таблица лидеров") ? "\n\n🏆 <b>Таблица лидеров группы</b>\n" + top : "") +
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
      .join("\n")
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
