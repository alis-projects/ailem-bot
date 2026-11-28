import { useState, useContext, useMemo, useEffect } from 'react';
import {
  X, Users as UsersIcon, Truck, ShoppingBag, DollarSign,
  Download, FileDown, RotateCw, Package, Printer
} from 'lucide-react';
import { AdminContext } from '../../../context/AdminContext';
import { useToast } from '../../../context/ToastContext';
import { useConfirm } from '../../../context/ConfirmContext';
import { formatPrice, formatDate, getStatusLabel } from '../../../utils/helpers';
import { inTashkentDayRange, orderMatchesSearch } from '../../../utils/orderFilters';
import { exportOrders, exportOrderItems } from '../../../utils/csvExport';
import { notifyReferrerReward } from '../../../services/telegram';
import { printShippingLabel, printMultipleLabels } from '../../../utils/shippingLabel';
import { printPackingSlip, printMultiplePackingSlips } from '../../../utils/packingSlip';

const OrdersSection = ({ onImageClick }) => {
  const { orders, approveOrder, rejectOrder, updateOrderStatus, loadAllData, confirmReturn, getBonusRecords } = useContext(AdminContext);
  const toast = useToast();
  const confirm = useConfirm();
  const [statusFilter, setStatusFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all'); // 'all', 'online', 'cash'
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [bonusRecords, setBonusRecords] = useState(null);

  // Bonus history of the open order (accruals, debt repayments, refunds, debts)
  useEffect(() => {
    let alive = true;
    setBonusRecords(null);
    if (!selectedOrder || !getBonusRecords) return undefined;
    getBonusRecords(selectedOrder)
      .then(r => { if (alive) setBonusRecords(r); })
      .catch(e => console.error('Failed to load bonus history:', e));
    return () => { alive = false; };
  }, [selectedOrder?.dbId, selectedOrder?.refundedAt, getBonusRecords]);
  const [selectedOrders, setSelectedOrders] = useState([]);
  const [bulkAction, setBulkAction] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  // Bulk operation loading state
  const [bulkProgress, setBulkProgress] = useState({ isProcessing: false, current: 0, total: 0, action: '' });
  // Date range filter
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  // Search: order number, customer name, phone (works together with the filters)
  const [searchQuery, setSearchQuery] = useState('');

  const filteredOrders = useMemo(() => {
    return orders.filter(order => {
      // Status filter
      const matchesStatus = statusFilter === 'all' || order.status === statusFilter;

      // Source filter (online vs cash)
      const isCashOrder = order.paymentMethod === 'cash';
      const matchesSource = sourceFilter === 'all' ||
        (sourceFilter === 'cash' && isCashOrder) ||
        (sourceFilter === 'online' && !isCashOrder);

      // Date filter: whole Tashkent calendar days, inclusive (audit finding 6)
      const matchesDate = inTashkentDayRange(order.createdAt || order.date, dateFrom, dateTo);

      return matchesStatus && matchesSource && matchesDate && orderMatchesSearch(order, searchQuery);
    });
  }, [orders, statusFilter, sourceFilter, dateFrom, dateTo, searchQuery]);

  // Count orders by source
  const cashOrdersCount = orders.filter(o => o.paymentMethod === 'cash').length;
  const onlineOrdersCount = orders.filter(o => o.paymentMethod !== 'cash').length;

  const pillClass = (status) => {
    const s = String(status).toLowerCase();
    if (s === 'approved' || s === 'delivered' || s === 'completed') return 'a-pill-ok';
    if (s === 'pending') return 'a-pill-warn';
    if (s === 'rejected') return 'a-pill-danger';
    if (s === 'return_pending') return 'a-pill-warn';
    return 'a-pill-info';
  };

  // Readable reason when the database refused an approval (nothing changed)
  const approveErrorMessage = (error) => {
    if (error?.code === 'insufficient_stock') {
      const list = (error.items || []).map(i =>
        `${i.name || i.productId}${i.color ? ` (${i.color}${i.size ? ` / ${i.size}` : ''})` : ''}: ${i.available ?? 0} / ${i.requested ?? '?'}`
      ).join('; ');
      return `Omborda yetarli mahsulot yo'q, buyurtma o'zgartirilmadi. ${list}`;
    }
    if (error?.code === 'already_fulfilled' || error?.code === 'not_pending') {
      return `Buyurtma allaqachon qayta ishlangan (${error.status ? getStatusLabel(error.status) : 'holat o\'zgargan'}). Ro'yxatni yangilang.`;
    }
    return 'Buyurtmani tasdiqlashda xatolik. Qayta urinib ko\'ring.';
  };

  // An already processed order cannot be rejected until a return flow exists
  // Payme transaction open far past Payme's timeout: reconcile manually in
  // the Payme merchant cabinet (see reconcile_payment_reservations)
  const needsPaymeReview = (order) => order.status === 'pending' && !!order.paymeReviewRequiredAt;

  const rejectErrorMessage = (error) => {
    if (error?.code === 'already_processed') {
      return `Buyurtma allaqachon qayta ishlangan (${error.status ? getStatusLabel(error.status) : 'to\'langan'}), uni rad etib bo'lmaydi: mahsulot va bonuslarni qaytarish hali qo'llab-quvvatlanmaydi. Holat o'zgartirilmadi.`;
    }
    if (error?.code === 'already_rejected') return 'Buyurtma allaqachon rad etilgan.';
    if (error?.code === 'not_pending') return `Buyurtma holati: ${getStatusLabel(error.status)}. Rad etib bo'lmaydi.`;
    return 'Buyurtmani rad etishda xatolik. Qayta urinib ko\'ring.';
  };

  const handleApprove = async (orderId) => {
    const order = orders.find(o => o.id === orderId);
    if (!order) return;

    const confirmed = await confirm({
      title: 'Buyurtmani tasdiqlash',
      message: 'Buyurtmani tasdiqlamoqchimisiz? Ombordagi mahsulotlar kamaytiriladi va bonus ballar beriladi.',
      type: 'success',
      confirmText: 'Tasdiqlash',
      cancelText: 'Bekor qilish'
    });

    if (confirmed) {
      try {
        // Stock, bonuses and status are applied by the database in one
        // transaction (admin_approve_order); the customer is notified there too.
        const { referrer } = await approveOrder(orderId);
        toast.success('Buyurtma muvaffaqiyatli tasdiqlandi');
        if (referrer?.telegram_id && referrer.commission > 0) {
          try {
            await notifyReferrerReward(referrer, referrer.commission, referrer.referrals || 0);
          } catch (notifyError) {
            console.error('❌ Failed to notify referrer:', notifyError);
          }
        }
      } catch (error) {
        console.error('❌ Failed to approve order:', error);
        toast.error(approveErrorMessage(error));
      }
    }
  };

  const handleReject = async (orderId) => {
    const order = orders.find(o => o.id === orderId);
    if (!order) return;

    const confirmed = await confirm({
      title: 'Buyurtmani rad etish',
      message: 'Buyurtmani rad etmoqchimisiz? Faqat hali qayta ishlanmagan (to\'lanmagan va tasdiqlanmagan) buyurtmani rad etish mumkin.',
      type: 'danger',
      confirmText: 'Rad etish',
      cancelText: 'Bekor qilish'
    });

    if (confirmed) {
      try {
        // Decided in the database (admin_reject_order); the customer is
        // notified by rejectOrder. Processed orders are refused, see below.
        await rejectOrder(orderId);
        toast.success('Buyurtma rad etildi');
      } catch (error) {
        console.error('❌ Failed to reject order:', error);
        toast.error(rejectErrorMessage(error));
      }
    }
  };

  // Why the database refused a status change (nothing changed)
  const statusErrorMessage = (error) => {
    if (error?.code === 'not_allowed') return `Buyurtma holati: ${getStatusLabel(error.status)}. Bu holatdan o'zgartirib bo'lmaydi.`;
    if (error?.code === 'status_changed') return `Buyurtma holati o'zgargan: ${getStatusLabel(error.status)}. Ro'yxat yangilandi.`;
    if (error?.code === 'not_found') return 'Buyurtma topilmadi';
    if (error?.code === 'forbidden') return "Ruxsat yo'q";
    return "Holatni yangilashda xatolik. Qayta urinib ko'ring.";
  };

  const handleMarkShipped = async (orderId) => {
    const order = orders.find(o => o.id === orderId);
    if (!order) return;

    const confirmed = await confirm({
      title: 'Jo\'natildi deb belgilash',
      message: 'Buyurtmani jo\'natildi deb belgilamoqchimisiz? Mijozga xabar yuboriladi.',
      type: 'info',
      confirmText: 'Jo\'natildi',
      cancelText: 'Bekor qilish'
    });

    if (confirmed) {
      try {
        // the customer is notified by updateOrderStatus
        await updateOrderStatus(orderId, 'shipped');
        toast.success('Buyurtma jo\'natildi deb belgilandi');
      } catch (error) {
        console.error('❌ Failed to mark as shipped:', error);
        toast.error(statusErrorMessage(error));
      }
    }
  };

  const handleMarkDelivered = async (orderId) => {
    const order = orders.find(o => o.id === orderId);
    if (!order) return;

    const confirmed = await confirm({
      title: 'Yetkazildi deb belgilash',
      message: 'Buyurtmani yetkazildi deb belgilamoqchimisiz? Mijozga xabar yuboriladi.',
      type: 'success',
      confirmText: 'Yetkazildi',
      cancelText: 'Bekor qilish'
    });

    if (confirmed) {
      try {
        // the customer is notified by updateOrderStatus
        await updateOrderStatus(orderId, 'delivered');
        toast.success('Buyurtma yetkazildi deb belgilandi');
      } catch (error) {
        console.error('❌ Failed to mark as delivered:', error);
        toast.error(statusErrorMessage(error));
      }
    }
  };

  // Refunded after shipping: the goods came back → stock, once
  const handleConfirmReturn = async (orderId) => {
    const order = orders.find(o => o.id === orderId);
    if (!order) return;
    const confirmed = await confirm({
      title: 'Qaytgan mahsulotni qabul qilish',
      message: "Pul Payme orqali qaytarilgan. Mahsulot sizga qaytib keldimi? Tasdiqlasangiz, buyurtmadagi mahsulotlar omborga qaytariladi (bir marta).",
      type: 'warning',
      confirmText: 'Qabul qilindi',
      cancelText: 'Bekor qilish'
    });
    if (!confirmed) return;
    try {
      const result = await confirmReturn(orderId);
      toast.success(result?.result === 'already_received' ? 'Mahsulot allaqachon qabul qilingan' : 'Mahsulot omborga qaytarildi');
    } catch (error) {
      console.error('❌ Failed to confirm return:', error);
      toast.error(error?.code === 'not_awaiting_return'
        ? `Buyurtma holati: ${getStatusLabel(error.status)}. Qaytarish kutilmayapti.`
        : "Qabul qilishda xatolik. Qayta urinib ko'ring.");
    }
  };

  const handleSelectOrder = (orderId) => {
    setSelectedOrders(prev =>
      prev.includes(orderId)
        ? prev.filter(id => id !== orderId)
        : [...prev, orderId]
    );
  };

  // Bulk actions apply only to the selected orders the current filter shows
  // (audit finding 4): a selection hidden by a filter change is never touched
  const visibleIds = useMemo(() => new Set(filteredOrders.map(o => o.id)), [filteredOrders]);
  const visibleSelected = useMemo(() => selectedOrders.filter(id => visibleIds.has(id)), [selectedOrders, visibleIds]);
  const hiddenSelectedCount = selectedOrders.length - visibleSelected.length;

  const handleSelectAll = () => {
    if (filteredOrders.length > 0 && visibleSelected.length === filteredOrders.length) {
      setSelectedOrders([]);
    } else {
      setSelectedOrders(filteredOrders.map(o => o.id));
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await loadAllData();
    } catch (error) {
      console.error('❌ Failed to refresh orders:', error);
    } finally {
      setIsRefreshing(false);
    }
  };

  // Which status each bulk action applies to
  const BULK_ACTIONS = {
    'Approve': { label: 'Tasdiqlash', from: 'pending' },
    'Mark as Shipped': { label: 'Jo\'natildi', from: 'approved' },
    'Mark as Delivered': { label: 'Yetkazildi', from: 'shipped' },
    'Reject': { label: 'Rad etish', from: 'pending' }
  };
  // a refusal returned by the database operation (a known result code), as
  // opposed to a network / unexpected error
  const isServerRefusal = (err) => typeof err?.code === 'string' && /^[a-z_]+$/.test(err.code) && err.code !== 'failed';

  const handleBulkAction = async () => {
    const spec = BULK_ACTIONS[bulkAction];
    if (!spec || visibleSelected.length === 0) {
      toast.warning('Iltimos, buyurtmalar va amalni tanlang');
      return;
    }
    const action = bulkAction;
    // only what is selected AND visible now; status as the list shows it
    const targets = visibleSelected.map(id => orders.find(o => o.id === id)).filter(Boolean);
    const applicable = targets.filter(o => o.status === spec.from);
    const notApplicable = targets.length - applicable.length;

    if (applicable.length === 0) {
      toast.warning(`Tanlangan ${targets.length} ta buyurtmaning hech biri «${spec.label}» uchun mos holatda emas`);
      return;
    }

    const lines = [`«${spec.label}» ${applicable.length} ta buyurtmaga qo'llanadi.`];
    if (notApplicable) lines.push(`${notApplicable} tasi holati mos emas — o'tkazib yuboriladi.`);
    if (hiddenSelectedCount) lines.push(`Filtrda ko'rinmaydigan ${hiddenSelectedCount} ta tanlangan buyurtmaga tegilmaydi.`);
    const confirmed = await confirm({
      title: 'Ommaviy amal',
      message: lines.join(' '),
      type: action === 'Reject' ? 'danger' : 'info',
      confirmText: `${spec.label} (${applicable.length})`,
      cancelText: 'Bekor qilish'
    });
    if (!confirmed) return;

    setBulkProgress({ isProcessing: true, current: 0, total: applicable.length, action: spec.label });
    let updated = 0;
    let refused = 0;   // the database refused (status changed meanwhile, not allowed, no stock, …)
    let errors = 0;    // network / unexpected

    try {
      for (let i = 0; i < applicable.length; i++) {
        const orderId = applicable[i].id;
        setBulkProgress(prev => ({ ...prev, current: i + 1 }));
        try {
          if (action === 'Approve') await approveOrder(orderId);
          else if (action === 'Reject') await rejectOrder(orderId);
          else await updateOrderStatus(orderId, action === 'Mark as Shipped' ? 'shipped' : 'delivered');
          updated++;
        } catch (err) {
          console.error(`Failed to ${action} order ${orderId}:`, err);
          if (isServerRefusal(err)) refused++;
          else errors++;
        }
      }

      setSelectedOrders([]);
      setBulkAction('');

      const summary = `Yangilandi: ${updated} · Holati mos emas (o'tkazildi): ${notApplicable} · Server rad etdi: ${refused}` + (errors ? ` · Xato: ${errors}` : '');
      if (notApplicable || refused || errors) toast.warning(summary);
      else toast.success(summary);
    } catch (error) {
      console.error('❌ Bulk action failed:', error);
      toast.error('Ommaviy amal bajarilmadi. Qayta urinib ko\'ring.');
    } finally {
      setBulkProgress({ isProcessing: false, current: 0, total: 0, action: '' });
    }
  };

  return (
    <div className="a-card">
      <div className="a-card-h" style={{ flexWrap: 'wrap', gap: 12 }}>
        <h3>Buyurtmalarni boshqarish</h3>
        <div className="flex gap-2">
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="a-btn disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RotateCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            Yangilash
          </button>

          <div className="relative group">
            <button className="a-btn">
              <Download className="w-4 h-4" />
              CSV yuklab olish
            </button>
            <div className="a-card absolute right-0 mt-1 w-48 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-10" style={{ overflow: 'hidden' }}>
              <button
                onClick={() => exportOrders(filteredOrders, `orders_${statusFilter}`)}
                className="w-full px-4 py-2 text-left text-sm flex items-center gap-2 hover:bg-[var(--surface-2)]"
                style={{ color: 'var(--text)' }}
              >
                <FileDown className="w-4 h-4" />
                Buyurtmalar hisoboti
              </button>
              <button
                onClick={() => exportOrderItems(filteredOrders, `order_items_${statusFilter}`)}
                className="w-full px-4 py-2 text-left text-sm flex items-center gap-2 hover:bg-[var(--surface-2)]"
                style={{ color: 'var(--text)', borderTop: '1px solid var(--border)' }}
              >
                <FileDown className="w-4 h-4" />
                Buyurtma tafsilotlari
              </button>
            </div>
          </div>

          <select
            className="a-input"
            style={{ width: 'auto' }}
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
          >
            <option value="all">Barcha buyurtmalar ({orders.length})</option>
            <option value="online">Onlayn ({onlineOrdersCount})</option>
            <option value="cash">Naqd/POS ({cashOrdersCount})</option>
          </select>

          <select
            className="a-input"
            style={{ width: 'auto' }}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="all">Barcha holatlar</option>
            <option value="pending">Kutilmoqda ({orders.filter(o => o.status === 'pending').length})</option>
            <option value="approved">Tasdiqlangan ({orders.filter(o => o.status === 'approved').length})</option>
            <option value="shipped">Jo'natilgan ({orders.filter(o => o.status === 'shipped').length})</option>
            <option value="delivered">Yetkazilgan ({orders.filter(o => o.status === 'delivered').length})</option>
            <option value="completed">Bajarilgan ({orders.filter(o => o.status === 'completed').length})</option>
            <option value="rejected">Rad etilgan ({orders.filter(o => o.status === 'rejected').length})</option>
            <option value="return_pending">Qaytarish kutilmoqda ({orders.filter(o => o.status === 'return_pending').length})</option>
            <option value="refunded">Qaytarilgan ({orders.filter(o => o.status === 'refunded').length})</option>
          </select>
        </div>
      </div>

      <div className="p-4 space-y-4" style={{ borderBottom: '1px solid var(--border)' }}>
        {/* Search */}
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Qidirish: buyurtma raqami, ism yoki telefon"
            aria-label="Buyurtmalarni qidirish"
            className="a-input"
            style={{ minWidth: 280, flex: '1 1 280px', maxWidth: 420 }}
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="a-btn"
              style={{ padding: '4px 9px', fontSize: 11 }}
            >
              Qidiruvni tozalash
            </button>
          )}
        </div>

        {/* Date Range Filter */}
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium a-muted" title="Toshkent vaqti bo'yicha butun kunlar">Sana oralig'i (Toshkent vaqti):</span>
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              aria-label="Sanadan"
              className="a-input"
              style={{ width: 'auto' }}
              placeholder="Dan"
            />
            <span className="a-faint">-</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              aria-label="Sanagacha"
              className="a-input"
              style={{ width: 'auto' }}
              placeholder="Gacha"
            />
          </div>
          {(dateFrom || dateTo) && (
            <button
              onClick={() => { setDateFrom(''); setDateTo(''); }}
              className="a-btn"
              style={{ padding: '4px 9px', fontSize: 11 }}
            >
              Sanalarni tozalash
            </button>
          )}
          <span className="ml-auto text-sm a-faint" data-testid="orders-count">
            {orders.length} tadan {filteredOrders.length} ta ko'rsatilmoqda
          </span>
        </div>

        {/* Bulk Operation Progress */}
        {bulkProgress.isProcessing && (
          <div className="p-4 rounded-lg" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
                {bulkProgress.action}: {bulkProgress.current} / {bulkProgress.total}
              </span>
              <span className="text-sm a-num a-muted">
                {Math.round((bulkProgress.current / bulkProgress.total) * 100)}%
              </span>
            </div>
            <div className="w-full rounded-full h-2.5" style={{ background: 'var(--border)' }}>
              <div
                className="h-2.5 rounded-full transition-all duration-300"
                style={{ width: `${(bulkProgress.current / bulkProgress.total) * 100}%`, background: 'var(--accent)' }}
              />
            </div>
            <p className="text-xs mt-2 a-muted">Buyurtmalar qayta ishlanmoqda, iltimos kuting...</p>
          </div>
        )}

        {selectedOrders.length > 0 && !bulkProgress.isProcessing && (
          <div className="flex items-center gap-3 p-3 rounded-lg flex-wrap" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
            <span className="text-sm font-semibold" style={{ color: 'var(--text)' }} data-testid="bulk-selected">
              {visibleSelected.length} ta buyurtma tanlandi
            </span>
            {hiddenSelectedCount > 0 && (
              <span className="text-xs a-muted" data-testid="bulk-hidden">
                (+{hiddenSelectedCount} ta filtrda yashirin — ularga amal qo'llanmaydi)
              </span>
            )}
            <button
              onClick={() => {
                const ordersToPrint = orders.filter(o => visibleSelected.includes(o.id));
                printMultiplePackingSlips(ordersToPrint);
              }}
              disabled={visibleSelected.length === 0}
              className="a-btn disabled:opacity-50"
            >
              <Package className="w-4 h-4" />
              Qadoqlash {visibleSelected.length}
            </button>
            <button
              onClick={() => {
                const ordersToPrint = orders.filter(o => visibleSelected.includes(o.id));
                printMultipleLabels(ordersToPrint);
              }}
              disabled={visibleSelected.length === 0}
              className="a-btn disabled:opacity-50"
            >
              <Printer className="w-4 h-4" />
              Yorliq {visibleSelected.length}
            </button>
            <select
              value={bulkAction}
              onChange={(e) => setBulkAction(e.target.value)}
              className="a-input"
              style={{ width: 'auto' }}
            >
              <option value="">Amalni tanlang</option>
              <option value="Approve">Tasdiqlash</option>
              <option value="Mark as Shipped">Jo'natildi deb belgilash</option>
              <option value="Mark as Delivered">Yetkazildi deb belgilash</option>
              <option value="Reject">Rad etish</option>
            </select>
            <button
              onClick={handleBulkAction}
              disabled={!bulkAction || bulkProgress.isProcessing || visibleSelected.length === 0}
              className="a-btn a-btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {bulkProgress.isProcessing ? 'Bajarilmoqda...' : 'Qo\'llash'}
            </button>
            <button
              onClick={() => setSelectedOrders([])}
              className="a-btn"
            >
              Tozalash
            </button>
          </div>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="a-table">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  checked={filteredOrders.length > 0 && visibleSelected.length === filteredOrders.length}
                  onChange={handleSelectAll}
                  className="w-4 h-4 rounded"
                  style={{ accentColor: 'var(--accent)' }}
                />
              </th>
              <th>Buyurtma ID</th>
              <th>Mijoz</th>
              <th>Sana</th>
              <th>Jami</th>
              <th>Holat</th>
              <th>Amallar</th>
            </tr>
          </thead>
          <tbody>
            {filteredOrders.length === 0 ? (
              <tr>
                <td colSpan="7" className="text-center a-faint" style={{ padding: '48px 24px' }}>
                  Tanlangan filtr uchun buyurtma topilmadi
                </td>
              </tr>
            ) : (
              filteredOrders.map((order) => (
                <tr key={order.id} style={selectedOrders.includes(order.id) ? { background: 'var(--accent-weak)' } : undefined}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selectedOrders.includes(order.id)}
                      onChange={() => handleSelectOrder(order.id)}
                      className="w-4 h-4 rounded"
                      style={{ accentColor: 'var(--accent)' }}
                    />
                  </td>
                  <td className="a-num" style={{ fontWeight: 500, color: 'var(--text)' }}>
                    <div className="flex items-center gap-2">
                      #{order.id}
                      {order.paymentMethod === 'cash' && (
                        <span className="a-pill a-pill-ok">
                          POS
                        </span>
                      )}
                      {needsPaymeReview(order) && (
                        <span className="a-pill a-pill-danger" title={order.paymeReviewReason || ''}>
                          Payme: tekshiring
                        </span>
                      )}
                    </div>
                  </td>
                  <td style={{ color: 'var(--text)' }}>{order.userName}</td>
                  <td className="a-muted">{formatDate(order.createdAt || order.date)}</td>
                  <td className="a-num" style={{ fontWeight: 500, color: 'var(--text)' }}>{formatPrice(order.total)}</td>
                  <td>
                    <span className={`a-pill ${pillClass(order.status)}`}>
                      {getStatusLabel(order.status)}
                    </span>
                    {order.refund?.needs_reconciliation && (
                      <span className="a-pill a-pill-danger ml-1">Sverka talab qilinadi</span>
                    )}
                  </td>
                  <td>
                    <div className="flex gap-2 flex-wrap items-center">
                      <button
                        onClick={() => setSelectedOrder(order)}
                        className="font-medium whitespace-nowrap"
                        style={{ color: 'var(--accent-ink)' }}
                      >
                        Ko'rish
                      </button>
                      {order.status === 'pending' && (
                        <>
                          <button
                            onClick={() => handleApprove(order.id)}
                            className="font-medium whitespace-nowrap"
                            style={{ color: 'var(--ok)' }}
                          >
                            Tasdiqlash
                          </button>
                          <button
                            onClick={() => handleReject(order.id)}
                            className="font-medium whitespace-nowrap"
                            style={{ color: 'var(--danger)' }}
                          >
                            Rad etish
                          </button>
                        </>
                      )}
                      {order.status === 'approved' && (
                        <>
                          <button
                            onClick={() => printPackingSlip(order)}
                            className="font-medium whitespace-nowrap flex items-center gap-1"
                            style={{ color: 'var(--warn)' }}
                          >
                            <Package className="w-4 h-4" />
                            Qadoqlash
                          </button>
                          <button
                            onClick={() => printShippingLabel(order)}
                            className="font-medium whitespace-nowrap flex items-center gap-1"
                            style={{ color: 'var(--ok)' }}
                          >
                            <Printer className="w-4 h-4" />
                            Yorliq
                          </button>
                          <button
                            onClick={() => handleMarkShipped(order.id)}
                            className="font-medium whitespace-nowrap"
                            style={{ color: 'var(--accent-ink)' }}
                          >
                            Jo'natildi
                          </button>
                        </>
                      )}
                      {order.status === 'return_pending' && (
                        <button
                          onClick={() => handleConfirmReturn(order.id)}
                          className="font-medium whitespace-nowrap"
                          style={{ color: 'var(--warn)' }}
                        >
                          Qabul qilindi
                        </button>
                      )}
                      {order.status === 'shipped' && (
                        <>
                          <button
                            onClick={() => printShippingLabel(order)}
                            className="font-medium whitespace-nowrap flex items-center gap-1"
                            style={{ color: 'var(--ok)' }}
                          >
                            <Printer className="w-4 h-4" />
                            Yorliq
                          </button>
                          <button
                            onClick={() => handleMarkDelivered(order.id)}
                            className="font-medium whitespace-nowrap"
                            style={{ color: 'var(--info)' }}
                          >
                            Yetkazildi
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Order Details Modal */}
      {selectedOrder && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setSelectedOrder(null)}>
          <div className="a-card max-w-2xl w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="a-card-h">
              <h3 style={{ fontSize: 18 }}>Buyurtma #{selectedOrder.id}</h3>
              <button onClick={() => setSelectedOrder(null)} className="a-faint hover:text-[var(--text)]">
                <X className="w-6 h-6" />
              </button>
            </div>
            <div className="p-6 space-y-6">
              {/* Customer Information */}
              <div>
                <h4 className="font-semibold text-lg mb-3 flex items-center gap-2" style={{ color: 'var(--text)' }}>
                  <UsersIcon className="w-5 h-5" style={{ color: 'var(--text-2)' }} />
                  Mijoz ma'lumotlari
                </h4>
                <div className="rounded-lg p-4 space-y-2" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
                  <div className="flex justify-between">
                    <span className="text-sm a-muted">Ism:</span>
                    <span className="text-sm font-medium" style={{ color: 'var(--text)' }}>{selectedOrder.userName}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm a-muted">Telefon:</span>
                    <span className="text-sm font-medium" style={{ color: 'var(--text)' }}>{selectedOrder.userPhone}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm a-muted">Foydalanuvchi ID:</span>
                    <span className="text-sm font-medium" style={{ color: 'var(--text)' }}>{selectedOrder.userId}</span>
                  </div>
                </div>
              </div>

              {/* Delivery Information */}
              {selectedOrder.deliveryInfo && (
                <div>
                  <h4 className="font-semibold text-lg mb-3 flex items-center gap-2" style={{ color: 'var(--text)' }}>
                    <Truck className="w-5 h-5" style={{ color: 'var(--text-2)' }} />
                    Yetkazib berish tafsilotlari
                  </h4>
                  <div className="rounded-lg p-4 space-y-2" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
                    {selectedOrder.deliveryInfo.fullName && (
                      <div className="flex justify-between">
                        <span className="text-sm a-muted">Qabul qiluvchi:</span>
                        <span className="text-sm font-medium" style={{ color: 'var(--text)' }}>{selectedOrder.deliveryInfo.fullName}</span>
                      </div>
                    )}
                    {selectedOrder.deliveryInfo.phone && (
                      <div className="flex justify-between">
                        <span className="text-sm a-muted">Aloqa:</span>
                        <span className="text-sm font-medium" style={{ color: 'var(--text)' }}>{selectedOrder.deliveryInfo.phone}</span>
                      </div>
                    )}
                    {selectedOrder.deliveryInfo.city && (
                      <div className="flex justify-between">
                        <span className="text-sm a-muted">Shahar:</span>
                        <span className="text-sm font-medium" style={{ color: 'var(--text)' }}>{selectedOrder.deliveryInfo.city}</span>
                      </div>
                    )}
                    {selectedOrder.deliveryInfo.address && (
                      <div>
                        <span className="text-sm a-muted block mb-1">Manzil:</span>
                        <span className="text-sm font-medium" style={{ color: 'var(--text)' }}>{selectedOrder.deliveryInfo.address}</span>
                      </div>
                    )}
                    {selectedOrder.courier && (
                      <div className="pt-2" style={{ borderTop: '1px solid var(--border)' }}>
                        <div className="flex justify-between">
                          <span className="text-sm a-muted">Kuryer xizmati:</span>
                          <span className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
                            {typeof selectedOrder.courier === 'string' && selectedOrder.courier.startsWith('{')
                              ? JSON.parse(selectedOrder.courier).name
                              : typeof selectedOrder.courier === 'object'
                              ? selectedOrder.courier.name
                              : selectedOrder.courier}
                          </span>
                        </div>
                      </div>
                    )}
                    {selectedOrder.deliveryFee > 0 && (
                      <div className="flex justify-between">
                        <span className="text-sm a-muted">Yetkazib berish narxi:</span>
                        <span className="text-sm font-medium" style={{ color: 'var(--text)' }}>{formatPrice(selectedOrder.deliveryFee)}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}


              {/* Order Items */}
              <div>
                <h4 className="font-semibold text-lg mb-3 flex items-center gap-2" style={{ color: 'var(--text)' }}>
                  <ShoppingBag className="w-5 h-5" style={{ color: 'var(--text-2)' }} />
                  Buyurtma tarkibi
                </h4>
                <div className="space-y-3">
                  {selectedOrder.items?.map((item, idx) => (
                    <div key={idx} className="flex items-start gap-3 p-3 rounded-lg" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
                      {item.image && (
                        <img
                          src={item.image}
                          alt={item.productName || item.name}
                          className="w-16 h-16 object-cover rounded"
                          onError={(e) => e.target.style.display = 'none'}
                        />
                      )}
                      <div className="flex-1">
                        <p className="font-medium" style={{ color: 'var(--text)' }}>
                          {item.productName || item.name || 'Noma\'lum mahsulot'}
                        </p>
                        {(item.color || item.size) && (
                          <p className="text-xs a-faint mt-1">
                            {item.color && <span>{item.color}</span>}
                            {item.color && item.size && <span> • </span>}
                            {item.size && <span>{item.size}</span>}
                          </p>
                        )}
                        <p className="text-sm a-muted mt-1">Soni: {item.quantity}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-semibold a-num" style={{ color: 'var(--text)' }}>
                          {formatPrice(item.price * item.quantity)}
                        </p>
                        <p className="text-xs a-faint a-num">
                          {formatPrice(item.price)} / dona
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Order Summary */}
              <div className="rounded-lg p-4 space-y-2" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
                <h4 className="font-semibold text-lg mb-3 flex items-center gap-2" style={{ color: 'var(--text)' }}>
                  <DollarSign className="w-5 h-5" style={{ color: 'var(--text-2)' }} />
                  Buyurtma hisoboti
                </h4>
                <div className="space-y-2">
                  {selectedOrder.subtotal && (
                    <div className="flex justify-between text-sm">
                      <span className="a-muted">Oraliq summa:</span>
                      <span className="font-medium a-num" style={{ color: 'var(--text)' }}>{formatPrice(selectedOrder.subtotal)}</span>
                    </div>
                  )}
                  {selectedOrder.deliveryFee > 0 && (
                    <div className="flex justify-between text-sm">
                      <span className="a-muted">Yetkazib berish narxi:</span>
                      <span className="font-medium a-num" style={{ color: 'var(--text)' }}>{formatPrice(selectedOrder.deliveryFee)}</span>
                    </div>
                  )}
                  {selectedOrder.bonusDiscount > 0 && (
                    <div className="flex justify-between text-sm">
                      <span style={{ color: 'var(--ok)' }}>Bonus chegirma:</span>
                      <span className="font-medium a-num" style={{ color: 'var(--ok)' }}>-{formatPrice(selectedOrder.bonusDiscount)}</span>
                    </div>
                  )}
                  {selectedOrder.bonusPointsUsed > 0 && (
                    <div className="flex justify-between text-sm">
                      <span className="a-muted">Ishlatilgan bonus:</span>
                      <span className="font-medium a-num" style={{ color: 'var(--text)' }}>{selectedOrder.bonusPointsUsed} ball</span>
                    </div>
                  )}
                  <div className="pt-2 mt-2" style={{ borderTop: '1px solid var(--border-strong)' }}>
                    <div className="flex justify-between">
                      <span className="text-lg font-bold" style={{ color: 'var(--text)' }}>Jami:</span>
                      <span className="text-lg font-bold a-num" style={{ color: 'var(--accent-ink)' }}>{formatPrice(selectedOrder.total)}</span>
                    </div>
                  </div>

                  {selectedOrder.refundedAt && (
                    <div role="note" className="pt-2 mt-2 text-sm space-y-1" style={{ borderTop: '1px solid var(--border-strong)' }}>
                      <div className="font-medium" style={{ color: 'var(--text)' }}>
                        Pul qaytarilgan ({selectedOrder.refund?.source?.startsWith('payme:') ? 'Payme' : selectedOrder.refund?.source || '—'}), {formatDate(selectedOrder.refundedAt)}
                      </div>
                      <div className="a-muted">
                        Ombor: {selectedOrder.refund?.stock === 'returned'
                          ? 'mahsulot qaytarildi'
                          : selectedOrder.refund?.stock === 'awaiting_return'
                          ? "mahsulot qaytib kelishi kutilmoqda — kelganda «Qabul qilindi» ni bosing"
                          : "o'zgartirilmadi (buyurtma tizimda yakunlanmagan edi)"}
                      </div>
                      <div className="a-muted">
                        Bonus: {selectedOrder.refund?.bonus_returned || 0} ball qaytarildi, {selectedOrder.refund?.bonus_revoked || 0} ball bekor qilindi
                      </div>
                      {selectedOrder.refund?.needs_reconciliation && (
                        <div style={{ color: 'var(--danger)' }}>
                          <div className="font-medium">Sverka talab qilinadi</div>
                          {(selectedOrder.refund.reconcile || []).map((r) => (
                            <div key={r}>
                              {r === 'bonus_earned_unrecorded'
                                ? "Xarid uchun berilgan bonus miqdori operatsiyalar tarixida yo'q — mijoz va taklif qilgan mijoz balansi o'zgartirilmadi."
                                : r === 'bonus_used_unconfirmed'
                                ? `Buyurtmada ishlatilgan ${selectedOrder.bonusPointsUsed || 0} ball tarixda tasdiqlanmagan — qaytarilmadi.`
                                : r === 'not_fulfilled'
                                ? "Buyurtma tizimda yakunlanmagan — ombor va bonuslar o'zgartirilmadi."
                                : r}
                            </div>
                          ))}
                        </div>
                      )}
                      {selectedOrder.refund?.bonus_shortfall > 0 && (
                        <div style={{ color: 'var(--danger)' }}>
                          Mijoz {selectedOrder.refund.bonus_shortfall} ball bonusni allaqachon sarflagan — bonus qarzi sifatida yozildi, keyingi bonuslardan avtomatik to'lanadi.
                        </div>
                      )}
                      {selectedOrder.refund?.referrer_revoked > 0 && (
                        <div className="a-muted">Taklif qilgan mijozdan {selectedOrder.refund.referrer_revoked} ball bekor qilindi</div>
                      )}
                      {selectedOrder.refund?.referrer_shortfall > 0 && (
                        <div style={{ color: 'var(--danger)' }}>
                          Taklif qilgan mijoz {selectedOrder.refund.referrer_shortfall} ball bonusni allaqachon sarflagan — bonus qarzi sifatida yozildi.
                        </div>
                      )}
                    </div>
                  )}

                  {bonusRecords?.history?.length > 0 && (
                    <div role="group" aria-label="Bonus tarixi" className="pt-2 mt-2 text-sm space-y-1" style={{ borderTop: '1px solid var(--border-strong)' }}>
                      <div className="font-medium" style={{ color: 'var(--text)' }}>Bonus tarixi</div>
                      {bonusRecords.history.map((h) => {
                        const debt = bonusRecords.debts.find(d => d.id === h.debt_id);
                        const isBuyer = debt ? debt.role === 'buyer' : String(h.user_id) === String(selectedOrder.userId);
                        const who = isBuyer ? 'Mijoz' : 'Taklif qilgan mijoz';
                        const ref = debt ? ` (qarz #${debt.orderNumber}, qoldi ${h.debt_remaining_after ?? debt.remaining} ball)` : '';
                        const text = {
                          earned: `Mijozga bonus: +${h.amount} ball`,
                          commission: `Taklif qilgan mijozga komissiya: +${h.amount} ball`,
                          debt_repaid: `${who}: ${h.amount} ball bonus qarzini to'lashga ketdi${ref}`,
                          refund_returned: `Mijozga ishlatilgan ${h.amount} ball qaytarildi`,
                          bonus_reserved: `Buyurtmada ishlatish uchun ${h.amount} ball band qilindi`,
                          reservation_released: `Band qilingan ${h.amount} ball qaytarildi (buyurtma bekor qilindi)`,
                          refund_revoked: `${isBuyer ? 'Mijozdan' : 'Taklif qilgan mijozdan'} ${h.amount} ball bekor qilindi`,
                          debt_created: `${who}: ${h.amount} ball bonus qarzi yozildi${debt ? ` (hozir qoldi ${debt.remaining} ball)` : ''}`,
                          debt_restored: `${who}: ${h.amount} ball qarzga qaytarildi — bu buyurtma bonusi bilan to'langan edi${ref}`
                        }[h.kind] || `${h.kind}: ${h.amount}`;
                        const danger = h.kind === 'debt_created' || h.kind === 'debt_restored';
                        return (
                          <div key={h.id} className={danger ? '' : 'a-muted'} style={danger ? { color: 'var(--danger)' } : undefined}>{text}</div>
                        );
                      })}
                    </div>
                  )}

                  {needsPaymeReview(selectedOrder) && (
                    <div role="alert" className="pt-2 mt-2 text-sm space-y-1" style={{ borderTop: '1px solid var(--border-strong)', color: 'var(--danger)' }}>
                      <div className="font-medium">Payme kabinetida tekshirish kerak</div>
                      <div>{selectedOrder.paymeReviewReason}</div>
                      {selectedOrder.paymeTransactionId && (
                        <div className="a-muted">Tranzaksiya: {selectedOrder.paymeTransactionId}</div>
                      )}
                      <div className="a-muted">Mahsulot va bonuslar shu buyurtma uchun band qilingan.</div>
                    </div>
                  )}

                  {/* Cash Payment Details */}
                  {selectedOrder.paymentMethod === 'cash' && (
                    <div className="pt-2 mt-2 space-y-2" style={{ borderTop: '1px solid var(--border-strong)' }}>
                      <div className="flex justify-between text-sm">
                        <span className="a-muted">To'lov usuli:</span>
                        <span className="font-medium" style={{ color: 'var(--ok)' }}>Naqd (POS)</span>
                      </div>
                      {selectedOrder.cashReceived > 0 && (
                        <div className="flex justify-between text-sm">
                          <span className="a-muted">Qabul qilingan naqd:</span>
                          <span className="font-medium a-num" style={{ color: 'var(--text)' }}>{formatPrice(selectedOrder.cashReceived)}</span>
                        </div>
                      )}
                      {selectedOrder.changeGiven > 0 && (
                        <div className="flex justify-between text-sm">
                          <span className="a-muted">Qaytim:</span>
                          <span className="font-medium a-num" style={{ color: 'var(--text)' }}>{formatPrice(selectedOrder.changeGiven)}</span>
                        </div>
                      )}
                      {selectedOrder.cashierName && (
                        <div className="flex justify-between text-sm">
                          <span className="a-muted">Kassir:</span>
                          <span className="font-medium" style={{ color: 'var(--text)' }}>{selectedOrder.cashierName}</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Order Status & Date */}
              <div className="flex items-center justify-between pt-4" style={{ borderTop: '1px solid var(--border)' }}>
                <div>
                  <p className="text-sm a-muted">Buyurtma holati</p>
                  <span className={`a-pill ${pillClass(selectedOrder.status)}`} style={{ marginTop: 4 }}>
                    {getStatusLabel(selectedOrder.status)}
                  </span>
                </div>
                <div className="text-right">
                  <p className="text-sm a-muted">Buyurtma sanasi</p>
                  <p className="text-sm font-medium mt-1" style={{ color: 'var(--text)' }}>{formatDate(selectedOrder.createdAt || selectedOrder.date)}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default OrdersSection;
