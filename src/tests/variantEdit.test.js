import { describe, expect, test } from 'vitest';
import { diffAxis, applyAxisChange, parseAxis, axisValues, removeVariant, pruneAxisText } from '../utils/variantEdit';

const v = (color, size, extra = {}) => ({ color, size, stock: 1, barcode: `${color}${size}`, ...extra });

describe('variantEdit', () => {
  test('diffAxis classifies one kind of change at a time', () => {
    expect(diffAxis(['Oq', 'Qora'], ['Qora', 'Oq'])).toEqual({ type: 'none' });
    expect(diffAxis(['Oq'], ['OQ'])).toEqual({ type: 'rename', renames: [['Oq', 'OQ']] });
    expect(diffAxis(['Oq', 'Qora'], ['Sut', 'Qora'])).toEqual({ type: 'rename', renames: [['Oq', 'Sut']] });
    expect(diffAxis(['Oq'], ['Oq', "Ko'k"])).toEqual({ type: 'add', added: ["Ko'k"] });
    expect(diffAxis(['Oq', 'Qora'], ['Qora'])).toEqual({ type: 'remove', removed: ['Oq'] });
    expect(diffAxis(['Oq', 'Qora'], ['Sut', 'Qora', "Ko'k"]).type).toBe('invalid');
    expect(diffAxis(['Oq'], ['Oq', 'oq']).type).toBe('invalid');   // duplicate, case-insensitive
  });

  test('applyAxisChange keeps every other field and never touches unrelated variants', () => {
    const list = [v('Oq', 'Katta', { color_ru: 'Белый', image: 'a.jpg' }), v('Qora', 'Katta')];
    const renamed = applyAxisChange(list, 'color', { type: 'rename', renames: [['oq', 'Sut']] });
    expect(renamed[0]).toEqual({ ...list[0], color: 'Sut' });
    expect(renamed[1]).toBe(list[1]);
    const added = applyAxisChange(list, 'size', { type: 'add', added: ['Kichik'] }, ['Oq', 'Qora']);
    expect(added.slice(0, 2)).toEqual(list);
    expect(added.slice(2).map(x => `${x.color}/${x.size}/${x.stock}`)).toEqual(['Oq/Kichik/0', 'Qora/Kichik/0']);
    expect(applyAxisChange(list, 'color', { type: 'remove', removed: ['QORA'] })).toEqual([list[0]]);
  });

  test('helpers', () => {
    expect(parseAxis(' Oq , ,Qora ')).toEqual(['Oq', 'Qora']);
    expect(axisValues([v('Oq', 'K'), v('oq', 'L'), v('Qora', 'K')], 'color')).toEqual(['Oq', 'Qora']);
    const list = [v('Oq', 'K'), v('Oq', 'L'), v('Qora', 'K')];
    expect(removeVariant(list, 'oq', 'l')).toEqual([list[0], list[2]]);
    expect(pruneAxisText('Oq, Qora', [v('Oq', 'K')], 'color')).toBe('Oq');
    expect(pruneAxisText('Oq, Qora', [], 'color')).toBe('Oq, Qora');
  });
});
