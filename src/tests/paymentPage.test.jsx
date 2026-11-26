// PaymentPage shows and charges the server quote (app/api/orders), never the
// client-side checkout numbers.
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { UserContext } from '../context/UserContext';
import PaymentPage from '../components/pages/PaymentPage';

const m = vi.hoisted(() => ({ cart: [], payme: vi.fn(() => 'https://checkout.example/pay') }));
vi.mock('../hooks/useCart', () => ({ useCart: () => ({ cartItems: m.cart }) }));
vi.mock('../services/payme', () => ({ generatePaymeLink: m.payme }));
vi.mock('../lib/supabase', () => ({ supabase: {} }));

const P1 = '00000000-0000-4000-8000-000000000001';
const user = { id: '00000000-0000-4000-8000-0000000000a1', telegramId: '555', name: 'Buyer', phone: '+998900000000', isGuest: false };
// Client-side numbers deliberately wrong: they must not be shown or charged
const checkoutData = {
  fullName: 'Buyer', phone: '+998 90 000 00 00', courier: "O'zi olib ketish", type: 'self_pickup',
  address: 'Yunusobod-19', useBonusPoints: false, subtotal: 1000, deliveryFee: 0, bonusDiscount: 0, total: 1000
};
const quote = (total) => ({ items: [], subtotal: total, deliveryFee: 0, shippingPaymentType: 'prepaid', bonusPointsUsed: 0, bonusDiscount: 0, total });
const json = (status, body) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

let fetchMock;
beforeEach(() => {
  m.cart = [{ id: P1, name: 'Choyshab', price: 1, quantity: 2, selectedColor: null, selectedSize: null }];
  m.payme.mockClear();
  fetchMock = vi.fn();
  global.fetch = fetchMock;
  delete window.location;
  window.location = { href: 'http://localhost/payment' };
});

const renderPage = (u = user, onNavigate = vi.fn()) => render(
  <UserContext.Provider value={{ user: u }}><PaymentPage checkoutData={checkoutData} onNavigate={onNavigate} /></UserContext.Provider>
);
const bodyOf = (call) => JSON.parse(call[1].body);

describe('PaymentPage', () => {
  test('shows the server total and sends only ids, quantities and the delivery choice', async () => {
    fetchMock.mockImplementationOnce(() => json(200, { quote: quote(200000) }));
    renderPage();
    expect((await screen.findAllByText(/200\s?000/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^1\s?000/)).toBeNull();
    const sent = bodyOf(fetchMock.mock.calls[0]);
    expect(sent).toEqual({
      mode: 'quote', account: 'user',
      items: [{ productId: P1, color: null, size: null, quantity: 2 }],
      delivery: { courier: "O'zi olib ketish", pickupPointId: null, district: null, address: 'Yunusobod-19', fullName: 'Buyer', phone: '+998 90 000 00 00' },
      useBonusPoints: false
    });
  });

  test('pays the stored server total with the server order ids', async () => {
    fetchMock
      .mockImplementationOnce(() => json(200, { quote: quote(200000) }))
      .mockImplementationOnce(() => json(201, { order: { orderNumber: 'ORD-1-2', paymeOrderId: '1795000000000123', ...quote(200000) } }));
    renderPage();
    await screen.findAllByText(/200\s?000/);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /payme/i })); });
    expect(bodyOf(fetchMock.mock.calls[1])).toMatchObject({ mode: 'create', expectedTotal: 200000 });
    expect(m.payme).toHaveBeenCalledWith(expect.objectContaining({ orderId: '1795000000000123', amount: 200000, account: { order_id: '1795000000000123' } }));
    expect(window.location.href).toBe('https://checkout.example/pay');
  });

  test('a changed total is shown to the buyer and nothing is paid', async () => {
    fetchMock
      .mockImplementationOnce(() => json(200, { quote: quote(200000) }))
      .mockImplementationOnce(() => json(409, { error: 'TOTAL_MISMATCH', message: 'changed', quote: quote(210000) }));
    renderPage();
    await screen.findAllByText(/200\s?000/);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /payme/i })); });
    await waitFor(() => expect(screen.getAllByText(/210\s?000/).length).toBeGreaterThan(0));
    expect(screen.getByRole('status')).toHaveTextContent('yangilandi');
    expect(m.payme).not.toHaveBeenCalled();
    expect(window.location.href).toBe('http://localhost/payment');
  });

  test('if the quote fails, an error is shown and paying is disabled', async () => {
    fetchMock.mockImplementationOnce(() => json(400, { error: 'PRODUCT_UNAVAILABLE', message: 'Mahsulot mavjud emas' }));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Mahsulot mavjud emas');
    expect(screen.getByRole('button', { name: /payme/i })).toBeDisabled();
  });

  test('a guest sends account guest and no user id', async () => {
    fetchMock.mockImplementationOnce(() => json(200, { quote: quote(200000) }));
    renderPage({ id: 'guest-1', isGuest: true, name: 'Mehmon' });
    await screen.findAllByText(/200\s?000/);
    const sent = bodyOf(fetchMock.mock.calls[0]);
    expect(sent.account).toBe('guest');
    expect(sent).not.toHaveProperty('userId');
  });

  test('an expired session asks the buyer to sign in again and blocks paying', async () => {
    const onNavigate = vi.fn();
    fetchMock.mockImplementationOnce(() => json(401, { error: 'SESSION_REQUIRED', message: 'Sessiya muddati tugagan' }));
    renderPage(user, onNavigate);
    expect(await screen.findByRole('alert')).toHaveTextContent('Sessiya muddati tugagan');
    expect(screen.getByRole('button', { name: /payme/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Telegram orqali kirish' }));
    expect(onNavigate).toHaveBeenCalledWith('login');
  });

  test('out of stock: the reason is shown, paying is blocked and the buyer can go back to the cart', async () => {
    const onNavigate = vi.fn();
    fetchMock.mockImplementationOnce(() => json(409, { error: 'OUT_OF_STOCK', message: '«Choyshab» omborda qolmadi' }));
    renderPage(user, onNavigate);
    expect(await screen.findByRole('alert')).toHaveTextContent('omborda qolmadi');
    expect(screen.getByRole('button', { name: /payme/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Savatga qaytish' }));
    expect(onNavigate).toHaveBeenCalledWith('cart');
  });

  test('sold out between quote and payment: no order, no Payme redirect, reason shown', async () => {
    fetchMock
      .mockImplementationOnce(() => json(200, { quote: quote(200000) }))
      .mockImplementationOnce(() => json(409, { error: 'OUT_OF_STOCK', message: '«Choyshab» omborda faqat 1 dona qoldi' }));
    renderPage();
    await screen.findAllByText(/200\s?000/);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /payme/i })); });
    expect(await screen.findByRole('alert')).toHaveTextContent('faqat 1 dona');
    expect(screen.getByRole('button', { name: /payme/i })).toBeDisabled();
    expect(m.payme).not.toHaveBeenCalled();
    expect(window.location.href).toBe('http://localhost/payment');
  });

  test('a product hidden after it was added to the cart: reason shown, paying blocked, back to the cart', async () => {
    const onNavigate = vi.fn();
    fetchMock.mockImplementationOnce(() => json(400, { error: 'PRODUCT_UNAVAILABLE', message: "«Choyshab» hozir sotuvda yo'q. Uni savatdan olib tashlang" }));
    renderPage(user, onNavigate);
    expect(await screen.findByRole('alert')).toHaveTextContent("sotuvda yo'q");
    expect(screen.getByRole('button', { name: /payme/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Savatga qaytish' }));
    expect(onNavigate).toHaveBeenCalledWith('cart');
    expect(m.payme).not.toHaveBeenCalled();
  });
});
