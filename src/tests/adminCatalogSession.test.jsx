// The catalog depends on the session (hidden products only for admins), so
// AdminProvider reloads it when an admin signs in or out — once per user
// change, not on every repeated SIGNED_IN / token refresh.
import React, { useContext } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const m = vi.hoisted(() => ({ listener: null, session: null, getAll: vi.fn() }));
vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: m.session } }),
      onAuthStateChange: (cb) => { m.listener = cb; return { data: { subscription: { unsubscribe: vi.fn() } } }; }
    }
  }
}));
vi.mock('../services/api', async (importOriginal) => ({
  ...Object.fromEntries(['categoriesAPI', 'productsAPI', 'reviewsAPI', 'storageAPI'].map(k => [k, {}])),
  essentialDataAPI: { getAll: m.getAll },
  ordersAPI: { getAll: vi.fn().mockResolvedValue([]) },
  usersAPI: { getAll: vi.fn().mockResolvedValue([]) },
  extractStoragePath: vi.fn(),
  isDefinitiveError: (await importOriginal()).isDefinitiveError
}));

import { AdminContext, AdminProvider } from '../context/AdminContext';

let latest;
function Probe() { latest = useContext(AdminContext); return null; }

describe('AdminProvider catalog and the admin session', () => {
  test('sign-in reloads the catalog (hidden products appear), sign-out reloads it again (they disappear)', async () => {
    const publicCatalog = { products: [{ id: 'a', visible: true }], categories: [], reviews: [] };
    const adminCatalog = { products: [{ id: 'a', visible: true }, { id: 'h', visible: false }], categories: [], reviews: [] };
    m.session = null;
    m.getAll.mockReset().mockResolvedValue(publicCatalog);
    render(<AdminProvider><Probe /></AdminProvider>);
    await waitFor(() => expect(latest.products.map(p => p.id)).toEqual(['a']));
    expect(m.getAll).toHaveBeenCalledTimes(1);

    m.getAll.mockResolvedValue(adminCatalog);
    await act(async () => { m.listener('SIGNED_IN', { user: { id: 'admin-1' } }); });
    await waitFor(() => expect(latest.products.map(p => p.id)).toEqual(['a', 'h']));
    expect(m.getAll).toHaveBeenCalledTimes(2);

    // the same user again (tab refocus / token refresh): no extra catalog load
    await act(async () => { m.listener('SIGNED_IN', { user: { id: 'admin-1' } }); });
    expect(m.getAll).toHaveBeenCalledTimes(2);

    m.getAll.mockResolvedValue(publicCatalog);
    await act(async () => { m.listener('SIGNED_OUT', null); });
    await waitFor(() => expect(latest.products.map(p => p.id)).toEqual(['a']));
    expect(m.getAll).toHaveBeenCalledTimes(3);
  });

  test('an already signed-in admin (restored session) is not reloaded again by the first SIGNED_IN', async () => {
    m.session = { user: { id: 'admin-2' } };
    m.getAll.mockReset().mockResolvedValue({ products: [], categories: [], reviews: [] });
    render(<AdminProvider><Probe /></AdminProvider>);
    await waitFor(() => expect(m.getAll).toHaveBeenCalledTimes(1));
    await new Promise(r => setTimeout(r, 0));
    await act(async () => { m.listener('SIGNED_IN', { user: { id: 'admin-2' } }); });
    expect(m.getAll).toHaveBeenCalledTimes(1);
  });
});
