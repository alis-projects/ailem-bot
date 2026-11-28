import { createContext, useState, useEffect, useMemo, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { essentialDataAPI, categoriesAPI, productsAPI, ordersAPI, reviewsAPI, usersAPI, storageAPI, extractStoragePath, isDefinitiveError } from '../services/api';
import { getTotalVariantStock } from '../utils/variants';
import { removeFromLocalStorage } from '../utils/helpers';
import { sortCategories, countProductsInCategory } from '../utils/categories';
import { categoryNameKey } from '../utils/validation';
import { newOperationId } from '../utils/operationId';
import { cleanupUnusedImage } from '../utils/storageCleanup';
import { logAuditAction, AUDIT_ACTIONS } from '../services/auditLog';
import { productSnapshot, productChanges } from '../utils/productAudit';

export const AdminContext = createContext();

export const AdminProvider = ({ children }) => {
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [orders, setOrders] = useState([]);
  const [users, setUsers] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adminLoading, setAdminLoading] = useState(true);
  const [error, setError] = useState(null);

  // Phase 1: Essential data (products, categories, reviews) — single RPC call
  // lightweight=true (default) for customer browsing, false for admin panel
  const loadEssentialData = async ({ lightweight = true } = {}) => {
    try {
      setLoading(true);
      setError(null);

      console.log('🔄 Loading essential data from Supabase (single RPC)...');

      const { products: productsData, categories: categoriesData, reviews: reviewsData } =
        await essentialDataAPI.getAll({ lightweight });

      console.log('✅ Essential data loaded:', {
        products: productsData?.length || 0,
        categories: categoriesData?.length || 0,
        reviews: reviewsData?.length || 0
      });

      setProducts(productsData || []);
      setReviews(reviewsData || []);

      // Shared display order comes from the database (categories.sort_order).
      // The old per-browser 'categoryOrder' preference is no longer used.
      setCategories(sortCategories(categoriesData || []));
      removeFromLocalStorage('categoryOrder');
    } catch (err) {
      console.error('❌ Failed to load essential data:', err);
      setError(err.message);
    } finally {
      setLoading(false);
      console.log('✅ Essential loading complete — UI unblocked');
    }
  };

  // Phase 2: Deferred data (orders, users) — loads silently in background
  const loadDeferredData = async () => {
    try {
      setAdminLoading(true);

      console.log('🔄 Loading deferred data (orders, users)...');

      const [ordersData, usersData] = await Promise.all([
        ordersAPI.getAll().catch(e => { console.error('Orders error:', e); return []; }),
        usersAPI.getAll().catch(e => { console.error('Users error:', e); return []; }),
      ]);

      console.log('✅ Deferred data loaded:', {
        orders: ordersData?.length || 0,
        users: usersData?.length || 0
      });

      setOrders(ordersData || []);
      setUsers(usersData || []);
    } catch (err) {
      console.error('❌ Failed to load deferred data:', err);
    } finally {
      setAdminLoading(false);
    }
  };

  // On mount: load essential (unblocks UI for everyone). Phase 2 (orders + users)
  // contains customer PII, so it loads ONLY for authenticated admin sessions —
  // anonymous/customer sessions use the anon key with no Supabase Auth session and
  // must never fetch these tables. RLS also enforces this server-side; this gate
  // just prevents the request from ever being issued for non-admins.
  useEffect(() => {
    let cancelled = false;
    // Whose session the loaded catalog belongs to (null = public catalog)
    let catalogSessionUser = null;
    const isAdmin = window.location.search.includes('admin=true');

    loadEssentialData({ lightweight: !isAdmin });

    // Load PII data now if an admin session already exists (e.g. cached login),
    // otherwise mark admin data as "not loading" so nothing waits on it.
    supabase.auth.getSession()
      .then(({ data: { session } }) => {
        if (cancelled) return;
        if (session) {
          catalogSessionUser = session.user?.id || null;
          loadDeferredData();
        } else {
          setAdminLoading(false);
        }
      })
      .catch(() => { if (!cancelled) setAdminLoading(false); });

    // React to admin auth changes: load PII data on sign-in, drop it on sign-out.
    // The catalog depends on the session too: hidden products are returned
    // only to admins (restrict-hidden-products.sql), so it is reloaded when the
    // signed-in user changes — not on every token refresh/SIGNED_IN repeat.
    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      if (cancelled) return;
      if (session && event === 'SIGNED_IN') {
        const userId = session.user?.id || null;
        if (userId !== catalogSessionUser) {
          catalogSessionUser = userId;
          loadEssentialData({ lightweight: true });
        }
        loadDeferredData();
      } else if (event === 'SIGNED_OUT') {
        setOrders([]);
        setUsers([]);
        setAdminLoading(false);
        if (catalogSessionUser !== null) {
          catalogSessionUser = null;
          loadEssentialData({ lightweight: true }); // drop hidden products from this browser
        }
      }
    });

    return () => {
      cancelled = true;
      authListener?.subscription?.unsubscribe?.();
    };
  }, []);

  // Full refresh for admin panel refresh button (loads all columns for editing)
  const loadAllData = async () => {
    await loadEssentialData({ lightweight: false });
    await loadDeferredData();
  };

  // Product management. Every successful admin change is written to the audit
  // log (who/when are stamped by the database from the verified session); a
  // failed or refused save throws before logging, so it leaves no entry.
  // Stock taken by payments/order approval is changed by database functions,
  // not here, and is not logged as an admin product edit.
  // The audit entry is sent AFTER the change succeeded and is not awaited: a
  // slow or failed entry never delays, fails or undoes the saved change (so
  // the admin always sees it saved and does not repeat it). When the entry
  // could not be written, options.onAuditFailed(entry) is called.
  const logProductAudit = (entry, onAuditFailed) => {
    logAuditAction(entry).then(ok => {
      if (!ok && onAuditFailed) onAuditFailed(entry);
    });
  };

  //   options.copyOf: { id, name } of the product this one was copied from
  const addProduct = async (product, { copyOf = null, onAuditFailed } = {}) => {
    try {
      const newProduct = await productsAPI.create(product);
      // Add new product at the beginning to match descending created_at order
      setProducts(prev => [newProduct, ...prev]);
      logProductAudit({
        action: copyOf ? AUDIT_ACTIONS.PRODUCT_COPY : AUDIT_ACTIONS.PRODUCT_CREATE,
        entityType: 'product',
        entityId: newProduct.id,
        newData: productSnapshot(newProduct),
        metadata: { name: newProduct.name, ...(copyOf ? { copied_from_id: copyOf.id, copied_from_name: copyOf.name } : {}) }
      }, onAuditFailed);
      return newProduct;
    } catch (err) {
      console.error('Failed to add product:', err);
      throw err;
    }
  };

  //   options.expectedUpdatedAt: see productsAPI.update
  //   options.before: the full record the edit started from (the form loads it);
  //     the audit entry lists only the fields that changed against it
  const updateProduct = async (productId, updates, { before = null, onAuditFailed, ...options } = {}) => {
    try {
      const previous = before || products.find(p => p.id === productId) || null;
      const updatedProduct = await productsAPI.update(productId, updates, options);
      setProducts(prev =>
        prev.map(product =>
          product.id === productId ? updatedProduct : product
        )
      );
      const { oldData, newData, fields } = productChanges(previous, updatedProduct);
      if (fields.length > 0) {
        logProductAudit({
          action: AUDIT_ACTIONS.PRODUCT_UPDATE,
          entityType: 'product',
          entityId: productId,
          oldData,
          newData,
          metadata: { name: updatedProduct.name, changed_fields: fields }
        }, onAuditFailed);
      }
      return updatedProduct;
    } catch (err) {
      console.error('Failed to update product:', err);
      throw err;
    }
  };

  const deleteProduct = async (productId, { onAuditFailed } = {}) => {
    try {
      const product = products.find(p => p.id === productId);
      // Full record for the audit entry (the catalog may be the lightweight one)
      let fullRecord = null;
      try {
        fullRecord = await productsAPI.getById(productId);
      } catch (e) {
        console.error('Failed to load the full product before deleting:', e);
      }

      // Clean up storage images (non-blocking)
      if (product) {
        const imageUrls = [];
        if (product.image) imageUrls.push(product.image);
        if (product.images?.length) imageUrls.push(...product.images);
        if (product.variants?.length) {
          product.variants.forEach(v => { if (v.image) imageUrls.push(v.image); });
        }
        const paths = imageUrls.map(extractStoragePath).filter(Boolean);
        if (paths.length) {
          await Promise.allSettled(paths.map(p => storageAPI.deleteImage(p)));
        }
      }

      await productsAPI.delete(productId);
      setProducts(prev => prev.filter(product => product.id !== productId));
      const deleted = fullRecord || product;
      logProductAudit({
        action: AUDIT_ACTIONS.PRODUCT_DELETE,
        entityType: 'product',
        entityId: productId,
        oldData: productSnapshot(deleted),
        metadata: { name: deleted?.name ?? null }
      }, onAuditFailed);
    } catch (err) {
      console.error('Failed to delete product:', err);
      throw err;
    }
  };

  // Order management
  const addOrder = async (order) => {
    try {
      const newOrder = await ordersAPI.create(order);
      setOrders(prev => [newOrder, ...prev]);
      return newOrder;
    } catch (err) {
      console.error('Failed to add order:', err);
      throw err;
    }
  };

  const updateOrderStatus = async (orderId, status) => {
    try {
      const order = orders.find(o => o.id === orderId || o.dbId === orderId);
      const updatedOrder = await ordersAPI.updateStatus(orderId, status);
      
      setOrders(prev =>
        prev.map(order =>
          // Match by id (order_number) or dbId (UUID)
          (order.id === orderId || order.dbId === orderId) ? updatedOrder : order
        )
      );

      // Send notification to customer for shipped and delivered status
      if (order && (status === 'shipped' || status === 'delivered')) {
        try {
          const { notifyUserOrderStatus } = await import('../services/telegram');
          await notifyUserOrderStatus(updatedOrder, status);
          console.log(`✅ Customer notified about order ${status}`);
        } catch (notifError) {
          console.error('❌ Failed to send customer notification:', notifError);
          // Don't fail the status update if notification fails
        }
      }

      return updatedOrder;
    } catch (err) {
      console.error('Failed to update order status:', err);
      throw err;
    }
  };

  // Manual approval runs in the database (admin_approve_order): stock check,
  // status change, stock deduction and bonuses in ONE transaction, exactly once
  // (the same fulfillment Payme/Click use). Throws an Error with .code
  // 'insufficient_stock' (+ .items) / 'already_fulfilled' / 'not_pending' /
  // 'not_found' when nothing was changed. Returns { referrer } when a referral
  // commission was credited (for the Telegram notification).
  const approveOrder = async (orderId) => {
    const order = orders.find(o => o.id === orderId || o.dbId === orderId);
    const result = await ordersAPI.approveAsAdmin(order?.dbId || orderId);
    if (result?.result !== 'approved') {
      const err = new Error(`approve_${result?.result || 'failed'}`);
      err.code = result?.result || 'failed';
      err.items = result?.items || [];
      err.status = result?.status;
      throw err;
    }

    // Reflect the database state (order + stock) in the admin lists
    try {
      const fresh = await ordersAPI.getById(order?.dbId || orderId);
      setOrders(prev => prev.map(o => (o.id === orderId || o.dbId === orderId) ? fresh : o));
    } catch (e) {
      console.error('Failed to reload approved order:', e);
    }
    try {
      await refreshCatalog();
    } catch (e) {
      console.error('Failed to reload products after approval:', e);
    }

    if (order) {
      try {
        const { notifyUserOrderStatus } = await import('../services/telegram');
        await notifyUserOrderStatus(order, 'approved');
      } catch (notifError) {
        console.error('❌ Failed to send customer notification:', notifError);
      }
    }
    return { referrer: result.referrer || null };
  };

  // «Rad etish» is decided in the database (admin_reject_order): only a
  // pending, unfulfilled order is rejected (a held bonus reservation is
  // released). An order already processed (paid or approved) is refused with
  // .code 'already_processed' and left unchanged — there is no return flow yet
  // that would give back stock and bonuses.
  const rejectOrder = async (orderId) => {
    const order = orders.find(o => o.id === orderId || o.dbId === orderId);
    const result = await ordersAPI.rejectAsAdmin(order?.dbId || orderId);
    if (result?.result !== 'rejected') {
      const err = new Error(`reject_${result?.result || 'failed'}`);
      err.code = result?.result || 'failed';
      err.status = result?.status;
      throw err;
    }
    try {
      const fresh = await ordersAPI.getById(order?.dbId || orderId);
      setOrders(prev => prev.map(o => (o.id === orderId || o.dbId === orderId) ? fresh : o));
    } catch (e) {
      console.error('Failed to reload rejected order:', e);
    }
    if (order) {
      try {
        const { notifyUserOrderStatus } = await import('../services/telegram');
        await notifyUserOrderStatus(order, 'rejected');
      } catch (notifError) {
        console.error('❌ Failed to send customer notification:', notifError);
      }
    }
  };

  // Returned goods of a refunded order were received: back to stock once
  // (admin_confirm_return). Throws with .code 'not_awaiting_return' /
  // 'not_found' when nothing changed; 'already_received' is not an error.
  // Bonus history / debts of one order, for the order card
  const getBonusRecords = async (order) => ordersAPI.getBonusRecords(order?.dbId || order?.id);

  const confirmReturn = async (orderId) => {
    const order = orders.find(o => o.id === orderId || o.dbId === orderId);
    const result = await ordersAPI.confirmReturn(order?.dbId || orderId);
    if (result?.result !== 'received' && result?.result !== 'already_received') {
      const err = new Error(`confirm_return_${result?.result || 'failed'}`);
      err.code = result?.result || 'failed';
      err.status = result?.status;
      throw err;
    }
    try {
      const fresh = await ordersAPI.getById(order?.dbId || orderId);
      setOrders(prev => prev.map(o => (o.id === orderId || o.dbId === orderId) ? fresh : o));
    } catch (e) {
      console.error('Failed to reload order after return:', e);
    }
    try {
      await refreshCatalog();
    } catch (e) {
      console.error('Failed to reload products after return:', e);
    }
    if (result.result === 'received') {
      logAuditAction({
        action: AUDIT_ACTIONS.ORDER_RETURN_RECEIVED,
        entityType: 'order',
        entityId: order?.dbId || orderId,
        oldData: { status: 'return_pending' },
        newData: { status: 'refunded', stock: 'returned' },
        metadata: { order_number: order?.orderNumber || orderId }
      });
    }
    return result;
  };

  const deleteOrder = async (orderId) => {
    try {
      await ordersAPI.delete(orderId);
      setOrders(prev => prev.filter(order => order.id !== orderId));
    } catch (err) {
      console.error('Failed to delete order:', err);
      throw err;
    }
  };

  // Review management
  const addReview = async (productId, review) => {
    try {
      const reviewData = {
        product_id: productId,
        user_id: review.userId || null,
        user_name: review.userName,
        rating: review.rating,
        comment: review.comment,
        images: review.images || [],
        approved: false
      };

      const newReview = await reviewsAPI.create(reviewData);

      // Reload reviews to get full data with product name
      const allReviews = await reviewsAPI.getAll();
      setReviews(allReviews);

      return newReview;
    } catch (err) {
      console.error('Failed to add review:', err);
      throw err;
    }
  };

  const approveReview = async (reviewId) => {
    try {
      await reviewsAPI.approve(reviewId);

      // Update local state
      setReviews(prev =>
        prev.map(review =>
          review.id === reviewId ? { ...review, approved: true } : review
        )
      );
    } catch (err) {
      console.error('Failed to approve review:', err);
      throw err;
    }
  };

  const deleteReview = async (reviewId) => {
    try {
      await reviewsAPI.delete(reviewId);
      setReviews(prev => prev.filter(review => review.id !== reviewId));
    } catch (err) {
      console.error('Failed to delete review:', err);
      throw err;
    }
  };

  // User management
  // Change a customer's bonus balance by `delta` on the server
  // (admin_adjust_bonus: admin check, never below 0, audit row in the same
  // transaction). Throws with .code when refused.
  const updateUserBonusPoints = async (userId, delta, reason) => {
    const result = await usersAPI.adjustBonus(userId, delta, reason);
    if (result?.result !== 'ok') {
      const err = new Error(`bonus_${result?.result || 'failed'}`);
      err.code = result?.result || 'failed';
      err.old = result?.old;
      throw err;
    }
    setUsers(prev =>
      prev.map(u =>
        u.id === userId
          ? { ...u, bonusPoints: result.new, bonus_points: result.new }
          : u
      )
    );
    return result;
  };

  // Category management
  // Membership is by name (products.category / category_name). Renames run as
  // one database transaction (admin_save_category RPC) that also moves the
  // products; deletion is refused while products remain. Storage cleanup only
  // runs after the database change has succeeded.

  // Reload products + categories from the server without toggling `loading`
  // (which would unmount the admin panel). Used after outcomes the client
  // cannot know (network failure mid-write) or that prove it is stale.
  const refreshCatalog = async () => {
    const { products: productsData, categories: categoriesData } =
      await essentialDataAPI.getAll({ lightweight: false });
    const catalog = { products: productsData || [], categories: sortCategories(categoriesData || []) };
    setProducts(catalog.products);
    setCategories(catalog.categories);
    return catalog;
  };

  // Refresh when the outcome is unknown or our copy is stale; returns an
  // accurate error for the caller either way.
  // 'Not found / nothing changed' can also mean our request already took
  // effect (a retried delivery after a lost response) — refresh for those too.
  const REFRESH_CODES = ['category_stale', 'category_not_deleted', 'category_not_updated', 'category_not_found'];
  const reconcileAfterFailure = async (err) => {
    if (isDefinitiveError(err) && !REFRESH_CODES.includes(err.code)) return err;
    let refreshed = false;
    try {
      refreshed = !!(await refreshCatalog());
    } catch (refreshErr) {
      console.error('❌ Failed to refresh catalog after an uncertain write:', refreshErr);
    }
    if (isDefinitiveError(err)) return err;
    return Object.assign(
      new Error(refreshed
        ? 'Saqlash natijasi aniq emas. Ma\'lumotlar serverdan qayta yuklandi — natijani tekshiring.'
        : 'Saqlash natijasi aniq emas va ma\'lumotlarni yangilab bo\'lmadi. Sahifani yangilang.'),
      { code: 'outcome_unknown', definitive: false, refreshed, cause: err }
    );
  };

  // Save through admin_save_category with an operation id. If the response
  // is lost, ask the database for the real outcome of that operation
  // (resolve_category_write waits while the save is still in flight):
  //   committed → refresh and report success; aborted → definitive failure;
  //   unknown   → propagate (reconcileAfterFailure → 'outcome_unknown').
  // Callers that hold images for this save keep the hold on 'outcome_unknown'.
  const saveCategoryRecord = async (payload) => {
    try {
      return { row: await categoriesAPI.save(payload), catalog: null };
    } catch (err) {
      if (isDefinitiveError(err)) throw err;
      const outcome = await categoriesAPI.resolveWrite(payload.opId);
      if (outcome === 'aborted') {
        throw Object.assign(new Error('Kategoriya saqlanmadi (aloqa uzildi). Qayta urinib ko\'ring.'),
          { code: 'category_not_saved', definitive: true, cause: err });
      }
      if (outcome !== 'committed') throw err;
      return { row: null, catalog: await refreshCatalog() };
    }
  };

  const addCategory = async (category, { opId = newOperationId() } = {}) => {
    try {
      const { row, catalog } = await saveCategoryRecord({ opId, name: category.name, image: category.image });
      const key = categoryNameKey(category.name);
      const newCategory = row || catalog.categories.find(c => categoryNameKey(c.name) === key);
      if (!newCategory) throw Object.assign(new Error('Saqlangan kategoriya topilmadi'), { code: 'outcome_unknown', definitive: false });
      if (row) setCategories(prev => sortCategories([...prev, newCategory]));
      await logAuditAction({
        action: AUDIT_ACTIONS.CATEGORY_CREATE,
        entityType: 'category',
        entityId: newCategory.id,
        newData: newCategory
      });
      return newCategory;
    } catch (err) {
      console.error('Failed to add category:', err);
      throw await reconcileAfterFailure(err);
    }
  };

  const updateCategory = async (categoryId, updates, { opId = newOperationId() } = {}) => {
    try {
      const oldCategory = categories.find(c => c.id === categoryId);
      // One transaction for the category and (on a rename) its products
      const { row, catalog } = await saveCategoryRecord({
        opId,
        id: categoryId,
        name: updates.name ?? oldCategory?.name,
        image: updates.image ?? oldCategory?.image,
        expectedName: oldCategory?.name ?? null
      });
      const updatedCategory = row || catalog.categories.find(c => c.id === categoryId);
      if (!updatedCategory) throw Object.assign(new Error('Saqlangan kategoriya topilmadi'), { code: 'outcome_unknown', definitive: false });

      if (row) {
        if (oldCategory && updatedCategory.name !== oldCategory.name) {
          setProducts(prev => prev.map(p =>
            p.category === oldCategory.name
              ? { ...p, category: updatedCategory.name, category_name: updatedCategory.name }
              : p
          ));
        }
        setCategories(prev => sortCategories(
          prev.map(category => category.id === categoryId ? updatedCategory : category)
        ));
      }

      await logAuditAction({
        action: AUDIT_ACTIONS.CATEGORY_UPDATE,
        entityType: 'category',
        entityId: categoryId,
        oldData: oldCategory || null,
        newData: updatedCategory
      });

      // Replaced image: remove the old object only if nothing else uses it
      // (skipped while a caller still holds it for this save)
      if (oldCategory?.image && oldCategory.image !== updatedCategory.image) {
        cleanupUnusedImage(oldCategory.image).catch(() => {});
      }
      return updatedCategory;
    } catch (err) {
      console.error('Failed to update category:', err);
      throw await reconcileAfterFailure(err);
    }
  };

  const deleteCategory = async (categoryId) => {
    try {
      const category = categories.find(c => c.id === categoryId);
      if (!category) throw new Error('Kategoriya topilmadi');

      // Refuse to orphan products (client state and database)
      const localCount = countProductsInCategory(products, category.name);
      const productCount = localCount > 0 ? localCount : await categoriesAPI.countProducts(category.name);
      if (productCount > 0) {
        throw Object.assign(
          new Error(`Bu kategoriyada ${productCount} ta mahsulot bor. Avval ularni boshqa kategoriyaga o'tkazing.`),
          { code: 'category_in_use', productCount }
        );
      }

      await categoriesAPI.delete(categoryId);
      setCategories(prev => prev.filter(c => c.id !== categoryId));

      await logAuditAction({
        action: AUDIT_ACTIONS.CATEGORY_DELETE,
        entityType: 'category',
        entityId: categoryId,
        oldData: category
      });

      // Record is gone; now clean up its image if unreferenced (never throws)
      if (category.image) {
        cleanupUnusedImage(category.image).catch(() => {});
      }
    } catch (err) {
      console.error('Failed to delete category:', err);
      throw err.code === 'category_in_use' && err.productCount ? err : await reconcileAfterFailure(err);
    }
  };

  // Persist a new display order for everyone (reorder_categories RPC).
  // Optimistic; on any failure the local order is reverted (and refreshed
  // from the server when the outcome is unknown or the list was stale).
  // Only a confirmed success is audit-logged.
  const reorderCategories = async (reorderedCategories) => {
    const previous = categories;
    const withOrder = reorderedCategories.map((c, i) => ({ ...c, sort_order: i + 1 }));
    setCategories(withOrder);
    try {
      await categoriesAPI.reorder(withOrder.map(c => c.id));
    } catch (err) {
      console.error('Failed to reorder categories:', err);
      setCategories(previous);
      throw await reconcileAfterFailure(err);
    }
    await logAuditAction({
      action: AUDIT_ACTIONS.CATEGORY_REORDER,
      entityType: 'category',
      entityId: 'order',
      oldData: previous.map(c => c.id),
      newData: withOrder.map(c => c.id)
    });
  };

  const toggleCategoryVisibility = async (categoryId, visible) => {
    try {
      const oldCategory = categories.find(c => c.id === categoryId);
      const updatedCategory = await categoriesAPI.toggleVisibility(categoryId, visible);
      setCategories(prev =>
        prev.map(category =>
          category.id === categoryId ? updatedCategory : category
        )
      );
      await logAuditAction({
        action: AUDIT_ACTIONS.CATEGORY_VISIBILITY,
        entityType: 'category',
        entityId: categoryId,
        oldData: { visible: oldCategory?.visible !== false },
        newData: { visible }
      });
      return updatedCategory;
    } catch (err) {
      console.error('Failed to toggle category visibility:', err);
      throw await reconcileAfterFailure(err);
    }
  };

  const toggleProductVisibility = async (productId, visible, { onAuditFailed } = {}) => {
    try {
      const previous = products.find(p => p.id === productId);
      const updatedProduct = await productsAPI.toggleVisibility(productId, visible);
      setProducts(prev =>
        prev.map(product =>
          product.id === productId ? { ...product, visible } : product
        )
      );
      logProductAudit({
        action: visible ? AUDIT_ACTIONS.PRODUCT_PUBLISH : AUDIT_ACTIONS.PRODUCT_HIDE,
        entityType: 'product',
        entityId: productId,
        oldData: { visible: previous ? previous.visible !== false : null },
        newData: { visible },
        metadata: { name: updatedProduct?.name ?? previous?.name ?? null }
      }, onAuditFailed);
      return updatedProduct;
    } catch (err) {
      console.error('Failed to toggle product visibility:', err);
      throw err;
    }
  };

  // Memoize context value to prevent unnecessary re-renders of consumers
  const contextValue = useMemo(() => ({
    products,
    addProduct,
    updateProduct,
    deleteProduct,
    toggleProductVisibility,
    categories,
    addCategory,
    updateCategory,
    deleteCategory,
    reorderCategories,
    toggleCategoryVisibility,
    refreshCatalog,
    orders,
    addOrder,
    updateOrderStatus,
    approveOrder,
    rejectOrder,
    confirmReturn,
    getBonusRecords,
    deleteOrder,
    reviews,
    addReview,
    approveReview,
    deleteReview,
    users,
    updateUserBonusPoints,
    loading,
    adminLoading,
    error,
    loadAllData
  }), [products, categories, orders, reviews, users, loading, adminLoading, error]);

  return (
    <AdminContext.Provider value={contextValue}>
      {children}
    </AdminContext.Provider>
  );
};
