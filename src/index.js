const DAY_MS = 24 * 60 * 60 * 1000;
const WORKER_URL = "https://streak-fire.m03555750.workers.dev";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("STREAK bot is running 🔥");
    }

    if (url.pathname === "/setup" && request.method === "GET") {
      return new Response(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>STREAK setup</title><body style="font:16px Arial;max-width:480px;margin:40px auto;padding:16px"><h2>Подключение STREAK 🔥</h2><p>Введи значение TELEGRAM_WEBHOOK_SECRET, которое ты сохранил в Cloudflare.</p><form method="post" action="/setup"><input name="secret" type="password" required autocomplete="off" placeholder="Webhook secret" style="box-sizing:border-box;width:100%;padding:12px;margin:12px 0"><button style="padding:12px 18px">Подключить Telegram</button></form></body></html>`, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
      });
    }

    if (url.pathname === "/setup" && request.method === "POST") {
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("В Cloudflare не настроены обязательные Secrets.", { status: 500 });
      }
      const form = await request.formData();
      if (form.get("secret") !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("Неверный секрет. Проверь значение в Cloudflare.", { status: 403 });
      }
      const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: WORKER_URL + "/telegram",
          secret_token: env.TELEGRAM_WEBHOOK_SECRET,
          allowed_updates: ["message"]
        })
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        return new Response("Telegram не принял webhook: " + (result.description || response.status), { status: 502 });
      }
      return new Response("Готово! Telegram подключён к STREAK 🔥 Можно закрыть эту страницу и открыть бота в Telegram.", {
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
      });
    }

    if (request.method === "GET" && url.pathname === "/story") {
      if (!env.DB || !env.TELEGRAM_WEBHOOK_SECRET) return new Response("Story unavailable", { status: 503 });
      const chatId = url.searchParams.get("chat") || "";
      const expires = Number(url.searchParams.get("exp") || 0);
      const signature = url.searchParams.get("sig") || "";
      if (!chatId || !Number.isInteger(expires) || expires < Math.floor(Date.now() / 1000) || expires > Math.floor(Date.now() / 1000) + 86400 ||
          !(await verifyStorySignature(env.TELEGRAM_WEBHOOK_SECRET, chatId, expires, signature))) {
        return new Response("Ссылка недействительна или устарела. Создай новую командой /story.", { status: 403 });
      }
      const pair = await env.DB.prepare("SELECT * FROM pairs WHERE chat_id = ?").bind(chatId).first();
      if (!pair) return new Response("Огонёк не найден.", { status: 404 });
      return new Response(renderStoryPage(pair), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }

    if (request.method === "POST" && url.pathname === "/telegram") {
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET || !env.DB) {
        return new Response("Missing configuration", { status: 500 });
      }
      const suppliedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (suppliedSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      let update;
      try {
        update = await request.json();
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }
      try {
        if (update.message) await handleMessage(update.message, env);
      } catch (error) {
        console.error("Update handling failed:", error);
      }
      return new Response("OK");
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(sendDailyReminders(env));
  },
};

async function sendDailyReminders(env) {
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN) {
    console.error("Reminder skipped: missing DB or TELEGRAM_BOT_TOKEN");
    return;
  }

  const day = new Date().toISOString().slice(0, 10);
  const result = await env.DB.prepare(
    `SELECT p.id, p.chat_id, p.member_a_id, p.member_a_name, p.member_b_id, p.member_b_name,
            COUNT(DISTINCT a.user_id) AS active_count
       FROM pairs p
       LEFT JOIN daily_activity a ON a.pair_id = p.id AND a.activity_day = ?
      WHERE p.last_completed_day IS NULL OR p.last_completed_day != ?
      GROUP BY p.id`
  ).bind(day, day).all();

  for (const pair of result.results || []) {
    if (Number(pair.active_count) !== 1) continue;

    const active = await env.DB.prepare(
      "SELECT user_id FROM daily_activity WHERE pair_id = ? AND activity_day = ? LIMIT 1"
    ).bind(pair.id, day).first();
    if (!active) continue;

    const inactiveName = active.user_id === pair.member_a_id
      ? pair.member_b_name
      : pair.member_a_name;

    const claimed = await env.DB.prepare(
      "UPDATE pairs SET reminder_sent_day = ? WHERE id = ? AND (reminder_sent_day IS NULL OR reminder_sent_day != ?)"
    ).bind(day, pair.id, day).run();

    if (claimed.meta?.changes) {
      await sendMessage(env, pair.chat_id,
        `⏰ Напоминание об огоньке! 🔥 Сегодня уже есть активность от одного участника. ${inactiveName}, отправь сообщение в группу до конца дня, чтобы сохранить вашу серию!`
      );
    }
  }
}

async function handleMessage(message, env) {
  const chat = message.chat;
  const sender = message.from;
  const text = (message.text || "").trim();
  if (!chat || !sender || sender.is_bot || !["group", "supergroup"].includes(chat.type)) return;

  if (text.startsWith("/start")) {
    await sendMessage(env, chat.id,
      "Привет! 🔥 Чтобы завести общий огонёк, добавьте меня в группу с двумя участниками, отключите Group Privacy через @BotFather, затем каждый из вас по очереди отправьте /pair."
    );
    return;
  }
  if (text.startsWith("/pair")) {
    await pairMember(message, env);
    return;
  }
  if (text.startsWith("/story")) {
    await sendStoryLink(chat.id, env);
    return;
  }
  if (text.startsWith("/status")) {
    await sendStatus(chat.id, env);
    return;
  }

  const pair = await env.DB.prepare("SELECT * FROM pairs WHERE chat_id = ?")
    .bind(String(chat.id)).first();
  if (!pair) return;
  const userId = String(sender.id);
  if (userId !== pair.member_a_id && userId !== pair.member_b_id) return;

  const day = new Date().toISOString().slice(0, 10);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO daily_activity (pair_id, user_id, activity_day) VALUES (?, ?, ?)"
  ).bind(pair.id, userId, day).run();

  const rows = await env.DB.prepare(
    "SELECT user_id FROM daily_activity WHERE pair_id = ? AND activity_day = ?"
  ).bind(pair.id, day).all();
  const activeIds = new Set((rows.results || []).map(row => row.user_id));
  if (activeIds.has(pair.member_a_id) && activeIds.has(pair.member_b_id)) {
    await completeDay(pair, day, env);
  }
}

async function pairMember(message, env) {
  const chat = message.chat;
  const sender = message.from;
  const chatId = String(chat.id);
  const userId = String(sender.id);
  const displayName = [sender.first_name, sender.last_name].filter(Boolean).join(" ") || sender.username || "Участник";
  const existing = await env.DB.prepare("SELECT * FROM pairs WHERE chat_id = ?").bind(chatId).first();
  if (existing) {
    await sendMessage(env, chat.id, "В этой группе огонёк уже настроен 🔥 Напишите /status.");
    return;
  }
  const pending = await env.DB.prepare("SELECT * FROM pending_pairs WHERE chat_id = ?").bind(chatId).first();
  if (!pending) {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO pending_pairs (chat_id, chat_title, first_user_id, first_user_name) VALUES (?, ?, ?, ?)"
    ).bind(chatId, chat.title || "Telegram group", userId, displayName).run();
    await sendMessage(env, chat.id, `${displayName} начал создание огонька! 🔥 Теперь второму человеку нужно отправить /pair в этой группе.`);
    return;
  }
  if (pending.first_user_id === userId) {
    await sendMessage(env, chat.id, "Теперь пусть второй участник отправит /pair 🔥");
    return;
  }
  await env.DB.prepare(
    "INSERT INTO pairs (chat_id, chat_title, member_a_id, member_a_name, member_b_id, member_b_name) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(chatId, pending.chat_title, pending.first_user_id, pending.first_user_name, userId, displayName).run();
  await env.DB.prepare("DELETE FROM pending_pairs WHERE chat_id = ?").bind(chatId).run();
  await updateGroupTitle(env, chat.id, pending.chat_title, 0);
  await sendMessage(env, chat.id,
    `╔══════════════════╗\n       🔥 STREAK ЗАПУЩЕН!\n╚══════════════════╝\n${pending.first_user_name} ❤️ ${displayName}\n\nКаждый день пишите хотя бы одно сообщение в этой группе. Команда /status покажет ваш огонёк.`
  );
}

async function sendStatus(chatId, env) {
  const pair = await env.DB.prepare("SELECT * FROM pairs WHERE chat_id = ?").bind(String(chatId)).first();
  if (!pair) {
    await sendMessage(env, chatId, "Огонёк ещё не настроен. Оба участника должны по очереди отправить /pair 🔥");
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const activity = await env.DB.prepare(
    "SELECT user_id FROM daily_activity WHERE pair_id = ? AND activity_day = ?"
  ).bind(pair.id, today).all();
  const activeIds = new Set((activity.results || []).map(row => row.user_id));
  const aDone = activeIds.has(pair.member_a_id);
  const bDone = activeIds.has(pair.member_b_id);
  const progress = (aDone ? "🟩" : "⬜") + (bDone ? "🟩" : "⬜");
  const state = aDone && bDone
    ? "Оба уже отметились — огонёк сохранён на сегодня! 🔥"
    : "Сегодняшняя активность: " + progress + "\n" +
      (aDone ? "✅" : "▫️") + " " + pair.member_a_name + "\n" +
      (bDone ? "✅" : "▫️") + " " + pair.member_b_name;

  const titleUpdated = await updateGroupTitle(env, chatId, pair.chat_title, pair.current_streak);
  await sendMessage(env, chatId,
    `╔══════════════════╗\n          🔥 ВАШ ОГОНЁК\n╚══════════════════╝\n\n🔥 ${pair.current_streak} ${pluralDays(pair.current_streak)} подряд\n🏆 Рекорд: ${pair.best_streak} ${pluralDays(pair.best_streak)}\n\n${state}\n\n📅 Последний общий день: ${pair.last_completed_day || "пока нет"}` +
    (titleUpdated ? "\\n\\n✅ Название группы обновлено." : "\\n\\n⚠️ Не удалось изменить название. Проверьте, что бот — администратор и ему разрешено менять информацию о группе.")
  );
}

async function completeDay(pair, day, env) {
  if (pair.last_completed_day === day) return;
  const yesterday = new Date(Date.parse(day + "T00:00:00Z") - DAY_MS).toISOString().slice(0, 10);
  const nextStreak = pair.last_completed_day === yesterday ? pair.current_streak + 1 : 1;
  const best = Math.max(pair.best_streak, nextStreak);
  const result = await env.DB.prepare(
    "UPDATE pairs SET current_streak = ?, best_streak = ?, last_completed_day = ? WHERE id = ? AND (last_completed_day IS NULL OR last_completed_day != ?)"
  ).bind(nextStreak, best, day, pair.id, day).run();
  if (result.meta?.changes) {
    await updateGroupTitle(env, pair.chat_id, pair.chat_title, nextStreak);
    await sendMessage(env, pair.chat_id,
      `🔥 ОГОНЁК СОХРАНЁН! 🔥\n\n${"🔥".repeat(Math.min(nextStreak, 10))}\n\nУ вас уже ${nextStreak} ${pluralDays(nextStreak)} вместе!\n🏆 Лучший результат: ${best} ${pluralDays(best)}`
    );
  }
}

function pluralDays(number) {
  const n = number % 100;
  if (n >= 11 && n <= 14) return "дней";
  switch (number % 10) {
    case 1: return "день";
    case 2:
    case 3:
    case 4: return "дня";
    default: return "дней";
  }
}

async function sendMessage(env, chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!response.ok) console.error("Telegram sendMessage failed:", await response.text());
}


async function updateGroupTitle(env, chatId, originalTitle, streak) {
  const suffix = ` 🔥 ${streak}`;
  const base = (originalTitle || "Наша группа").slice(0, Math.max(1, 128 - suffix.length));
  const title = base + suffix;
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setChatTitle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, title }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    console.error("Telegram setChatTitle failed:", result.description || response.status);
    return false;
  }
  return true;
}


async function signStoryPayload(secret, chatId, expires) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${chatId}:${expires}`)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
async function verifyStorySignature(secret, chatId, expires, signature) {
  const expected = await signStoryPayload(secret, chatId, expires);
  if (signature.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
async function sendStoryLink(chatId, env) {
  const pair = await env.DB.prepare("SELECT * FROM pairs WHERE chat_id = ?").bind(String(chatId)).first();
  if (!pair) { await sendMessage(env, chatId, "Сначала создайте общий огонёк командой /pair 🔥"); return; }
  const expires = Math.floor(Date.now() / 1000) + 86400;
  const signature = await signStoryPayload(env.TELEGRAM_WEBHOOK_SECRET, String(chatId), expires);
  const link = `${WORKER_URL}/story?chat=${encodeURIComponent(chatId)}&exp=${expires}&sig=${signature}`;
  await sendMessage(env, chatId, `🔥 Ваша карточка огонька готова!\\n\\nОткройте ссылку на телефоне, сделайте скриншот карточки и добавьте его в историю Telegram:\\n${link}\\n\\nСсылка действует 24 часа.`);
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[char]);
}
function renderStoryPage(pair) {
  const a=escapeHtml(pair.member_a_name), b=escapeHtml(pair.member_b_name), group=escapeHtml(pair.chat_title || "Наша группа");
  const days=Number(pair.current_streak)||0, best=Number(pair.best_streak)||0;
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><title>STREAK 🔥</title><style>
  *{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:Arial,sans-serif;background:#100d1c;color:white}body{display:flex;justify-content:center;align-items:center;padding:14px}.card{position:relative;width:min(100%,430px);aspect-ratio:9/16;overflow:hidden;border-radius:28px;padding:12% 8%;display:flex;flex-direction:column;align-items:center;justify-content:space-between;text-align:center;background:radial-gradient(ellipse at 50% 42%,#71341f 0,#311b35 42%,#100d1c 78%);border:1px solid #ffffff24}.glow{position:absolute;width:75%;aspect-ratio:1;border-radius:50%;top:27%;background:#ff6a24;filter:blur(80px);opacity:.35}.top,.middle,.bottom{position:relative;z-index:1}.brand{font-size:14px;letter-spacing:5px;font-weight:bold;color:#ffd2a1}.group{font-size:15px;color:#f4d9cb;margin-top:14px}.fire{font-size:clamp(100px,27vw,150px);line-height:1.2;filter:drop-shadow(0 0 22px #ff742d)}.days{font-size:clamp(58px,16vw,82px);font-weight:900;line-height:1;color:#fff}.label{font-size:19px;color:#ffd8c0;margin-top:10px}.names{font-size:22px;font-weight:bold;line-height:1.5;margin-top:28px}.heart{color:#ff8064}.best{margin-top:28px;padding:12px 20px;border:1px solid #ffffff35;border-radius:30px;background:#ffffff12;font-size:16px}.bottom{font-size:13px;letter-spacing:3px;color:#f5c5a9}.hint{max-width:430px;text-align:center;color:#d9cbd5;font-size:13px;padding:12px 8px 0}</style><body><div><main class="card"><div class="glow"></div><header class="top"><div class="brand">STREAK</div><div class="group">${group}</div></header><section class="middle"><div class="fire">🔥</div><div class="days">${days}</div><div class="label">дней вместе</div><div class="names">${a}<br><span class="heart">❤️</span><br>${b}</div><div class="best">🏆 Рекорд: ${best} дн.</div></section><footer class="bottom">НАШ ОГОНЁК НЕ ГАСНЕТ</footer></main><div class="hint">Сделай скриншот карточки и добавь его в историю Telegram 🔥</div></div></body></html>`;
}
