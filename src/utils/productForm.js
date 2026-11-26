// Admin product form helpers (audit-reports/2026-11-25-products, findings 7, 9, 14, 15).
import { marked } from 'marked';

marked.setOptions({ breaks: true, gfm: true });

// The complete initial state of the product form. Every "new product" form
// starts from a fresh copy of this, so nothing from a previous product leaks in.
export const emptyProductForm = () => ({
  name: '',
  description: '',
  price: '',
  salePrice: '',
  imageUrl: '',
  additionalImages: '',
  category: '',
  weight: '',
  stock: '',
  badge: '',
  material: '',
  colors: '',
  sizes: '',
  tags: '',
  barcode: '',
  uzumUrl: '',
  inStock: true,
  variants: [],
  volume_pricing: null,
  aPlusContent: null
});

const axisText = (list, variants, key) => (list && list.length > 0
  ? list.join(', ')
  : (variants && variants.length > 0 ? [...new Set(variants.map(v => v[key]).filter(Boolean))].join(', ') : ''));

// In the database `price` is the selling price and `originalPrice` the old
// (crossed-out) one; the form shows them as «Narxi» and «Chegirma narxi».
const formPrices = (product) => (product.originalPrice
  ? { price: String(product.originalPrice), salePrice: String(product.price) }
  : { price: product.price != null ? String(product.price) : '', salePrice: '' });

// Form state from a full product record. With { copy: true } the result is a
// new product: name marked «(Nusxa)», no product or variant barcodes and no
// variant ids (the database assigns new ones on insert).
export const productToForm = (product, { copy = false } = {}) => {
  let description = product.description || '';
  if (description && (description.includes('**') || description.includes('*') || description.includes('- ') || description.includes('\n'))) {
    description = marked.parse(description);
  }
  const variants = (product.variants || []).map(v => {
    if (!copy) return v;
    const { variant_id, barcode, ...rest } = v;
    return { ...rest, barcode: null };
  });
  return {
    ...emptyProductForm(),
    name: copy ? `${product.name} (Nusxa)` : (product.name || ''),
    description,
    ...formPrices(product),
    imageUrl: product.image || product.imageUrl || '',
    additionalImages: product.images ? product.images.slice(1).join(', ') : '',
    category: product.category || '',
    weight: product.weight != null ? String(product.weight) : '',
    // 0 is a real stock value, only a missing one leaves the field empty
    stock: product.stock != null ? String(product.stock) : '',
    badge: product.badge || '',
    material: product.material || '',
    colors: axisText(product.colors, product.variants, 'color'),
    sizes: axisText(product.sizes, product.variants, 'size'),
    tags: product.tags ? product.tags.join(', ') : '',
    barcode: copy ? '' : (product.barcode || ''),
    uzumUrl: product.uzumUrl || '',
    inStock: product.inStock !== false,
    variants,
    volume_pricing: product.volume_pricing ? product.volume_pricing.map(t => ({ ...t })) : null,
    aPlusContent: product.aPlusContent || product.a_plus_content || null
  };
};

export const productImages = (product) =>
  (product.images?.length ? product.images : [product.image || product.imageUrl]).filter(Boolean);

// «Ombor miqdori»: empty is an error, 0 is allowed, negative or fractional is not
export const stockError = (value) => {
  const text = String(value ?? '').trim();
  if (text === '') return 'Ombor miqdori kiritilishi shart';
  if (!/^\d+$/.test(text)) return 'Ombor miqdori 0 yoki undan katta butun son bo\'lishi kerak';
  return null;
};

const num = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));

// Bulk-price tiers as typed (values may still be strings) → numbers, sorted by
// min_qty. Sorting happens only here, on save, never while the admin types.
export const normalizeTiers = (tiers) => {
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  return tiers
    .map(t => ({
      min_qty: num(t.min_qty),
      max_qty: t.max_qty === '' || t.max_qty === null || t.max_qty === undefined ? null : num(t.max_qty),
      price: num(t.price)
    }))
    .sort((a, b) => a.min_qty - b.min_qty);
};

// Problems of a tier list, or null. `basePrice` is the regular price of the
// product or of the variant the tiers belong to.
export const tiersError = (tiers, basePrice) => {
  const list = normalizeTiers(tiers);
  if (!list) return null;
  for (const t of list) {
    const range = `${Number.isFinite(t.min_qty) ? t.min_qty : '?'}${t.max_qty === null ? '+' : `-${Number.isFinite(t.max_qty) ? t.max_qty : '?'}`}`;
    if (!Number.isInteger(t.min_qty) || t.min_qty < 1) return `Min miqdor 1 yoki undan katta butun son bo'lishi kerak (${range})`;
    if (t.max_qty !== null && (!Number.isInteger(t.max_qty) || t.max_qty < t.min_qty)) return `Max miqdor min miqdordan kam bo'lmasligi kerak (${range})`;
    if (!Number.isFinite(t.price) || t.price <= 0) return `Narx 0 dan katta bo'lishi kerak (${range})`;
    if (Number.isFinite(basePrice) && basePrice > 0 && t.price > basePrice) return `Hajm narxi oddiy narxdan (${basePrice}) yuqori bo'lmasligi kerak (${range})`;
  }
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1];
    if (prev.max_qty === null || list[i].min_qty <= prev.max_qty) {
      return `Darajalar kesishmoqda: ${prev.min_qty}${prev.max_qty === null ? '+' : `-${prev.max_qty}`} va ${list[i].min_qty}${list[i].max_qty === null ? '+' : `-${list[i].max_qty}`}`;
    }
  }
  return null;
};

// What the form state plus images look like, to detect unsaved changes
export const formSnapshot = (formData, images) => JSON.stringify({ formData, images });
