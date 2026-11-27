// Variant SKU: unique within a product (audit 2026-11-25-products #20)
import { describe, expect, test } from 'vitest';
import { baseSku, uniqueSku, duplicateSkus, newDuplicateSkus, duplicateSkuMessage } from '../utils/variantSku';
import { applyAxisChange, diffAxis } from '../utils/variantEdit';
import { generateVariants, generateSKU } from '../utils/variants';
import { productSaveError } from '../services/api';

describe('variant SKU helpers', () => {
  test('base format is unchanged: 3 letters of the colour - 1 letter of the size', () => {
    expect(baseSku('Kulrang', '50x70')).toBe('KUL-5');
    expect(generateSKU('Oq', 'Katta')).toBe('OQ-K');
  });

  test('uniqueSku adds -2, -3 when the base is taken (case/space-insensitive)', () => {
    expect(uniqueSku('KUL-5', [])).toBe('KUL-5');
    expect(uniqueSku('KUL-5', ['kul-5 '])).toBe('KUL-5-2');
    expect(uniqueSku('KUL-5', ['KUL-5', 'KUL-5-2'])).toBe('KUL-5-3');
  });

  test('duplicateSkus / newDuplicateSkus', () => {
    const v = [
      { color: 'Kulrang', size: '50x70', sku: 'KUL-5' },
      { color: "Kulrang ko'k", size: '50x70', sku: 'kul-5' },
      { color: 'Oq', size: '50x70', sku: '' },
      { color: 'Oq', size: '60x60', sku: null }
    ];
    expect(duplicateSkus(v)).toEqual([{ sku: 'KUL-5', variants: ['Kulrang / 50x70', "Kulrang ko'k / 50x70"] }]);
    expect(newDuplicateSkus(v, [])).toHaveLength(1);
    expect(newDuplicateSkus(v, v)).toEqual([]);               // already duplicated when opened → tolerated
    expect(duplicateSkuMessage(duplicateSkus(v))).toBe("SKU takrorlanmoqda: «KUL-5» — Kulrang / 50x70, Kulrang ko'k / 50x70. Bitta mahsulot ichida har bir variantning SKU'si boshqacha bo'lishi kerak.");
  });
});

describe('new variants get a SKU unique within the product', () => {
  test('adding a colour that starts like an existing one', () => {
    const start = [{ variant_id: 'a', color: 'Kulrang', size: '50x70', stock: 3, sku: 'KUL-5' }];
    const out = applyAxisChange(start, 'color', diffAxis(['Kulrang'], ['Kulrang', "Kulrang ko'k"]), ['50x70']);
    expect(out.map(v => v.sku)).toEqual(['KUL-5', 'KUL-5-2']);
    expect(out[0]).toBe(start[0]);                            // the existing variant is untouched
  });

  test('adding sizes that start with the same character', () => {
    const start = [{ variant_id: 'a', color: 'Oq', size: '1 kishilik', stock: 1, sku: 'OQ-1' }];
    const out = applyAxisChange(start, 'size', diffAxis(['1 kishilik'], ['1 kishilik', '1.5 kishilik']), ['Oq']);
    expect(out.map(v => v.sku)).toEqual(['OQ-1', 'OQ-1-2']);
  });

  test('a renamed variant keeps its SKU', () => {
    const start = [{ variant_id: 'a', color: 'Oq', size: 'Katta', sku: 'OQ-K' }];
    expect(applyAxisChange(start, 'color', diffAxis(['Oq'], ['Sutrang']))[0].sku).toBe('OQ-K');
  });

  test('generateVariants: unique within the generated set', () => {
    expect(generateVariants(['Kulrang', "Kulrang ko'k"], ['1 kishilik', '1.5 kishilik']).map(v => v.sku))
      .toEqual(['KUL-1', 'KUL-1-2', 'KUL-1-3', 'KUL-1-4']);
  });
});

describe('database refusal → clear message', () => {
  test('duplicate_variant_sku with details', () => {
    const err = productSaveError({ message: 'duplicate_variant_sku', details: JSON.stringify([{ sku: 'KUL-5', variants: ['Kulrang / 50x70', "Kulrang ko'k / 50x70"] }]) });
    expect(err.code).toBe('duplicate_variant_sku');
    expect(err.message).toBe("Saqlanmadi: SKU takrorlanmoqda: «KUL-5» — Kulrang / 50x70, Kulrang ko'k / 50x70. Bitta mahsulot ichida har bir variantning SKU'si boshqacha bo'lishi kerak.");
  });
  test('without details', () => {
    expect(productSaveError({ message: 'duplicate_variant_sku' }).message).toBe("Saqlanmadi: bitta mahsulot ichida ikki variantning SKU'si bir xil.");
  });
});
