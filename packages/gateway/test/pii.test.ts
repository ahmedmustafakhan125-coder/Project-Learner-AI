import { describe, expect, it } from 'vitest';

import { analyzePii } from '../src/pii/index.js';

/**
 * PII analysis.
 *
 * The first block is the Python gateway's test_pii.py. After it, each case
 * pins a result the Python gateway produced (or, for names, a deliberate
 * difference from it), chosen where the JavaScript libraries or regex engine
 * would otherwise have answered differently.
 */

const types = (text: string) => analyzePii(text).entities.map((e) => e.type);
const masked = (text: string) => analyzePii(text).maskedText;

describe('the Python suite', () => {
  it('detects and masks an email', () => {
    expect(types('My email is ali@example.com please reply.')).toContain('EMAIL_ADDRESS');
    expect(masked('My email is ali@example.com please reply.')).toContain('<EMAIL>');
  });

  it('detects a CNIC', () => {
    expect(masked('My CNIC is 35202-1234567-1 please add it.')).toBe('My CNIC is <CNIC> please add it.');
  });

  it('detects a student ID', () => {
    expect(masked('Please use student id FA21-BCS-123 in the form.')).toBe('Please use student id <STUDENT_ID> in the form.');
  });

  it('detects an API key and flags a secret', () => {
    const result = analyzePii('Use this key sk-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890 for testing.');
    expect(result.entities.map((e) => e.type)).toContain('API_KEY');
    expect(result.hasSecret).toBe(true);
  });

  it('detects a Pakistani phone number', () => {
    expect(types('Call me on 03001234567 tomorrow morning.')).toContain('PHONE_NUMBER');
  });

  it('flags composite PII', () => {
    expect(analyzePii('Student FA21-BCS-123 has email ali@uni.edu.pk for registration.').compositePii).toBe(true);
  });

  it('returns text without PII unchanged', () => {
    expect(analyzePii('Explain TCP and UDP briefly.')).toMatchObject({ entities: [], maskedText: 'Explain TCP and UDP briefly.' });
  });
});

describe('what the Python gateway decided', () => {
  it('accepts only emails under a registered public suffix', () => {
    expect(types('email: a@b.c')).toEqual([]);
    expect(types('user@localhost is not an email')).toEqual([]);
    expect(masked('send the file to x@y.py')).toBe('send the file to <EMAIL>');
  });

  it('requires the national prefix where a country writes one', () => {
    // Without it, a date passes as a German number.
    expect(types('Date 2024-01-15 and time 10:30')).toEqual([]);
    // Indian mobiles are written without one.
    expect(masked('my cell 98765 43210')).toBe('my cell <PHONE>');
  });

  it('merges overlapping detections of one number into one placeholder', () => {
    expect(masked('My number is +92 300 1234567')).toBe('My number is <PHONE>');
  });

  it('checks card numbers with Luhn', () => {
    expect(masked('My card is 4111 1111 1111 1111')).toBe('My card is <CREDIT_CARD>');
    expect(types('card 4111-1111-1111-1112')).toEqual([]);
  });

  it('shortens an IBAN candidate until the checksum holds', () => {
    expect(masked('I want my deposit in DE89370400440532013000 2 days from today.')).toBe(
      'I want my deposit in <IBAN> 2 days from today.',
    );
  });

  it('counts a weak SSN match only with SSN words nearby', () => {
    expect(types('My social security number is 536221234')).toEqual(['US_SSN']);
    expect(types('order 536221234')).toEqual([]);
  });

  it('reads Urdu digits as digits', () => {
    expect(masked('CNIC ۳۵۲۰۲-۱۲۳۴۵۶۷-۱')).toBe('CNIC <CNIC>');
  });
});

describe('where the port differs on purpose', () => {
  it('finds a student ID with a Korean particle attached, which Python missed', () => {
    expect(masked('내 학생 ID는 FA21-BCS-123입니다. 등록해 주세요.')).toBe('내 학생 ID는 <STUDENT_ID>입니다. 등록해 주세요.');
  });

  it('masks names', () => {
    expect(masked('My name is Ali Khan.')).toBe('My name is <PERSON>.');
    expect(masked("Sarah's laptop is broken")).toBe("<PERSON>'s laptop is broken");
  });

  it('does not take Urdu or Korean words for names, as spaCy did', () => {
    expect(types('میں آج بہت خوش ہوں. ایک اچھی نظم لکھیں.')).toEqual([]);
    expect(types('오늘 날씨가 어때요?')).toEqual([]);
  });

  it('leaves algorithm names alone', () => {
    expect(types('Explain the Floyd-Warshall algorithm')).toEqual([]);
    expect(types('What are Markov chains?')).toEqual([]);
  });
});
