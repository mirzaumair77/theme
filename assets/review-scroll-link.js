import { getScrollContainer, scrollContainerMediaQuery } from '@theme/scroll-container';

/**
 * <review-scroll-link> wraps the review-count link rendered by blocks/review.liquid.
 * On click it smoothly scrolls to the visible Reviews Widget app block (Yotpo),
 * offsetting for the sticky header, then moves focus there for keyboard/screen-reader users.
 *
 * Scrolling goes through `@theme/scroll-container`: on desktop (≥990px) the page scrolls inside
 * `.page-wrapper` while `html`/`body` are `overflow: hidden`. Scrolling the window there shifts the
 * locked root out of view and leaves a blank screen, so never use `window.scrollTo` here.
 */

// Ordered most to least specific: the app block wrapper exists at page load,
// the Yotpo widget markup only once the app script has rendered it.
const REVIEW_WIDGET_SELECTORS = [
  '[id^="shopify-block-"][id*="yotpo_product_reviews_reviews"]',
  '.yotpo-widget-instance[data-yotpo-widget-type*="Reviews"]',
  '.yotpo-reviews-main-widget',
  '.yotpo-main-widget',
  '#reviews',
];

const EXTRA_OFFSET = 16;

/**
 * @param {Element} element
 * @returns {boolean}
 */
const isVisible = (element) => element.getClientRects().length > 0;

/** @returns {HTMLElement | null} */
const findReviewWidget = () => {
  for (const selector of REVIEW_WIDGET_SELECTORS) {
    for (const element of document.querySelectorAll(selector)) {
      // Skip hidden copies (e.g. desktop-only / mobile-only duplicates).
      if (element instanceof HTMLElement && isVisible(element)) return element;
    }
  }
  return null;
};

const getHeaderOffset = () => {
  const value = parseFloat(getComputedStyle(document.body).getPropertyValue('--header-height'));
  return Number.isFinite(value) ? value : 0;
};

/**
 * Scroll position inside `container` that puts `target` just below the sticky header.
 *
 * @param {Element} container
 * @param {Element} target
 * @returns {number}
 */
const getTargetScrollTop = (container, target) => {
  const isRoot = container === document.scrollingElement || container === document.documentElement;
  const containerTop = isRoot ? 0 : container.getBoundingClientRect().top;
  const top = target.getBoundingClientRect().top - containerTop + container.scrollTop;
  const max = container.scrollHeight - container.clientHeight;

  return Math.min(Math.max(top - getHeaderOffset() - EXTRA_OFFSET, 0), Math.max(max, 0));
};

class ReviewScrollLink extends HTMLElement {
  /** @type {AbortController | undefined} */
  #controller;

  /** @type {AbortController | undefined} */
  #scrollController;

  connectedCallback() {
    this.#controller?.abort();
    this.#controller = new AbortController();
    this.addEventListener('click', this.handleClick, { signal: this.#controller.signal });
  }

  disconnectedCallback() {
    this.#controller?.abort();
    this.#scrollController?.abort();
  }

  /** @param {MouseEvent} event */
  handleClick = (event) => {
    if (!(event.target instanceof Element) || !event.target.closest('a')) return;

    const target = findReviewWidget();
    if (!target) return;

    event.preventDefault();

    const container = getScrollContainer();
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Desktop: the document root is locked; make sure it is not left offset by an earlier scroll.
    if (scrollContainerMediaQuery.matches && container !== document.scrollingElement) {
      document.scrollingElement?.scrollTo({ top: 0, behavior: 'instant' });
    }

    container.scrollTo({
      top: getTargetScrollTop(container, target),
      behavior: reduceMotion ? 'instant' : 'smooth',
    });

    this.#correctAfterScroll(container, target);

    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  };

  /**
   * Lazy images and the app widget can change height while the smooth scroll runs.
   * Once scrolling settles, nudge to the final position if the target moved.
   *
   * @param {Element} container
   * @param {Element} target
   */
  #correctAfterScroll(container, target) {
    this.#scrollController?.abort();
    const controller = new AbortController();
    this.#scrollController = controller;

    const eventTarget = container === document.scrollingElement ? document : container;
    const fallback = setTimeout(() => settle(), 1200);

    const settle = () => {
      if (controller.signal.aborted) return;
      controller.abort();
      clearTimeout(fallback);

      const top = getTargetScrollTop(container, target);
      if (Math.abs(container.scrollTop - top) > 4) {
        container.scrollTo({ top, behavior: 'instant' });
      }
    };

    eventTarget.addEventListener('scrollend', settle, { once: true, signal: controller.signal });
    // A new user scroll (wheel/touch) cancels the correction.
    for (const type of ['wheel', 'touchstart']) {
      window.addEventListener(type, () => { controller.abort(); clearTimeout(fallback); }, {
        once: true,
        passive: true,
        signal: controller.signal,
      });
    }
  }
}

if (!customElements.get('review-scroll-link')) {
  customElements.define('review-scroll-link', ReviewScrollLink);
}
