import { useState, useContext, useMemo, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
const ReactQuill = dynamic(() => import('react-quill'), { ssr: false });
import 'react-quill/dist/quill.snow.css';
import { marked } from 'marked';
import {
  Edit, Trash2, Copy, Plus, ChevronRight, Upload, AlertTriangle, X, Download, Search, ImagePlus, Eye, EyeOff, Send
} from 'lucide-react';
import { AdminContext } from '../../../context/AdminContext';
import { useToast } from '../../../context/ToastContext';
import { useConfirm } from '../../../context/ConfirmContext';
import { formatPrice } from '../../../utils/helpers';
import { updateVariantStock, updateVariantImage, updateVariantPrice, getTotalVariantStock } from '../../../utils/variants';
import { parseAxis, axisValues, diffAxis, applyAxisChange, variantsRemovedBy, removeVariant, pruneAxisText } from '../../../utils/variantEdit';
import { productsAPI, ordersAPI, storageAPI, uzumClicksAPI } from '../../../services/api';
import { exportProducts } from '../../../utils/csvExport';
import { notifyProductBackInStock } from '../../../services/stockNotifications';
import APlusEditor from '../shared/APlusEditor';
import { emptyProductForm, productToForm, productImages, stockError, tiersError, normalizeTiers, formSnapshot } from '../../../utils/productForm';

// Configure marked for proper line breaks
marked.setOptions({
  breaks: true,
  gfm: true
});

const ProductsSection = () => {
  const { products, categories, users, orders, addProduct, updateProduct, deleteProduct, toggleProductVisibility } = useContext(AdminContext);
  const toast = useToast();
  const confirm = useConfirm();

  // Form state - all managed internally now
  const [allImages, setAllImages] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);
  const [formData, setFormData] = useState(emptyProductForm);
  // Form state + images as the form was opened; differs → unsaved changes
  const baselineRef = useRef(null);

  // Other local state
  const [uploadingImage, setUploadingImage] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formErrors, setFormErrors] = useState({});
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [imageUrl, setImageUrl] = useState('');
  const [expandedVP, setExpandedVP] = useState(new Set());
  const [tagSuggestions, setTagSuggestions] = useState([]);
  const [showTagSuggestions, setShowTagSuggestions] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [stockFilter, setStockFilter] = useState('');
  const [uzumStats, setUzumStats] = useState({});
  // Full-record load for editing: idle | loading | ready | error
  const [fullRecord, setFullRecord] = useState({ status: 'idle', error: null });
  const editRequestRef = useRef(0);
  // «Ranglar»/«O'lchamlar» text when the field got focus: the edit is applied
  // to the variants once, when the field is left (see utils/variantEdit.js)
  const axisFocusRef = useRef({});

  // Load UZUM click stats
  useEffect(() => {
    uzumClicksAPI.getStats().then(setUzumStats).catch(() => {});
  }, []);

  // Filtered products based on search and filters
  const filteredProducts = useMemo(() => {
    if (!products || !Array.isArray(products)) {
      return [];
    }
    return products.filter(product => {
      const matchesSearch = !searchQuery ||
        product.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        product.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        product.tags?.some(tag => tag.toLowerCase().includes(searchQuery.toLowerCase()));

      const matchesCategory = !categoryFilter || product.category === categoryFilter;

      let matchesStock = true;
      if (stockFilter) {
        const stock = product.variants && product.variants.length > 0
          ? getTotalVariantStock(product.variants)
          : (product.stock || 0);

        switch (stockFilter) {
          case 'in_stock':
            matchesStock = stock > 10;
            break;
          case 'low_stock':
            matchesStock = stock > 0 && stock <= 10;
            break;
          case 'out_of_stock':
            matchesStock = stock === 0;
            break;
          default:
            matchesStock = true;
        }
      }

      return matchesSearch && matchesCategory && matchesStock;
    });
  }, [products, searchQuery, categoryFilter, stockFilter]);

  // Get all existing tags from products for auto-suggest
  const allExistingTags = useMemo(() => {
    const tags = new Set();
    products.forEach(product => {
      if (product.tags) {
        product.tags.forEach(tag => tags.add(tag.toLowerCase()));
      }
    });
    return Array.from(tags).sort();
  }, [products]);

  // Handle tag input and suggestions
  const handleTagInput = (value) => {
    setFormData(prev => ({ ...prev, tags: value }));
    const tags = value.split(',');
    const currentTag = tags[tags.length - 1].trim().toLowerCase();

    if (currentTag.length >= 2) {
      const suggestions = allExistingTags.filter(tag =>
        tag.includes(currentTag) && !tags.slice(0, -1).map(t => t.trim().toLowerCase()).includes(tag)
      ).slice(0, 5);
      setTagSuggestions(suggestions);
      setShowTagSuggestions(suggestions.length > 0);
    } else {
      setShowTagSuggestions(false);
    }
  };

  const selectTagSuggestion = (tag) => {
    const tags = formData.tags.split(',').map(t => t.trim());
    tags[tags.length - 1] = tag;
    setFormData(prev => ({ ...prev, tags: tags.join(', ') + ', ' }));
    setShowTagSuggestions(false);
  };

  // Form validation
  const validateForm = () => {
    const errors = {};

    if (!formData.name.trim()) {
      errors.name = 'Mahsulot nomi kiritilishi shart';
    }

    if (!formData.price || parseFloat(formData.price) <= 0) {
      errors.price = 'Narx kiritilishi shart';
    }

    if (formData.salePrice && parseFloat(formData.salePrice) >= parseFloat(formData.price)) {
      errors.salePrice = 'Chegirma narxi asosiy narxdan kam bo\'lishi kerak';
    }

    if (!formData.category) {
      errors.category = 'Kategoriya tanlanishi shart';
    }

    if (!formData.tags.trim()) {
      errors.tags = 'Kamida bitta teg kiritilishi shart';
    }

    const hasVariants = formData.variants && formData.variants.length > 0;
    if (!hasVariants) {
      const stockProblem = stockError(formData.stock);
      if (stockProblem) errors.stock = stockProblem;
    }

    if (allImages.length === 0) {
      errors.images = 'Kamida bitta rasm yuklanishi shart';
    }

    if (hasVariants) {
      const variantKeys = formData.variants.map(v => `${v.color}-${v.size}`.trim().toLocaleLowerCase());
      const uniqueKeys = new Set(variantKeys);
      if (variantKeys.length !== uniqueKeys.size) {
        errors.variants = 'Takroriy variantlar mavjud';
      }
    }

    // Bulk prices: valid ranges, no overlaps, 0 < price ≤ the regular price of
    // the product, or of the variant when it has its own price
    const productPrice = parseFloat(formData.salePrice || formData.price);
    if (hasVariants) {
      for (const v of formData.variants) {
        const problem = tiersError(v.volume_pricing, Number(v.price) > 0 ? Number(v.price) : productPrice);
        if (problem) {
          errors.volumePricing = `${v.color} / ${v.size}: ${problem}`;
          break;
        }
      }
    } else {
      const problem = tiersError(formData.volume_pricing, productPrice);
      if (problem) errors.volumePricing = problem;
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // Add image via URL
  const handleAddImageUrl = () => {
    if (imageUrl.trim()) {
      try {
        new URL(imageUrl);
        setAllImages(prev => [...prev, imageUrl.trim()]);
        setImageUrl('');
        setShowUrlInput(false);
      } catch {
        toast.error('Noto\'g\'ri URL manzili');
      }
    }
  };

  // Multi-image upload
  const handleMultiImageUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    setUploadingImage(true);

    try {
      const maxFileSize = 5 * 1024 * 1024;
      let uploadedCount = 0;

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        try {
          if (file.size > maxFileSize) {
            toast.error(`${file.name} juda katta (max 5MB)`);
            continue;
          }

          const result = await storageAPI.uploadProductImage(file);
          setAllImages(prev => [...prev, result.url]);
          uploadedCount++;

          if (i < files.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        } catch (uploadError) {
          console.error(`❌ Failed to upload ${file.name}:`, uploadError);
          toast.error(`${file.name} yuklashda xatolik`);
        }
      }

      if (uploadedCount > 0) {
        toast.success(`${uploadedCount} ta rasm yuklandi`);
      }
    } catch (error) {
      console.error('❌ Image upload failed:', error);
      toast.error(`Rasm yuklashda xatolik: ${error.message}`);
    } finally {
      setUploadingImage(false);
      if (e.target) {
        e.target.value = '';
      }
    }
  };

  const handleRemoveImage = (indexToRemove) => {
    setAllImages(prev => prev.filter((_, index) => index !== indexToRemove));
  };

  const handleMoveImage = (fromIndex, toIndex) => {
    setAllImages(prev => {
      const newImages = [...prev];
      const [movedImage] = newImages.splice(fromIndex, 1);
      newImages.splice(toIndex, 0, movedImage);
      return newImages;
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    await saveForm();
  };

  // Saves the open form; true when the product was saved (and the form closed)
  const saveForm = async () => {
    // Never save an edit that did not start from the full database record
    if (editingProduct && fullRecord.status !== 'ready') {
      toast.error('Mahsulot to\'liq yuklanmadi. Saqlash mumkin emas.');
      return false;
    }

    if (!validateForm()) {
      toast.error('Formada xatolar bor. Belgilangan maydonlarni tekshiring.');
      return false;
    }

    try {
      setSubmitting(true);

      if (!addProduct || !updateProduct) {
        toast.error('Tizim tayyor emas. Iltimos, biroz kuting va qayta urinib ko\'ring.');
        return false;
      }

      const productData = {
        name: formData.name,
        description: formData.description,
        price: parseFloat(formData.salePrice || formData.price),
        originalPrice: formData.salePrice ? parseFloat(formData.price) : null,
        category: formData.category,
        imageUrl: allImages[0],
        images: allImages,
        weight: formData.weight ? parseFloat(formData.weight) : null,
        stock: formData.variants?.length > 0 ? (parseInt(formData.stock) || 0) : parseInt(formData.stock, 10),
        badge: formData.badge || null,
        material: formData.material || null,
        colors: formData.colors ? formData.colors.split(',').map(c => c.trim()).filter(c => c) :
          (formData.variants && formData.variants.length > 0
            ? [...new Set(formData.variants.map(v => v.color).filter(Boolean))]
            : []),
        sizes: formData.sizes ? formData.sizes.split(',').map(s => s.trim()).filter(s => s) :
          (formData.variants && formData.variants.length > 0
            ? [...new Set(formData.variants.map(v => v.size).filter(Boolean))]
            : []),
        tags: formData.tags ? formData.tags.split(',').map(t => t.trim().toLowerCase()).filter(t => t) : [],
        // Bulk-price tiers are stored as numbers, sorted by min_qty
        variants: (formData.variants || []).map(v => (v.volume_pricing ? { ...v, volume_pricing: normalizeTiers(v.volume_pricing) } : v)),
        // Clear product-level volume_pricing when variants exist (per-variant pricing takes over)
        volume_pricing: formData.variants?.length > 0 ? null : normalizeTiers(formData.volume_pricing),
        barcode: formData.barcode || null,
        uzumUrl: formData.uzumUrl || null,
        aPlusContent: formData.aPlusContent || null
      };

      if (editingProduct) {
        const oldStock = editingProduct.stock || 0;
        const newStock = productData.stock || 0;
        const stockIncreased = oldStock === 0 && newStock > 0;

        const variantsToNotify = [];
        if (productData.variants && productData.variants.length > 0) {
          productData.variants.forEach((newVariant) => {
            const oldVariant = editingProduct.variants?.find(
              v => v.color === newVariant.color && v.size === newVariant.size
            );
            const oldVarStock = oldVariant?.stock || 0;
            const newVarStock = newVariant.stock || 0;

            if (oldVarStock === 0 && newVarStock > 0) {
              variantsToNotify.push({
                color: newVariant.color,
                size: newVariant.size
              });
            }
          });
        }

        // expectedUpdatedAt: refuse if the product changed since the form loaded it
        await updateProduct(editingProduct.id, productData, { expectedUpdatedAt: editingProduct.updated_at });

        if (stockIncreased || variantsToNotify.length > 0) {
          const productWithId = { ...productData, id: editingProduct.id };
          (async () => {
            try {
              if (stockIncreased && (!productData.variants || productData.variants.length === 0)) {
                await notifyProductBackInStock(productWithId);
              }
              for (const variant of variantsToNotify) {
                await notifyProductBackInStock(productWithId, variant.color, variant.size);
              }
            } catch (error) {
              console.error('❌ Failed to send stock notifications:', error);
            }
          })();
        }
      } else {
        await addProduct(productData);
      }

      toast.success(editingProduct ? 'Mahsulot yangilandi' : 'Mahsulot qo\'shildi');

      closeForm();
      return true;
    } catch (error) {
      console.error('❌ Failed to save product:', error);
      if (error?.code === 'reserved_variant_changed' || error?.code === 'product_stale') {
        // Shown in the form next to the save button; the form keeps the edits
        setFormErrors(prev => ({ ...prev, save: error.message }));
        toast.error(error.message);
      } else {
        toast.error(`Mahsulotni saqlashda xatolik: ${error.message}`);
      }
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  // The catalog in AdminContext may be the "lightweight" one (no description,
  // images, a_plus_content). Editing must start from the full database record,
  // otherwise saving writes those fields back empty. Saving stays blocked until
  // the full record has loaded.
  const startEdit = async (product) => {
    const requestId = ++editRequestRef.current;
    setEditingProduct(product);
    setFullRecord({ status: 'loading', error: null });
    setFormErrors({});
    setAllImages([]);
    baselineRef.current = null;
    setShowForm(true);
    try {
      const full = await productsAPI.getById(product.id);
      if (requestId !== editRequestRef.current) return; // another product was opened or the form was closed
      if (!full || full.id !== product.id) throw new Error('Mahsulot topilmadi');
      fillFormFromProduct(full);
      setFullRecord({ status: 'ready', error: null });
    } catch (error) {
      if (requestId !== editRequestRef.current) return;
      console.error('❌ Failed to load full product:', error);
      setFullRecord({ status: 'error', error: error?.message || 'Noma\'lum xatolik' });
    }
  };

  const closeForm = () => {
    editRequestRef.current++; // ignore a full-record load that is still in flight
    setShowForm(false);
    setEditingProduct(null);
    setFormData(emptyProductForm());
    setAllImages([]);
    setFormErrors({});
    setFullRecord({ status: 'idle', error: null });
    baselineRef.current = null;
  };

  const isFormDirty = () => showForm && baselineRef.current !== null &&
    formSnapshot(formData, allImages) !== baselineRef.current;

  // Before another card replaces the open one: unsaved changes are saved or
  // dropped, as the admin chooses. false = stay in the open card.
  const settleUnsavedChanges = async () => {
    if (isFormDirty()) {
      const choice = await confirm({
        title: 'Saqlanmagan o\'zgarishlar',
        message: `«${formData.name || 'Yangi mahsulot'}» kartasida saqlanmagan o'zgarishlar bor. Yangi mahsulot ochishdan oldin ularni saqlaysizmi?`,
        type: 'warning',
        confirmText: 'Saqlash',
        extraText: 'O\'zgarishlarni bekor qilish',
        cancelText: 'Tahrirga qaytish'
      });
      if (choice === true) return saveForm(); // on errors the card stays open with them shown
      if (choice !== 'extra') return false;
    }
    return true;
  };

  // «Mahsulot qo'shish»: always a clean create form
  const openNewForm = async () => {
    if (!(await settleUnsavedChanges())) return;
    closeForm();
    const fresh = emptyProductForm();
    setFormData(fresh);
    baselineRef.current = formSnapshot(fresh, []);
    setShowForm(true);
  };

  const fillFormFromProduct = (product) => {
    setEditingProduct(product);
    const images = productImages(product);
    const form = productToForm(product);
    setAllImages(images);
    setFormData(form);
    baselineRef.current = formSnapshot(form, images);
  };

  const handleDelete = async (productId) => {
    const confirmed = await confirm({
      title: 'Mahsulotni o\'chirish',
      message: 'Ushbu mahsulotni o\'chirishga ishonchingiz komilmi? Bu amalni ortga qaytarib bo\'lmaydi.',
      type: 'danger',
      confirmText: 'O\'chirish',
      cancelText: 'Bekor qilish'
    });
    if (confirmed) {
      try {
        await deleteProduct(productId);
        toast.success('Mahsulot muvaffaqiyatli o\'chirildi');
      } catch (error) {
        console.error('❌ Failed to delete product:', error);
        toast.error('Mahsulotni o\'chirishda xatolik. Qayta urinib ko\'ring.');
      }
    }
  };

  const handleToggleVisibility = async (product) => {
    const newVisibility = product.visible === false ? true : false;
    try {
      await toggleProductVisibility(product.id, newVisibility);
      toast.success(newVisibility ? 'Mahsulot ko\'rsatildi' : 'Mahsulot yashirildi');
    } catch (error) {
      console.error('❌ Failed to toggle product visibility:', error);
      toast.error('Ko\'rinishni o\'zgartirishda xatolik');
    }
  };

  const handleNotifyNewProduct = async (product, testMode = false) => {
    if (testMode) {
      // Test mode: send only to admin
      const chatId = localStorage.getItem('admin_telegram_chat_id') || '8370090674';
      if (!chatId) return;

      try {
        toast.info('Test bildirishnoma yuborilmoqda...');
        const { sendTelegramPhoto } = await import('../../../services/telegram');
        const price = Number(product.price).toLocaleString('uz-UZ').replace(/,/g, ' ');
        const caption = `🆕 <b>Yangi mahsulot!</b>\n\n<b>${product.name}</b>\n💰 ${price} so'm`;
        const result = await sendTelegramPhoto(chatId.trim(), product.image, caption);
        if (result.success) {
          toast.success('Test bildirishnoma yuborildi!');
        } else {
          toast.error(`Yuborilmadi: ${result.error}`);
          // Clear saved chat ID if it failed (might be wrong)
          localStorage.removeItem('admin_telegram_chat_id');
        }
      } catch (error) {
        console.error('❌ Failed to send test notification:', error);
        toast.error('Test bildirishnoma yuborishda xatolik');
      }
      return;
    }

    // Full mode: send to all users
    const confirmed = await confirm({
      title: 'Bildirishnoma yuborish',
      message: `"${product.name}" haqida barcha foydalanuvchilarga (${users.length} ta) bildirishnoma yuborilsinmi?`,
      confirmText: 'Hammaga yuborish',
      cancelText: 'Bekor qilish'
    });

    if (!confirmed) return;

    try {
      toast.info('Bildirishnomalar yuborilmoqda...');
      const { notifyAllUsersNewProduct } = await import('../../../services/telegram');
      const result = await notifyAllUsersNewProduct(product, users);
      toast.success(`${result.sent} ta foydalanuvchiga yuborildi`);
      if (result.failed > 0) {
        toast.warning(`${result.failed} ta yuborilmadi`);
      }
    } catch (error) {
      console.error('❌ Failed to send notifications:', error);
      toast.error('Bildirishnoma yuborishda xatolik');
    }
  };

  // «Nusxa»: a new product from the FULL record of the original (the catalog in
  // the admin panel may be the lightweight one, without description/images/A+).
  // Prices stay as they are (regular + sale), barcodes and variant ids do not:
  // the database gives the copy's variants new ids on insert.
  const handleDuplicate = async (product) => {
    if (!(await settleUnsavedChanges())) return;
    const requestId = ++editRequestRef.current;
    let full;
    try {
      full = await productsAPI.getById(product.id);
      if (!full || full.id !== product.id) throw new Error('Mahsulot topilmadi');
    } catch (error) {
      console.error('❌ Failed to load product for copying:', error);
      toast.error(`Nusxa olish uchun mahsulot yuklanmadi: ${error?.message || ''}`);
      return;
    }
    if (requestId !== editRequestRef.current) return;
    const form = productToForm(full, { copy: true });
    const images = productImages(full);
    setEditingProduct(null); // Not editing, creating new
    setFullRecord({ status: 'idle', error: null });
    setFormErrors({});
    setAllImages(images);
    setFormData(form);
    baselineRef.current = formSnapshot(form, images);
    setShowForm(true);
    toast.info('Mahsulot nusxalandi. Tahrirlang va saqlang.');
  };

  // Typing only changes the text; the variants change once, on leaving the field
  const handleAxisTextChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleAxisFocus = (field) => {
    axisFocusRef.current[field] = formData[field];
  };

  // Apply the colour/size list edit to the existing variants: rename in place
  // (every other field kept), add new combinations, or remove the variants of
  // removed values after a confirmation. See utils/variantEdit.js.
  const commitAxisEdit = async (field) => {
    const before = axisFocusRef.current[field];
    delete axisFocusRef.current[field];
    const current = formData[field];
    if (before === undefined || before === current) return;

    const axis = field === 'colors' ? 'color' : 'size';
    const otherAxis = axis === 'color' ? 'size' : 'color';
    const otherField = field === 'colors' ? 'sizes' : 'colors';
    const revert = () => setFormData(prev => ({ ...prev, [field]: before }));

    const change = diffAxis(parseAxis(before), parseAxis(current));
    if (change.type === 'invalid') {
      toast.error(change.error);
      revert();
      return;
    }
    if (change.type === 'none') return;

    const variants = formData.variants || [];
    const otherValues = variants.length ? axisValues(variants, otherAxis) : parseAxis(formData[otherField]);

    if (change.type === 'rename' && editingProduct) {
      // Unpaid OLD orders (lines without a permanent variantId) carry the old
      // name: they could no longer be paid. Lines with variantId follow the
      // variant through a rename, so they are not counted. Warn first.
      const oldNames = new Set(change.renames.map(([from]) => from.trim().toLocaleLowerCase()));
      const itemAxis = (item) => (axis === 'color' ? (item.color || item.selectedColor) : (item.size || item.selectedSize));
      // Fresh from the database: the orders list in the admin panel may be old
      let pending = orders || [];
      try {
        pending = await ordersAPI.getPendingItems();
      } catch (error) {
        console.error('Failed to load pending orders, using the loaded list:', error);
      }
      const affected = pending.filter(o => o.status === 'pending' && Array.isArray(o.items) && o.items.some(item =>
        (item.productId || item.id || item.product_id) === editingProduct.id &&
        !(item.variantId || item.variant_id) &&
        oldNames.has(String(itemAxis(item) || '').trim().toLocaleLowerCase())));
      if (affected.length > 0) {
        const ok = await confirm({
          title: 'To\'lanmagan buyurtmalar bor',
          message: `${affected.length} ta to'lanmagan buyurtmada eski nom ishlatilgan (${affected.slice(0, 5).map(o => o.orderNumber || o.id).join(', ')}${affected.length > 5 ? ', …' : ''}). Nomi o'zgarsa, ularni to'lab bo'lmaydi, band qilingan dona esa bekor qilinganda omborga qaytmaydi. Avval ularni yakunlash tavsiya etiladi. Baribir o'zgartirasizmi?`,
          type: 'warning',
          confirmText: "O'zgartirish"
        });
        if (!ok) {
          revert();
          return;
        }
      }
    }

    if (change.type === 'remove') {
      const gone = variantsRemovedBy(variants, axis, change);
      if (gone.length > 0) {
        const stock = gone.reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
        const ok = await confirm({
          title: "Variantlarni o'chirish",
          message: `${gone.length} ta variant o'chiriladi: ${gone.map(v => `${v.color} / ${v.size}`).join(', ')}. Omborda jami ${stock} dona. Boshqa variantlar o'zgarmaydi.`,
          type: 'danger',
          confirmText: "O'chirish"
        });
        if (!ok) {
          revert();
          return;
        }
      }
    }

    setFormData(prev => ({ ...prev, variants: applyAxisChange(prev.variants || [], axis, change, otherValues) }));
    if (change.type === 'rename' && variants.length > 0) {
      toast.info(`${change.renames.map(([from, to]) => `«${from}» → «${to}»`).join(', ')}: narx, ombor, rasm, shtrix-kod va hajm narxlari saqlandi`);
    }
  };

  const handleAxisKeyDown = (e) => {
    // Enter must not submit the form before the edit is applied
    if (e.key === 'Enter') {
      e.preventDefault();
      e.currentTarget.blur();
    }
  };

  // Remove exactly one variant; the others stay as they are
  const handleRemoveVariant = async (variant) => {
    const stock = Number(variant.stock) || 0;
    const ok = await confirm({
      title: "Variantni o'chirish",
      message: `«${variant.color} / ${variant.size}» varianti o'chiriladi${stock > 0 ? ` (omborda ${stock} dona)` : ''}. Boshqa variantlar o'zgarmaydi.`,
      type: 'danger',
      confirmText: "O'chirish"
    });
    if (!ok) return;
    setFormData(prev => {
      const variants = removeVariant(prev.variants, variant.color, variant.size);
      return {
        ...prev,
        variants,
        colors: pruneAxisText(prev.colors, variants, 'color'),
        sizes: pruneAxisText(prev.sizes, variants, 'size')
      };
    });
  };

  const handleVariantStockChange = (color, size, newStock) => {
    const updatedVariants = updateVariantStock(formData.variants, color, size, parseInt(newStock) || 0);
    setFormData(prev => ({ ...prev, variants: updatedVariants }));
  };

  const handleVariantPriceChange = (color, size, newPrice) => {
    const updatedVariants = updateVariantPrice(formData.variants, color, size, parseFloat(newPrice) || 0);
    setFormData(prev => ({ ...prev, variants: updatedVariants }));
  };

  const handleVariantBarcodeChange = (color, size, barcode) => {
    const updatedVariants = formData.variants.map(v => {
      if (v.color?.toLowerCase() === color.toLowerCase() && v.size?.toLowerCase() === size.toLowerCase()) {
        return { ...v, barcode: barcode || null };
      }
      return v;
    });
    setFormData(prev => ({ ...prev, variants: updatedVariants }));
  };

  const handleVariantVolumePricingChange = (color, size, newTiers) => {
    const updatedVariants = formData.variants.map(v => {
      if (v.color?.toLowerCase() === color.toLowerCase() && v.size?.toLowerCase() === size.toLowerCase()) {
        return { ...v, volume_pricing: newTiers && newTiers.length > 0 ? newTiers : null };
      }
      return v;
    });
    setFormData(prev => ({ ...prev, variants: updatedVariants }));
  };

  const handleVariantImageChange = (color, size, imageUrl) => {
    const updatedVariants = updateVariantImage(formData.variants, color, size, imageUrl);
    setFormData(prev => ({ ...prev, variants: updatedVariants }));
  };

  const handleVariantImageUpload = async (color, size, file) => {
    if (!file) return;

    try {
      const result = await storageAPI.uploadProductImage(file);
      handleVariantImageChange(color, size, result.url);
    } catch (error) {
      console.error('Upload error:', error);
      toast.error('Variant rasmini yuklashda xatolik: ' + error.message);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Actions */}
      <div className="flex items-center justify-between">
        <div>
          <h3 style={{ fontSize: 17, fontWeight: 650, letterSpacing: '-.01em', color: 'var(--text)', margin: 0 }}>Mahsulotlarni boshqarish</h3>
          <p className="a-muted" style={{ margin: '2px 0 0', fontSize: 13 }}>Katalogda {products.length} ta mahsulot</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => exportProducts(products)}
            className="a-btn"
          >
            <Download className="w-4 h-4" />
            CSV yuklash
          </button>
          <button
            onClick={openNewForm}
            className="a-btn a-btn-primary"
          >
            <Plus className="w-5 h-5" />
            Mahsulot qo'shish
          </button>
        </div>
      </div>

      {/* Add/Edit Form */}
      {showForm && (
        <div className="a-card" style={{ padding: 24 }}>
          <div className="flex items-center justify-between mb-6">
            <h4 style={{ fontSize: 16, fontWeight: 650, letterSpacing: '-.01em', color: 'var(--text)', margin: 0 }}>
              {editingProduct ? 'Mahsulotni tahrirlash' : 'Yangi mahsulot qo\'shish'}
            </h4>
            <button
              type="button"
              onClick={closeForm}
              aria-label="Yopish"
              className="a-faint"
              style={{ background: 'none', border: 'none', cursor: 'pointer' }}
            >
              <X className="w-6 h-6" />
            </button>
          </div>

          {editingProduct && fullRecord.status === 'loading' && (
            <div role="status" className="a-muted text-sm py-8 text-center">
              Mahsulot ma'lumotlari yuklanmoqda...
            </div>
          )}

          {editingProduct && fullRecord.status === 'error' && (
            <div role="alert" className="p-4 rounded-lg text-sm" style={{ background: 'var(--danger-weak)', border: '1px solid var(--danger)', color: 'var(--danger)' }}>
              <div className="flex items-center gap-2" style={{ fontWeight: 600 }}>
                <AlertTriangle className="w-4 h-4" />
                Mahsulotni to'liq yuklab bo'lmadi. Saqlash bloklandi.
              </div>
              <p className="mt-1">{fullRecord.error}</p>
              <div className="flex gap-2 mt-3">
                <button type="button" className="a-btn" onClick={() => startEdit(editingProduct)}>
                  Qayta urinish
                </button>
                <button type="button" className="a-btn" onClick={closeForm}>
                  Yopish
                </button>
              </div>
            </div>
          )}

          {(!editingProduct || fullRecord.status === 'ready') && (
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Product Information */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="md:col-span-2">
                <label className="a-muted" style={{ display: 'block', fontSize: 12.5, fontWeight: 500, marginBottom: 8 }}>Mahsulot nomi *</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => {
                    setFormData(prev => ({ ...prev, name: e.target.value }));
                    if (formErrors.name) setFormErrors({ ...formErrors, name: null });
                  }}
                  className="a-input"
                  style={formErrors.name ? { borderColor: 'var(--danger)', background: 'var(--danger-weak)' } : undefined}
                  placeholder="Masalan: Choyshablar to'plami"
                />
                {formErrors.name && <p className="text-xs mt-1" style={{ color: 'var(--danger)' }}>{formErrors.name}</p>}
              </div>

              <div className="md:col-span-2">
                <label className="a-muted" style={{ display: 'block', fontSize: 12.5, fontWeight: 500, marginBottom: 8 }}>Tavsif</label>
                <ReactQuill
                  theme="snow"
                  value={formData.description || ''}
                  onChange={(value, _delta, source) => {
                    // Quill also reports its own normalisation of the loaded
                    // HTML ('api'/'silent'); only the admin's edits change the form
                    if (source && source !== 'user') return;
                    setFormData(prev => (prev.description === value ? prev : { ...prev, description: value }));
                  }}
                  modules={{
                    toolbar: [
                      ['bold', 'italic', 'underline'],
                      [{ 'list': 'ordered'}, { 'list': 'bullet' }],
                      ['clean']
                    ]
                  }}
                  formats={['bold', 'italic', 'underline', 'list', 'bullet']}
                  placeholder="Mahsulot haqida batafsil ma'lumot..."
                  className="rounded-lg"
                  style={{ background: 'var(--surface)' }}
                />
              </div>

              <div className="md:col-span-2">
                <label className="a-muted" style={{ display: 'block', fontSize: 12.5, fontWeight: 500, marginBottom: 8 }}>Material</label>
                <input
                  type="text"
                  value={formData.material}
                  onChange={(e) => setFormData(prev => ({ ...prev, material: e.target.value }))}
                  className="a-input"
                  placeholder="Masalan: Paxta"
                />
              </div>

              <div>
                <label className="a-muted" style={{ display: 'block', fontSize: 12.5, fontWeight: 500, marginBottom: 8 }}>Ranglar</label>
                <input
                  type="text"
                  value={formData.colors}
                  onChange={(e) => handleAxisTextChange('colors', e.target.value)}
                  onFocus={() => handleAxisFocus('colors')}
                  onBlur={() => commitAxisEdit('colors')}
                  onKeyDown={handleAxisKeyDown}
                  className="a-input"
                  placeholder="Oq, Qora, Ko'k (vergul bilan ajratilgan)"
                />
              </div>

              <div>
                <label className="a-muted" style={{ display: 'block', fontSize: 12.5, fontWeight: 500, marginBottom: 8 }}>O'lchamlar</label>
                <input
                  type="text"
                  value={formData.sizes}
                  onChange={(e) => handleAxisTextChange('sizes', e.target.value)}
                  onFocus={() => handleAxisFocus('sizes')}
                  onBlur={() => commitAxisEdit('sizes')}
                  onKeyDown={handleAxisKeyDown}
                  className="a-input"
                  placeholder="Kichik, O'rta, Katta (vergul bilan ajratilgan)"
                />
              </div>

              <div className="md:col-span-2 relative">
                <label className="a-muted" style={{ display: 'block', fontSize: 12.5, fontWeight: 500, marginBottom: 8 }}>Teglar *</label>
                <input
                  type="text"
                  value={formData.tags}
                  onChange={(e) => {
                    handleTagInput(e.target.value);
                    if (formErrors.tags) setFormErrors({ ...formErrors, tags: null });
                  }}
                  onFocus={() => {
                    if (tagSuggestions.length > 0) setShowTagSuggestions(true);
                  }}
                  onBlur={() => {
                    setTimeout(() => setShowTagSuggestions(false), 200);
                  }}
                  className="a-input"
                  style={formErrors.tags ? { borderColor: 'var(--danger)', background: 'var(--danger-weak)' } : undefined}
                  placeholder="choyshablar, paxta, hashamatli, yumshoq (vergul bilan ajratilgan)"
                />
                {showTagSuggestions && tagSuggestions.length > 0 && (
                  <div className="absolute z-50 w-full mt-1 rounded-lg max-h-40 overflow-y-auto" style={{ background: 'var(--surface)', border: '1px solid var(--border)', boxShadow: 'var(--a-shadow)' }}>
                    {tagSuggestions.map((tag, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => selectTagSuggestion(tag)}
                        className="w-full px-3 py-2 text-left text-sm last:border-b-0"
                        style={{ color: 'var(--text)', borderBottom: '1px solid var(--border)' }}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                )}
                {formErrors.tags && <p className="text-xs mt-1" style={{ color: 'var(--danger)' }}>{formErrors.tags}</p>}
                <p className="a-faint text-xs mt-1">Teglar qidiruv uchun ishlatiladi - kalit so'zlarni vergul bilan ajrating</p>
              </div>
            </div>

            {/* Pricing and Details */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4" style={{ borderTop: '1px solid var(--border)' }}>

            <div>
              <label className="a-muted" style={{ display: 'block', fontSize: 12.5, fontWeight: 500, marginBottom: 8 }}>Narxi (UZS) *</label>
              <input
                type="number"
                value={formData.price}
                onChange={(e) => {
                  setFormData(prev => ({ ...prev, price: e.target.value }));
                  if (formErrors.price) setFormErrors({ ...formErrors, price: null });
                }}
                className="a-input"
                style={formErrors.price ? { borderColor: 'var(--danger)', background: 'var(--danger-weak)' } : undefined}
              />
              {formErrors.price && <p className="text-xs mt-1" style={{ color: 'var(--danger)' }}>{formErrors.price}</p>}
            </div>

            <div>
              <label className="a-muted" style={{ display: 'block', fontSize: 12.5, fontWeight: 500, marginBottom: 8 }}>Chegirma narxi (UZS)</label>
              <input
                type="number"
                value={formData.salePrice}
                onChange={(e) => {
                  setFormData(prev => ({ ...prev, salePrice: e.target.value }));
                  if (formErrors.salePrice) setFormErrors({ ...formErrors, salePrice: null });
                }}
                className="a-input"
                style={formErrors.salePrice ? { borderColor: 'var(--danger)', background: 'var(--danger-weak)' } : undefined}
              />
              {formErrors.salePrice && <p className="text-xs mt-1" style={{ color: 'var(--danger)' }}>{formErrors.salePrice}</p>}
            </div>

            <div>
              <label className="a-muted" style={{ display: 'block', fontSize: 12.5, fontWeight: 500, marginBottom: 8 }}>Kategoriya *</label>
              <select
                value={formData.category}
                onChange={(e) => {
                  setFormData(prev => ({ ...prev, category: e.target.value }));
                  if (formErrors.category) setFormErrors({ ...formErrors, category: null });
                }}
                className="a-input"
                style={formErrors.category ? { borderColor: 'var(--danger)', background: 'var(--danger-weak)' } : undefined}
              >
                <option value="">Kategoriyani tanlang</option>
                {categories?.map(cat => (
                  <option key={cat.id} value={cat.name}>{cat.name}</option>
                ))}
              </select>
              {formErrors.category && <p className="text-xs mt-1" style={{ color: 'var(--danger)' }}>{formErrors.category}</p>}
            </div>

            {(!formData.variants || formData.variants.length === 0) && (
              <div>
                <label className="a-muted" style={{ display: 'block', fontSize: 12.5, fontWeight: 500, marginBottom: 8 }}>Ombor miqdori *</label>
                <input
                  type="number"
                  value={formData.stock}
                  onChange={(e) => {
                    setFormData(prev => ({ ...prev, stock: e.target.value }));
                    if (formErrors.stock) setFormErrors({ ...formErrors, stock: null });
                  }}
                  className="a-input"
                  style={formErrors.stock ? { borderColor: 'var(--danger)', background: 'var(--danger-weak)' } : undefined}
                />
                {formErrors.stock && <p className="text-xs mt-1" style={{ color: 'var(--danger)' }}>{formErrors.stock}</p>}
              </div>
            )}

            <div>
              <label className="a-muted" style={{ display: 'block', fontSize: 12.5, fontWeight: 500, marginBottom: 8 }}>Vazni</label>
              <div className="relative">
                <input
                  type="number"
                  step="0.01"
                  value={formData.weight}
                  onChange={(e) => setFormData(prev => ({ ...prev, weight: e.target.value }))}
                  className="a-input"
                  style={{ paddingRight: 48 }}
                  placeholder="Masalan: 1.5"
                />
                <span className="a-faint text-sm absolute right-3 top-1/2 -translate-y-1/2">kg</span>
              </div>
            </div>

            <div>
              <label className="a-muted" style={{ display: 'block', fontSize: 12.5, fontWeight: 500, marginBottom: 8 }}>Belgisi</label>
              <select
                value={formData.badge}
                onChange={(e) => setFormData(prev => ({ ...prev, badge: e.target.value }))}
                className="a-input"
              >
                <option value="">Yo'q</option>
                <option value="BEST SELLER">ENG KO'P SOTILGAN</option>
                <option value="NEW ARRIVAL">YANGI KELDI</option>
                <option value="SALE">CHEGIRMA</option>
                <option value="LIMITED">CHEKLANGAN</option>
                <option value="2+">2+ CHEGIRMA</option>
                <option value="3+">3+ CHEGIRMA</option>
                <option value="4+">4+ CHEGIRMA</option>
                <option value="5+">5+ CHEGIRMA</option>
              </select>
            </div>

            <div>
              <label className="a-muted" style={{ display: 'block', fontSize: 12.5, fontWeight: 500, marginBottom: 8 }}>Shtrix-kod (Barcode)</label>
              <input
                type="text"
                value={formData.barcode}
                onChange={(e) => setFormData(prev => ({ ...prev, barcode: e.target.value }))}
                className="a-input"
                placeholder="Masalan: 4750001234567"
              />
              <p className="a-faint text-xs mt-1">Kassir skaneri uchun mahsulot shtrix-kodi</p>
            </div>

            <div>
              <label className="a-muted" style={{ display: 'block', fontSize: 12.5, fontWeight: 500, marginBottom: 8 }}>UZUM havola</label>
              <input
                type="url"
                value={formData.uzumUrl}
                onChange={(e) => setFormData(prev => ({ ...prev, uzumUrl: e.target.value }))}
                className="a-input"
                placeholder="https://uzum.uz/uz/product/..."
              />
              <p className="a-faint text-xs mt-1">UZUM marketplace sahifasi havolasi</p>
            </div>

            {/* Variant Stock Management */}
            {formData.variants.length > 0 && (
              <div className="md:col-span-2 rounded-lg p-4" style={{ background: 'var(--surface-2)', border: `1px solid ${formErrors.variants ? 'var(--danger)' : 'var(--border)'}` }}>
                <div className="flex items-center justify-between mb-3">
                  <label className="block text-sm" style={{ fontWeight: 700, color: formErrors.variants ? 'var(--danger)' : 'var(--text)' }}>
                    Variant inventarizatsiyasi ({formData.variants.length} ta variant)
                  </label>
                  <span className="text-xs font-medium" style={{ color: formErrors.variants ? 'var(--danger)' : 'var(--text-2)' }}>
                    Jami: {getTotalVariantStock(formData.variants)} dona
                  </span>
                </div>
                {formErrors.variants && (
                  <div className="mb-3 p-2 rounded text-xs flex items-center gap-2" style={{ background: 'var(--danger-weak)', border: '1px solid var(--danger)', color: 'var(--danger)' }}>
                    <AlertTriangle className="w-4 h-4" />
                    {formErrors.variants}
                  </div>
                )}
                <p className="text-xs mb-3" style={{ color: formErrors.variants ? 'var(--danger)' : 'var(--text-2)' }}>
                  Har bir rang + o'lcham kombinatsiyasi uchun miqdorni kiriting
                </p>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 max-h-96 overflow-y-auto">
                  {formData.variants.map((variant) => (
                    <div
                      key={`${variant.color}|${variant.size}`}
                      className="flex items-start gap-3 p-3 rounded transition-colors"
                      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
                    >
                      <div className="flex-shrink-0">
                        {variant.image ? (
                          <div className="relative w-16 h-16 rounded overflow-hidden" style={{ border: '2px solid var(--accent)' }}>
                            <img
                              src={variant.image}
                              alt={`${variant.color} - ${variant.size}`}
                              className="w-full h-full object-cover"
                            />
                            <button
                              type="button"
                              onClick={() => handleVariantImageChange(variant.color, variant.size, null)}
                              className="absolute top-0 right-0 text-white p-0.5 rounded-bl"
                              style={{ background: 'var(--danger)' }}
                              title="Rasmni o'chirish"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        ) : (
                          <label className="w-16 h-16 flex items-center justify-center rounded cursor-pointer transition-colors" style={{ border: '2px dashed var(--border)' }}>
                            <ImagePlus className="w-6 h-6 a-faint" />
                            <input
                              type="file"
                              accept="image/*"
                              onChange={(e) => e.target.files[0] && handleVariantImageUpload(variant.color, variant.size, e.target.files[0])}
                              className="hidden"
                            />
                          </label>
                        )}
                      </div>

                      <div className="flex-1">
                        <div className="text-sm font-medium mb-2 flex items-center justify-between gap-2">
                          <span>
                            <span style={{ color: 'var(--text)' }}>{variant.color}</span>
                            <span className="a-faint mx-1">•</span>
                            <span style={{ color: 'var(--text)' }}>{variant.size}</span>
                          </span>
                          <button
                            type="button"
                            onClick={() => handleRemoveVariant(variant)}
                            className="p-1 rounded"
                            style={{ color: 'var(--danger)' }}
                            title="Variantni o'chirish"
                            aria-label={`Variantni o'chirish: ${variant.color} / ${variant.size}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                        <div className="flex flex-col gap-2">
                          <div className="flex items-center gap-2">
                            <span className="a-muted text-xs w-12">Narxi:</span>
                            <input
                              type="number"
                              min="0"
                              value={variant.price || ''}
                              onChange={(e) => handleVariantPriceChange(variant.color, variant.size, e.target.value)}
                              className="a-input text-sm"
                              style={{ width: 96, padding: '4px 8px' }}
                              placeholder={formData.salePrice || formData.price || '0'}
                            />
                            <span className="a-faint text-xs">UZS</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="a-muted text-xs w-12">Ombor:</span>
                            <input
                              type="number"
                              min="0"
                              value={variant.stock}
                              onChange={(e) => handleVariantStockChange(variant.color, variant.size, e.target.value)}
                              className="a-input text-sm"
                              style={{ width: 96, padding: '4px 8px' }}
                              placeholder="0"
                            />
                            <span className="a-faint text-xs">dona</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="a-muted text-xs w-12">Shtrix:</span>
                            <input
                              type="text"
                              value={variant.barcode || ''}
                              onChange={(e) => handleVariantBarcodeChange(variant.color, variant.size, e.target.value)}
                              className="a-input text-sm font-mono"
                              style={{ width: 112, padding: '4px 8px' }}
                              placeholder="Shtrix-kod"
                            />
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="a-muted text-xs w-12">Vazni:</span>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={variant.weight || ''}
                              onChange={(e) => {
                                const updatedVariants = formData.variants.map(v => {
                                  if (v.color?.toLowerCase() === variant.color.toLowerCase() && v.size?.toLowerCase() === variant.size.toLowerCase()) {
                                    return { ...v, weight: e.target.value ? parseFloat(e.target.value) : null };
                                  }
                                  return v;
                                });
                                setFormData(prev => ({ ...prev, variants: updatedVariants }));
                              }}
                              className="a-input text-sm"
                              style={{ width: 80, padding: '4px 8px' }}
                              placeholder={formData.weight || '0.5'}
                            />
                            <span className="a-faint text-xs">kg</span>
                          </div>
                        </div>
                        {/* Per-variant volume pricing */}
                        {(() => {
                          const vpKey = `${variant.color}-${variant.size}`;
                          const isExpanded = expandedVP.has(vpKey);
                          const tiers = variant.volume_pricing || [];
                          const variantBasePrice = variant.price || parseFloat(formData.salePrice || formData.price) || 0;

                          return (
                            <div className="mt-2">
                              <button
                                type="button"
                                onClick={() => {
                                  const next = new Set(expandedVP);
                                  if (isExpanded) next.delete(vpKey); else next.add(vpKey);
                                  setExpandedVP(next);
                                }}
                                className="text-xs px-2 py-1 rounded flex items-center gap-1 transition-colors"
                                style={tiers.length > 0
                                  ? { background: 'var(--ok-weak)', color: 'var(--ok)' }
                                  : { background: 'var(--surface-2)', color: 'var(--text-2)' }}
                              >
                                💰 Hajm narxi {tiers.length > 0 && `(${tiers.length})`}
                                <ChevronRight className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                              </button>

                              {isExpanded && (
                                <div className="mt-2 p-2 rounded space-y-2" style={{ background: 'var(--ok-weak)', border: '1px solid var(--ok)' }}>
                                  {tiers.map((tier, tIdx) => (
                                    <div key={tIdx} className="flex items-center gap-1.5 text-xs">
                                      <input
                                        type="number"
                                                                                aria-label="Min miqdor"
                                        value={tier.min_qty}
                                        onChange={(e) => {
                                          const updated = [...tiers];
                                          updated[tIdx] = { ...updated[tIdx], min_qty: e.target.value === '' ? '' : parseInt(e.target.value, 10) };
                                          handleVariantVolumePricingChange(variant.color, variant.size, updated);
                                        }}
                                        className="a-input text-xs"
                                        style={{ width: 56, padding: '4px 6px' }}
                                        placeholder="Min"
                                      />
                                      <span className="a-faint">-</span>
                                      <input
                                        type="number"
                                        value={tier.max_qty || ''}
                                        onChange={(e) => {
                                          const updated = [...tiers];
                                          updated[tIdx] = { ...updated[tIdx], max_qty: e.target.value ? parseInt(e.target.value, 10) : null };
                                          handleVariantVolumePricingChange(variant.color, variant.size, updated);
                                        }}
                                        className="a-input text-xs"
                                        style={{ width: 56, padding: '4px 6px' }}
                                        placeholder="∞"
                                      />
                                      <span className="a-faint">=</span>
                                      <input
                                        type="number"
                                        value={tier.price}
                                        onChange={(e) => {
                                          const updated = [...tiers];
                                          updated[tIdx] = { ...updated[tIdx], price: e.target.value === '' ? '' : parseFloat(e.target.value) };
                                          handleVariantVolumePricingChange(variant.color, variant.size, updated);
                                        }}
                                        className="a-input text-xs"
                                        style={{ width: 80, padding: '4px 6px' }}
                                        placeholder="Narx"
                                      />
                                      <span className="a-faint">so'm</span>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          const updated = tiers.filter((_, i) => i !== tIdx);
                                          handleVariantVolumePricingChange(variant.color, variant.size, updated);
                                        }}
                                        className="p-0.5"
                                        style={{ color: 'var(--danger)' }}
                                      >
                                        <X className="w-3 h-3" />
                                      </button>
                                    </div>
                                  ))}
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const newTier = {
                                        min_qty: tiers.length > 0 ? (Number(tiers[tiers.length - 1].max_qty || tiers[tiers.length - 1].min_qty) || 0) + 1 : 2,
                                        max_qty: null,
                                        price: variantBasePrice
                                      };
                                      handleVariantVolumePricingChange(variant.color, variant.size, [...tiers, newTier]);
                                    }}
                                    className="text-xs text-white px-2 py-1 rounded flex items-center gap-1"
                                    style={{ background: 'var(--ok)' }}
                                  >
                                    <Plus className="w-3 h-3" /> Daraja
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        })()}

                        {variant.image && (
                          <div className="mt-1 text-xs flex items-center gap-1" style={{ color: 'var(--ok)' }}>
                            <ImagePlus className="w-3 h-3" />
                            Maxsus rasm o'rnatilgan
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-3 p-2 rounded" style={{ background: 'var(--warn-weak)', border: '1px solid var(--warn)' }}>
                  <p className="text-xs" style={{ color: 'var(--warn)' }}>
                    💡 <strong>Eslatma:</strong> Har bir variant uchun alohida narx, ombor va hajm narxlashni belgilashingiz mumkin.
                    Agar narx bo'sh qoldirilsa, asosiy narx ishlatiladi.
                  </p>
                </div>
              </div>
            )}

            <div className="md:col-span-2">
              <label className="a-muted" style={{ display: 'block', fontSize: 12.5, fontWeight: 500, marginBottom: 8 }}>
                Mahsulot rasmlari * {allImages.length > 0 && <span className="a-faint font-normal">({allImages.length} ta rasm)</span>}
              </label>

              {formErrors.images && (
                <div className="mb-3 p-2 rounded text-xs flex items-center gap-2" style={{ background: 'var(--danger-weak)', border: '1px solid var(--danger)', color: 'var(--danger)' }}>
                  <AlertTriangle className="w-4 h-4" />
                  {formErrors.images}
                </div>
              )}

              {allImages.length > 0 && (
                <div className="mb-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                  {allImages.map((imgUrl, index) => (
                    <div key={index} className="relative group">
                      <div className="aspect-square rounded-lg overflow-hidden" style={{ border: '2px solid var(--border)', background: 'var(--surface-2)' }}>
                        <img
                          src={imgUrl}
                          alt={`Mahsulot ${index + 1}`}
                          className="w-full h-full object-cover"
                          onError={(e) => {
                            e.target.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="100" height="100"%3E%3Crect fill="%23ddd" width="100" height="100"/%3E%3Ctext fill="%23999" x="50%25" y="50%25" text-anchor="middle" dy=".3em"%3EXato%3C/text%3E%3C/svg%3E';
                          }}
                        />
                      </div>

                      {index === 0 && (
                        <div className="absolute top-1 left-1 bg-accent text-white text-xs px-2 py-1 rounded font-medium">
                          Asosiy
                        </div>
                      )}

                      <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-50 transition-all flex items-center justify-center gap-1 opacity-0 group-hover:opacity-100">
                        {index > 0 && (
                          <button
                            type="button"
                            onClick={() => handleMoveImage(index, index - 1)}
                            className="p-1.5 rounded-lg transition-colors"
                            style={{ background: 'var(--surface)', color: 'var(--text)' }}
                            title="Chapga ko'chirish"
                          >
                            <ChevronRight className="w-4 h-4 rotate-180" />
                          </button>
                        )}
                        {index < allImages.length - 1 && (
                          <button
                            type="button"
                            onClick={() => handleMoveImage(index, index + 1)}
                            className="p-1.5 rounded-lg transition-colors"
                            style={{ background: 'var(--surface)', color: 'var(--text)' }}
                            title="O'ngga ko'chirish"
                          >
                            <ChevronRight className="w-4 h-4" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleRemoveImage(index)}
                          className="p-1.5 rounded-lg text-white transition-colors"
                          style={{ background: 'var(--danger)' }}
                          title="Rasmni o'chirish"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex gap-2 flex-wrap">
                <label className={`a-btn a-btn-primary flex-1 min-w-[200px] justify-center ${uploadingImage ? 'opacity-50 cursor-wait' : ''}`} style={{ padding: '12px 16px' }}>
                  <Upload className="w-5 h-5" />
                  <span>{uploadingImage ? 'Yuklanmoqda...' : (allImages.length === 0 ? 'Rasmlarni yuklash' : 'Rasm qo\'shish')}</span>
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={handleMultiImageUpload}
                    className="hidden"
                    disabled={uploadingImage}
                  />
                </label>

                <button
                  type="button"
                  onClick={() => setShowUrlInput(!showUrlInput)}
                  className="a-btn"
                  style={{ padding: '12px 16px' }}
                >
                  <ImagePlus className="w-5 h-5" />
                  <span>URL orqali</span>
                </button>
              </div>

              {showUrlInput && (
                <div className="mt-3 flex gap-2">
                  <input
                    type="url"
                    value={imageUrl}
                    onChange={(e) => setImageUrl(e.target.value)}
                    placeholder="Rasm URL manzilini kiriting..."
                    className="a-input flex-1"
                  />
                  <button
                    type="button"
                    onClick={handleAddImageUrl}
                    className="a-btn text-white"
                    style={{ background: 'var(--ok)', borderColor: 'var(--ok)' }}
                  >
                    Qo'shish
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowUrlInput(false);
                      setImageUrl('');
                    }}
                    className="a-btn"
                  >
                    Bekor
                  </button>
                </div>
              )}

              <p className="a-faint text-xs mt-2">
                {allImages.length === 0 ? 'Kamida bitta rasm yuklang. ' : ''}
                Birinchi rasm asosiy mahsulot rasmi bo'ladi. Tartibni o'zgartirish uchun strelkalarni bosing.
              </p>
            </div>

            </div>

            {/* Volume Pricing Section - only for products WITHOUT variants */}
            {formData.variants.length === 0 && (
            <div className="md:col-span-2 pt-6" style={{ borderTop: '1px solid var(--border)' }}>
              <div className="rounded-lg p-4" style={{ background: 'var(--ok-weak)', border: '1px solid var(--ok)' }}>
                <div className="flex items-center justify-between mb-3">
                  <label className="text-sm" style={{ fontWeight: 700, color: 'var(--ok)' }}>
                    Hajmli narxlash (Volume Discounts)
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      const newTier = {
                        min_qty: formData.volume_pricing?.length > 0
                          ? (Number(formData.volume_pricing[formData.volume_pricing.length - 1].max_qty || formData.volume_pricing[formData.volume_pricing.length - 1].min_qty) || 0) + 1
                          : 2,
                        max_qty: null,
                        price: parseFloat(formData.salePrice || formData.price) || 0
                      };
                      setFormData(prev => ({
                        ...prev,
                        volume_pricing: [...(prev.volume_pricing || []), newTier]
                      }));
                    }}
                    className="a-btn text-white"
                    style={{ background: 'var(--ok)', borderColor: 'var(--ok)' }}
                  >
                    <Plus className="w-4 h-4" />
                    Daraja qo'shish
                  </button>
                </div>

                <p className="text-xs mb-4" style={{ color: 'var(--ok)' }}>
                  Ko'p miqdorda xarid qilgan xaridorlar uchun maxsus narxlarni belgilang
                </p>

                {formData.volume_pricing && formData.volume_pricing.length > 0 ? (
                  <div className="space-y-3">
                    {/* Rows stay in the order they were added; sorted only on save */}
                    {formData.volume_pricing.map((tier, index) => (
                      <div key={index} className="p-3 rounded-lg flex items-center gap-3" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
                        <div className="flex-1 grid grid-cols-3 gap-3">
                          <div>
                            <label className="a-muted block text-xs font-medium mb-1">
                              Min miqdor
                            </label>
                            <input
                              type="number"
                                                            aria-label="Min miqdor"
                              value={tier.min_qty}
                              onChange={(e) => {
                                const value = e.target.value === '' ? '' : parseInt(e.target.value, 10);
                                setFormData(prev => ({ ...prev, volume_pricing: prev.volume_pricing.map((t, i) => (i === index ? { ...t, min_qty: value } : t)) }));
                              }}
                              className="a-input text-sm"
                              style={{ padding: '6px 12px' }}
                            />
                          </div>
                          <div>
                            <label className="a-muted block text-xs font-medium mb-1">
                              Max miqdor
                            </label>
                            <input
                              type="number"
                              aria-label="Max miqdor"
                              value={tier.max_qty || ''}
                              onChange={(e) => {
                                const value = e.target.value ? parseInt(e.target.value, 10) : null;
                                setFormData(prev => ({ ...prev, volume_pricing: prev.volume_pricing.map((t, i) => (i === index ? { ...t, max_qty: value } : t)) }));
                              }}
                              placeholder="Cheksiz"
                              className="a-input text-sm"
                              style={{ padding: '6px 12px' }}
                            />
                          </div>
                          <div>
                            <label className="a-muted block text-xs font-medium mb-1">
                              Har bir narxi (UZS)
                            </label>
                            <input
                              type="number"
                              aria-label="Har bir narxi"
                              value={tier.price}
                              onChange={(e) => {
                                const value = e.target.value === '' ? '' : parseFloat(e.target.value);
                                setFormData(prev => ({ ...prev, volume_pricing: prev.volume_pricing.map((t, i) => (i === index ? { ...t, price: value } : t)) }));
                              }}
                              className="a-input text-sm"
                              style={{ padding: '6px 12px' }}
                            />
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            const updated = formData.volume_pricing.filter((_, i) => i !== index);
                            setFormData(prev => ({ ...prev, volume_pricing: updated.length > 0 ? updated : null }));
                          }}
                          className="p-2 rounded-lg transition-colors"
                          style={{ background: 'var(--danger-weak)', color: 'var(--danger)' }}
                          title="Darajani o'chirish"
                          aria-label="Darajani o'chirish"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}

                    <div className="rounded-lg p-3" style={{ background: 'var(--info-weak)', border: '1px solid var(--info)' }}>
                      <p className="text-xs font-semibold mb-2" style={{ color: 'var(--info)' }}>📊 Ko'rinish:</p>
                      <div className="text-xs space-y-1" style={{ color: 'var(--info)' }}>
                        {[...formData.volume_pricing]
                          .sort((a, b) => Number(a.min_qty) - Number(b.min_qty))
                          .map((tier, idx) => (
                          <div key={idx}>
                            • {tier.min_qty}{tier.max_qty ? `-${tier.max_qty}` : '+'} dona: har biri {formatPrice(tier.price)}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="a-faint text-center py-6 text-sm">
                    <p className="mb-2">Hozircha hajmli narxlash yo'q</p>
                    <p className="text-xs">Yuqoridagi "Daraja qo'shish" tugmasini bosing</p>
                  </div>
                )}
              </div>
            </div>
            )}

            {/* A+ Content Section */}
            <div className="md:col-span-2">
              <div className="rounded-lg p-4" style={{ border: '1px solid var(--border)' }}>
                <APlusEditor
                  value={formData.aPlusContent}
                  onChange={(value) => setFormData(prev => ({ ...prev, aPlusContent: value }))}
                />
              </div>
            </div>

            {formErrors.volumePricing && (
              <div role="alert" className="md:col-span-2 rounded-lg p-3 text-sm" style={{ background: 'var(--danger-weak, #fef2f2)', border: '1px solid var(--danger)', color: 'var(--danger)' }}>
                Hajmli narxlash: {formErrors.volumePricing}
              </div>
            )}

            {formErrors.save && (
              <div role="alert" className="md:col-span-2 rounded-lg p-3 text-sm" style={{ background: 'var(--danger-weak, #fef2f2)', border: '1px solid var(--danger)', color: 'var(--danger)' }}>
                {formErrors.save}
              </div>
            )}

            <div className="md:col-span-2 flex gap-4">
              <button
                type="submit"
                disabled={submitting}
                className={`a-btn a-btn-primary ${submitting ? 'opacity-50 cursor-wait' : ''}`}
                style={{ padding: '10px 24px' }}
              >
                {submitting && (
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                )}
                {submitting ? 'Saqlanmoqda...' : (editingProduct ? 'Yangilash' : 'Qo\'shish')}
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={closeForm}
                className={`a-btn ${submitting ? 'opacity-50 cursor-not-allowed' : ''}`}
                style={{ padding: '10px 24px' }}
              >
                Bekor qilish
              </button>
            </div>
          </form>
          )}
        </div>
      )}

      {/* Search and Filters */}
      <div className="a-card" style={{ padding: 16, marginBottom: 16 }}>
        <div className="flex flex-wrap gap-4 items-center">
          <div className="flex-1 min-w-[200px]">
            <div className="relative">
              <Search className="a-faint absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" />
              <input
                type="text"
                placeholder="Mahsulot qidirish..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="a-input"
                style={{ paddingLeft: 40 }}
              />
            </div>
          </div>

          <div className="min-w-[150px]">
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="a-input"
            >
              <option value="">Barcha kategoriyalar</option>
              {categories?.map(cat => (
                <option key={cat.id} value={cat.name}>{cat.name}</option>
              ))}
            </select>
          </div>

          <div className="min-w-[150px]">
            <select
              value={stockFilter}
              onChange={(e) => setStockFilter(e.target.value)}
              className="a-input"
            >
              <option value="">Ombor holati</option>
              <option value="in_stock">Mavjud (10+)</option>
              <option value="low_stock">Kam qolgan (1-10)</option>
              <option value="out_of_stock">Tugagan</option>
            </select>
          </div>

          {(searchQuery || categoryFilter || stockFilter) && (
            <button
              onClick={() => {
                setSearchQuery('');
                setCategoryFilter('');
                setStockFilter('');
              }}
              className="a-btn"
            >
              Tozalash
            </button>
          )}
        </div>

        <div className="a-muted mt-3 text-sm">
          {filteredProducts.length} ta mahsulot topildi
          {filteredProducts.length !== products.length && ` (jami: ${products.length})`}
        </div>
      </div>

      {/* Products Table */}
      <div className="a-card" style={{ padding: 0 }}>
        <div className="overflow-x-auto">
          <table className="a-table">
            <thead>
              <tr>
                <th>Mahsulot</th>
                <th>Kategoriya</th>
                <th>Narxi</th>
                <th>Ombor</th>
                <th>Holat</th>
                <th>UZUM</th>
                <th>Amallar</th>
              </tr>
            </thead>
            <tbody>
              {filteredProducts.map((product) => (
                <tr key={product.id}>
                  <td>
                    <div className="flex items-center">
                      <img
                        src={product.image}
                        alt={product.name}
                        className="w-12 h-12 object-cover rounded-lg mr-4"
                      />
                      <div>
                        <div className="text-sm font-medium" style={{ color: 'var(--text)' }}>{product.name}</div>
                        <div className="a-faint text-sm">{product.description?.substring(0, 50)}...</div>
                      </div>
                    </div>
                  </td>
                  <td className="text-sm" style={{ color: 'var(--text)' }}>{product.category}</td>
                  <td>
                    <div className="a-num text-sm font-medium" style={{ color: 'var(--text)' }}>{formatPrice(product.price)}</div>
                    {product.originalPrice && (
                      <div className="a-faint a-num text-sm line-through">{formatPrice(product.originalPrice)}</div>
                    )}
                  </td>
                  <td>
                    {(() => {
                      const displayStock = product.variants && product.variants.length > 0
                        ? getTotalVariantStock(product.variants)
                        : (product.stock || 0);

                      return (
                        <span className={`a-pill ${
                          displayStock > 10 ? 'a-pill-ok' :
                          displayStock > 0 ? 'a-pill-warn' :
                          'a-pill-danger'
                        }`}>
                          {displayStock} dona
                        </span>
                      );
                    })()}
                  </td>
                  <td>
                    {(() => {
                      const displayStock = product.variants && product.variants.length > 0
                        ? getTotalVariantStock(product.variants)
                        : (product.stock || 0);

                      return (
                        <span className={`a-pill ${displayStock > 0 ? 'a-pill-ok' : 'a-pill-danger'}`}>
                          {displayStock > 0 ? 'Mavjud' : 'Tugagan'}
                        </span>
                      );
                    })()}
                  </td>
                  <td className="text-sm">
                    {product.uzumUrl ? (
                      <span className="a-pill" style={{ color: '#7B68EE', background: 'rgba(123,104,238,.14)' }}>
                        {uzumStats[product.id]?.count || 0} klik
                      </span>
                    ) : (
                      <span className="a-faint">—</span>
                    )}
                  </td>
                  <td className="text-sm">
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleToggleVisibility(product)}
                        style={{ color: product.visible === false ? 'var(--text-3)' : 'var(--ok)' }}
                        title={product.visible === false ? 'Ko\'rsatish' : 'Yashirish'}
                      >
                        {product.visible === false ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                      <button
                        onClick={() => handleNotifyNewProduct(product, true)}
                        style={{ color: '#9F8FEE' }}
                        title="Test yuborish (faqat o'zim)"
                      >
                        <Send className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleNotifyNewProduct(product)}
                        style={{ color: '#7B68EE' }}
                        title="Hammaga yuborish"
                      >
                        <Send className="w-4 h-4" />
                      </button>
                      <button
                        onClick={async () => { if (await settleUnsavedChanges()) startEdit(product); }}
                        style={{ color: 'var(--accent)' }}
                        title="Tahrirlash"
                      >
                        <Edit className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDuplicate(product)}
                        style={{ color: 'var(--info)' }}
                        title="Nusxalash"
                      >
                        <Copy className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(product.id)}
                        style={{ color: 'var(--danger)' }}
                        title="O'chirish"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default ProductsSection;
