// Variant SKU: «first 3 letters of the colour»-«first letter of the size»
// (OQ-K, KUL-5). It is a label for people; nothing in the app looks variants
// up by it (they have permanent variant_id). It must be unique WITHIN one
// product — the same SKU on different products is expected with this format.
// The database refuses new duplicates too (add-variant-sku-guard.sql).

export const normalizeSku = (sku) => String(sku ?? '').trim().toUpperCase();

export const baseSku = (color, size) =>
  `${String(color ?? '').trim().substring(0, 3).toUpperCase()}-${String(size ?? '').trim().substring(0, 1).toUpperCase()}`;

// A SKU not used yet among `taken` (any iterable of SKUs): base, base-2, base-3, …
export const uniqueSku = (base, taken) => {
  const used = new Set([...taken].map(normalizeSku).filter(Boolean));
  const b = normalizeSku(base);
  if (!used.has(b)) return b;
  let n = 2;
  while (used.has(`${b}-${n}`)) n++;
  return `${b}-${n}`;
};

// SKUs used by more than one variant of the same product:
// [{ sku, variants: ['Kulrang / 50x70', …] }] (empty SKUs are ignored)
export const duplicateSkus = (variants = []) => {
  const groups = new Map();
  for (const v of variants || []) {
    const sku = normalizeSku(v?.sku);
    if (!sku) continue;
    if (!groups.has(sku)) groups.set(sku, []);
    groups.get(sku).push(`${v.color ?? ''} / ${v.size ?? ''}`);
  }
  return [...groups.entries()].filter(([, list]) => list.length > 1).map(([sku, list]) => ({ sku, variants: list }));
};

// Duplicates in `variants` that were not already duplicated in `before`
// (the card as it was opened). Old duplicates are tolerated, like the
// database trigger does, so they never block other edits.
export const newDuplicateSkus = (variants = [], before = []) => {
  const old = new Set(duplicateSkus(before).map(d => d.sku));
  return duplicateSkus(variants).filter(d => !old.has(d.sku));
};

export const duplicateSkuMessage = (dups) =>
  `SKU takrorlanmoqda: ${dups.map(d => `«${d.sku}» — ${d.variants.join(', ')}`).join('; ')}. Bitta mahsulot ichida har bir variantning SKU'si boshqacha bo'lishi kerak.`;
