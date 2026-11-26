// Permanent variant ids on the client: cart lookups, availability, request,
// new admin variants.
import { describe, expect, test, vi } from 'vitest';
vi.mock('../lib/supabase', () => ({ supabase: {} }));
import { findCartVariant } from '../utils/variants';
import { getUnavailableCartItems, getVisibleCartItems } from '../utils/helpers';
import { buildCheckoutRequest } from '../services/api';
import { applyAxisChange, newVariantId } from '../utils/variantEdit';

const VA = '00000000-0000-4000-8000-00000000aaaa';
const variants = [{ variant_id: VA, color: 'Sutrang', size: 'Katta', stock: 4 }, { variant_id: 'x2', color: 'Qora', size: 'Katta', stock: 1 }];

describe('variant ids on the client', () => {
  test('findCartVariant: by id (survives a rename), old lines by colour + size, unknown id -> none', () => {
    expect(findCartVariant(variants, { variantId: VA, selectedColor: 'Oq', selectedSize: 'Katta' })).toBe(variants[0]);
    expect(findCartVariant(variants, { selectedColor: 'qora', selectedSize: 'KATTA' })).toBe(variants[1]);
    expect(findCartVariant(variants, { variantId: 'nope', selectedColor: 'Qora', selectedSize: 'Katta' })).toBeNull();
  });

  test('cart availability: line with a removed variant id or an old name that no longer exists is unavailable', () => {
    const products = [{ id: 'p', visible: true, variants }, { id: 'plain', visible: true, variants: [] }];
    const cart = [
      { cartItemId: 1, id: 'p', variantId: VA, selectedColor: 'Oq', selectedSize: 'Katta' },   // renamed: still on sale
      { cartItemId: 2, id: 'p', variantId: 'gone', selectedColor: 'Qora', selectedSize: 'Katta' }, // removed id
      { cartItemId: 3, id: 'p', selectedColor: 'Oq', selectedSize: 'Katta' },                   // old line, old name
      { cartItemId: 4, id: 'p', selectedColor: 'Qora', selectedSize: 'Katta' },                 // old line, current name
      { cartItemId: 5, id: 'plain' },
      { cartItemId: 6, id: 'plain', variantId: VA }                                             // id on a plain product
    ];
    expect(getVisibleCartItems(cart, products).map(i => i.cartItemId)).toEqual([1, 4, 5]);
    expect(getUnavailableCartItems(cart, products).map(i => i.cartItemId)).toEqual([2, 3, 6]);
  });

  test('checkout request carries variantId when the line has one; old lines send only names', () => {
    const req = buildCheckoutRequest({ isGuest: true }, [
      { id: 'p', variantId: VA, selectedColor: 'Oq', selectedSize: 'Katta', quantity: 1 },
      { id: 'p', selectedColor: 'Qora', selectedSize: 'Katta', quantity: 2 },
      { id: 'plain', quantity: 1 }
    ], { courier: "O'zi olib ketish" });
    expect(req.items).toEqual([
      { productId: 'p', variantId: VA, color: 'Oq', size: 'Katta', quantity: 1 },
      { productId: 'p', color: 'Qora', size: 'Katta', quantity: 2 },
      { productId: 'plain', color: null, size: null, quantity: 1 }
    ]);
  });

  test('admin: new variants get a fresh id, renamed ones keep theirs', () => {
    expect(newVariantId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const renamed = applyAxisChange(variants, 'color', { type: 'rename', renames: [['Sutrang', 'Oq']] });
    expect(renamed[0].variant_id).toBe(VA);
    const added = applyAxisChange(variants, 'size', { type: 'add', added: ['Kichik'] }, ['Sutrang', 'Qora']);
    const fresh = added.slice(2).map(v => v.variant_id);
    expect(fresh).toHaveLength(2);
    expect(new Set([...fresh, VA, 'x2']).size).toBe(4);
  });
});
