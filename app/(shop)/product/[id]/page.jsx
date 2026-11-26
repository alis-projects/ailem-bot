import { notFound } from 'next/navigation';
import { getProductById } from '../../../../src/lib/data';
import ProductPageClient from '../../../../src/components/pages/ProductPageClient';

function stripHtml(html) {
  return html ? html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

export async function generateMetadata({ params }) {
  const product = await getProductById(params.id);

  // Missing or hidden: nothing about the product goes into the metadata
  if (!product) {
    return { title: 'Mahsulot topilmadi — Ailem', robots: { index: false } };
  }

  const plainDesc = product.description
    ? stripHtml(product.description).substring(0, 160)
    : `${product.name} — sifatli uy tekstil mahsulotlari. Ailem do'konida xarid qiling.`;

  return {
    title: `${product.name} — Ailem`,
    description: plainDesc,
    openGraph: {
      title: `${product.name} — Ailem`,
      description: plainDesc,
      images: product.image ? [{ url: product.image }] : [],
    },
  };
}

// Customers get HTTP 404 for a product that does not exist or is hidden.
// Admins edit hidden products in /admin (they load them with their own
// session through RLS), not through this public page.
export default async function ProductPage({ params }) {
  const product = await getProductById(params.id);
  if (!product) notFound();
  return <ProductPageClient productId={params.id} />;
}
