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
  // Every vehicle is drawn facing right, in local coordinates with the ground at y = 0.

  const wheel = (cx, cy, r) =>
    `<circle class="l-wheel" cx="${cx}" cy="${cy}" r="${r}"/><circle class="l-hub" cx="${cx}" cy="${cy}" r="${r * 0.4}"/>`;

  const at = (x, y, s, body) => `<g transform="translate(${x} ${y}) scale(${s})">${body}</g>`;

  // Rigid truck for full loads
  const truck = (x, y, s) => at(x, y, s, `
      <rect class="l-truck-box" x="0" y="-176" width="300" height="140"/>
      <rect class="l-livery" x="0" y="-70" width="300" height="12"/>
      <text class="l-truck-text" x="22" y="-112">PURELINE</text>
      <text class="l-truck-sub" x="24" y="-88">HYGIENE · BULK SUPPLY</text>
      <path class="l-cab" d="M306 -36 V-128 Q306 -136 314 -136 H362 Q372 -136 378 -126 L398 -86 V-36 Z"/>
      <path class="l-window" d="M318 -126 H360 L380 -92 H318 Z"/>
      <rect class="l-chassis" x="-4" y="-38" width="404" height="14"/>
      ${wheel(56, -18, 22)}${wheel(104, -18, 22)}${wheel(346, -18, 22)}`);

  // Bakkie with cartons on the back
  const bakkie = (x, y, s) => at(x, y, s, `
      ${carton(8, -60, 44, 30)}${carton(56, -60, 44, 30)}${carton(30, -90, 44, 28)}
      <rect class="l-bakkie" x="0" y="-62" width="124" height="34"/>
      <path class="l-bakkie" d="M124 -28 V-80 Q124 -88 132 -88 H174 L202 -58 H220 Q228 -58 228 -50 V-28 Z"/>
      <path class="l-window" d="M134 -80 H170 L192 -60 H134 Z"/>
      <rect class="l-chassis" x="-4" y="-32" width="236" height="10"/>
      ${wheel(42, -18, 17)}${wheel(186, -18, 17)}`);

  // Minibus (taxi-style), for smaller drops to schools and clinics
  const minibus = (x, y, s) => {
    let windows = '';
    for (let w = 0; w < 5; w += 1) windows += `<rect class="l-glass" x="${14 + w * 44}" y="-114" width="36" height="30" rx="3"/>`;
    return at(x, y, s, `
      <path class="l-bus" d="M0 -30 V-118 Q0 -130 12 -130 H236 Q252 -130 262 -118 L294 -72 Q302 -62 302 -50 V-30 Z"/>
      ${windows}
      <path class="l-glass" d="M244 -116 Q254 -116 260 -106 L284 -72 H244 Z"/>
      <rect class="l-livery" x="0" y="-70" width="302" height="7"/>
      <line class="l-seam" x1="150" y1="-118" x2="150" y2="-32"/>
      <rect class="l-chassis" x="-2" y="-34" width="306" height="9"/>
      <rect class="l-lamp" x="294" y="-58" width="8" height="8" rx="2"/>
      ${wheel(62, -18, 18)}${wheel(246, -18, 18)}`);
  };

  // Panel van with livery
  const van = (x, y, s) => at(x, y, s, `
      <path class="l-van" d="M0 -30 V-140 Q0 -150 10 -150 H218 Q232 -150 240 -138 L272 -86 Q280 -76 280 -62 V-30 Z"/>
      <path class="l-glass" d="M226 -138 Q232 -138 236 -132 L262 -90 H226 Z"/>
      <rect class="l-livery" x="0" y="-62" width="280" height="10"/>
      <text class="l-van-text" x="18" y="-92">PURELINE</text>
      <text class="l-van-sub" x="20" y="-74">HYGIENE · DELIVERIES</text>
      <line class="l-seam" x1="212" y1="-140" x2="212" y2="-32"/>
      <rect class="l-chassis" x="-2" y="-34" width="284" height="9"/>
      <rect class="l-lamp" x="272" y="-54" width="8" height="8" rx="2"/>
      ${wheel(54, -18, 18)}${wheel(228, -18, 18)}`);

  // Forklift carrying a loaded pallet
  const forklift = (x, y, s) => at(x, y, s, `
      <rect class="l-mast" x="78" y="-132" width="7" height="124"/>
      <rect class="l-mast" x="85" y="-20" width="58" height="5"/>
      ${loadedPallet(85, -15, 2, 2, 27, 22)}
      <rect class="l-fork-dark" x="-12" y="-62" width="18" height="50" rx="3"/>
      <path class="l-fork" d="M0 -12 V-60 H44 L74 -36 V-12 Z"/>
      <path class="l-cage" d="M10 -60 V-112 H58 L76 -44"/>
      <rect class="l-fork-dark" x="22" y="-80" width="16" height="20" rx="3"/>
      ${wheel(18, -10, 12)}${wheel(62, -10, 12)}`);

  // Manual pallet jack under a loaded pallet
  const palletJack = (x, y, s) => at(x, y, s, `
      ${loadedPallet(0, -3, 3, 3, 30, 24)}
      <rect class="l-jack" x="-4" y="-4" width="104" height="4"/>
      <rect class="l-jack" x="-20" y="-26" width="18" height="24" rx="2"/>
      <line class="l-jack-handle" x1="-12" y1="-26" x2="-46" y2="-96"/>
      <rect class="l-jack" x="-56" y="-102" width="22" height="7" rx="3"/>
      <circle class="l-wheel" cx="-12" cy="-3" r="5"/><circle class="l-wheel" cx="92" cy="-2" r="3"/>`);

  // Warehouse worker in a hi-vis vest, leaning in to push the pallet-jack handle (hands at x = -46, y = -100).
  const worker = (x, y, s) => at(x, y, s, `
      <path class="l-worker-leg" d="M-92 0 L-82 -46 M-64 0 L-76 -46"/>
      <path class="l-worker-boot" d="M-100 0 H-86 M-70 0 H-56"/>
      <path class="l-worker-shirt" d="M-88 -46 L-70 -48 L-56 -102 Q-62 -112 -74 -108 L-90 -96 Z"/>
      <path class="l-worker-vest" d="M-86 -60 L-70 -62 L-60 -98 Q-64 -104 -72 -102 L-84 -92 Z"/>
      <path class="l-worker-stripe" d="M-84 -76 L-66 -80"/>
      <path class="l-worker-arm" d="M-64 -100 L-46 -98"/>
      <circle class="l-worker-skin" cx="-52" cy="-120" r="10"/>
      <path class="l-worker-cap" d="M-63 -122 Q-62 -134 -50 -133 Q-41 -131 -41 -122 Z"/>`);

  // Courier scooter with a top box, for urgent small parcels
  const scooter = (x, y, s) => at(x, y, s, `
      <rect class="l-courier-box" x="-14" y="-82" width="40" height="34" rx="3"/>
      <rect class="l-livery" x="-14" y="-68" width="40" height="5"/>
      <path class="l-scooter" d="M-10 -22 Q-6 -44 22 -46 H58 L70 -22 Z"/>
      <rect class="l-fork-dark" x="4" y="-54" width="34" height="8" rx="4"/>
      <line class="l-jack-handle" x1="62" y1="-40" x2="72" y2="-84"/>
      <rect class="l-fork-dark" x="64" y="-90" width="20" height="6" rx="3"/>
      ${wheel(0, -12, 13)}${wheel(76, -12, 13)}`);

  function logisticsScene() {
    let doors = '';
    for (let d = 0; d < 6; d += 1) {
      const dx = 230 + d * 200;
      doors += `<rect class="l-door" x="${dx}" y="330" width="130" height="170"/>`;
      for (let sl = 1; sl < 9; sl += 1) doors += `<line class="l-slat" x1="${dx}" y1="${330 + sl * 19}" x2="${dx + 130}" y2="${330 + sl * 19}"/>`;
    }
    let lanes = '';
    for (let l = 0; l < 12; l += 1) lanes += `<rect class="l-lane" x="${20 + l * 140}" y="708" width="80" height="6"/>`;

    const body = `
      <rect class="l-sky" x="0" y="0" width="1600" height="760"/>
      <path class="l-hills" d="M0 300 L180 240 L340 280 L520 210 L700 270 L880 220 L1080 260 L1260 200 L1440 250 L1600 230 V420 H0 Z"/>
      <rect class="l-building" x="100" y="190" width="1400" height="330"/>
      <path class="l-roof" d="M80 196 L800 120 L1520 196 Z"/>
      <rect class="l-sign" x="960" y="214" width="460" height="64"/>
      <text class="l-sign-text" x="1190" y="256" text-anchor="middle">PURELINE HYGIENE · DISTRIBUTION</text>
      ${doors}
      <rect class="l-dock" x="100" y="500" width="1400" height="34"/>
      ${loadedPallet(150, 500, 3, 2, 40, 30)}
      ${forklift(870, 500, 0.9)}
      ${palletJack(1330, 500, 0.9)}
      ${worker(1330, 500, 0.9)}
      <rect class="l-yard" x="0" y="534" width="1600" height="226"/>
      ${van(850, 600, 0.62)}
      ${minibus(1060, 600, 0.62)}
      ${scooter(1300, 600, 0.66)}
      <rect class="l-road" x="0" y="640" width="1600" height="120"/>
      ${lanes}
      ${truck(860, 748, 0.82)}
      ${bakkie(1230, 748, 0.85)}`;
    return svg(
      '0 0 1600 760',
      body,
      'Illustration of the PureLine Hygiene distribution centre: a truck, panel van, minibus, bakkie and courier scooter, with a forklift and a worker pushing a pallet jack',
      'xMaxYMax slice' // the hero copy sits on the left, so any cropping happens there
    );
  }

  window.PureLineIllustrations = Object.freeze({ tierIllustration, productIllustration, logisticsScene });
})();
