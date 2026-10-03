import crypto from 'node:crypto';
import { Config } from '../config.js';
import { cacheGet, cacheSet } from '../core/cache.js';
import { getRequestHost } from '../core/host.js';
import { mbSubstr } from '../helpers/text.js';
import { Validator } from '../helpers/validator.js';
import { MediaService } from '../services/media.js';
import { TelegramService, type ReplyMarkup } from '../services/telegram.js';
import { TikTokUserService } from '../services/tiktokUser.js';
import { TikwmService } from '../services/tikwm.js';
import { Tool77Service } from '../services/tool77.js';
import { YoutubeSearchService, type SearchResult } from '../services/youtubeSearch.js';

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
}

export interface CallbackQuery {
  id: string;
  from?: TelegramUser;
  data?: string;
  message?: { message_id?: number; chat?: { id?: number } };
}

export interface TelegramUpdate {
  callback_query?: CallbackQuery;
  message?: TelegramMessage;
}

/**
 * Routes every incoming Telegram update to the right handler. This is
 * what the /webhook route calls into — there is no state to persist
 * first, so an update goes straight to its handler.
 *
 * Platform routing: Facebook and YouTube extract via Tool77Service —
 * one client for tool77.com's "download/all" endpoint (see that
 * class's docblock for how the response's obfuscated url tokens get
 * resolved into real, fetchable links, and the caveats that come with
 * an unofficial API). TikTok deliberately does NOT touch tool77: links
 * and /story post picks alike go through TikwmService, the same
 * client the web downloader uses. TikTokUserService is separate again —
 * it only handles browsing a TikTok user's video list; picking a video
 * from that list hands off to handleTikTokUrl() like any other TikTok
 * link.
 */
export class BotController {
  private readonly telegram = new TelegramService();
  private readonly tool77 = new Tool77Service();
  private readonly tikwm = new TikwmService();
  private readonly tiktokUser = new TikTokUserService();
  private readonly ytSearch = new YoutubeSearchService();
  private readonly media = new MediaService();

  async processUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }

    if (!update.message) {
      return;
    }

    const message = update.message;
    const from = message.from;
    const chatId = message.chat?.id;
    const text = (message.text ?? '').trim();

    if (!from || !chatId) {
      return;
    }

    if (text === '') {
      return;
    }

    if (text.startsWith('/')) {
      await this.handleCommand(text, Number(chatId), from);
      return;
    }

    const url = Validator.extractUrl(text) ?? text;

    if (Validator.isTikTokUrl(text)) {
      await this.handleTikTokUrl(Number(chatId), url);
      return;
    }

    if (Validator.isFacebookUrl(text)) {
      await this.handleFacebookUrl(Number(chatId), url);
      return;
    }

    if (Validator.isYouTubeUrl(text)) {
      await this.handleYouTubeUrl(Number(chatId), url);
      return;
    }

    await this.handleTextSearch(Number(chatId), text);
  }

  private async handleCommand(text: string, chatId: number, from: TelegramUser): Promise<void> {
    const command = text.split(' ')[0].split('@')[0].toLowerCase();

    switch (command) {
      case '/start':
        await this.telegram.sendMessage(
          chatId,
          '👋 *Welcome!*\n\n' +
            'I download videos from TikTok, Facebook & YouTube — free, no watermark.\n\n' +
            '*Just send me:*\n' +
            '• TikTok link → video/photos + 🎵 audio\n' +
            '• Facebook link → video + 🎵 audio\n' +
            '• YouTube link → pick 1080p–360p or 🎵 audio\n' +
            '• Any word → YouTube search results\n' +
            '• /story @handle → browse their videos\n\n' +
            'Type /help for everything I can do.',
        );
        return;

      case '/help':
        await this.telegram.sendMessage(
          chatId,
          '*How to use this bot*\n\n' +
            '*Downloads* — just paste a link:\n' +
            '• TikTok → video (no watermark), photo albums, 🎵 audio button\n' +
            '• Facebook → best video + 🎵 audio button\n' +
            '• YouTube → buttons: 1080p/720p/480p/360p 🔇 + 🎵 m4a/opus\n' +
            '• Any text → YouTube search, tap a result\n\n' +
            '*TikTok profiles*\n' +
            '• /story @handle → recent videos, tap to download\n\n' +
            '*Commands*\n' +
            '/start · /help · /about · /story\n\n' +
            '💡 Download buttons last about an hour — resend the link if one expires.',
        );
        return;

      case '/about':
        await this.telegram.sendMessage(
          chatId,
          '🤖 *TikTok, Facebook & YouTube Downloader Bot*\nBuilt with Node.js, TypeScript & Hono.',
        );
        return;

      // /username kept as an unadvertised alias for older chat history.
      case '/story':
      case '/username': {
        const firstToken = text.split(/\s+/)[0];
        const arg = text.slice(firstToken.length).trim();
        if (arg === '') {
          await this.telegram.sendMessage(chatId, 'Usage: /story @tiktokhandle');
          return;
        }
        await this.handleUsernameLookup(chatId, arg);
        return;
      }

      default:
        await this.telegram.sendMessage(chatId, 'Unknown command. Try /help.');
    }
  }

  /**
   * TikTok: video primary (or a photo carousel), with a 🎵 Download
   * Audio button. Extraction runs through TikwmService — tool77 is
   * reserved for Facebook and YouTube only.
   */
  async handleTikTokUrl(chatId: number, rawUrl: string): Promise<void> {
    let url = rawUrl;
    if (Validator.isShortLink(url)) {
      url = await Validator.resolveRedirect(url);
    }

    await this.telegram.sendChatAction(chatId, 'typing');

    const data = await this.tikwm.fetch(url);
    if (!data) {
      await this.telegram.sendMessage(
        chatId,
        "❌ Couldn't fetch that TikTok link. It may be private, deleted, or invalid.",
      );
      return;
    }

    const title = Validator.markdownEscape(String(data.title ?? ''));
    const tiktokId = String(data.id ?? md5(url));
    const audioUrl = this.tikwm.getAudioUrl(data);
    await this.tikwm.cacheAudioUrl(tiktokId, audioUrl, url);

    const keyboard: ReplyMarkup | null = audioUrl
      ? { inline_keyboard: [[{ text: '🎵 Download Audio', callback_data: 'tkaud_' + tiktokId }]] }
      : null;

    const images = this.tikwm.getImages(data);
    if (images.length > 0) {
      // Slides backed by a TikTok live photo carry an MP4 in
      // live_images (index-paired with images) — send those as videos
      // so users get the animated version, not a still.
      const liveImages = this.tikwm.getLiveImages(data);
      await this.telegram.sendChatAction(chatId, liveImages.length > 0 ? 'upload_video' : 'upload_photo');
      await this.telegram.sendMediaGroup(chatId, this.buildCarouselMedia(images, liveImages));
      await this.telegram.sendMessage(chatId, title !== '' ? title : 'Here you go 👆', keyboard);
      return;
    }

    const videoUrl = this.tikwm.getVideoUrl(data);
    if (!videoUrl) {
      await this.telegram.sendMessage(chatId, '❌ No downloadable video found for that link.');
      return;
    }

    await this.deliverVideo(chatId, videoUrl, title, keyboard);
  }

  /**
   * Pairs carousel slides with their live-photo videos: slide i with a
   * live_images entry goes out as a video media item, the rest as
   * plain photo URLs (sendMediaGroup's default).
   */
  private buildCarouselMedia(
    images: string[],
    liveImages: string[],
  ): Array<string | { type: string; media: string }> {
    const items: Array<string | { type: string; media: string }> = [];
    images.forEach((url, index) => {
      if (liveImages[index]) {
        items.push({ type: 'video', media: liveImages[index] });
      } else {
        items.push(url);
      }
    });
    return items;
  }

  /**
   * Facebook: fetch via tool77, deliver the best combined-audio+video
   * format, with a 🎵 Download Audio button when a separate audio track
   * exists.
   */
  async handleFacebookUrl(chatId: number, rawUrl: string): Promise<void> {
    let url = rawUrl;
    if (Validator.isShortLink(url)) {
      url = await Validator.resolveRedirect(url);
    }
    // tool77 only accepts the plain https://www.facebook.com/<type>/<id>
    // shape — strip tracking queries etc. before it sees the link.
    url = Validator.normalizeFacebookUrl(url);

    await this.telegram.sendChatAction(chatId, 'typing');

    const data = await this.tool77.fetch(url);
    if (!data) {
      await this.telegram.sendMessage(
        chatId,
        "❌ Couldn't fetch that Facebook link. It may be private or invalid.",
      );
      return;
    }

    const title = Validator.markdownEscape(String(data.title ?? ''));
    const id = this.tool77.cacheId(url);

    const audio = this.tool77.getBestAudio(data);
    const keyboard: ReplyMarkup | null = audio?.url
      ? { inline_keyboard: [[{ text: '🎵 Download Audio', callback_data: 'dlaud_' + id }]] }
      : null;

    const video = this.tool77.getBestNormal(data);
    const videoUrl = video ? this.tool77.resolveUrl(video) : null;
    if (!videoUrl) {
      await this.telegram.sendMessage(chatId, '❌ No downloadable video found for that link.');
      return;
    }

    await this.deliverVideo(chatId, videoUrl, title, keyboard);
  }

  /**
   * Sends a video by URL, or downloads-then-uploads for anything over
   * 20MB (Telegram's fetch-by-URL ceiling in practice).
   */
  private async deliverVideo(
    chatId: number,
    videoUrl: string,
    caption: string,
    keyboard: ReplyMarkup | null,
  ): Promise<void> {
    await this.telegram.sendChatAction(chatId, 'upload_video');
    const size = await Validator.getRemoteFileSize(videoUrl);

    if (size !== null && size > Config.get<number>('max_url_upload_bytes', 20 * 1024 * 1024)) {
      const localPath = await this.media.downloadToTemp(videoUrl);
      if (!localPath) {
        await this.telegram.sendMessage(chatId, '❌ Failed to process this video. Please try again.');
        return;
      }
      await this.telegram.sendVideoLocal(chatId, localPath, caption, keyboard);
      await this.media.cleanup(localPath);
    } else {
      await this.telegram.sendVideo(chatId, videoUrl, caption, keyboard);
    }
  }

  /**
   * YouTube: no media file is sent to the chat. The bot replies with
   * the video's cover image as a photo message carrying the download
   * menu (fallback: plain text message if there's no thumbnail):
   * inline buttons are short download links on this server (/dl
   * re-resolves the real CDN URL when tapped, so the user's browser
   * does the actual download): video buttons for each rung of
   * Tool77Service.MENU_HEIGHTS the video actually offers (1080p →
   * 360p), plus one audio button per format tool77 returned
   * (typically m4a + opus).
   */
  async handleYouTubeUrl(chatId: number, rawUrl: string): Promise<void> {
    let url = rawUrl;
    if (Validator.isShortLink(url)) {
      url = await Validator.resolveRedirect(url);
    }

    await this.telegram.sendChatAction(chatId, 'typing');

    const videoId = Validator.extractYouTubeId(url);
    const cleanUrl = videoId ? 'https://www.youtube.com/watch?v=' + videoId : url;

    const data = await this.tool77.fetch(cleanUrl);
    if (!data) {
      await this.telegram.sendMessage(chatId, "❌ Couldn't fetch that YouTube link. Please try again later.");
      return;
    }

    const keyboard = await this.buildYoutubeKeyboard(
      data,
      this.downloaderBaseUrl(),
      this.tool77.cacheId(cleanUrl),
    );
    if (!keyboard) {
      await this.telegram.sendMessage(chatId, '❌ No downloadable formats found for that video.');
      return;
    }

    const title = String(data.title ?? '').trim();
    const caption =
      (title !== '' ? `🎬 *${Validator.markdownEscape(mbSubstr(title, 0, 256))}*\n` : '') +
      'Pick a quality to download:';

    // Cover + buttons in one photo message; falls back to a plain text
    // menu when the video has no usable thumbnail or Telegram rejects
    // the URL (sendPhoto retries parse errors internally, anything else
    // lands here).
    let sent = false;
    const thumbnail = String(data.thumbnail ?? '');
    if (/^https?:\/\//i.test(thumbnail)) {
      await this.telegram.sendChatAction(chatId, 'upload_photo');
      const result = await this.telegram.sendPhoto(chatId, thumbnail, caption, keyboard);
      sent = result?.ok === true;
    }

    if (!sent) {
      await this.telegram.sendMessage(chatId, caption, keyboard);
    }
  }

  /**
   * Public base URL of the web downloader — same host as the incoming
   * webhook request, falling back to the configured webhook URL's host
   * (CLI context has no Host header).
   */
  private downloaderBaseUrl(): string {
    let host = getRequestHost();
    if (!host) {
      const webhookUrl = Config.get<string>('webhook_url', '');
      try {
        host = webhookUrl ? new URL(webhookUrl).host : '';
      } catch {
        host = '';
      }
    }
    return host ? `https://${host}` : '';
  }

  /**
   * Inline-button keyboard over getVideoQualities() + getAudioFormats():
   * two buttons per row (Telegram renders these nicely at that width),
   * videos first then audios. Null when neither produced a single
   * resolvable link. Everything above 360p is a video-only stream, so
   * those buttons get a 🔇 marker.
   *
   * Buttons deliberately do NOT carry the resolved CDN URLs — each
   * googlevideo link is 800–1500 chars and a few of them blow past
   * Telegram's reply-markup size cap ("reply markup is too long"). They
   * carry a short /dl redirect link keyed by the tool77 cache id
   * instead; the server re-resolves the real URL at tap time. That also
   * makes button lifetime == tool77_cache_ttl.
   */
  private async buildYoutubeKeyboard(
    data: Record<string, any>,
    baseUrl: string,
    id: string,
  ): Promise<ReplyMarkup | null> {
    if (baseUrl === '' || id === '') {
      return null;
    }

    const videos = this.tool77.getVideoQualities(data);
    const audios = this.tool77.getAudioFormats(data);
    if (videos.size === 0 && Object.keys(audios).length === 0) {
      return null;
    }

    const rows: Array<Array<{ text: string; url: string }>> = [];
    let row: Array<{ text: string; url: string }> = [];

    for (const [height, video] of videos) {
      row.push({
        text: `🎬 ${height}p${video.hasAudio ? '' : ' 🔇'}`,
        url: `${baseUrl}/dl?id=${encodeURIComponent(id)}&kind=video&h=${Number(height)}`,
      });
      if (row.length === 2) {
        rows.push(row);
        row = [];
      }
    }
    for (const [ext, audio] of Object.entries(audios)) {
      const label = ext.toUpperCase() + (audio.kbps > 0 ? ` · ${audio.kbps}kbps` : '');
      row.push({
        text: `🎵 ${label}`,
        url: `${baseUrl}/dl?id=${encodeURIComponent(id)}&kind=audio&fmt=${encodeURIComponent(ext)}`,
      });
      if (row.length === 2) {
        rows.push(row);
        row = [];
      }
    }
    if (row.length > 0) {
      rows.push(row);
    }

    return { inline_keyboard: rows };
  }

  private async handleTextSearch(chatId: number, query: string): Promise<void> {
    await this.telegram.sendChatAction(chatId, 'typing');
    const results = await this.ytSearch.search(query, 10);

    if (results.items.length === 0) {
      await this.telegram.sendMessage(chatId, '😕 No results found for that search.');
      return;
    }

    await this.telegram.sendMessage(
      chatId,
      `🔍 Results for *${Validator.markdownEscape(query)}*:`,
      { inline_keyboard: await this.buildSearchKeyboard(results, query) },
    );
  }

  private async buildSearchKeyboard(
    results: SearchResult,
    query: string,
  ): Promise<Array<Array<{ text: string; callback_data: string }>>> {
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    for (const item of results.items) {
      if (!item.videoId) {
        continue;
      }
      keyboard.push([
        { text: mbSubstr(item.title, 0, 60), callback_data: 'ytdl_' + item.videoId },
      ]);
    }
    if (results.nextPageToken) {
      keyboard.push([
        {
          text: '➡️ Next',
          callback_data:
            'nextpage_' + (await this.stashCallbackPayload({ q: query, pt: results.nextPageToken })),
        },
      ]);
    }
    return keyboard;
  }

  /**
   * Telegram caps callback_data at 64 bytes — far too small for a
   * search query plus YouTube's pageToken (and long TikTok usernames),
   * which is what the pagination buttons need to carry. So the payload
   * goes into the in-memory cache under a random key and only the short
   * key rides in the button.
   */
  private async stashCallbackPayload(payload: Record<string, unknown>): Promise<string> {
    const key = randomHex(8);
    await cacheSet('cbpayload_' + key, payload, Config.get<number>('cache_ttl', 3600));
    return key;
  }

  private async popCallbackPayload(data: string): Promise<Record<string, any> | null> {
    if (!/^[0-9a-f]{16}$/.test(data)) {
      return null;
    }
    return cacheGet<Record<string, any>>('cbpayload_' + data);
  }

  /** /story @handle — lists a TikTok user's recent videos to pick from. */
  async handleUsernameLookup(chatId: number, rawUsername: string): Promise<void> {
    const uniqueId = rawUsername.trim().replace(/^@+/, '');

    await this.telegram.sendChatAction(chatId, 'typing');
    await this.deliverUsernameResults(chatId, null, uniqueId, 0);
  }

  /**
   * Shared by the initial lookup and the "Next" button — sends a new
   * message the first time, edits the existing one for pagination.
   */
  private async deliverUsernameResults(
    chatId: number,
    editMessageId: number | null,
    uniqueId: string,
    cursor: number,
  ): Promise<void> {
    const result = await this.tiktokUser.fetchPosts(uniqueId, 12, cursor);
    if (!result || result.videos.length === 0) {
      await this.telegram.sendMessage(
        chatId,
        `😕 No videos found for @${uniqueId} — the account may be private or not exist.`,
      );
      return;
    }

    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    for (const video of result.videos) {
      const videoId = String(video.video_id ?? video.id ?? '');
      if (videoId === '') {
        continue;
      }
      keyboard.push([{ text: this.buildVideoLabel(video), callback_data: 'tkuser_' + videoId }]);
    }

    if (result.hasMore) {
      keyboard.push([
        {
          text: '➡️ Next',
          callback_data:
            'tkusernext_' + (await this.stashCallbackPayload({ u: uniqueId, c: result.cursor })),
        },
      ]);
    }

    const text = `🎬 Recent videos from *@${Validator.markdownEscape(uniqueId)}*:`;
    if (editMessageId) {
      await this.telegram.editMessageText(chatId, editMessageId, text, { inline_keyboard: keyboard });
    } else {
      await this.telegram.sendMessage(chatId, text, { inline_keyboard: keyboard });
    }
  }

  private buildVideoLabel(video: Record<string, any>): string {
    const title = String(video.title ?? '').trim();
    let label = title !== '' ? mbSubstr(title, 0, 45) : 'Video';

    const plays = Number(video.play_count ?? 0);
    if (plays > 0) {
      label += ' · ' + this.formatCount(plays) + ' plays';
    }
    return label;
  }

  private formatCount(n: number): string {
    if (n >= 1_000_000) return String(Math.round((n / 1_000_000) * 10) / 10) + 'M';
    if (n >= 1_000) return String(Math.round((n / 1_000) * 10) / 10) + 'K';
    return String(n);
  }

  async handleCallback(callback: CallbackQuery): Promise<void> {
    const callbackId = callback.id;
    const data = callback.data ?? '';
    const chatId = callback.message?.chat?.id ?? null;
    const messageId = callback.message?.message_id ?? null;
    const userId = Number(callback.from?.id ?? 0);

    if (!chatId || !userId) {
      await this.telegram.answerCallbackQuery(callbackId);
      return;
    }

    if (data.startsWith('nextpage_')) {
      await this.onNextPage(callbackId, Number(chatId), Number(messageId), data.slice(9));
      return;
    }
    if (data.startsWith('ytdl_')) {
      await this.onYtDl(callbackId, Number(chatId), Number(messageId), data.slice(5));
      return;
    }
    if (data.startsWith('dlaud_')) {
      await this.onDownloadAudioButton(callbackId, Number(chatId), data.slice(6));
      return;
    }
    if (data.startsWith('tkaud_')) {
      await this.onTikTokAudioButton(callbackId, Number(chatId), data.slice(6));
      return;
    }
    if (data.startsWith('tkusernext_')) {
      await this.onTikTokUserNextPage(callbackId, Number(chatId), Number(messageId), data.slice(11));
      return;
    }
    if (data.startsWith('tkuser_')) {
      await this.onTikTokUserVideoSelected(callbackId, Number(chatId), Number(messageId), data.slice(7));
      return;
    }

    await this.telegram.answerCallbackQuery(callbackId);
  }

  private async onNextPage(
    callbackId: string,
    chatId: number,
    messageId: number,
    encodedPayload: string,
  ): Promise<void> {
    await this.telegram.answerCallbackQuery(callbackId);
    const payload = await this.popCallbackPayload(encodedPayload);
    if (!payload || !payload.q) {
      return;
    }

    const results = await this.ytSearch.search(payload.q, 10, payload.pt ?? null);
    await this.telegram.editMessageText(
      chatId,
      messageId,
      `🔍 Results for *${Validator.markdownEscape(payload.q)}*:`,
      { inline_keyboard: await this.buildSearchKeyboard(results, payload.q) },
    );
  }

  private async onYtDl(
    callbackId: string,
    chatId: number,
    messageId: number,
    videoId: string,
  ): Promise<void> {
    await this.telegram.answerCallbackQuery(callbackId);
    await this.telegram.editMessageReplyMarkup(chatId, messageId, null);
    await this.handleYouTubeUrl(chatId, 'https://www.youtube.com/watch?v=' + videoId);
  }

  private async onTikTokUserNextPage(
    callbackId: string,
    chatId: number,
    messageId: number,
    encodedPayload: string,
  ): Promise<void> {
    await this.telegram.answerCallbackQuery(callbackId);
    const payload = await this.popCallbackPayload(encodedPayload);
    if (!payload || !payload.u) {
      return;
    }
    const cursorRaw = Number(payload.c ?? 0);
    const cursor = Number.isFinite(cursorRaw) ? cursorRaw : 0;
    await this.deliverUsernameResults(chatId, messageId, String(payload.u), cursor);
  }

  /** Reconstructs the canonical TikTok URL and hands off to handleTikTokUrl() — same delivery pipeline as any other TikTok link. */
  private async onTikTokUserVideoSelected(
    callbackId: string,
    chatId: number,
    messageId: number,
    videoId: string,
  ): Promise<void> {
    const video = await this.tiktokUser.getCachedVideo(videoId);
    const uniqueId = String(video?.author?.unique_id ?? '');
    if (!video || uniqueId === '') {
      await this.telegram.answerCallbackQuery(callbackId, 'That expired — try /story again.', true);
      return;
    }

    await this.telegram.answerCallbackQuery(callbackId);
    await this.telegram.editMessageReplyMarkup(chatId, messageId, null);
    await this.handleTikTokUrl(chatId, `https://www.tiktok.com/@${uniqueId}/video/${videoId}`);
  }

  /** "Download Audio" button under Facebook results — cached via Tool77Service. */
  private async onDownloadAudioButton(
    callbackId: string,
    chatId: number,
    id: string,
  ): Promise<void> {
    const data = await this.tool77.getCachedById(id);
    if (!data) {
      await this.telegram.answerCallbackQuery(callbackId, 'That link expired — please resend it.', true);
      return;
    }

    const audio = this.tool77.getBestAudio(data);
    const audioUrl = audio ? this.tool77.resolveUrl(audio) : null;
    if (!audioUrl) {
      await this.telegram.answerCallbackQuery(callbackId, 'No audio track available.', true);
      return;
    }

    await this.telegram.answerCallbackQuery(callbackId);
    await this.telegram.sendChatAction(chatId, 'upload_audio');
    await this.telegram.sendAudio(chatId, audioUrl, '🎵 Extracted audio');
  }

  /** "Download Audio" button under TikTok results — audio URL pre-cached by handleTikTokUrl() via TikwmService. */
  private async onTikTokAudioButton(
    callbackId: string,
    chatId: number,
    tiktokId: string,
  ): Promise<void> {
    const cached = await this.tikwm.getCachedAudio(tiktokId);
    if (!cached?.url) {
      await this.telegram.answerCallbackQuery(callbackId, 'That link expired — please resend it.', true);
      return;
    }

    await this.telegram.answerCallbackQuery(callbackId);
    await this.telegram.sendChatAction(chatId, 'upload_audio');
    await this.telegram.sendAudio(chatId, cached.url, '🎵 Extracted audio');
  }
}

function md5(text: string): string {
  return crypto.createHash('md5').update(text).digest('hex');
}

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}
