import { BotController, type TelegramUpdate } from '../controllers/bot.js';

/**
 * Entry point for Telegram's webhook POST. Decodes the update and
 * hands it to BotController. Returns the HTTP status the server should
 * answer with (Telegram expects a fast 200 regardless of what the
 * update did).
 */
export async function handleWebhook(rawBody: string): Promise<number> {
  let update: unknown;
  try {
    update = JSON.parse(rawBody);
  } catch {
    update = null;
  }

  if (typeof update !== 'object' || update === null || Array.isArray(update)) {
    // Usually scanners hitting the webhook URL.
    return 400;
  }

  try {
    await new BotController().processUpdate(update as TelegramUpdate);
  } catch {
    // One bad update must not stall Telegram's delivery of the next.
  }

  return 200;
}
