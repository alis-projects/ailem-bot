# Plus Jakarta Sans (self-hosted)

Official webfont by Tokotype, licensed under the SIL Open Font License 1.1
(see `OFL.txt` in this folder).

- Source: https://github.com/tokotype/PlusJakartaSans at commit
  `163c006ff169bbb932757276b98a26f36a1409d8` — the commit Google Fonts pins in
  `google/fonts/ofl/plusjakartasans/upstream_info.md`.
- Files (byte-identical to upstream; git blob SHA-1):

| File | Upstream path | Bytes | git blob |
|---|---|---|---|
| `PlusJakartaSans[wght].woff2` | `fonts/webfonts/PlusJakartaSans[wght].woff2` | 60612 | eebac44580986b89ed54b1dfc23209ce82ebc073 |
| `OFL.txt` | `OFL.txt` | 4402 | ea69b0ca12a02556c436680ea0a159efb7a748fa |

The upright variable font (weight axis 200–800) is the source Google Fonts
serves this family from. `app/layout.jsx` loads it with `next/font/local`,
limited to the weights the site uses (400–700) and to the same unicode ranges
Google served (latin, latin-ext, vietnamese, cyrillic-ext), so `next build`
needs no network access to Google Fonts and the rendering is unchanged.
