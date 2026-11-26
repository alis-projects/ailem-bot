// Orders marked by reconcile_payment_reservations() (Payme transaction open
// long after Payme's timeout) show a "check in the Payme cabinet" badge and
// details, only while the order is still pending.
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../lib/supabase', () => ({ supabase: {} }));
vi.mock('../context/ToastContext', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }) }));
vi.mock('../context/ConfirmContext', () => ({ useConfirm: () => vi.fn() }));
vi.mock('../services/telegram', () => ({ notifyUserOrderStatus: vi.fn(), notifyReferrerReward: vi.fn() }));

import { AdminContext } from '../context/AdminContext';
import OrdersSection from '../components/admin/sections/OrdersSection';
import { ordersAPI } from '../services/api';

const base = { userName: 'Xaridor', total: 40000, items: [], deliveryInfo: { type: 'self_pickup' }, date: '2026-11-26', createdAt: '2026-11-26T10:00:00Z', paymentMethod: 'payme' };
const reason = "Payme tranzaksiyasi 13 soatdan ortiq ochiq: bekor qilish/to'lov xabari kelmadi. Payme kabinetida tekshiring";

const renderOrders = (orders) => render(
  <AdminContext.Provider value={{ orders, approveOrder: vi.fn(), rejectOrder: vi.fn(), updateOrderStatus: vi.fn(), loadAllData: vi.fn() }}>
    <OrdersSection />
  </AdminContext.Provider>
);

describe('Payme reconciliation marker', () => {
  test('the API maps the reconciliation columns', () => {
    const o = ordersAPI._mapOrderFromDB({ id: 'u', order_number: 'ORD-1', payme_transaction_id: 'tx-1', payme_review_required_at: '2026-11-26T23:00:00Z', payme_review_reason: reason });
    expect(o).toMatchObject({ paymeTransactionId: 'tx-1', paymeReviewRequiredAt: '2026-11-26T23:00:00Z', paymeReviewReason: reason });
    expect(ordersAPI._mapOrderFromDB({ id: 'v', order_number: 'ORD-2' }).paymeReviewRequiredAt).toBeNull();
  });

  test('pending marked order: badge in the list and details in the order view; resolved or unmarked orders: no badge', () => {
    renderOrders([
      { ...base, id: 'ORD-FLAG', status: 'pending', paymeTransactionId: 'tx-flag', paymeReviewRequiredAt: '2026-11-26T23:00:00Z', paymeReviewReason: reason },
      { ...base, id: 'ORD-DONE', status: 'approved', paymeReviewRequiredAt: '2026-11-26T23:00:00Z', paymeReviewReason: reason },
      { ...base, id: 'ORD-PLAIN', status: 'pending' }
    ]);
    const badges = screen.getAllByText('Payme: tekshiring');
    expect(badges).toHaveLength(1);
    const row = badges[0].closest('tr');
    expect(within(row).getByText(/ORD-FLAG/)).toBeInTheDocument();
    fireEvent.click(within(row).getByText("Ko'rish"));
    const alert = screen.getByText('Payme kabinetida tekshirish kerak').closest('[role="alert"]');
    expect(alert).toHaveTextContent('13 soatdan ortiq');
    expect(alert).toHaveTextContent('tx-flag');
    expect(alert).toHaveTextContent('band qilingan');
  });
});
