// Tashkent calendar days and order search (orders audit 6, 8). Run under
// several TZ values: the result must not depend on the browser's time zone.
import { describe, expect, test } from 'vitest';
import { tashkentDay, inTashkentDayRange, orderMatchesSearch } from '../utils/orderFilters';

// Tashkent = UTC+5
const T = {
  prevLast: '2026-11-26T18:59:59.999Z',  // 26 Nov 23:59:59.999 Tashkent
  midnight: '2026-11-26T19:00:00.000Z',  // 27 Nov 00:00:00 Tashkent
  night: '2026-11-26T20:30:00.000Z',     // 27 Nov 01:30 Tashkent (audit case)
  fourAm: '2026-11-26T23:59:59.000Z',    // 27 Nov 04:59:59 Tashkent (old code: 26 Nov)
  last: '2026-11-27T18:59:59.999Z',      // 27 Nov 23:59:59.999 Tashkent
  nextMidnight: '2026-11-27T19:00:00.000Z', // 28 Nov 00:00 Tashkent
  tzOffset: '2026-11-27T00:30:00+05:00'  // 27 Nov 00:30 Tashkent written with an offset
};

describe(`Tashkent calendar day (process TZ=${process.env.TZ || 'default'})`, () => {
  test('the day of a moment', () => {
    expect(tashkentDay(T.prevLast)).toBe('2026-11-26');
    expect(tashkentDay(T.midnight)).toBe('2026-11-27');
    expect(tashkentDay(T.night)).toBe('2026-11-27');
    expect(tashkentDay(T.fourAm)).toBe('2026-11-27');
    expect(tashkentDay(T.last)).toBe('2026-11-27');
    expect(tashkentDay(T.nextMidnight)).toBe('2026-11-28');
    expect(tashkentDay(T.tzOffset)).toBe('2026-11-27');
    expect(tashkentDay(new Date(T.midnight))).toBe('2026-11-27');
    expect(tashkentDay('nonsense')).toBeNull();
    expect(tashkentDay(null)).toBeNull();
  });

  test('a single day 27..27 includes 00:00 … 23:59:59.999 and nothing else', () => {
    const inDay = (v) => inTashkentDayRange(v, '2026-11-27', '2026-11-27');
    expect([T.midnight, T.night, T.fourAm, T.last, T.tzOffset].map(inDay)).toEqual([true, true, true, true, true]);
    expect([T.prevLast, T.nextMidnight].map(inDay)).toEqual([false, false]);
  });

  test('open ranges and edges of a period', () => {
    expect(inTashkentDayRange(T.midnight, '2026-11-27', '')).toBe(true);
    expect(inTashkentDayRange(T.prevLast, '2026-11-27', '')).toBe(false);
    expect(inTashkentDayRange(T.last, '', '2026-11-27')).toBe(true);
    expect(inTashkentDayRange(T.nextMidnight, '', '2026-11-27')).toBe(false);
    expect(inTashkentDayRange(T.nextMidnight, '2026-11-26', '2026-11-28')).toBe(true);
    expect(inTashkentDayRange(T.night, '2026-11-28', '2026-11-26')).toBe(false);   // from > to: empty
    expect(inTashkentDayRange(T.night, '', '')).toBe(true);
    expect(inTashkentDayRange(undefined, '2026-11-27', '')).toBe(false);
  });
});

describe('order search', () => {
  const o = {
    id: 'ORD-1795852159049-14', orderNumber: 'ORD-1795852159049-14', userName: "Ali Valiyev",
    userPhone: '+998901234567', deliveryInfo: { fullName: "G'ulom O'tkirov", phone: '+998 93 765 43 21' }
  };
  const m = (q) => orderMatchesSearch(o, q);

  test('empty query matches everything', () => {
    expect(m('')).toBe(true);
    expect(m('   ')).toBe(true);
  });

  test('phone with and without spaces, +998, dashes, brackets', () => {
    for (const q of ['+998901234567', '998901234567', '901234567', '90 123 45 67', '+998 90 123 45 67', '(90) 123-45-67', '4567', '93 765', '937654321', '+998937654321']) {
      expect(m(q), q).toBe(true);
    }
    for (const q of ['901234568', '+998 91 123 45 67', '55555']) expect(m(q), q).toBe(false);
  });

  test('order number: full, partial, with #, any case', () => {
    for (const q of ['ORD-1795852159049-14', '#ORD-1795852159049-14', 'ord-1795852159049', '1795852159049', '9049-14']) expect(m(q), q).toBe(true);
    expect(m('ORD-1795852159049-15')).toBe(false);
  });

  test('name: customer or recipient, any case, apostrophe variants, several words', () => {
    for (const q of ['ali', 'VALIYEV', 'ali valiyev', "g'ulom", 'gʻulom', 'G‘ulom O’tkirov', 'ulom']) expect(m(q), q).toBe(true);
    for (const q of ['vali olimov', 'Bobur']) expect(m(q), q).toBe(false);
  });

  test('a short digit query does not match phones by accident', () => {
    expect(m('12')).toBe(false);          // < 3 digits: only the order number (not contained)
    expect(m('14')).toBe(true);           // part of the order number
  });
});
