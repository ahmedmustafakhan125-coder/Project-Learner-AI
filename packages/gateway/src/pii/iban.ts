/**
 * IBAN recognition, as Presidio's IbanRecognizer: a generic pattern finds
 * candidates, then the mod-97 checksum and the country's format confirm them.
 * A candidate that fails is retried shorter, one optional group at a time, so
 * "DE89370400440532013000 2 days" still yields the IBAN and not the trailing 2.
 */

import { pyRegex } from '../pyre.js';
import type { Detection, Recognizer } from './types.js';

const CK = '[0-9]{2}[ ]?';
const A = '[A-Z][ ]?';
const A4 = '([A-Z][ ]?){4}';
const C = '[a-zA-Z0-9][ ]?';
const C2 = '([a-zA-Z0-9][ ]?){2}';
const C3 = '([a-zA-Z0-9][ ]?){3}';
const C4 = '([a-zA-Z0-9][ ]?){4}';
const N = '[0-9][ ]?';
const N2 = '([0-9][ ]?){2}';
const N3 = '([0-9][ ]?){3}';
const N4 = '([0-9][ ]?){4}';

/** Presidio's iban_patterns.py. */
const COUNTRY_FORMATS: Record<string, string> = {
  AL: '(AL)' + CK + N4 + N4 + C4 + C4 + C4 + C4,
  AD: '(AD)' + CK + N4 + N4 + C4 + C4 + C4,
  AT: '(AT)' + CK + N4 + N4 + N4 + N4,
  AZ: '(AZ)' + CK + C4 + N4 + N4 + N4 + N4 + N4,
  BH: '(BH)' + CK + A4 + C4 + C4 + C4 + C2,
  BY: '(BY)' + CK + C4 + N4 + C4 + C4 + C4 + C4,
  BE: '(BE)' + CK + N4 + N4 + N4,
  BA: '(BA)' + CK + N4 + N4 + N4 + N4,
  BR: '(BR)' + CK + N4 + N4 + N4 + N4 + N4 + N3 + A + C,
  BG: '(BG)' + CK + A4 + N4 + N + N + C2 + C4 + C2,
  CR: '(CR)' + CK + '[0]' + N3 + N4 + N4 + N4 + N2,
  HR: '(HR)' + CK + N4 + N4 + N4 + N4 + N,
  CY: '(CY)' + CK + N4 + N4 + C4 + C4 + C4 + C4,
  CZ: '(CZ)' + CK + N4 + N4 + N4 + N4 + N4,
  DK: '(DK)' + CK + N4 + N4 + N4 + N2,
  DO: '(DO)' + CK + A4 + N4 + N4 + N4 + N4 + N4,
  TL: '(TL)' + CK + N4 + N4 + N4 + N4 + N3,
  EE: '(EE)' + CK + N4 + N4 + N4 + N4,
  FO: '(FO)' + CK + N4 + N4 + N4 + N2,
  FI: '(FI)' + CK + N4 + N4 + N4 + N2,
  FR: '(FR)' + CK + N4 + N4 + N2 + C2 + C4 + C4 + C + N2,
  GE: '(GE)' + CK + C2 + N2 + N4 + N4 + N4 + N2,
  DE: '(DE)' + CK + N4 + N4 + N4 + N4 + N2,
  GI: '(GI)' + CK + A4 + C4 + C4 + C4 + C3,
  GR: '(GR)' + CK + N4 + N3 + C + C4 + C4 + C4 + C3,
  GL: '(GL)' + CK + N4 + N4 + N4 + N2,
  GT: '(GT)' + CK + C4 + C4 + C4 + C4 + C4 + C4,
  HU: '(HU)' + CK + N4 + N4 + N4 + N4 + N4 + N4,
  IS: '(IS)' + CK + N4 + N4 + N4 + N4 + N4 + N2,
  IE: '(IE)' + CK + C4 + N4 + N4 + N4 + N2,
  IL: '(IL)' + CK + N4 + N4 + N4 + N4 + N3,
  IT: '(IT)' + CK + A + N3 + N4 + N3 + C + C3 + C + C4 + C3,
  JO: '(JO)' + CK + A4 + N4 + N4 + N4 + N4 + N4 + N2,
  KZ: '(KZ)' + CK + N3 + C + C4 + C4 + C4,
  XK: '(XK)' + CK + N4 + N4 + N4 + N4,
  KW: '(KW)' + CK + A4 + C4 + C4 + C4 + C4 + C4 + C2,
  LV: '(LV)' + CK + A4 + C4 + C4 + C4 + C,
  LB: '(LB)' + CK + N4 + C4 + C4 + C4 + C4 + C4,
  LI: '(LI)' + CK + N4 + N + C3 + C4 + C4 + C,
  LT: '(LT)' + CK + N4 + N4 + N4 + N4,
  LU: '(LU)' + CK + N3 + C + C4 + C4 + C4,
  MT: '(MT)' + CK + A4 + N4 + N + C3 + C4 + C4 + C4 + C3,
  MR: '(MR)' + CK + N4 + N4 + N4 + N4 + N4 + N3,
  MU: '(MU)' + CK + A4 + N4 + N4 + N4 + N4 + N3 + A,
  MD: '(MD)' + CK + C4 + C4 + C4 + C4 + C4,
  MC: '(MC)' + CK + N4 + N4 + N2 + C2 + C4 + C4 + C + N2,
  ME: '(ME)' + CK + N4 + N4 + N4 + N4 + N2,
  NL: '(NL)' + CK + A4 + N4 + N4 + N2,
  MK: '(MK)' + CK + N3 + C + C4 + C4 + C + N2,
  NO: '(NO)' + CK + N4 + N4 + N3,
  PK: '(PK)' + CK + C4 + N4 + N4 + N4 + N4,
  PS: '(PS)' + CK + C4 + N4 + N4 + N4 + N4 + N,
  PL: '(PL)' + CK + N4 + N4 + N4 + N4 + N4 + N4,
  PT: '(PT)' + CK + N4 + N4 + N4 + N4 + N,
  QA: '(QA)' + CK + A4 + C4 + C4 + C4 + C4 + C,
  RO: '(RO)' + CK + A4 + C4 + C4 + C4 + C4,
  SM: '(SM)' + CK + A + N3 + N4 + N3 + C + C4 + C4 + C3,
  SA: '(SA)' + CK + N2 + C2 + C4 + C4 + C4 + C4,
  RS: '(RS)' + CK + N4 + N4 + N4 + N4 + N2,
  SK: '(SK)' + CK + N4 + N4 + N4 + N4 + N4,
  SI: '(SI)' + CK + N4 + N4 + N4 + N3,
  ES: '(ES)' + CK + N4 + N4 + N4 + N4 + N4,
  SE: '(SE)' + CK + N4 + N4 + N4 + N4 + N4,
  CH: '(CH)' + CK + N4 + N + C3 + C4 + C4 + C,
  TN: '(TN)' + CK + N4 + N4 + N4 + N4 + N4,
  TR: '(TR)' + CK + N4 + N + C3 + C4 + C4 + C4 + C2,
  AE: '(AE)' + CK + N4 + N4 + N4 + N4 + N3,
  GB: '(GB)' + CK + A4 + N4 + N4 + N4 + N2,
  VA: '(VA)' + CK + N4 + N4 + N4 + N4 + N2,
  VG: '(VG)' + CK + C4 + N4 + N4 + N4 + N4,
};

const IBAN = pyRegex(
  String.raw`\b([A-Z]{2}[ \-]?[0-9]{2})(?=(?:[ \-]?[A-Z0-9]){9,30})((?:[ \-]?[A-Z0-9]{3,5}){2})` +
    String.raw`([ \-]?[A-Z0-9]{3,5})?([ \-]?[A-Z0-9]{3,5})?([ \-]?[A-Z0-9]{3,5})?([ \-]?[A-Z0-9]{3,5})?([ \-]?[A-Z0-9]{3,5})?` +
    String.raw`([ \-]?[A-Z0-9]{1,3})?\b`,
  { global: true, indices: true },
);

/** The two check digits a candidate should carry: ISO 7064 mod 97-10. */
function checkDigits(iban: string): string {
  const rearranged = (iban.slice(4) + iban.slice(0, 2) + '00').toUpperCase();
  let remainder = 0;
  for (const char of rearranged) {
    // Letters count as 10 to 35, so each contributes two decimal digits.
    const value = parseInt(char, 36);
    remainder = value < 10 ? (remainder * 10 + value) % 97 : (remainder * 100 + value) % 97;
  }
  return String(98 - remainder).padStart(2, '0');
}

function isValidIban(candidate: string): boolean {
  const iban = candidate.replaceAll('-', '').replaceAll(' ', '');
  if (checkDigits(iban) !== iban.slice(2, 4)) return false;
  const format = COUNTRY_FORMATS[iban.slice(0, 2)];
  return format !== undefined && new RegExp(`^${format}`).test(iban);
}

export const ibanRecognizer: Recognizer = {
  name: 'IbanRecognizer',
  context: ['iban', 'bank', 'transaction'],
  analyze(text) {
    const found: Detection[] = [];
    for (const match of text.matchAll(IBAN)) {
      const start = match.index;
      // The whole match first, then shorter, ending where each later group ends.
      for (let group = match.length - 1; group >= 1; group--) {
        const end = match.indices?.[group]?.[1] ?? start + match[0].length;
        if (end > start && isValidIban(text.slice(start, end))) {
          found.push({ type: 'IBAN_CODE', start, end, score: 1, recognizer: ibanRecognizer });
          break;
        }
      }
    }
    return found;
  },
};
