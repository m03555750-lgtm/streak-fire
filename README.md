# STREAK 🔥

A free-to-start Telegram streak bot prototype. Two people share a Telegram group with the bot; each person sends at least one message per calendar day to keep their shared streak.

## Current scope

- Telegram group-based streaks (the bot cannot read ordinary private chats).
- The first person sends `/pair`; the second person sends `/pair` to complete pairing.
- Every human message from either paired member counts as that person's activity for the day.
- When both paired users have been active on the same day, the shared streak is updated and announced in the group.
- `/status` shows the current and best streak.

Instagram is not included in this first version. Instagram's official APIs do not provide general access to ordinary users' private DMs, and this project will not try to bypass that.

## Requirements

- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- A Cloudflare account.
- Cloudflare Workers and D1 (free tiers have limits and can change).

## Important Telegram setup

1. Create a bot with @BotFather and copy its token. Keep the token secret.
2. In @BotFather, open Bot Settings → Group Privacy → Turn off. This allows the bot to receive normal group messages.
3. Add the bot to a Telegram group with the two people who want a shared streak.
4. Create a D1 database and put its ID into `wrangler.toml`.
5. Set the secret: `npx wrangler secret put TELEGRAM_BOT_TOKEN`.
6. Deploy: `npx wrangler deploy`.
7. Set the Telegram webhook to the deployed Worker URL:
   `https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=<YOUR_WORKER_URL>/telegram`

## Database

Run:

```sh
npx wrangler d1 execute streak-db --remote --file=./schema.sql
```

## Commands

- `/start` — explain how to set up the shared streak.
- `/pair` — first person starts pairing; second person runs it to join.
- `/status` — show the shared streak.

## Notes

- This is an early MVP, not yet a production-hardened service.
- Calendar days are currently calculated in UTC. Pair-specific timezone settings will come later.
- The bot counts messages in the shared group, not private chats.
- Do not commit bot tokens, credentials, or personal data.
