import localFont from 'next/font/local';
import Script from 'next/script';
import Providers from '../src/components/Providers';
import './globals.css';

export const dynamic = 'force-dynamic';

// Plus Jakarta Sans, self-hosted: the official Tokotype webfonts (OFL-1.1,
// src/fonts/plus-jakarta-sans/OFL.txt) at the commit Google Fonts pins, so the
// build never fetches fonts.googleapis.com (that fetch failed CI builds).
// Same weights as before; unicode-range = what Google served for this family
// (latin, latin-ext, vietnamese, cyrillic-ext), so text in other scripts keeps
// falling back exactly as before.
const plusJakartaSans = localFont({
  // The variable font Google Fonts builds its files from; weights limited to
  // the same 400-700 the site used (static Tokotype builds differ by ~0.04%)
  src: [
    { path: '../src/fonts/plus-jakarta-sans/PlusJakartaSans[wght].woff2', weight: '400 700', style: 'normal' },
  ],
  display: 'swap',
  variable: '--font-plus-jakarta',
  // The metric-matched Arial fallback shown until the font has loaded: the
  // exact values Google Fonts generated before (see app/globals.css)
  adjustFontFallback: false,
  fallback: ['Plus Jakarta Sans Fallback'],
  declarations: [{
    prop: 'unicode-range',
    // next/font needs a plain literal here (no concatenation)
    value: 'U+0000-00FF, U+0100-02BA, U+02BB-02BC, U+02BD-02C5, U+02C6, U+02C7-02CC, U+02CE-02D7, U+02DA, U+02DC, U+02DD-02FF, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+0460-052F, U+1C80-1C8A, U+1D00-1DBF, U+1E00-1E9F, U+1EA0-1EF9, U+1EF2-1EFF, U+2000-206F, U+20A0-20AB, U+20AC, U+20AD-20C4, U+20B4, U+2113, U+2122, U+2191, U+2193, U+2212, U+2215, U+2C60-2C7F, U+2DE0-2DFF, U+A640-A69F, U+A720-A7FF, U+FE2E-FE2F, U+FEFF, U+FFFD',
  }],
});

export const metadata = {
  title: {
    default: "Ailem — Uy tekstillari do'koni | ailem.uz",
    template: '%s | Ailem',
  },
  description:
    "Ailem — Toshkentdagi eng yaxshi choyshab, yostiq va pardalar do'koni. Tez yetkazib berish, qulay narxlar.",
  openGraph: {
    title: "Ailem — Uy tekstillari do'koni",
    description:
      "Toshkentdagi eng yaxshi choyshab, yostiq va pardalar do'koni. Tez yetkazib berish, qulay narxlar.",
    url: 'https://www.ailem.uz',
    type: 'website',
    images: [{ url: 'https://www.ailem.uz/site.png', width: 1200, height: 900, alt: "Ailem — Uy tekstillari do'koni" }],
  },
  robots: 'index, follow',
  icons: {
    icon: '/favicon.png',
    apple: '/apple-touch-icon.png',
  },
  verification: {
    google: 'J9WtvH4lNeukCrZ50c2TwffjQzVuPbEYjEF8OhavFM4',
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="uz" className={plusJakartaSans.variable}>
      <body className={plusJakartaSans.className}>
        <Providers>{children}</Providers>
        <Script src="https://www.googletagmanager.com/gtag/js?id=G-CSM5FK64M7" strategy="afterInteractive" />
        <Script id="ga4" strategy="afterInteractive">{`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', 'G-CSM5FK64M7');
        `}</Script>
      </body>
    </html>
  );
}
