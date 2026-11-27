// logAuditAction never throws and says whether the entry was written
import { beforeEach, describe, expect, test, vi } from 'vitest';

const m = vi.hoisted(() => ({ insert: null }));
vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: { getSession: () => Promise.resolve({ data: { session: { user: { id: 'u1', email: 'a@b' } } } }) },
    from: () => ({ insert: (...args) => m.insert(...args) })
  }
}));

import { logAuditAction, AUDIT_ACTIONS } from '../services/auditLog';

const entry = { action: AUDIT_ACTIONS.PRODUCT_CREATE, entityType: 'product', entityId: 'p1', newData: { name: 'X' } };

beforeEach(() => { m.insert = vi.fn().mockResolvedValue({ error: null }); });

describe('logAuditAction', () => {
  test('written → true', async () => {
    expect(await logAuditAction(entry)).toBe(true);
    expect(m.insert).toHaveBeenCalledTimes(1);
  });
  test('refused by the database (RLS / permission) → false, no throw', async () => {
    m.insert = vi.fn().mockResolvedValue({ error: { code: '42501', message: 'permission denied' } });
    expect(await logAuditAction(entry)).toBe(false);
  });
  test('network error → false, no throw', async () => {
    m.insert = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await logAuditAction(entry)).toBe(false);
  });
  test('no answer within the timeout → false', async () => {
    m.insert = vi.fn(() => new Promise(() => {}));
    expect(await logAuditAction(entry, { timeoutMs: 50 })).toBe(false);
  });
});
