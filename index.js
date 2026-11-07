// 🐊 «Крокодил» — Telegram-бот для групп (этап 1)
// Cloudflare Workers + Durable Objects: по одному объекту на каждую группу.
// Объект группы обрабатывает её события строго по очереди, поэтому
// два игрока не могут "угадать одновременно" и получить очки дважды.

import { DurableObject } from "cloudflare:workers";
import { WORDS } from "./words.js";

// ================== НАСТРОЙКИ ==================
const ROUND_MS = 5 * 60 * 1000;  // время на объяснение слова
const WAIT_MS = 3 * 60 * 1000;   // сколько ждать, пока кто-то вызовется ведущим
const MAX_SKIPS = 5;             // сколько раз ведущий может сменить слово
const RECENT_LIMIT = 150;        // не повторять последние N слов в группе
const LEADER_PENALTY = 3;        // штраф ведущему, если он сам написал слово

const COMMANDS = [
  { command: "game", description: "🐊 Начать игру" },
  { command: "top", description: "🏆 Рейтинг группы" },
  { command: "me", description: "📊 Моя статистика" },
  { command: "stop", description: "🛑 Остановить игру (ведущий или админ)" },
  { command: "rules", description: "📖 Правила и очки" },
];

const RULES_TEXT =
  "📖 <b>Правила «Крокодила»</b>\n\n" +
  "1. /game — новый раунд. Кто хочет объяснять, жмёт «🙋 Я буду ведущим».\n" +
  "2. Ведущий смотрит слово кнопкой «👁» — его видит только он.\n" +
  "3. Ведущий объясняет в чате, не называя слово и однокоренные. " +
  `Назвал — раунд аннулируется и −${LEADER_PENALTY} очка.\n` +
  "4. Остальные пишут догадки. Падежи и мелкие опечатки засчитываются.\n" +
  `5. На раунд ${ROUND_MS / 60000} минут. Слово можно сменить до ${MAX_SKIPS} раз.\n\n` +
  "<b>Очки</b>\n" +
  "🎯 Угадавший: 3, +2 если за 30 сек, +1 если за минуту.\n" +
  "🎤 Ведущий: 2, +2 если хватило 3 сообщений (+1 если до 6), +1 если угадали за минуту.";

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
      RULES_TEXT,
    reply_markup: username
      ? { inline_keyboard: [[{ text: "➕ Добавить в группу", url: `https://t.me/${username}?startgroup=true` }]] }
      : undefined,
  });
}

// ================== ИГРА: ОДИН ОБЪЕКТ НА ГРУППУ ==================
// round.status: "idle" | "waiting" (ждём ведущего) | "playing" | "ended" (подводим итоги)
export class CrocodileGame extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.round = { status: "idle" };
    this.recent = [];
    ctx.blockConcurrencyWhile(async () => {
      this.round = (await ctx.storage.get("round")) || { status: "idle" };
      this.recent = (await ctx.storage.get("recent")) || [];
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

  async getBotUsername() {
    let me = await this.ctx.storage.get("me");
    if (!me) {
      const res = await this.tg("getMe", {});
      me = res.result?.username || null;
      if (me) await this.ctx.storage.put("me", me);
    }
    return me;
  }

  async isAdmin(chatId, userId) {
    const res = await this.tg("getChatMember", { chat_id: chatId, user_id: userId });
    return ["creator", "administrator"].includes(res.result?.status);
  }

  pickWord() {
    const recent = new Set(this.recent);
    let pool = WORDS.filter((w) => !recent.has(w));
    if (!pool.length) {
      this.recent = [];
      pool = WORDS;
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

  // ---------- сообщения ----------
  async onMessage(msg) {
    if (!msg.text) return;
    const anonAdmin = msg.sender_chat?.id === msg.chat.id; // анонимный админ группы
    if (msg.from?.is_bot && !anonAdmin) return;

    if (msg.text.startsWith("/")) return this.onCommand(msg, anonAdmin);
    if (this.round.status === "playing" && !msg.from?.is_bot) return this.onPlayingText(msg);
  }

  async onCommand(msg, anonAdmin) {
    const first = msg.text.trim().split(/\s+/)[0];
    const [cmdRaw, target] = first.split("@");
    if (target) {
      const me = await this.getBotUsername();
      if (me && target.toLowerCase() !== me.toLowerCase()) return; // команда другому боту
    }
    switch (cmdRaw.toLowerCase()) {
      case "/game":
      case "/start":
      case "/croc":
      case "/crocodile":
        return this.cmdGame(msg);
      case "/top":
        return this.cmdTop(msg);
      case "/me":
      case "/stats":
        return this.cmdMe(msg);
      case "/stop":
        return this.cmdStop(msg, anonAdmin);
      case "/rules":
      case "/help":
        return this.send(msg.chat.id, RULES_TEXT);
    }
  }

  async cmdGame(msg) {
    const r = this.round;
    const chatId = msg.chat.id;
    if (r.status === "waiting") {
      return this.send(chatId, "☝️ Раунд уже ждёт ведущего — нажми «🙋 Я буду ведущим».", {
        reply_parameters: { message_id: r.msgId, allow_sending_without_reply: true },
      });
    }
    if (r.status === "playing") {
      return this.send(chatId, `🎤 Сейчас объясняет <b>${esc(r.leaderName)}</b> — угадывайте!`);
    }
    if (r.status === "ended") return; // прямо сейчас подводятся итоги
    return this.openRound(chatId, "");
  }

  // Новый раунд: сообщение с кнопкой «Я буду ведущим». header — итоги прошлого раунда.
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
    await this.tg("editMessageText", {
      chat_id: r.chatId,
      message_id: r.msgId,
      parse_mode: "HTML",
      text:
        (r.header ? r.header + "\n\n" : "") +
        `🎤 Ведущий: <b>${esc(r.leaderName)}</b>\n` +
        "Объясняет слово — пишите догадки прямо в чат!\n" +
        `⏱ На раунд ${ROUND_MS / 60000} мин.`,
      reply_markup: kb([
        [["👁 Посмотреть слово", "word"]],
        [["🔄 Другое слово", "skip"], ["🏳 Сдаюсь", "giveup"]],
      ]),
    });
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

    let gp = 3;
    if (sec <= 30) gp += 2;
    else if (sec <= 60) gp += 1;

    let lp = 2;
    if (r.leaderMsgs <= 3) lp += 2;
    else if (r.leaderMsgs <= 6) lp += 1;
    if (sec <= 60) lp += 1;

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
      `🎤 ${esc(r.leaderName)}: +${lp} ${plural(lp, "очко", "очка", "очков")} (сообщений: ${r.leaderMsgs})`;
    return this.openRound(r.chatId, header, r.msgId);
  }

  // ---------- кнопки ----------
  async onCallback(cq) {
    const r = this.round;
    const msgId = cq.message?.message_id;
    if (!this.isActive() || !r.msgId || msgId !== r.msgId) {
      await this.answer(cq, "⌛ Этот раунд уже закончился. Новая игра — /game");
      if (cq.message && msgId !== r.msgId) await this.removeButtons(cq.message.chat.id, msgId);
      return;
    }

    const isLeader = r.status === "playing" && cq.from.id === r.leaderId;

    switch (cq.data) {
      case "lead": {
        if (r.status !== "waiting") return this.answer(cq, "Ведущий уже выбран 🙂");
        const word = this.pickWord();
        Object.assign(r, {
          status: "playing",
          leaderId: cq.from.id,
          leaderName: displayName(cq.from),
          word,
          skips: 0,
          leaderMsgs: 0,
          startedAt: Date.now(),
          deadline: Date.now() + ROUND_MS,
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
        r.word = this.pickWord();
        r.skips++;
        r.leaderMsgs = 0;
        r.startedAt = Date.now();
        r.deadline = Date.now() + ROUND_MS;
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
    const chatId = msg.chat.id;
    const all = await this.ctx.storage.list({ prefix: "u:" });
    const top = [...all.values()]
      .filter((s) => s.points !== 0 || s.guessed || s.explained)
      .sort((a, b) => b.points - a.points)
      .slice(0, 10);
    if (!top.length) return this.send(chatId, "🏆 Рейтинг пока пуст. Сыграйте — /game");

    const medals = ["🥇", "🥈", "🥉"];
    const lines = top.map(
      (s, i) => `${medals[i] || i + 1 + "."} <b>${esc(s.name)}</b> — ${s.points} (🎯 ${s.guessed} · 🎤 ${s.explained})`
    );
    return this.send(chatId, "🏆 <b>Топ игроков группы</b>\n\n" + lines.join("\n") + "\n\n🎯 угадал · 🎤 объяснил");
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
    if (!this.isActive()) return this.send(chatId, "Сейчас нет активной игры. Начать — /game");

    const isLeader = this.round.status === "playing" && msg.from?.id === this.round.leaderId;
    const allowed = isLeader || anonAdmin || (await this.isAdmin(chatId, msg.from.id));
    if (!allowed) return this.send(chatId, "🛑 Остановить игру может ведущий или админ группы.");

    const cur = this.round;
    if (!this.isActive()) return; // пока проверяли права, раунд уже закончился
    const word = cur.status === "playing" ? cur.word : null;
    this.round = { status: "idle" };
    await this.save();
    await this.ctx.storage.deleteAlarm();
    await this.removeButtons(chatId, cur.msgId);
    return this.send(chatId, "🛑 Игра остановлена." + (word ? `\nСлово было: <b>${upper(word)}</b>` : "") + "\nНовая игра — /game");
  }

  // ---------- таймер ----------
  async alarm() {
    const r = this.round;
    if (!this.isActive()) return;
    if (Date.now() < r.deadline - 1000) {
      await this.ctx.storage.setAlarm(r.deadline);
      return;
    }

    if (r.status === "waiting") {
      this.round = { status: "idle" };
      await this.save();
      if (r.msgId) {
        await this.tg("editMessageText", {
          chat_id: r.chatId,
          message_id: r.msgId,
          parse_mode: "HTML",
          text: (r.header ? r.header + "\n\n" : "") + "😴 Никто не вызвался вести. Сыграть ещё — /game",
          reply_markup: { inline_keyboard: [] },
        });
      }
      return;
    }

    r.status = "ended";
    return this.openRound(r.chatId, `⏰ Время вышло — никто не угадал.\nСлово было: <b>${upper(r.word)}</b>`, r.msgId);
  }
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
