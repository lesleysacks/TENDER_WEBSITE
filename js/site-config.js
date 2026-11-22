/*
 * Business settings for the website. Empty values are hidden on the page, so nothing unconfirmed
 * is ever shown. Fill these in as the business confirms each item.
 */
window.PURELINE_CONFIG = Object.freeze({
  // The enquiry API is served by the Node server (npm start, port 8000). VS Code Live Server
  // (port 5500/5501) only serves files, so when the page is opened from it, call port 8000 instead.
  apiBase: ['5500', '5501'].includes(window.location.port)
    ? `${window.location.protocol}//${window.location.hostname}:8000/api`
    : '/api',

  // Google Apps Script web app that saves enquiries (its /exec URL from Deploy → Web app).
  // Leave empty to use the Node server's /api instead (npm start). See docs/DEPLOY.md.
  leadsEndpoint: '',

  // Official business channels only (no personal numbers). Example WhatsApp format: '27XXXXXXXXX'.
  businessEmail: 'Nextgeneration.ai7.0@gmail.com',
  whatsappNumber: '',

  // Authentic photography. Leave a path empty to keep the drawn illustration in its place.
  photography: Object.freeze({
    logistics: '', // e.g. 'assets/photography/logistics-fleet.webp'
    product: 'assets/photography/product-pads.webp',
    tiers: Object.freeze({
      individual: 'assets/photography/individual-pads.webp',
      'small-packs': 'assets/photography/small-packs.webp',
      'multiple-packs': 'assets/photography/multiple-packs.webp',
      'bulk-packaging': 'assets/photography/bulk-packaging.webp',
      pallet: 'assets/photography/pallets.webp',
      'large-scale': 'assets/photography/large-scale.webp',
    }),
  }),
});
