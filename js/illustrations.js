/*
 * Drawn stand-ins for photography that has not been supplied yet: the product, the six supply-volume
 * tiers and the logistics scene. Colours come from CSS classes (see "Illustrations" in styles.css).
 * When real photography is configured in site-config.js it replaces these.
 */
(function () {
  'use strict';

  const svg = (viewBox, body, label, fit = 'xMidYMid meet') =>
    `<svg viewBox="${viewBox}" preserveAspectRatio="${fit}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${label}" focusable="false">${body}</svg>`;

  // ---- Product and packaging primitives (local coordinates, baseline at y = 0) ----

  const pad = (x, y, s = 1) => `
    <g transform="translate(${x} ${y}) scale(${s})">
      <ellipse class="i-pad-wing" cx="0" cy="-46" rx="30" ry="12"/>
      <rect class="i-pad" x="-17" y="-92" width="34" height="92" rx="17"/>
      <rect class="i-pad-core" x="-9" y="-80" width="18" height="68" rx="9"/>
    </g>`;

  const pack = (x, y, w = 64, h = 84) => `
    <g transform="translate(${x} ${y})">
      <rect class="i-pack" x="0" y="${-h}" width="${w}" height="${h}" rx="3"/>
      <rect class="i-pack-top" x="0" y="${-h}" width="${w}" height="${h * 0.14}" rx="3"/>
      <rect class="i-band" x="0" y="${-h * 0.52}" width="${w}" height="${h * 0.12}"/>
      <rect class="i-label" x="${w * 0.2}" y="${-h * 0.34}" width="${w * 0.6}" height="${h * 0.14}" rx="1"/>
    </g>`;

  const carton = (x, y, w = 80, h = 54) => `
    <g transform="translate(${x} ${y})">
      <rect class="i-carton" x="0" y="${-h}" width="${w}" height="${h}"/>
      <rect class="i-tape" x="${w * 0.44}" y="${-h}" width="${w * 0.12}" height="${h * 0.45}"/>
      <rect class="i-carton-label" x="${w * 0.1}" y="${-h * 0.36}" width="${w * 0.3}" height="${h * 0.18}"/>
      <line class="i-edge" x1="0" y1="${-h}" x2="${w}" y2="${-h}"/>
    </g>`;

  const pallet = (x, y, w) => `
    <g transform="translate(${x} ${y})">
      <rect class="i-pallet" x="0" y="-16" width="${w}" height="6"/>
      <rect class="i-pallet-dark" x="4" y="-10" width="14" height="6"/>
      <rect class="i-pallet-dark" x="${w / 2 - 7}" y="-10" width="14" height="6"/>
      <rect class="i-pallet-dark" x="${w - 18}" y="-10" width="14" height="6"/>
      <rect class="i-pallet" x="0" y="-4" width="${w}" height="4"/>
    </g>`;

  const loadedPallet = (x, y, cols, rows, cw = 52, ch = 36) => {
    const w = cols * cw + 8;
    let body = pallet(x, y, w);
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) body += carton(x + 4 + c * cw, y - 16 - r * ch, cw, ch);
    }
    return body;
  };

  const ground = (cx, rx) => `<ellipse class="i-ground" cx="${cx}" cy="196" rx="${rx}" ry="10"/>`;

  // ---- Supply-volume tiers (viewBox 0 0 360 220) ----

  const TIER_DRAWINGS = {
    individual: () => ground(180, 90) + pad(130, 192, 0.9) + pad(180, 192, 1) + pad(230, 192, 0.9),
    'small-packs': () => ground(180, 110) + pack(112, 194, 64, 84) + pack(184, 194, 64, 84) + pad(272, 194, 0.7),
    'multiple-packs': () => {
      let body = ground(180, 140);
      for (let c = 0; c < 4; c += 1) body += pack(78 + c * 52, 194, 48, 64);
      for (let c = 0; c < 3; c += 1) body += pack(104 + c * 52, 130, 48, 64);
      return body;
    },
    'bulk-packaging': () => {
      let body = ground(180, 140);
      for (let c = 0; c < 3; c += 1) body += carton(66 + c * 78, 194, 76, 54);
      for (let c = 0; c < 2; c += 1) body += carton(105 + c * 78, 140, 76, 54);
      body += carton(144, 86, 76, 54);
      return body;
    },
    pallet: () => ground(180, 150) + loadedPallet(48, 196, 3, 3, 44, 34) + loadedPallet(196, 196, 2, 4, 52, 34),
    'large-scale': () => {
      let body = '<g class="i-depth">';
      for (let p = 0; p < 4; p += 1) body += loadedPallet(14 + p * 86, 120, 2, 3, 38, 26);
      body += '</g>' + ground(180, 170);
      for (let p = 0; p < 3; p += 1) body += loadedPallet(18 + p * 112, 196, 2, 3, 50, 32);
      return body;
    },
  };

  function tierIllustration(id, label) {
    return svg('0 0 360 220', TIER_DRAWINGS[id](), label);
  }

  function productIllustration() {
    const body = `${ground(180, 70)}${pad(180, 194, 1.85)}`;
    return svg('0 0 360 220', body, 'Illustration of a single sanitary pad');
  }

  // ---- Logistics scene (viewBox 0 0 1600 760) ----

  const wheel = (cx, cy, r) =>
    `<circle class="l-wheel" cx="${cx}" cy="${cy}" r="${r}"/><circle class="l-hub" cx="${cx}" cy="${cy}" r="${r * 0.4}"/>`;

  const truck = (x, y, s) => `
    <g transform="translate(${x} ${y}) scale(${s})">
      <rect class="l-truck-box" x="0" y="-176" width="300" height="140"/>
      <rect class="l-livery" x="0" y="-70" width="300" height="12"/>
      <text class="l-truck-text" x="22" y="-112">PURELINE</text>
      <text class="l-truck-sub" x="24" y="-88">HYGIENE · BULK SUPPLY</text>
      <path class="l-cab" d="M306 -36 V-128 Q306 -136 314 -136 H362 Q372 -136 378 -126 L398 -86 V-36 Z"/>
      <path class="l-window" d="M318 -126 H360 L380 -92 H318 Z"/>
      <rect class="l-chassis" x="-4" y="-38" width="404" height="14"/>
      ${wheel(56, -18, 22)}${wheel(104, -18, 22)}${wheel(346, -18, 22)}
    </g>`;

  const bakkie = (x, y, s) => `
    <g transform="translate(${x} ${y}) scale(${s})">
      ${carton(8, -60, 44, 30)}${carton(56, -60, 44, 30)}${carton(30, -90, 44, 28)}
      <rect class="l-bakkie" x="0" y="-62" width="124" height="34"/>
      <path class="l-bakkie" d="M124 -28 V-80 Q124 -88 132 -88 H174 L202 -58 H220 Q228 -58 228 -50 V-28 Z"/>
      <path class="l-window" d="M134 -80 H170 L192 -60 H134 Z"/>
      <rect class="l-chassis" x="-4" y="-32" width="236" height="10"/>
      ${wheel(42, -18, 17)}${wheel(186, -18, 17)}
    </g>`;

  function logisticsScene() {
    let doors = '';
    for (let d = 0; d < 6; d += 1) {
      const dx = 230 + d * 200;
      doors += `<rect class="l-door" x="${dx}" y="330" width="130" height="170"/>`;
      for (let s = 1; s < 9; s += 1) doors += `<line class="l-slat" x1="${dx}" y1="${330 + s * 19}" x2="${dx + 130}" y2="${330 + s * 19}"/>`;
    }
    let lanes = '';
    for (let l = 0; l < 12; l += 1) lanes += `<rect class="l-lane" x="${20 + l * 140}" y="708" width="80" height="6"/>`;

    let dockStock = '';
    [[150, 3, 2], [1420, 2, 3]].forEach(([px, cols, rows]) => {
      dockStock += loadedPallet(px, 500, cols, rows, 40, 30);
    });

    const body = `
      <rect class="l-sky" x="0" y="0" width="1600" height="760"/>
      <path class="l-hills" d="M0 300 L180 240 L340 280 L520 210 L700 270 L880 220 L1080 260 L1260 200 L1440 250 L1600 230 V420 H0 Z"/>
      <rect class="l-building" x="100" y="190" width="1400" height="330"/>
      <path class="l-roof" d="M80 196 L800 120 L1520 196 Z"/>
      <rect class="l-sign" x="960" y="214" width="460" height="64"/>
      <text class="l-sign-text" x="1190" y="256" text-anchor="middle">PURELINE HYGIENE · DISTRIBUTION</text>
      ${doors}
      <rect class="l-dock" x="100" y="500" width="1400" height="34"/>
      ${dockStock}
      <rect class="l-yard" x="0" y="534" width="1600" height="226"/>
      <rect class="l-road" x="0" y="640" width="1600" height="120"/>
      ${lanes}
      ${truck(930, 652, 1.2)}
      ${bakkie(1150, 742, 0.95)}`;
    return svg(
      '0 0 1600 760',
      body,
      'Illustration of a PureLine Hygiene distribution centre with delivery trucks and bakkies',
      'xMaxYMax slice' // the hero copy sits on the left, so any cropping happens there
    );
  }

  window.PureLineIllustrations = Object.freeze({ tierIllustration, productIllustration, logisticsScene });
})();
