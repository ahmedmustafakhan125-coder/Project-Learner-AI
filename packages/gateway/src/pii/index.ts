/**
 * PII analysis: Presidio's analyzer and anonymizer, with the Python gateway's
 * four customisations on top.
 *
 *   1. Custom recognizers: STUDENT_ID (FA21-BCS-123), CNIC, API_KEY, and
 *      Pakistani phone formats.
 *   2. Context-aware scoring, with English, Urdu and Korean context words.
 *   3. Composite PII: PERSON with PHONE or EMAIL, STUDENT_ID with EMAIL, or
 *      CNIC with PHONE in one prompt adds COMPOSITE_PII.
 *   4. Confidence calibration: PERSON −0.10, PHONE and CREDIT_CARD +0.05, and
 *      anything under 0.40 dropped.
 *
 * Detected spans are replaced with placeholders: <PERSON>, <EMAIL>, <PHONE>,
 * <CNIC>, <API_KEY>, <STUDENT_ID>, <CREDIT_CARD>, <IBAN>, <SSN>.
 */

import { round3 } from '../pyre.js';
import { anonymize } from './anonymize.js';
import { enhanceUsingContext } from './context.js';
import { ibanRecognizer } from './iban.js';
import { personRecognizer } from './person.js';
import { phoneRecognizer } from './phone.js';
import {
  apiKeyRecognizer,
  cnicRecognizer,
  creditCardRecognizer,
  emailRecognizer,
  pakistaniPhoneRecognizer,
  ssnRecognizer,
  studentIdRecognizer,
} from './recognizers.js';
import { removeDuplicates, type EntityType, type Recognizer } from './types.js';

export type { EntityType } from './types.js';

const RECOGNIZERS: Recognizer[] = [
  personRecognizer,
  emailRecognizer,
  phoneRecognizer,
  creditCardRecognizer,
  ibanRecognizer,
  ssnRecognizer,
  apiKeyRecognizer,
  pakistaniPhoneRecognizer,
  cnicRecognizer,
  studentIdRecognizer,
];

const CONFIDENCE_ADJUSTMENTS: Partial<Record<EntityType, number>> = {
  PERSON: -0.1,
  PHONE_NUMBER: 0.05,
  CREDIT_CARD: 0.05,
};
const MIN_CONFIDENCE = 0.4;

const PLACEHOLDERS: Record<EntityType, string> = {
  PERSON: '<PERSON>',
  EMAIL_ADDRESS: '<EMAIL>',
  PHONE_NUMBER: '<PHONE>',
  CNIC: '<CNIC>',
  API_KEY: '<API_KEY>',
  STUDENT_ID: '<STUDENT_ID>',
  CREDIT_CARD: '<CREDIT_CARD>',
  IBAN_CODE: '<IBAN>',
  US_SSN: '<SSN>',
};

const PASSWORD_WORDS = ['password', 'passwd', 'passcode', 'secret', 'پاس ورڈ', 'خفیہ کلید', '비밀번호', '비밀'];

export interface PiiEntity {
  type: EntityType;
  text: string;
  score: number;
  start: number;
  end: number;
}

export interface PiiAnalysis {
  entities: PiiEntity[];
  maskedText: string;
  compositePii: boolean;
  /** An API key, or a mention of a password or secret. */
  hasSecret: boolean;
}

export function analyzePii(text: string): PiiAnalysis {
  const detections = RECOGNIZERS.flatMap((recognizer) => recognizer.analyze(text));
  enhanceUsingContext(text, detections);

  const kept = removeDuplicates(detections).filter((detection) => {
    const score = detection.score + (CONFIDENCE_ADJUSTMENTS[detection.type] ?? 0);
    if (score < MIN_CONFIDENCE) return false;
    detection.score = round3(score);
    return true;
  });

  const types = new Set(kept.map((detection) => detection.type));
  const compositePii =
    (types.has('PERSON') && types.has('PHONE_NUMBER')) ||
    (types.has('STUDENT_ID') && types.has('EMAIL_ADDRESS')) ||
    (types.has('PERSON') && types.has('EMAIL_ADDRESS')) ||
    (types.has('CNIC') && types.has('PHONE_NUMBER'));
  const lower = text.toLowerCase();
  const hasSecret = types.has('API_KEY') || PASSWORD_WORDS.some((word) => lower.includes(word));

  const maskedText = kept.length > 0 ? anonymize(text, kept, PLACEHOLDERS) : text;

  // Read after anonymizing, which can widen merged spans in place (see types.ts).
  const entities = kept.map(({ type, start, end, score }) => ({ type, text: text.slice(start, end), score, start, end }));
  return { entities, maskedText, compositePii, hasSecret };
}
