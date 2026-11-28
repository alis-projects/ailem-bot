// «Buyurtmalar»: search + Tashkent-day date filter in the list, and bulk
// actions limited to the selected orders visible in the current result
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

const ord = (id, status, createdAt, userName, userPhone) => ({ id, dbId: `db-${id}`, status, createdAt, userName, userPhone, total: 100000, items: [], paymentMethod: 'payme', deliveryInfo: { fullName: userName, phone: userPhone } });
// Tashkent = UTC+5
const ORDERS = [
  ord('ORD-A', 'approved', '2026-11-26T18:59:59Z', 'Ali Valiyev', '+998901234567'),   // 26 Nov 23:59:59
  ord('ORD-B', 'approved', '2026-11-26T19:00:00Z', 'Bobur Karimov', '+998 93 765 43 21'), // 27 Nov 00:00:00
  ord('ORD-C', 'pending',  '2026-11-26T20:30:00Z', 'Ali Karimov', '998901112233'),      // 27 Nov 01:30
  ord('ORD-D', 'approved', '2026-11-27T18:59:59Z', 'Dilnoza', '+998 90 123 45 67'),    // 27 Nov 23:59:59
  ord('ORD-E', 'approved', '2026-11-27T19:00:00Z', 'Eldor', '+998901234567')           // 28 Nov 00:00:00
];
let value;
function renderList(orders = ORDERS) {
  value = { orders, approveOrder: vi.fn(), rejectOrder: vi.fn(), updateOrderStatus: vi.fn().mockResolvedValue({}), loadAllData: vi.fn(), confirmReturn: vi.fn(), getBonusRecords: vi.fn().mockResolvedValue({ history: [], debts: [] }) };
  render(<AdminContext.Provider value={value}><OrdersSection /></AdminContext.Provider>);
}
const shown = () => [...document.querySelectorAll('tbody tr')].map(r => (r.textContent.match(/#(ORD-[A-Z])/) || [])[1]).filter(Boolean).sort();
const search = (q) => fireEvent.change(screen.getByLabelText('Buyurtmalarni qidirish'), { target: { value: q } });
const dates = (from, to) => { fireEvent.change(screen.getByLabelText('Sanadan'), { target: { value: from } }); fireEvent.change(screen.getByLabelText('Sanagacha'), { target: { value: to } }); };
const statusFilter = () => screen.getAllByRole('combobox').find(s => [...s.options].some(o => o.value === 'pending'));

beforeEach(() => { vi.clearAllMocks(); m.confirm.mockResolvedValue(true); });

describe('date filter: Tashkent calendar days', () => {
  test('27..27 shows 00:00, 01:30 and 23:59:59 of 27 Nov; not 26 Nov 23:59:59 nor 28 Nov 00:00', () => {
    renderList();
    dates('2026-11-27', '2026-11-27');
    expect(shown()).toEqual(['ORD-B', 'ORD-C', 'ORD-D']);
    expect(screen.getByTestId('orders-count').textContent).toContain("5 tadan 3 ta");
  });
  test('edges of a period: 26..27 and 27..28', () => {
    renderList();
    dates('2026-11-26', '2026-11-27');
    expect(shown()).toEqual(['ORD-A', 'ORD-B', 'ORD-C', 'ORD-D']);
    dates('2026-11-27', '2026-11-28');
    expect(shown()).toEqual(['ORD-B', 'ORD-C', 'ORD-D', 'ORD-E']);
  });
});

describe('search together with the filters', () => {
  test('phone with and without spaces finds the same orders', () => {
    renderList();
    search('90 123 45 67');
    expect(shown()).toEqual(['ORD-A', 'ORD-D', 'ORD-E']);
    search('901234567');
    expect(shown()).toEqual(['ORD-A', 'ORD-D', 'ORD-E']);
    search('+998 93 765 43 21');
    expect(shown()).toEqual(['ORD-B']);
    search('937654321');
    expect(shown()).toEqual(['ORD-B']);
  });
  test('name and number; combined with status and dates', () => {
    renderList();
    search('karimov');
    expect(shown()).toEqual(['ORD-B', 'ORD-C']);
    fireEvent.change(statusFilter(), { target: { value: 'approved' } });
    expect(shown()).toEqual(['ORD-B']);
    search('ord-');
    dates('2026-11-27', '2026-11-27');
    expect(shown()).toEqual(['ORD-B', 'ORD-D']);
    search('#ORD-E');
    expect(shown()).toEqual([]);           // 28 Nov: outside the dates
    fireEvent.click(screen.getByText('Qidiruvni tozalash'));
    expect(shown()).toEqual(['ORD-B', 'ORD-D']);
  });
});

describe('bulk actions use only the selected orders visible in the current result', () => {
  test('select all, then narrow by search: only the found ones are applied', async () => {
    renderList();
    fireEvent.change(statusFilter(), { target: { value: 'approved' } });
    fireEvent.click(screen.getAllByRole('checkbox')[0]);              // A, B, D, E
    search('90 123 45 67');                                            // → A, D, E
    expect(screen.getByTestId('bulk-selected').textContent).toBe('3 ta buyurtma tanlandi');
    expect(screen.getByTestId('bulk-hidden').textContent).toContain('+1 ta filtrda yashirin');
    dates('2026-11-27', '2026-11-27');                                 // → D
    expect(screen.getByTestId('bulk-selected').textContent).toBe('1 ta buyurtma tanlandi');
    const bulk = screen.getAllByRole('combobox').find(s => [...s.options].some(o => o.value === 'Mark as Shipped'));
    fireEvent.change(bulk, { target: { value: 'Mark as Shipped' } });
    await act(async () => { fireEvent.click(screen.getByText("Qo'llash")); });
    expect(m.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: "«Jo'natildi» 1 ta buyurtmaga qo'llanadi. Filtrda ko'rinmaydigan 3 ta tanlangan buyurtmaga tegilmaydi." }));
    expect(value.updateOrderStatus.mock.calls.map(c => c[0])).toEqual(['ORD-D']);
  });
});
