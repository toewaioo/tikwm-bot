/**
 * Standalone entry point: `bun run dev` (tsx) and `bun run build && bun
 * start` (node dist/src/server.js) both end up here.
 *
 * Everything HTTP-related lives in src/app.ts so other runtimes can mount
 * the same app without binding a port — see api/index.ts for the Vercel
 * handler, which adapts `app.fetch` to a plain (req, res) listener.
 */
import { serve } from '@hono/node-server';
import { app } from './app.js';
import { Config } from './config.js';

/**
 * Node 18's fetch (bundled undici 5.x) throws ERR_INVALID_STATE out of
 * its own internal tick when a response body is cancelled — closing a
 * browser tab halfway through a proxied download, or an aborted media
 * upload, would otherwise take the whole process down. The transfer is
 * already lost at that point; the bot isn't. Node 20+ doesn't throw
 * here, so the guard is a no-op there. Every other uncaught exception
 * still takes the default path (stack trace, non-zero exit).
 */
process.on('uncaughtException', (error) => {
  if ((error as NodeJS.ErrnoException).code !== 'ERR_INVALID_STATE') {
    throw error;
  }
});

const port = Config.get<number>('port', 3000);
const host = Config.get<string>('host', '0.0.0.0');

serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`yt-dl listening on http://${info.address}:${info.port}`);
  console.log(`webhook: POST /webhook  ·  web UI: GET /  ·  ajax: POST /ajax`);
});
