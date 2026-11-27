// Payme refund of a paid order in «Buyurtmalar» (add-payme-refund.sql)
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
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
import { getStatusLabel, getStatusColor } from '../utils/helpers';
import { t } from '../utils/translation-fallback';

const refundRec = (over = {}) => ({ source: 'payme:tx-1', stock: 'returned', fulfilled: true, bonus_returned: 20000, bonus_revoked: 6000, bonus_shortfall: 0, referrer_revoked: 0, referrer_shortfall: 0, needs_reconciliation: false, reconcile: [], ...over });
const ord = (id, status, over = {}) => ({ id, dbId: `db-${id}`, status, createdAt: '2026-11-27T10:00:00+05:00', userName: `Mijoz ${id}`, total: 180000, items: [], paymentMethod: 'payme', ...over });

function renderWith(orders, ctx = {}) {
  const value = { orders, approveOrder: vi.fn(), rejectOrder: vi.fn(), updateOrderStatus: vi.fn(), loadAllData: vi.fn(), confirmReturn: vi.fn().mockResolvedValue({ result: 'received' }), ...ctx };
  render(<AdminContext.Provider value={value}><OrdersSection /></AdminContext.Provider>);
  return value;
}
const rowOf = (id) => screen.getByText(`#${id}`).closest('tr');

beforeEach(() => { vi.clearAllMocks(); m.confirm.mockResolvedValue(true); });

describe('refund statuses', () => {
  test('labels and colours (admin and customer)', () => {
    expect(getStatusLabel('refunded')).toBe('Qaytarilgan');
    expect(getStatusLabel('return_pending')).toBe('Qaytarish kutilmoqda');
    expect(getStatusColor('refunded')).not.toBe('bg-gray-500 text-white');
    expect(t('orders.refunded')).toBe('Pul qaytarildi');
    expect(t('orders.return_pending')).toBe('Pul qaytarildi');
  });

  test('filter options and pills', () => {
    renderWith([ord('R1', 'refunded', { refundedAt: '2026-11-27T11:00:00Z', refund: refundRec() }), ord('R2', 'return_pending', { refundedAt: '2026-11-27T11:00:00Z', refund: refundRec({ stock: 'awaiting_return' }) })]);
    const statusSelect = screen.getAllByRole('combobox').find(s => [...s.options].some(o => o.value === 'pending'));
    expect([...statusSelect.options].map(o => o.textContent)).toEqual(expect.arrayContaining(['Qaytarish kutilmoqda (1)', 'Qaytarilgan (1)']));
    expect(within(rowOf('R1')).getByText('Qaytarilgan')).toBeTruthy();
    expect(within(rowOf('R2')).getByText('Qaytarish kutilmoqda')).toBeTruthy();
    fireEvent.change(statusSelect, { target: { value: 'return_pending' } });
    expect(screen.queryByText('#R1')).toBeNull();
    expect(screen.getByText('#R2')).toBeTruthy();
  });

  test('«Qabul qilindi» only for an order awaiting its goods; asks first, then confirms the return', async () => {
    const ctx = renderWith([ord('R2', 'return_pending', { refundedAt: '2026-11-27T11:00:00Z', refund: refundRec({ stock: 'awaiting_return' }) }), ord('R1', 'refunded'), ord('A1', 'approved')]);
    expect(within(rowOf('R1')).queryByText('Qabul qilindi')).toBeNull();
    expect(within(rowOf('A1')).queryByText('Qabul qilindi')).toBeNull();
    await act(async () => { fireEvent.click(within(rowOf('R2')).getByText('Qabul qilindi')); });
    expect(m.confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmText: 'Qabul qilindi' }));
    expect(ctx.confirmReturn).toHaveBeenCalledWith('R2');
    expect(m.toast.success).toHaveBeenCalledWith('Mahsulot omborga qaytarildi');
  });

  test('cancelling the confirmation changes nothing', async () => {
    m.confirm.mockResolvedValue(false);
    const ctx = renderWith([ord('R2', 'return_pending')]);
    await act(async () => { fireEvent.click(within(rowOf('R2')).getByText('Qabul qilindi')); });
    expect(ctx.confirmReturn).not.toHaveBeenCalled();
  });

  test('a refused confirmation says why', async () => {
    const err = Object.assign(new Error('x'), { code: 'not_awaiting_return', status: 'refunded' });
    renderWith([ord('R2', 'return_pending')], { confirmReturn: vi.fn().mockRejectedValue(err) });
    await act(async () => { fireEvent.click(within(rowOf('R2')).getByText('Qabul qilindi')); });
    expect(m.toast.error).toHaveBeenCalledWith('Buyurtma holati: Qaytarilgan. Qaytarish kutilmayapti.');
  });

  test('order card: what was returned, what is awaited, bonus shortfall', () => {
    renderWith([ord('R3', 'return_pending', { refundedAt: '2026-11-27T11:00:00Z', refund: refundRec({ stock: 'awaiting_return', bonus_returned: 0, bonus_revoked: 4000, bonus_shortfall: 11000, referrer_revoked: 1000, referrer_shortfall: 49000 }) })]);
    fireEvent.click(within(rowOf('R3')).getByText("Ko'rish"));
    const note = screen.getByRole('note').textContent;
    expect(note).toContain('Pul qaytarilgan (Payme)');
    expect(note).toContain('mahsulot qaytib kelishi kutilmoqda');
    expect(note).toContain('0 ball qaytarildi, 4000 ball bekor qilindi');
    expect(note).toContain('Mijoz 11000 ball bonusni allaqachon sarflagan');
    expect(note).toContain('Taklif qilgan mijozdan 1000 ball bekor qilindi');
    expect(note).toContain('Taklif qilgan mijoz 49000 ball bonusni allaqachon sarflagan');
  });

  test('order card and row: «Sverka talab qilinadi» when an amount could not be confirmed', () => {
    renderWith([
      ord('E1', 'refunded', { bonusPointsUsed: 5000, refundedAt: '2026-11-27T11:00:00Z', refund: refundRec({ bonus_returned: 0, bonus_revoked: 0, needs_reconciliation: true, reconcile: ['bonus_earned_unrecorded', 'bonus_used_unconfirmed'] }) }),
      ord('OK1', 'refunded', { refundedAt: '2026-11-27T11:00:00Z', refund: refundRec() })
    ]);
    expect(within(rowOf('E1')).getByText('Sverka talab qilinadi')).toBeTruthy();
    expect(within(rowOf('OK1')).queryByText('Sverka talab qilinadi')).toBeNull();
    fireEvent.click(within(rowOf('E1')).getByText("Ko'rish"));
    const note = screen.getByRole('note').textContent;
    expect(note).toContain('Sverka talab qilinadi');
    expect(note).toContain("Xarid uchun berilgan bonus miqdori operatsiyalar tarixida yo'q");
    expect(note).toContain('Buyurtmada ishlatilgan 5000 ball tarixda tasdiqlanmagan');
    expect(note).not.toContain('joriy sozlamalar');
  });
});
