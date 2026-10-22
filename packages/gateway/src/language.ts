/**
 * Language detection: "en", "ur", "ko" or "other".
 *
 * Any Hangul makes a prompt Korean and any Arabic-script letter makes it Urdu,
 * as in the Python gateway, because an attack is usually hidden in the
 * non-English part. Python asked langdetect about everything else, which on
 * prompts this short was close to a coin toss ("How do I make banana bread?"
 * came back as not English). The label decides nothing, so here any other
 * text with Latin letters is English, and text with none is "other".
 */

export type Language = 'en' | 'ur' | 'ko' | 'other';

const HANGUL = /[가-힯ᄀ-ᇿ㄰-㆏]/;
const ARABIC = /[؀-ۿݐ-ݿ]/;
const LATIN = /[A-Za-z]/;

export function detectLanguage(text: string): Language {
  if (HANGUL.test(text)) return 'ko';
  if (ARABIC.test(text)) return 'ur';
  return LATIN.test(text) ? 'en' : 'other';
}

/** Latin letters together with Hangul or Arabic script. */
export function isMixedLanguage(text: string): boolean {
  return LATIN.test(text) && (HANGUL.test(text) || ARABIC.test(text));
}
