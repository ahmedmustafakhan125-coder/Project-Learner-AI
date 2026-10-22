/**
 * Phone numbers, as Presidio's PhoneRecognizer: libphonenumber's matcher at
 * its VALID leniency, run once per default region.
 *
 * Presidio's regions are US, UK, DE, FE, IL, IN, CA and BR. "UK" and "FE" are
 * not region codes libphonenumber knows, so in Python those two passes find
 * only numbers written with a "+"; the pass with no default region here does
 * the same.
 *
 * libphonenumber-js leaves one VALID check out ("skipped for simplicity"): a
 * number written in national format must carry its national prefix when the
 * country's format requires one. Without it, "2024-01-15" passes as a German
 * number, so `nationalPrefixPresentIfRequired` restores it, after Python's
 * phonenumbers.
 */

import { findPhoneNumbersInText, Metadata, parseDigits, type CountryCode, type PhoneNumber } from 'libphonenumber-js/core';
import metadata from 'libphonenumber-js/max/metadata';

import type { Detection, Recognizer } from './types.js';

const REGIONS: Array<CountryCode | undefined> = ['US', 'DE', 'IL', 'IN', 'CA', 'BR', undefined];

/** The runtime surface of libphonenumber-js's metadata that its typings leave out. */
interface NumberFormat {
  pattern(): string;
  leadingDigitsPatterns(): string[];
  nationalPrefixFormattingRule(): string | undefined;
  nationalPrefixIsOptionalWhenFormattingInNationalFormat(): boolean;
  usesNationalPrefix(): boolean;
}

interface NumberingPlan {
  formats(): NumberFormat[];
  nationalPrefixForParsing(): string | undefined;
  nationalPrefixTransformRule(): string | undefined;
  nationalNumberPattern(): string;
}

function numberingPlan(callingCode: string): NumberingPlan {
  const plans = new Metadata(metadata);
  // Accepts a calling code at runtime, despite the CountryCode typing.
  plans.selectNumberingPlan(callingCode as CountryCode);
  return plans.numberingPlan as unknown as NumberingPlan;
}

const fullMatch = (pattern: string, value: string) => new RegExp(`^(?:${pattern})$`).test(value);

/** Python phonenumbers' `_is_national_prefix_present_if_required`. */
function nationalPrefixPresentIfRequired(phone: PhoneNumber, candidate: string): boolean {
  // Set when the number carried its own country code ("+", an IDD prefix, or
  // the bare code); then no national prefix is expected.
  if ((phone as { __countryCallingCodeSource?: string }).__countryCallingCodeSource) return true;

  const plan = numberingPlan(phone.countryCallingCode);
  const national = phone.nationalNumber;
  const format = plan.formats().find((f) => {
    const leading = f.leadingDigitsPatterns();
    // The last leading-digits pattern is the most specific.
    if (leading.length > 0 && national.search(new RegExp(leading[leading.length - 1]!)) !== 0) return false;
    return fullMatch(f.pattern(), national);
  });
  if (!format?.nationalPrefixFormattingRule()) return true;
  if (format.nationalPrefixIsOptionalWhenFormattingInNationalFormat()) return true;
  if (!format.usesNationalPrefix()) return true;
  return stripsNationalPrefix(parseDigits(candidate), plan);
}

/** Whether the digits begin with a national prefix: `_maybe_strip_national_prefix_carrier_code(...)[2]`. */
function stripsNationalPrefix(digits: string, plan: NumberingPlan): boolean {
  const prefix = plan.nationalPrefixForParsing();
  if (!digits || !prefix) return false;
  const match = new RegExp(`^(?:${prefix})`).exec(digits);
  if (!match) return false;

  // Stripping must not turn a viable number into an unviable one.
  const viable = fullMatch(plan.nationalNumberPattern(), digits);
  const rule = plan.nationalPrefixTransformRule();
  const lastGroupMatched = match.length > 1 && match[match.length - 1] !== undefined;
  const stripped =
    rule && lastGroupMatched ? digits.replace(new RegExp(`^(?:${prefix})`), rule) : digits.slice(match[0].length);
  return !viable || fullMatch(plan.nationalNumberPattern(), stripped);
}

export const phoneRecognizer: Recognizer = {
  name: 'PhoneRecognizer',
  context: ['phone', 'number', 'telephone', 'cell', 'cellphone', 'mobile', 'call'],
  analyze(text) {
    const found: Detection[] = [];
    for (const region of REGIONS) {
      const matches = region
        ? findPhoneNumbersInText(text, { defaultCountry: region }, metadata)
        : findPhoneNumbersInText(text, metadata);
      for (const match of matches) {
        if (!nationalPrefixPresentIfRequired(match.number, text.slice(match.startsAt, match.endsAt))) continue;
        found.push({ type: 'PHONE_NUMBER', start: match.startsAt, end: match.endsAt, score: 0.4, recognizer: phoneRecognizer });
      }
    }
    return found;
  },
};
