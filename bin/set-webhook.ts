/**
 * One-off CLI helper: run `bun run set-webhook` on the server (or
 * locally with the same .env) to register the webhook URL with
 * Telegram.
 *
 * The same thing over HTTP: once the site is deployed, open
 * https://<your-domain>/set-webhook — it registers that domain's own
 * /webhook route.
 *
 * Equivalent curl command, if you prefer:
 *   curl -F "url=https://yourdomain.com/webhook" \
 *        https://api.telegram.org/bot<TOKEN>/setWebhook
 */
import { Config } from '../src/config.js';
import { TelegramService } from '../src/services/telegram.js';

const url = Config.get<string>('webhook_url', '');
if (!url) {
  console.error('WEBHOOK_URL is not set — fill in .env first.');
  process.exit(1);
}

const result = await new TelegramService().setWebhook(url);

console.log(JSON.stringify(result, null, 2));
if (result?.ok !== true) process.exit(1);
