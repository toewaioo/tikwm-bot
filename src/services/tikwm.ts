import crypto from 'node:crypto';
import { Config } from '../config.js';
import { cacheGet, cacheSet } from '../core/cache.js';

export type TikwmData = Record<string, any>;

/**
 * TikTok extraction via the TikWM API (https://tikwm.com/api/). Results
 * are cached in memory for cache_ttl seconds to avoid re-hitting TikWM
 * for the same link.
 */
export class TikwmService {
  private static readonly API_URL = 'https://www.tikwm.com/api/';

  private static md5(text: string): string {
    return crypto.createHash('md5').update(text).digest('hex');
  }

  /** Returns TikWM's `data` object, or null on failure. */
  async fetch(url: string): Promise<TikwmData | null> {
    const cacheKey = 'tikwm_' + TikwmService.md5(url);
    const cached = await cacheGet<TikwmData>(cacheKey);
    if (cached !== null) {
      return cached;
    }

    let response: Response;
    try {
      response = await fetch(TikwmService.API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0',
        },
        body: new URLSearchParams({ url, hd: '1' }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      return null;
    }

    let data: any;
    try {
      data = await response.json();
    } catch {
      return null;
    }

    if (data?.code !== 0 || !data?.data) {
      return null;
    }

    const result = data.data as TikwmData;
    await cacheSet(cacheKey, result, Config.get<number>('cache_ttl', 3600));
    return result;
  }

  detectType(data: TikwmData): 'image' | 'video' {
    return Array.isArray(data?.images) && data.images.length > 0 ? 'image' : 'video';
  }

  getVideoUrl(data: TikwmData): string | null {
    // fetch() asks for hd=1, so hdplay carries the no-watermark HD
    // rendition when one exists; play is the standard-quality copy.
    for (const key of ['hdplay', 'play']) {
      if (typeof data?.[key] === 'string' && data[key] !== '') {
        return data[key] as string;
      }
    }
    return null;
  }

  getAudioUrl(data: TikwmData): string | null {
    return typeof data?.music === 'string' ? data.music : null;
  }

  getImages(data: TikwmData): string[] {
    return Array.isArray(data?.images) ? (data.images as string[]) : [];
  }

  /**
   * TikTok "live photo" slides: MP4 renditions that pair by index with
   * getImages() — live_images[i] is the animated version of
   * images[i]. Empty for plain image posts.
   */
  getLiveImages(data: TikwmData): string[] {
    return Array.isArray(data?.live_images) ? (data.live_images as string[]) : [];
  }

  /** Caches a TikTok's extracted audio under a short, stable key for the "Download Audio" button. */
  async cacheAudioUrl(tiktokId: string, audioUrl: string | null, originUrl?: string | null): Promise<void> {
    if (!audioUrl) return;
    await cacheSet(
      'audio_' + tiktokId,
      { url: audioUrl, origin: originUrl ?? undefined },
      Config.get<number>('cache_ttl', 3600),
    );
  }

  async getCachedAudio(tiktokId: string): Promise<{ url?: string; origin?: string } | null> {
    return cacheGet<{ url?: string; origin?: string }>('audio_' + tiktokId);
  }

  async getCachedAudioUrl(tiktokId: string): Promise<string | null> {
    const cached = await this.getCachedAudio(tiktokId);
    return cached?.url ?? null;
  }
}
