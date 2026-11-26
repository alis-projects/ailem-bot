import { useContext, useMemo, useCallback } from 'react';
import { Trash2, Plus, Minus, ShoppingBag } from 'lucide-react';
import { t } from "../../utils/translation-fallback";
import { useCart } from '../../hooks/useCart';
import { useProducts } from '../../hooks/useProducts';
import { formatPrice, getVisibleCartItems, getUnavailableCartItems } from '../../utils/helpers';
import ProductCard from '../product/ProductCard';
import { UserContext } from '../../context/UserContext';
import { CartContext } from '../../context/CartContext';
import {
  getEffectivePriceWithTierGrouping,
  calculateItemTotalWithTierGrouping,
  getTierGroupInfo
} from '../../utils/volumePricing';
import { findCartVariant } from '../../utils/variants';
import { AdminContext } from '../../context/AdminContext';

const CartPage = ({ onNavigate }) => {
  const { cartItems, updateQuantity, removeFromCart, getCartTotal } = useCart();
  const { products } = useContext(AdminContext);
  const { toggleFavorite, isFavorite } = useContext(UserContext);
  const { addToCart } = useContext(CartContext);
  const { featuredProducts } = useProducts();

  const handleQuickAddToCart = useCallback((product) => {
    const hasVariants = (product.variants && product.variants.length > 0) ||
                       (product.colors && product.colors.length > 0) ||
                       (product.sizes && product.sizes.length > 0);
    if (hasVariants) {
      onNavigate('product', { productId: product.id });
    } else {
      addToCart(product, 1, null, null);
    }
  }, [onNavigate, addToCart]);

  // Filter out hidden products and resolve live volume_pricing from product data
  // Cart stores snapshots — volume_pricing may be stale if admin changed it
  const visibleCartItems = useMemo(() => {
    if (!products.length) return cartItems;
    return getVisibleCartItems(cartItems, products)
      .map(item => {
        const liveProduct = products.find(p => p.id === item.id);
        if (!liveProduct) return item;

        // Resolve live volume_pricing: variant-level first, then product-level.
        // The variant is found by its permanent id (renames do not matter);
        // old lines without one by colour + size.
        let liveVolumePricing = liveProduct.volume_pricing;
        const liveVariant = liveProduct.variants?.length > 0 ? findCartVariant(liveProduct.variants, item) : null;
        if (liveVariant?.volume_pricing?.length > 0) {
          liveVolumePricing = liveVariant.volume_pricing;
        }

        return {
          ...item,
          volume_pricing: liveVolumePricing,
          liveVariant,
          liveStock: liveVariant ? (Number(liveVariant.stock) || 0) : (Number(liveProduct.stock) || 0),
          // show the variant's current name (it may have been renamed)
          selectedColor: liveVariant?.color || item.selectedColor,
          selectedSize: liveVariant?.size || item.selectedSize
        };
      });
  }, [cartItems, products]);

  // Lines whose product was hidden or removed after being added: shown with
  // a remove button; checkout stays blocked until they are gone (the server
  // refuses them anyway).
  const unavailableItems = useMemo(() => getUnavailableCartItems(cartItems, products), [cartItems, products]);
  const canCheckout = unavailableItems.length === 0;
  const unavailableBlock = unavailableItems.length > 0 && (
    <div role="alert" className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 text-sm">
      <p className="font-semibold mb-1">Sotuvda yo'q mahsulotlar</p>
      <p className="mb-3">Bu mahsulotlar endi sotilmaydi. Buyurtma berish uchun ularni savatdan olib tashlang.</p>
      <ul className="space-y-2">
        {unavailableItems.map(item => (
          <li key={item.cartItemId} className="flex justify-between items-center gap-3">
            <span>
              {item.name}
              {item.selectedColor && item.selectedSize ? ` (${item.selectedColor}, ${item.selectedSize})` : ''}
            </span>
            <button type="button" onClick={() => removeFromCart(item.cartItemId)} className="font-semibold underline whitespace-nowrap">
              Olib tashlash
            </button>
          </li>
        ))}
      </ul>
    </div>
  );

  if (visibleCartItems.length === 0) {
    return (
      <div className="pb-20 lg:pb-8">
        {unavailableBlock && <div className="px-4 pt-4">{unavailableBlock}</div>}
        <div className="flex flex-col items-center justify-center py-16 px-4">
          <ShoppingBag className="w-24 h-24 text-gray-300 mb-4" />
          <h2 className="text-2xl font-bold text-gray-700 mb-2">{t('cart.empty')}</h2>
          <p className="text-gray-500 mb-6 text-center">
            {t('cart.continueShopping')}
          </p>
          <button
            onClick={() => onNavigate('shop')}
            className="bg-accent text-white px-6 py-3 rounded-lg font-semibold hover:bg-red-700 transition-colors"
          >
            {t('home.shopNow')}
          </button>
        </div>

        {/* Best Sellers */}
        {featuredProducts.length > 0 && (
          <div className="px-4 pb-6">
            <h3 className="text-xl font-bold mb-4">{t('home.bestSellers')}</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {featuredProducts.slice(0, 4).map((product) => (
                <ProductCard
                  key={product.id}
                  product={product}
                  onView={(id) => onNavigate('product', { productId: id })}
                  isFavorite={isFavorite(product.id)}
                  onToggleFavorite={toggleFavorite}
                  onQuickAddToCart={handleQuickAddToCart}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // Calculate subtotal only for visible items
  const subtotal = visibleCartItems.reduce((total, item) => {
    return total + calculateItemTotalWithTierGrouping(item, visibleCartItems);
  }, 0);

  return (
    <div className="pb-40 lg:pb-8">
      <div className="px-4 py-4 lg:flex lg:gap-8 lg:items-start">
        {/* Cart Items */}
        <div className="space-y-4 mb-6 lg:flex-1 lg:mb-0">
          {unavailableBlock}
          {visibleCartItems.map((item) => (
            <div key={item.cartItemId} className="bg-white rounded-lg shadow-md p-4">
              {/* Clickable Product Area */}
              <div
                className="flex gap-4 cursor-pointer hover:bg-gray-50 rounded-lg p-2 -m-2 transition-colors"
                onClick={() => onNavigate('product', { productId: item.id })}
              >
                <div
                  className="w-20 aspect-[4/5] rounded-lg bg-cover bg-center bg-no-repeat flex-shrink-0"
                  style={{
                    backgroundImage: `url(${item.image})`,
                    WebkitTouchCallout: 'none',
                    WebkitUserSelect: 'none',
                    userSelect: 'none'
                  }}
                  role="img"
                  aria-label={item.name}
                  onContextMenu={(e) => e.preventDefault()}
                />
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-800 mb-1">{item.name}</h3>
                  {item.selectedColor && (
                    <p className="text-sm text-gray-600">{t('product.colors')}: {item.selectedColor}</p>
                  )}
                  {item.selectedSize && (
                    <p className="text-sm text-gray-600">{t('product.sizes')}: {item.selectedSize}</p>
                  )}
                  <div className="mt-2">
                    <p className="text-lg font-bold text-primary">
                      {formatPrice(item.price)}
                    </p>
                    {item.volume_pricing && item.volume_pricing.length > 0 && (
                      <p className="text-xs text-green-600 font-medium">
                        💰 Hajm bo'yicha chegirma mavjud
                      </p>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between mt-4">
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => updateQuantity(item.cartItemId, item.quantity - 1)}
                    className="w-11 h-11 rounded-lg border-2 border-gray-300 flex items-center justify-center hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                    disabled={item.quantity <= 1}
                  >
                    <Minus className="w-4 h-4" />
                  </button>
                  <span className="text-lg font-semibold w-8 text-center">
                    {item.quantity}
                  </span>
                  <button
                    onClick={() => updateQuantity(item.cartItemId, item.quantity + 1)}
                    className="w-11 h-11 rounded-lg border-2 border-gray-300 flex items-center justify-center hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                    disabled={item.quantity >= (item.liveStock ?? (item.stock || 0))}
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>

                <button
                  onClick={() => removeFromCart(item.cartItemId)}
                  className="text-error hover:bg-red-50 p-2 rounded-lg transition-colors"
                >
                  <Trash2 className="w-5 h-5" />
                </button>
              </div>

              {/* Stock limit indicator */}
              {(() => {
                // Live stock of this line's variant (by id), else the product's
                const currentStock = item.liveStock ?? (item.stock || 0);

                if (item.quantity >= currentStock) {
                  return (
                    <div className="mt-2 text-xs text-warning flex items-center gap-1">
                      <span>⚠️ Omborda {currentStock} dona mavjud</span>
                    </div>
                  );
                }
                return null;
              })()}

              <div className="mt-3 pt-3 border-t border-gray-200">
                {(() => {
                  const effectivePrice = getEffectivePriceWithTierGrouping(item, visibleCartItems);
                  const itemTotal = calculateItemTotalWithTierGrouping(item, visibleCartItems);
                  const hasDiscount = effectivePrice < item.price;
                  const tierInfo = getTierGroupInfo(item, visibleCartItems);

                  return (
                    <>
                      {/* Show tier progress if item has volume pricing */}
                      {tierInfo && !tierInfo.qualifies && (
                        <div className="mb-2 bg-blue-50 border border-blue-200 rounded p-2">
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-blue-700">
                              {tierInfo.threshold}+ chegirma uchun:
                            </span>
                            <span className="font-bold text-blue-800">
                              {tierInfo.combinedQty}/{tierInfo.threshold} dona
                            </span>
                          </div>
                          <div className="text-xs text-blue-600 mt-1">
                            Yana {tierInfo.remaining} dona qo'shing
                            {tierInfo.itemsInGroup > 1 && ` (${tierInfo.itemsInGroup} xil mahsulot birlashtirilgan)`}
                          </div>
                        </div>
                      )}
                      {hasDiscount && (
                        <div className="mb-2 bg-green-50 border border-green-200 rounded p-2">
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-green-700">
                              Har biri ({item.quantity} dona):
                            </span>
                            <span className="font-bold text-green-800">
                              {formatPrice(effectivePrice)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between text-xs mt-1">
                            <span className="text-green-700">
                              Tejadingiz:
                            </span>
                            <span className="font-bold text-green-800">
                              {formatPrice((item.price - effectivePrice) * item.quantity)}
                            </span>
                          </div>
                          {tierInfo && tierInfo.itemsInGroup > 1 && (
                            <div className="text-xs text-green-600 mt-1">
                              {tierInfo.itemsInGroup} xil mahsulot birlashtirilgan ({tierInfo.combinedQty} dona jami)
                            </div>
                          )}
                        </div>
                      )}
                      <div className="flex justify-between items-center">
                        <span className="text-gray-600">{t('cart.subtotal')}:</span>
                        <div className="text-right">
                          <span className="text-lg font-bold">
                            {formatPrice(itemTotal)}
                          </span>
                          {hasDiscount && (
                            <div className="text-xs text-gray-500 line-through">
                              {formatPrice(item.price * item.quantity)}
                            </div>
                          )}
                        </div>
                      </div>
                    </>
                  );
                })()}
              </div>
            </div>
          ))}
        </div>

        {/* Desktop Summary Sidebar */}
        <div className="hidden lg:block lg:w-80 lg:sticky lg:top-20 lg:flex-shrink-0">
          <div className="bg-white rounded-lg shadow-md p-6">
            <h3 className="text-lg font-semibold mb-4">{t('checkout.orderSummary')}</h3>
            <div className="flex justify-between items-center mb-6">
              <span className="text-gray-600">{t('cart.subtotal')}:</span>
              <span className="text-2xl font-bold text-primary">
                {formatPrice(subtotal)}
              </span>
            </div>
            <button
              onClick={() => onNavigate('checkout')}
              disabled={!canCheckout}
              className="w-full bg-accent text-white py-4 rounded-lg font-semibold hover:bg-red-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              {t('cart.checkout')}
            </button>
          </div>
        </div>
      </div>

      {/* Fixed Bottom Section — mobile/tablet only */}
      <div className="fixed bottom-16 left-0 right-0 bg-white border-t border-gray-200 shadow-lg lg:hidden">
        <div className="max-w-6xl mx-auto px-4 py-4">
          <div className="flex justify-between items-center mb-4">
            <span className="text-lg font-semibold">{t('cart.subtotal')}:</span>
            <span className="text-2xl font-bold text-primary">
              {formatPrice(subtotal)}
            </span>
          </div>
          <button
            onClick={() => onNavigate('checkout')}
            disabled={!canCheckout}
            className="w-full bg-accent text-white py-4 rounded-lg font-semibold hover:bg-red-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            {t('cart.checkout')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CartPage;
