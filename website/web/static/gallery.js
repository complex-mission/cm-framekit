// Screenshot lightbox: PhotoSwipe with all default UI turned off and the site's own controls.
import PhotoSwipeLightbox from '/static/vendor/photoswipe/photoswipe-lightbox.esm.min.js';

const en = document.getElementById('fk-config')?.dataset.lang === 'en';
const L = en
  ? { close: 'Close', zoom: 'Zoom', prev: 'Previous', next: 'Next' }
  : { close: '关闭', zoom: '缩放', prev: '上一张', next: '下一张' };

const icon = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`;
const ICONS = {
  close: icon('M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z'),
  zoomIn: icon('M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14zM12 10h-2v2H9v-2H7V9h2V7h1v2h2v1z'),
  zoomOut: icon('M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14zM7 9h5v1H7z'),
  prev: icon('M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z'),
  next: icon('M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z'),
};

const lightbox = new PhotoSwipeLightbox({
  gallery: '.shots',
  children: 'a.shot-link',
  pswpModule: () => import('/static/vendor/photoswipe/photoswipe.esm.min.js'),
  // default UI off; everything below is registered by hand
  arrowPrev: false,
  arrowNext: false,
  close: false,
  zoom: false,
  counter: false,
  bgOpacity: 1,
  showHideAnimationType: 'fade',
  // room for the bar, caption and arrows; phones swipe instead of using arrows
  paddingFn: (vp) => (vp.x < 600 ? { top: 64, bottom: 72, left: 8, right: 8 } : { top: 72, bottom: 64, left: 72, right: 72 }),
  wheelToZoom: true,
  imageClickAction: 'zoom',
  tapAction: 'toggle-controls',
  closeOnVerticalDrag: true,
});

lightbox.addFilter('itemData', (data) => {
  const el = data.element;
  if (el) data.caption = el.closest('figure')?.querySelector('figcaption')?.textContent?.trim() || '';
  return data;
});

lightbox.on('uiRegister', () => {
  const ui = lightbox.pswp.ui;

  ui.registerElement({
    name: 'fk-counter',
    order: 5,
    onInit: (el, pswp) => {
      pswp.on('change', () => { el.textContent = `${pswp.currIndex + 1} / ${pswp.getNumItems()}`; });
    },
  });

  ui.registerElement({
    name: 'fk-zoom',
    className: 'fk-pswp-btn fk-pswp-zoom',
    order: 10,
    isButton: true,
    title: L.zoom,
    html: ICONS.zoomIn,
    onClick: 'toggleZoom',
    onInit: (el, pswp) => {
      const sync = () => {
        const s = pswp.currSlide;
        el.innerHTML = s && s.currZoomLevel > s.zoomLevels.initial + 0.01 ? ICONS.zoomOut : ICONS.zoomIn;
      };
      pswp.on('zoomPanUpdate', sync);
      pswp.on('change', sync);
    },
  });

  ui.registerElement({
    name: 'fk-close',
    className: 'fk-pswp-btn fk-pswp-close',
    order: 20,
    isButton: true,
    title: L.close,
    html: ICONS.close,
    onClick: 'close',
  });

  for (const dir of ['prev', 'next']) {
    ui.registerElement({
      name: 'fk-' + dir,
      className: 'fk-pswp-btn fk-pswp-arrow fk-pswp-' + dir,
      appendTo: 'wrapper',
      isButton: true,
      title: L[dir],
      html: ICONS[dir],
      onClick: dir,
    });
  }

  ui.registerElement({
    name: 'fk-caption',
    appendTo: 'root',
    onInit: (el, pswp) => {
      pswp.on('change', () => { el.textContent = pswp.currSlide?.data.caption || ''; });
    },
  });
});

lightbox.init();
