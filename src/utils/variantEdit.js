// Editing a product's colour/size lists WITHOUT losing variant data
// (audit 2026-11-25 #12).
//
// Before: ProductsSection rebuilt every variant from the «Ranglar» /
// «O'lchamlar» text on EACH keystroke and copied only a few fields from a
// variant with exactly the same name. Renaming «Oq» typed through «O»,
// «Oq…», so the renamed variants lost price, stock, image, barcode and
// volume pricing; the barcode of every variant was dropped on any edit;
// clearing a field wiped all variants.
//
// Now a list edit is applied once (when the field is left) as ONE of:
//   rename  the same number of values, some replaced: each replaced value
//           (in list order) is renamed in place — every other field of the
//           variant is kept as is;
//   add     new values only: a new empty variant for each new value and each
//           existing value of the other axis; existing variants untouched;
//   remove  values only removed: exactly the variants with those values go
//           (the form asks first);
//   none    order or spacing only.
// Mixing them in one edit is refused (do one, leave the field, then the next).
// A single variant is removed with removeVariant (its own button).

const key = (s) => String(s ?? '').trim().toLocaleLowerCase();

export function parseAxis(text) {
  return String(text ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

// Distinct axis values present in the variants, in first-seen order
export function axisValues(variants, axis) {
  const seen = new Map();
  for (const v of variants || []) {
    const value = v?.[axis];
    if (value && !seen.has(key(value))) seen.set(key(value), value);
  }
  return [...seen.values()];
}

/**
 * @returns {{type:'none'}|{type:'rename',renames:Array<[string,string]>}|
 *           {type:'add',added:string[]}|{type:'remove',removed:string[]}|
 *           {type:'invalid',error:string}}
 */
export function diffAxis(oldList, newList) {
  const seen = new Set();
  for (const value of newList) {
    if (seen.has(key(value))) return { type: 'invalid', error: `Takroriy qiymat: «${value}»` };
    seen.add(key(value));
  }
  const oldKeys = new Set(oldList.map(key));
  const newKeys = new Set(newList.map(key));
  const removed = oldList.filter(v => !newKeys.has(key(v)));
  const added = newList.filter(v => !oldKeys.has(key(v)));

  if (removed.length === 0 && added.length === 0) {
    // Only order/case/spacing changed: a case change is a rename of the label
    const renames = [];
    for (const value of newList) {
      const before = oldList.find(o => key(o) === key(value));
      if (before !== undefined && before !== value) renames.push([before, value]);
    }
    return renames.length ? { type: 'rename', renames } : { type: 'none' };
  }
  if (removed.length === added.length && oldList.length === newList.length) {
    return { type: 'rename', renames: removed.map((from, i) => [from, added[i]]) };
  }
  if (removed.length === 0) return { type: 'add', added };
  if (added.length === 0) return { type: 'remove', removed };
  return {
    type: 'invalid',
    error: "Nomini o'zgartirish va qo'shish/o'chirishni alohida bajaring: bittasini kiriting, maydondan chiqing, keyin keyingisini"
  };
}

const skuFor = (color, size) => `${String(color).substring(0, 3).toUpperCase()}-${String(size).substring(0, 1).toUpperCase()}`;

// Permanent id of a new variant (the database also fills in / fixes ids:
// supabase-migrations/add-variant-ids.sql)
export const newVariantId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // RFC 4122 v4 from Math.random as a last resort (old WebViews)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
};

const emptyVariant = (color, size) => ({
  variant_id: newVariantId(),
  color, size, stock: 0, price: null, image: null, weight: null, volume_pricing: null, sku: skuFor(color, size)
});

/**
 * Apply a diffAxis result to the variants.
 * @param {Array} variants
 * @param {'color'|'size'} axis
 * @param {object} change  result of diffAxis
 * @param {string[]} otherValues values of the other axis to pair NEW values with
 *        (normally axisValues(variants, otherAxis); when there are no variants
 *        yet, the other text field's list)
 */
export function applyAxisChange(variants, axis, change, otherValues = []) {
  const list = Array.isArray(variants) ? variants : [];
  switch (change?.type) {
    case 'rename': {
      const map = new Map(change.renames.map(([from, to]) => [key(from), to]));
      return list.map(v => (map.has(key(v?.[axis])) ? { ...v, [axis]: map.get(key(v[axis])) } : v));
    }
    case 'add': {
      const out = [...list];
      const has = (c, s) => out.some(v => key(v.color) === key(c) && key(v.size) === key(s));
      for (const value of change.added) {
        for (const o of otherValues) {
          const color = axis === 'color' ? value : o;
          const size = axis === 'color' ? o : value;
          if (!has(color, size)) out.push(emptyVariant(color, size));
        }
      }
      return out;
    }
    case 'remove': {
      const gone = new Set(change.removed.map(key));
      return list.filter(v => !gone.has(key(v?.[axis])));
    }
    default:
      return list;
  }
}

// Variants a 'remove' change would delete (for the confirmation)
export function variantsRemovedBy(variants, axis, change) {
  if (change?.type !== 'remove') return [];
  const gone = new Set(change.removed.map(key));
  return (variants || []).filter(v => gone.has(key(v?.[axis])));
}

// Remove exactly one variant (colour + size, case-insensitive)
export function removeVariant(variants, color, size) {
  return (variants || []).filter(v => !(key(v.color) === key(color) && key(v.size) === key(size)));
}

// Drop list values that no variant uses any more (after removing variants).
export function pruneAxisText(text, variants, axis) {
  if (!variants?.length) return text;
  const used = new Set(axisValues(variants, axis).map(key));
  return parseAxis(text).filter(v => used.has(key(v))).join(', ');
}
