/*
 * Shared page behaviour: mobile navigation and the hero background image.
 */
(function () {
  'use strict';

  const config = window.PURELINE_CONFIG || {};
  const $ = (selector, scope = document) => scope.querySelector(selector);

  // ---------- Mobile navigation ----------

  const header = $('.site-header');
  const toggle = $('.menu-toggle');
  const nav = $('.main-nav');

  const setMenuOpen = (open) => {
    if (!header || !toggle) return;
    header.classList.toggle('menu-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  };

  toggle?.addEventListener('click', () => setMenuOpen(toggle.getAttribute('aria-expanded') !== 'true'));
  nav?.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => setMenuOpen(false)));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && toggle?.getAttribute('aria-expanded') === 'true') {
      setMenuOpen(false);
      toggle.focus();
    }
  });

  // ---------- Hero background ----------

  const scene = $('[data-logistics-scene]');
  if (scene) {
    const photo = config.photography && config.photography.logistics;
    // Above the fold, so the photo is not lazy-loaded.
    scene.innerHTML = photo
      ? `<img src="${photo}" alt="PureLine Hygiene delivery vehicles at the distribution centre" fetchpriority="high" decoding="async" />`
      : window.PureLineIllustrations.logisticsScene();
  }
})();
