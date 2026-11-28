// «Buyurtmalar» bulk actions (orders audit 4 and 9): only the selected orders
// the current filter shows; the count is shown before confirming; the result
// separates updated / skipped (status) / refused by the server
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const m = vi.hoisted(() => ({ confirm: vi.fn(), toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock('../services/telegram', () => ({ notifyUserOrderStatus: vi.fn(), notifyReferrerReward: vi.fn() }));
vi.mock('../context/ToastContext', () => ({ useToast: () => m.toast }));
vi.mock('../context/ConfirmContext', () => ({ useConfirm: () => m.confirm }));
vi.mock('../utils/csvExport', () => ({ exportOrders: vi.fn(), exportOrderItems: vi.fn() }));
vi.mock('../utils/shippingLabel', () => ({ printShippingLabel: vi.fn(), printMultipleLabels: vi.fn() }));
vi.mock('../utils/packingSlip', () => ({ printPackingSlip: vi.fn(), printMultiplePackingSlips: vi.fn() }));

import { AdminContext } from '../context/AdminContext';
import OrdersSection from '../components/admin/sections/OrdersSection';

const ord = (id, status) => ({ id, dbId: `db-${id}`, status, createdAt: '2026-11-28T10:00:00+05:00', userName: `Mijoz ${id}`, total: 100000, items: [], paymentMethod: 'payme' });
const refusal = (code, status) => Object.assign(new Error(code), { code, status });

let value;
function renderWith(orders, ctx = {}) {
  value = { orders, approveOrder: vi.fn().mockResolvedValue({}), rejectOrder: vi.fn().mockResolvedValue({}), updateOrderStatus: vi.fn().mockResolvedValue({}), loadAllData: vi.fn(), confirmReturn: vi.fn(), getBonusRecords: vi.fn().mockResolvedValue({ history: [], debts: [] }), ...ctx };
  const r = render(<AdminContext.Provider value={value}><OrdersSection /></AdminContext.Provider>);
  return { ...r, rerenderWith: (orders2) => { value = { ...value, orders: orders2 }; r.rerender(<AdminContext.Provider value={value}><OrdersSection /></AdminContext.Provider>); } };
}
const statusFilter = () => screen.getAllByRole('combobox').find(s => [...s.options].some(o => o.value === 'pending'));
const bulkSelect = () => screen.getAllByRole('combobox').find(s => [...s.options].some(o => o.value === 'Mark as Shipped'));
const selectAll = () => fireEvent.click(screen.getAllByRole('checkbox')[0]);
const rowBox = (id) => screen.getByText(`#${id}`).closest('tr').querySelector('input[type=checkbox]');
const apply = async (action) => {
  fireEvent.change(bulkSelect(), { target: { value: action } });
  await act(async () => { fireEvent.click(screen.getByText("Qo'llash")); });
};

beforeEach(() => { vi.clearAllMocks(); m.confirm.mockResolvedValue(true); });

describe('filter changed after selecting', () => {
  test('selected under «pending», then filter «approved»: the hidden selection is never touched', async () => {
    renderWith([ord('P1', 'pending'), ord('P2', 'pending'), ord('A1', 'approved')]);
    fireEvent.change(statusFilter(), { target: { value: 'pending' } });
    selectAll();
    expect(screen.getByTestId('bulk-selected').textContent).toBe('2 ta buyurtma tanlandi');
    fireEvent.change(statusFilter(), { target: { value: 'approved' } });
    expect(screen.getByTestId('bulk-selected').textContent).toBe('0 ta buyurtma tanlandi');
    expect(screen.getByTestId('bulk-hidden').textContent).toContain("+2 ta filtrda yashirin");
    fireEvent.change(bulkSelect(), { target: { value: 'Reject' } });
    expect(screen.getByText("Qo'llash").closest('button').disabled).toBe(true);   // nothing visible is selected
    // select the visible approved one and «Rad etish»: it is not pending → nothing is sent
    fireEvent.click(rowBox('A1'));
    await act(async () => { fireEvent.click(screen.getByText("Qo'llash")); });
    expect(m.confirm).not.toHaveBeenCalled();
    expect(m.toast.warning).toHaveBeenCalledWith('Tanlangan 1 ta buyurtmaning hech biri «Rad etish» uchun mos holatda emas');
    expect(value.rejectOrder).not.toHaveBeenCalled();
  });

  test('mixed selection, then a narrower filter: only the visible part, and the confirm says so', async () => {
    renderWith([ord('P1', 'pending'), ord('P2', 'pending'), ord('A1', 'approved')]);
    selectAll();                                                    // all three
    fireEvent.change(statusFilter(), { target: { value: 'pending' } });
    fireEvent.click(rowBox('P2'));                                  // unselect P2 → visible: P1
    await apply('Reject');
    expect(m.confirm).toHaveBeenCalledWith(expect.objectContaining({
      message: "«Rad etish» 1 ta buyurtmaga qo'llanadi. Filtrda ko'rinmaydigan 1 ta tanlangan buyurtmaga tegilmaydi.",
      confirmText: 'Rad etish (1)'
    }));
    expect(value.rejectOrder.mock.calls.map(c => c[0])).toEqual(['P1']);
    expect(m.toast.success).toHaveBeenCalledWith("Yangilandi: 1 · Holati mos emas (o'tkazildi): 0 · Server rad etdi: 0");
  });

  test('cancelling the confirmation changes nothing', async () => {
    m.confirm.mockResolvedValue(false);
    renderWith([ord('A1', 'approved')]);
    selectAll();
    await apply('Mark as Shipped');
    expect(value.updateOrderStatus).not.toHaveBeenCalled();
  });
});

describe('status changed after selecting', () => {
  test('on the server meanwhile: counted as refused, separately from skipped and updated', async () => {
    renderWith([ord('A1', 'approved'), ord('A2', 'approved'), ord('P1', 'pending'), ord('A3', 'approved')], {
      updateOrderStatus: vi.fn()
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(refusal('status_changed', 'refunded'))
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    });
    selectAll();
    await apply('Mark as Shipped');
    expect(m.confirm).toHaveBeenCalledWith(expect.objectContaining({
      message: "«Jo'natildi» 3 ta buyurtmaga qo'llanadi. 1 tasi holati mos emas — o'tkazib yuboriladi.",
      confirmText: "Jo'natildi (3)"
    }));
    expect(value.updateOrderStatus.mock.calls.map(c => c[0]).sort()).toEqual(['A1', 'A2', 'A3']);
    expect(m.toast.warning).toHaveBeenCalledWith("Yangilandi: 1 · Holati mos emas (o'tkazildi): 1 · Server rad etdi: 1 · Xato: 1");
  });

  test('the list refreshed after selecting (now refunded): nothing applicable, nothing sent', async () => {
    const view = renderWith([ord('A1', 'approved'), ord('A2', 'approved')]);
    selectAll();
    view.rerenderWith([ord('A1', 'refunded'), ord('A2', 'approved')]);
    await apply('Mark as Shipped');
    expect(m.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: "«Jo'natildi» 1 ta buyurtmaga qo'llanadi. 1 tasi holati mos emas — o'tkazib yuboriladi." }));
    expect(value.updateOrderStatus.mock.calls.map(c => c[0])).toEqual(['A2']);
  });

  test('approval refused by the server (no stock / not pending) is «rad etdi», not an error', async () => {
    renderWith([ord('P1', 'pending'), ord('P2', 'pending')], {
      approveOrder: vi.fn().mockRejectedValueOnce(refusal('insufficient_stock')).mockRejectedValueOnce(refusal('not_pending', 'approved'))
    });
    selectAll();
    await apply('Approve');
    expect(m.toast.warning).toHaveBeenCalledWith("Yangilandi: 0 · Holati mos emas (o'tkazildi): 0 · Server rad etdi: 2");
  });
});
