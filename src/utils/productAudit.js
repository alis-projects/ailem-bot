// What a product audit entry records (src/services/auditLog.js format).
// Values are taken from database rows as returned by the API, under their
// database column names, so "before" and "after" compare like with like.
// Who and when are stamped by the database (audit_logs_stamp trigger, from
// the verified session), never by this code.

export const PRODUCT_AUDIT_FIELDS = [
  'name', 'description', 'price', 'original_price', 'category_name', 'image', 'images',
  'stock', 'weight', 'badge', 'material', 'colors', 'sizes', 'tags', 'variants',
  'volume_pricing', 'barcode', 'uzum_url', 'a_plus_content', 'visible'
];

// The app maps some columns to camelCase; accept both shapes
const FROM_APP = {
  original_price: 'originalPrice', category_name: 'category', uzum_url: 'uzumUrl',
  a_plus_content: 'aPlusContent', image: 'imageUrl'
};

const valueOf = (product, field) => {
  if (Object.prototype.hasOwnProperty.call(product, field)) return product[field];
  const alt = FROM_APP[field];
  if (alt && Object.prototype.hasOwnProperty.call(product, alt)) return product[alt];
  return undefined;
};

// Stable JSON (object keys sorted) so equal jsonb values compare equal
const stable = (v) => {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
};

const normalise = (field, v) => {
  if (v === undefined || v === '') return null;
  if (['price', 'original_price', 'stock', 'weight'].includes(field) && v !== null && Number.isFinite(Number(v))) return Number(v);
  if (field === 'visible') return v !== false;
  return v;
};

// Full product state for create / copy / delete entries
export const productSnapshot = (product) => {
  if (!product) return null;
  const out = {};
  for (const f of PRODUCT_AUDIT_FIELDS) {
    const v = valueOf(product, f);
    if (v !== undefined) out[f] = normalise(f, v);
  }
  return out;
};

// Only the fields that really changed, before and after. A field that is not
// known on one side (e.g. a lightweight catalog row without description) is
// not reported as a change.
export const productChanges = (before, after) => {
  const old = {};
  const now = {};
  for (const f of PRODUCT_AUDIT_FIELDS) {
    const a = valueOf(before || {}, f);
    const b = valueOf(after || {}, f);
    if (a === undefined || b === undefined) continue;
    const na = normalise(f, a);
    const nb = normalise(f, b);
    if (stable(na) !== stable(nb)) {
      old[f] = na;
      now[f] = nb;
    }
  }
  return { oldData: old, newData: now, fields: Object.keys(now) };
};
