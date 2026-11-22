# Asset attribution and permissions register (internal — not published)

Every image, logo and font used on the site must be listed here before it goes live, with the
evidence of permission. (The municipal-logo section has been removed from the site; the rules
below still apply if logos are used anywhere in future.)

## Folder layout

| Folder | Contents | Format guidance |
|---|---|---|
| `assets/photography/` | Authentic PureLine photography: logistics fleet, product, packaging tiers | WebP or AVIF, ≤ 1600 px wide, ≤ 250 KB (hero/background), ≤ 120 KB (others) |
| `assets/icons/` | Small interface icons | SVG |

To use a photo, add the file and set its path in `js/site-config.js` (`photography`). The drawn
illustrations are replaced automatically. Non-critical images are lazy-loaded.

## Register

| Asset | Used on | Source / creator | Licence or permission | Evidence | Status |
|---|---|---|---|---|---|
| `assets/favicon.svg` | All pages | Created for this project | Owned by PureLine Hygiene | — | In use |
| Drawn illustrations (logistics scene; product and supply-tier drawings as fallback) | Home page | Generated in code (`js/illustrations.js`) for this project | Owned by PureLine Hygiene | — | Hero in use; tier drawings replaced by photos |
| `assets/photography/product-pads.webp` | Home page, product panel | Photo supplied by PureLine Hygiene (two individually wrapped pads), placed on a white canvas | Owned by PureLine Hygiene (confirm it is your own photo) | — | In use |
| `assets/photography/individual-pads.webp` | "Individual pads" volume + gallery | Same pads photo, framed tighter | As above | — | In use |
| `assets/photography/small-packs.webp`, `multiple-packs.webp`, `bulk-packaging.webp` | "Small packs", "Multiple packs", "Bulk packaging" volumes + gallery | Crops of one photo supplied by PureLine Hygiene (stacked heat-sealed packs): a few packs, one stack, the whole wall | Owned by PureLine Hygiene (confirm it is your own photo) | — | In use |
| `assets/photography/pallets.webp`, `large-scale.webp` | "Pallet quantities", "Large-scale supply" volumes + gallery | Crops of one photo supplied by PureLine Hygiene (shrink-wrapped cartons on pallets): two pallets, the whole yard | Owned by PureLine Hygiene (confirm it is your own photo) | — | In use |
| `assets/logos/b-bbee.webp` | Home page, credentials strip | Cropped from a B-BBEE promotional banner supplied by PureLine Hygiene (the "B-BBEE" wordmark only) | To be recorded: confirm the banner's source and licence (B-BBEE has no official logo) | — | In use; record source |
| `assets/logos/sabs.webp` | Home page, credentials strip | SABS logo supplied by PureLine Hygiene | SABS permit (management confirmed PureLine holds one) | Add permit number and a copy of the permit | In use; file evidence |
| `assets/logos/proudly-south-african.webp` | Home page, credentials strip | Proudly South African logo supplied by PureLine Hygiene | Proudly SA membership licence (management confirmed membership) | Add membership number and licence terms | In use; file evidence |
| IBM Plex Sans / IBM Plex Mono | All pages | Google Fonts | SIL Open Font Licence 1.1 | fonts.google.com | In use |
| `assets/images/hero-factory.webp` | Not used | Legacy placeholder illustration | Unknown | — | Unused — review and delete |
| `assets/images/og-preview.jpg` | Not used | Legacy social preview from the previous brand | Unknown | — | Unused — replace with a PureLine preview image |
| `assets/icons/badge-*.svg` | Not used | Legacy placeholder badges resembling certification marks | Not official marks | — | Unused — do not publish; delete |

## Municipal logos

None yet. Before adding one:

1. Obtain the official file from the municipality (not a web search).
2. Obtain written permission covering website use, and confirm the wording around it is acceptable.
3. Record the entry here with the permission evidence before publishing.
4. Displaying a logo must not imply a partnership, customer relationship, tender award or endorsement
   unless that has been verified and approved.
