// «Buyurtmalar»: status changes are decided by the database
// (add-order-status-transitions.sql) — refusals explained, bulk summary, one
// customer notification (sent by AdminContext.updateOrderStatus only)
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const m = vi.hoisted(() => ({ confirm: vi.fn(), toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }, notify: vi.fn() }));
vi.mock('../services/telegram', () => ({ notifyUserOrderStatus: m.notify, notifyReferrerReward: vi.fn() }));
vi.mock('../context/ToastContext', () => ({ useToast: () => m.toast }));
vi.mock('../context/ConfirmContext', () => ({ useConfirm: () => m.confirm }));
vi.mock('../utils/csvExport', () => ({ exportOrders: vi.fn(), exportOrderItems: vi.fn() }));
vi.mock('../utils/shippingLabel', () => ({ printShippingLabel: vi.fn(), printMultipleLabels: vi.fn() }));
vi.mock('../utils/packingSlip', () => ({ printPackingSlip: vi.fn(), printMultiplePackingSlips: vi.fn() }));

import { AdminContext } from '../context/AdminContext';
import OrdersSection from '../components/admin/sections/OrdersSection';

const ord = (id, status) => ({ id, dbId: `db-${id}`, status, createdAt: '2026-11-28T10:00:00+05:00', userName: `Mijoz ${id}`, total: 100000, items: [], paymentMethod: 'payme' });
const refusal = (code, status) => Object.assign(new Error(code), { code, status });

function renderWith(orders, ctx = {}) {
  const value = { orders, approveOrder: vi.fn(), rejectOrder: vi.fn(), updateOrderStatus: vi.fn().mockResolvedValue({}), loadAllData: vi.fn(), confirmReturn: vi.fn(), getBonusRecords: vi.fn().mockResolvedValue({ history: [], debts: [] }), ...ctx };
  render(<AdminContext.Provider value={value}><OrdersSection /></AdminContext.Provider>);
  return value;
}
const rowOf = (id) => screen.getByText(`#${id}`).closest('tr');

beforeEach(() => { vi.clearAllMocks(); m.confirm.mockResolvedValue(true); });

describe('single status change', () => {
  test('«Jo\'natildi» asks the server; one notification at most (none from the section)', async () => {
    const ctx = renderWith([ord('A1', 'approved')]);
    await act(async () => { fireEvent.click(within(rowOf('A1')).getByText("Jo'natildi")); });
    expect(ctx.updateOrderStatus).toHaveBeenCalledWith('A1', 'shipped');
    expect(m.notify).not.toHaveBeenCalled();
    expect(m.toast.success).toHaveBeenCalledWith("Buyurtma jo'natildi deb belgilandi");
  });

  test('a refusal says why (status changed meanwhile / not allowed)', async () => {
    const ctx = renderWith([ord('A1', 'approved'), ord('S1', 'shipped')], {
      updateOrderStatus: vi.fn()
        .mockRejectedValueOnce(refusal('status_changed', 'rejected'))
        .mockRejectedValueOnce(refusal('not_allowed', 'refunded'))
    });
    await act(async () => { fireEvent.click(within(rowOf('A1')).getByText("Jo'natildi")); });
    expect(m.toast.error).toHaveBeenLastCalledWith("Buyurtma holati o'zgargan: Rad etilgan. Ro'yxat yangilandi.");
    await act(async () => { fireEvent.click(within(rowOf('S1')).getByText('Yetkazildi')); });
    expect(m.toast.error).toHaveBeenLastCalledWith("Buyurtma holati: Qaytarilgan. Bu holatdan o'zgartirib bo'lmaydi.");
    expect(ctx.updateOrderStatus).toHaveBeenCalledTimes(2);
  });
});

describe('bulk status change', () => {
  test('summary: updated, skipped (wrong status in the list), refused (changed meanwhile)', async () => {
    const ctx = renderWith([ord('A1', 'approved'), ord('A2', 'approved'), ord('P1', 'pending'), ord('R1', 'refunded')], {
      updateOrderStatus: vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(refusal('status_changed', 'rejected'))
    });
    const selectAll = screen.getAllByRole('checkbox')[0];
    await act(async () => { fireEvent.click(selectAll); });
    const bulk = screen.getAllByRole('combobox').find(s => [...s.options].some(o => o.value === 'Mark as Shipped'));
    fireEvent.change(bulk, { target: { value: 'Mark as Shipped' } });
    await act(async () => { fireEvent.click(screen.getByText("Qo'llash")); });
    expect(ctx.updateOrderStatus.mock.calls.map(c => c[0]).sort()).toEqual(['A1', 'A2']);   // never asked for P1 / R1
    expect(m.toast.warning).toHaveBeenCalledWith("Yangilandi: 1 · Holati mos emas (o'tkazildi): 2 · Server rad etdi: 1");
    expect(m.notify).not.toHaveBeenCalled();
  });
});
