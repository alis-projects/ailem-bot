// Manual bonus correction in «Foydalanuvchilar»: reason required, sent to the
// server (admin_adjust_bonus via AdminContext.updateUserBonusPoints)
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const m = vi.hoisted(() => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock('../context/ToastContext', () => ({ useToast: () => m.toast }));
vi.mock('../utils/csvExport', () => ({ exportUsers: vi.fn() }));
vi.mock('../services/auditLog', () => ({ logAuditAction: vi.fn(), AUDIT_ACTIONS: {} }));
vi.mock('../services/api', () => ({ usersAPI: { updateRole: vi.fn() } }));

import { AdminContext } from '../context/AdminContext';
import UsersSection from '../components/admin/sections/UsersSection';

const user = { id: 'u1', name: 'Mijoz Bir', bonusPoints: 1000, role: 'customer', createdAt: '2026-11-01T10:00:00Z' };

function renderWith(ctx = {}) {
  const value = { users: [user], refreshUsers: vi.fn(), updateUserBonusPoints: vi.fn().mockResolvedValue({ result: 'ok', old: 1000, new: 1500 }), ...ctx };
  render(<AdminContext.Provider value={value}><UsersSection /></AdminContext.Provider>);
  fireEvent.click(screen.getByTitle("Ballni o'zgartirish"));
  return value;
}
const amount = () => screen.getByPlaceholderText('0');
const reason = () => screen.getByLabelText("Bonus o'zgartirish sababi");

beforeEach(() => vi.clearAllMocks());

describe('manual bonus correction', () => {
  test('without a reason nothing is sent', async () => {
    const ctx = renderWith();
    fireEvent.change(amount(), { target: { value: '500' } });
    await act(async () => { fireEvent.click(screen.getByTitle("Qo'shish")); });
    expect(ctx.updateUserBonusPoints).not.toHaveBeenCalled();
    expect(m.toast.error).toHaveBeenCalledWith('Sababini yozing (kamida 3 belgi)');
  });

  test('credit and debit go to the server with the reason', async () => {
    const ctx = renderWith();
    fireEvent.change(amount(), { target: { value: '500' } });
    fireEvent.change(reason(), { target: { value: '  aksiya sovg\'asi ' } });
    await act(async () => { fireEvent.click(screen.getByTitle("Qo'shish")); });
    expect(ctx.updateUserBonusPoints).toHaveBeenCalledWith('u1', 500, "aksiya sovg'asi");

    fireEvent.click(screen.getByTitle("Ballni o'zgartirish"));
    fireEvent.change(amount(), { target: { value: '200' } });
    fireEvent.change(reason(), { target: { value: 'xato tuzatildi' } });
    await act(async () => { fireEvent.click(screen.getByTitle('Ayirish')); });
    expect(ctx.updateUserBonusPoints).toHaveBeenLastCalledWith('u1', -200, 'xato tuzatildi');
  });

  test('a server refusal is explained', async () => {
    const err = Object.assign(new Error('x'), { code: 'reason_required' });
    renderWith({ updateUserBonusPoints: vi.fn().mockRejectedValue(err) });
    fireEvent.change(amount(), { target: { value: '5' } });
    fireEvent.change(reason(), { target: { value: 'abc' } });
    await act(async () => { fireEvent.click(screen.getByTitle("Qo'shish")); });
    expect(m.toast.error).toHaveBeenCalledWith('Sababini yozing (kamida 3 belgi)');
  });
});
