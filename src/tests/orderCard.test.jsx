// «Buyurtmalar» order card (orders audit 7): payment, delivery, bonuses from
// the bonus history, status history from recorded events only
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { NO_DATA, paymentInfo, deliveryInfo, bonusSummary, orderTimeline } from '../utils/orderCard';

vi.mock('../services/telegram', () => ({ notifyUserOrderStatus: vi.fn(), notifyReferrerReward: vi.fn() }));
vi.mock('../context/ToastContext', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }) }));
vi.mock('../context/ConfirmContext', () => ({ useConfirm: () => vi.fn() }));
vi.mock('../utils/csvExport', () => ({ exportOrders: vi.fn(), exportOrderItems: vi.fn() }));
vi.mock('../utils/shippingLabel', () => ({ printShippingLabel: vi.fn(), printMultipleLabels: vi.fn() }));
vi.mock('../utils/packingSlip', () => ({ printPackingSlip: vi.fn(), printMultiplePackingSlips: vi.fn() }));
import { AdminContext } from '../context/AdminContext';
import OrdersSection from '../components/admin/sections/OrdersSection';

const BUYER = '11111111-1111-4111-8111-111111111111', REF = '22222222-2222-4222-8222-222222222222';
const START = '2026-11-28T07:00:00Z';   // bonus history started
// Payme, paid with bonus, Yandex delivery
const PAYME = {
  id: 'ORD-P', dbId: 'db-P', userId: BUYER, userName: 'Payme Mijoz', status: 'approved', total: 470000, items: [], createdAt: '2026-11-28T09:00:00Z',
  paymentMethod: 'payme', paymeTransactionId: 'tx-abc', paymeState: 2, payme_create_time: Date.parse('2026-11-28T09:01:00Z'), payme_perform_time: Date.parse('2026-11-28T09:02:00Z'),
  fulfilled_at: '2026-11-28T09:02:00Z', fulfilled_by: 'payme:tx-abc',
  deliveryInfo: { type: 'home_delivery', courier: 'Yandex', district: 'Chilonzor', address: 'Qatortol 5', fullName: 'Payme Mijoz', phone: '+998901112233' }
};
// manual approval, courier pickup point
const MANUAL = {
  id: 'ORD-M', dbId: 'db-M', userId: BUYER, userName: 'Qo\'lda', status: 'approved', total: 100000, items: [], createdAt: '2026-11-28T10:00:00Z',
  paymentMethod: 'payme', paymeState: 0, fulfilled_at: '2026-11-28T10:30:00Z', fulfilled_by: 'admin:abc',
  deliveryInfo: { type: 'pickup', courier: 'Fargo', pickupPoint: { name: 'Fargo Samarqand-1', address: 'Registon 1' }, state: 'Samarqand', city: 'Samarqand', fullName: 'Q', phone: '+998' }
};
// BTS, postpaid shipping
const BTS = {
  id: 'ORD-B', dbId: 'db-B', userId: BUYER, userName: 'BTS Mijoz', status: 'shipped', total: 200000, items: [], createdAt: '2026-11-28T11:00:00Z',
  paymentMethod: 'payme', paymeState: 2, payme_perform_time: Date.parse('2026-11-28T11:05:00Z'), fulfilled_by: 'payme:tx-b', fulfilled_at: '2026-11-28T11:05:00Z',
  shipping_payment_type: 'postpaid', deliveryInfo: { type: 'bts_delivery', courier: 'BTS', address: 'Andijon, BTS filial 3', fullName: 'B', phone: '+998' }
};
// old order: nothing recorded
const OLD = {
  id: 'ORD-O', dbId: 'db-O', userId: BUYER, userName: 'Eski', status: 'shipped', total: 50000, items: [], createdAt: '2025-11-06T19:24:13Z',
  paymentMethod: null, paymeState: 0, bonusPointsUsed: 3000, deliveryInfo: null
};
const HISTORY = {
  'db-P': [
    { user_id: BUYER, kind: 'bonus_reserved', amount: 30000 },
    { user_id: BUYER, kind: 'debt_repaid', amount: 4000, debt_id: 'd1' },
    { user_id: BUYER, kind: 'earned', amount: 10100 },
    { user_id: REF, kind: 'commission', amount: 47000 }
  ],
  'db-M': [{ user_id: BUYER, kind: 'earned', amount: 3000 }],
  'db-B': [{ user_id: BUYER, kind: 'bonus_reserved', amount: 5000 }, { user_id: BUYER, kind: 'reservation_released', amount: 5000 }],
  'db-O': []
};
const EVENTS = {
  'db-P': [{ from_status: null, to_status: 'pending', at: '2026-11-28T09:00:00Z', actor: 'server' }, { from_status: 'pending', to_status: 'approved', at: '2026-11-28T09:02:00Z', actor: 'server' }],
  'db-M': [{ from_status: 'pending', to_status: 'approved', at: '2026-11-28T10:30:00Z', actor: 'admin:boss@ailem.uz' }],
  'db-B': [{ from_status: 'approved', to_status: 'shipped', at: '2026-11-28T12:00:00Z', actor: 'admin:boss@ailem.uz' }],
  'db-O': []
};

describe('card data helpers', () => {
  test('payment: method, confirmation time only from the payment system', () => {
    expect(paymentInfo(PAYME)).toMatchObject({ label: 'Payme', paymeTransaction: 'tx-abc', paymeState: "To'langan", paidAt: Date.parse('2026-11-28T09:02:00Z'), paidBy: 'Payme', adminApprovedAt: null });
    const m = paymentInfo(MANUAL);
    expect(m.paidAt).toBeNull();                                  // approval ≠ payment
    expect(m.adminApprovedAt).toBe(Date.parse('2026-11-28T10:30:00Z'));
    expect(paymentInfo(OLD)).toMatchObject({ label: NO_DATA, paidAt: null, adminApprovedAt: null });
    expect(paymentInfo({ paymentMethod: 'cash' }).label).toBe('Naqd (POS)');
    expect(paymentInfo({ payment_screenshot: 'https://x/y.jpg' }).label).toBe("Qo'lda (chek bilan)");
  });
  test('delivery: district, pickup point, BTS postpaid, missing', () => {
    expect(deliveryInfo(PAYME)).toMatchObject({ kind: "Yandex (Toshkent bo'ylab)", postpaid: false });
    expect(deliveryInfo(PAYME).lines).toContainEqual(['Tuman', 'Chilonzor']);
    expect(deliveryInfo(MANUAL).lines).toEqual(expect.arrayContaining([['Olib ketish punkti', 'Fargo Samarqand-1'], ['Viloyat / shahar', 'Samarqand, Samarqand']]));
    expect(deliveryInfo(BTS)).toMatchObject({ kind: 'BTS', postpaid: true });
    expect(deliveryInfo(OLD)).toMatchObject({ kind: NO_DATA, lines: [] });
  });
  test('delivery of old orders (no type; courier in orders.courier, sometimes JSON)', () => {
    const oldBts = { courier: '{"name":"BTS","duration":"Pickup"}', shipping_payment_type: 'prepaid', deliveryInfo: { address: 'Namangan', city: 'Namangan', fullName: 'X', phone: '1' } };
    expect(deliveryInfo(oldBts)).toEqual({ kind: 'BTS', lines: [['Shahar', 'Namangan'], ['Manzil', 'Namangan']], postpaid: false, postpaidUnknown: true });
    expect(deliveryInfo({ courier: 'Aktiv', deliveryInfo: { address: 'A', city: 'C' } })).toMatchObject({ kind: 'Aktiv', postpaidUnknown: false });
    expect(deliveryInfo({ courier: '{"name":"Yandex","duration":"Home Delivery"}', deliveryInfo: { address: 'A' } }).kind).toBe('Yandex');
    expect(deliveryInfo({ deliveryInfo: {} })).toMatchObject({ kind: NO_DATA, lines: [] });
  });
  test('bonuses from the history; old orders → no data', () => {
    expect(bonusSummary(PAYME, { history: HISTORY['db-P'], historyStart: START })).toMatchObject({ covered: true, used: 30000, returned: 0, earned: 14100, earnedToDebt: 4000, commission: 47000 });
    expect(bonusSummary(BTS, { history: HISTORY['db-B'], historyStart: START })).toMatchObject({ used: 5000, returned: 5000, earned: 0 });
    expect(bonusSummary(OLD, { history: [], historyStart: START })).toEqual({ covered: false });
    // a new order with no bonus operations: real zeros
    expect(bonusSummary({ ...MANUAL, createdAt: '2026-11-28T12:00:00Z' }, { history: [], historyStart: START })).toMatchObject({ covered: true, used: 0, earned: 0 });
  });
  test('timeline: only recorded moments, approval labelled as not payment', () => {
    expect(orderTimeline(PAYME, EVENTS['db-P']).map(x => x.text)).toEqual(['Buyurtma yaratildi', 'Payme: tranzaksiya ochildi', "Payme: to'lov tasdiqlandi", 'Holat: Kutilmoqda → Tasdiqlangan — tizim (server)']);
    expect(orderTimeline(MANUAL, EVENTS['db-M']).map(x => x.text)).toEqual(['Buyurtma yaratildi', "Admin buyurtmani tasdiqladi (to'lov tasdig'i emas)", 'Holat: Kutilmoqda → Tasdiqlangan — admin boss@ailem.uz']);
    expect(orderTimeline(OLD, []).map(x => x.text)).toEqual(['Buyurtma yaratildi']);
    // Payme's clock a second behind ours: creation still comes first
    const skew = { ...PAYME, payme_create_time: Date.parse('2026-11-28T08:59:59Z') };
    expect(orderTimeline(skew, []).map(x => x.text).slice(0, 2)).toEqual(['Buyurtma yaratildi', 'Payme: tranzaksiya ochildi']);
  });
});

describe('the card in «Buyurtmalar»', () => {
  const renderList = () => {
    const value = {
      orders: [PAYME, MANUAL, BTS, OLD], approveOrder: vi.fn(), rejectOrder: vi.fn(), updateOrderStatus: vi.fn(), loadAllData: vi.fn(), confirmReturn: vi.fn(),
      getBonusRecords: vi.fn(async (o) => ({ history: HISTORY[o.dbId], debts: [], historyStart: START })),
      getOrderEvents: vi.fn(async (o) => EVENTS[o.dbId])
    };
    render(<AdminContext.Provider value={value}><OrdersSection /></AdminContext.Provider>);
  };
  const open = async (id) => {
    await act(async () => { fireEvent.click(within(screen.getByText(`#${id}`).closest('tr')).getByText("Ko'rish")); });
    return {
      pay: screen.getByTestId('card-payment').textContent,
      dlv: screen.queryByTestId('card-delivery')?.textContent || '',
      bon: (await screen.findByTestId('card-bonuses')).textContent,
      his: (await screen.findByTestId('card-history')).textContent
    };
  };

  test('Payme', async () => {
    renderList();
    const c = await open('ORD-P');
    expect(c.pay).toContain("To'lov usuli:Payme");
    expect(c.pay).toContain('Payme tranzaksiyasi:tx-abc');
    expect(c.pay).toContain("To'lov tasdiqlangan:28.11.2026, 14:02:00 (Payme)");   // Tashkent time
    expect(c.dlv).toContain('Tuman:Chilonzor');
    expect(c.bon).toContain('Ishlatilgan:30000 ball');
    expect(c.bon).toContain('Hisoblangan:14100 ball');
    expect(c.bon).toContain("shundan 4000 ball bonus qarzini to'lashga ketgan");
    expect(c.bon).toContain('Taklif qilgan mijozga:47000 ball');
    expect(c.his).toContain("Payme: to'lov tasdiqlandi");
  });
  test('manual approval is not shown as a payment confirmation', async () => {
    renderList();
    const c = await open('ORD-M');
    expect(c.pay).toContain(`To'lov tasdiqlangan:${NO_DATA}`);
    expect(c.pay).toContain("Admin tasdiqlagan:28.11.2026, 15:30:00 — bu to'lov tasdig'i emas");
    expect(c.dlv).toContain('Olib ketish punkti:Fargo Samarqand-1');
    expect(c.his).toContain('admin boss@ailem.uz');
  });
  test('BTS: delivery paid on receipt', async () => {
    renderList();
    const c = await open('ORD-B');
    expect(c.dlv).toContain('Yetkazib berish turi:BTS');
    expect(c.dlv).toContain("Yetkazib berish narxi qabul qilishda to'lanadi (BTS)");
    expect(c.bon).toContain('Ishlatilgan:5000 ball');
    expect(c.bon).toContain('Qaytarilgan:5000 ball');
  });
  test('old order: «ma\'lumot yo\'q», no invented history', async () => {
    renderList();
    const c = await open('ORD-O');
    expect(c.pay).toContain(`To'lov usuli:${NO_DATA}`);
    expect(c.pay).toContain(`To'lov tasdiqlangan:${NO_DATA}`);
    expect(c.dlv).toContain(`Yetkazib berish turi:${NO_DATA}`);
    expect(c.bon).toContain(`Ishlatilgan:${NO_DATA}`);
    expect(c.bon).toContain(`Hisoblangan:${NO_DATA}`);
    expect(c.his).toContain('Buyurtma yaratildi');
    expect(c.his).toContain(`Holat o'zgarishlari: ${NO_DATA}`);
    expect(c.his).not.toMatch(/Jo'natilgan|Holat:/);
  });
});
