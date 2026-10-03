/** Text helpers replacing PHP's mb_* functions. */

export function mbSubstr(text: string, start: number, length?: number): string {
  const chars = Array.from(text);
  return chars.slice(start, length === undefined ? undefined : start + length).join('');
}
