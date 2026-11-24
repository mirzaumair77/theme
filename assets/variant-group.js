import { Component } from '@theme/component';
import { StandardEvents } from '@shopify/events';

/** Option names treated as the Color option (matched case-insensitively). */
const COLOR_OPTION_NAMES = ['color', 'colour'];

/**
 * @typedef {object} VariantGroupRefs
 * @property {HTMLUListElement} list - The product list.
 * @property {HTMLElement} [currentTitle] - The heading's active product title.
 * @property {HTMLButtonElement[]} [layoutButtons] - Grid / List toggle buttons.
 * @property {HTMLButtonElement} [toggle] - Show more / Show less button.
 * @property {HTMLButtonElement} [previous] - Slider arrow toward the start.
 * @property {HTMLButtonElement} [next] - Slider arrow toward the end.
 */

const LAYOUTS = ['grid', 'list'];

/**
 * Variant Group (Pocket Square PDP).
 *
 * - Layouts (data-layout): Grid (one scrolling row of tiles with arrows) and List.
 * - List holds back items beyond the initial count until "Show more" (data-expanded).
 * - Keeps sibling product links pointed at the variant matching the shopper's current
 *   Color selection, so the chosen finish carries over to the destination PDP.
 *
 * @extends {Component<VariantGroupRefs>}
 */
class VariantGroupComponent extends Component {
  requiredRefs = ['list'];

  /** @type {AbortController | undefined} */
  #abortController;

  /** @type {WeakMap<HTMLAnchorElement, Record<string, number>>} */
  #colorMaps = new WeakMap();

  /** @type {number} */
  #frame = 0;

  connectedCallback() {
    super.connectedCallback();

    this.#abortController?.abort();
    this.#abortController = new AbortController();
    const { signal } = this.#abortController;

    const section = this.closest('.shopify-section');
    section?.addEventListener(StandardEvents.productSelect, this.#handleProductSelect, { signal });

    this.refs.list.addEventListener('scroll', this.#scheduleArrowUpdate, { passive: true, signal });
    window.addEventListener('resize', this.#scheduleArrowUpdate, { passive: true, signal });

    // Set the initial arrow state (the current product renders first).
    this.#scheduleArrowUpdate();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abortController?.abort();
    cancelAnimationFrame(this.#frame);
  }

  /**
   * Switches the layout. Bound through on:click="/setLayout/<layout>".
   * @param {string} layout - 'grid' or 'list'.
   */
  setLayout(layout) {
    if (!LAYOUTS.includes(layout)) return;

    this.dataset.layout = layout;

    for (const button of this.refs.layoutButtons ?? []) {
      button.setAttribute('aria-pressed', String(button.dataset.layoutValue === layout));
    }

    if (layout === 'grid') this.refs.list.scrollTo({ left: 0 });
    this.#scheduleArrowUpdate();
  }

  /**
   * List: shows or hides the items beyond the initial count.
   * Bound through on:click="/toggleExpanded".
   */
  toggleExpanded() {
    const { toggle, list } = this.refs;
    const expanded = this.dataset.expanded !== 'true';

    this.dataset.expanded = String(expanded);
    toggle?.setAttribute('aria-expanded', String(expanded));

    if (expanded) {
      // Move focus to the first revealed product so keyboard users land on the new content.
      const firstExtraLink = list.querySelector('[data-extra] a');
      if (firstExtraLink instanceof HTMLElement) firstExtraLink.focus();
    } else if (document.activeElement instanceof HTMLElement && document.activeElement.closest('[data-extra]')) {
      // Focus would be lost inside a now-hidden item.
      toggle?.focus();
    }
  }

  /** Bound through on:click="/scrollPrevious". */
  scrollPrevious() {
    this.#scrollByPage(-1);
  }

  /** Bound through on:click="/scrollNext". */
  scrollNext() {
    this.#scrollByPage(1);
  }

  /** @param {1 | -1} direction - Logical direction (1 = toward the inline end). */
  #scrollByPage(direction) {
    const { list } = this.refs;
    const isRtl = getComputedStyle(list).direction === 'rtl';
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    list.scrollBy({
      left: list.clientWidth * 0.8 * direction * (isRtl ? -1 : 1),
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
  }

  #scheduleArrowUpdate = () => {
    cancelAnimationFrame(this.#frame);
    this.#frame = requestAnimationFrame(() => {
      const { list, previous, next } = this.refs;
      const isSlider = this.dataset.layout === 'grid';
      // scrollLeft is negative in RTL; compare magnitudes.
      const offset = Math.abs(list.scrollLeft);
      const maxOffset = list.scrollWidth - list.clientWidth;

      if (previous) previous.hidden = !isSlider || offset <= 1;
      if (next) next.hidden = !isSlider || offset >= maxOffset - 1;
    });
  };

  /**
   * Retargets sibling links when the shopper changes Color on this PDP.
   * @param {Event & { selectedOptions?: { name: string, value: string }[], detail?: { variantId?: string } }} event
   */
  #handleProductSelect = (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest('product-card, quick-add-dialog, dialog')) return;

    const { selectedOptions } = event;
    if (!Array.isArray(selectedOptions)) return;

    const colorOption = selectedOptions.find((option) =>
      COLOR_OPTION_NAMES.includes(String(option?.name ?? '').trim().toLowerCase())
    );

    this.#updateLinks(colorOption ? String(colorOption.value).trim().toLowerCase() : '', event.detail?.variantId);
  };

  /**
   * @param {string} colorKey - Lowercased Color value, or '' when the product has no Color option.
   * @param {string | undefined} currentVariantId - The variant just selected on this PDP.
   */
  #updateLinks(colorKey, currentVariantId) {
    for (const link of this.refs.list.querySelectorAll('a.variant-group__link')) {
      if (!(link instanceof HTMLAnchorElement)) continue;

      const { baseUrl } = link.dataset;
      if (!baseUrl) continue;

      const url = new URL(baseUrl, window.location.origin);

      if (link.getAttribute('aria-current') === 'page') {
        if (currentVariantId) url.searchParams.set('variant', currentVariantId);
      } else {
        const variantId = colorKey ? this.#getColorMap(link)[colorKey] : undefined;
        if (variantId) url.searchParams.set('variant', String(variantId));
      }

      link.href = `${url.pathname}${url.search}`;
    }
  }

  /**
   * @param {HTMLAnchorElement} link
   * @returns {Record<string, number>}
   */
  #getColorMap(link) {
    let map = this.#colorMaps.get(link);

    if (!map) {
      try {
        map = JSON.parse(link.dataset.colorVariants || '{}');
      } catch {
        map = {};
      }
      this.#colorMaps.set(link, /** @type {Record<string, number>} */ (map));
    }

    return /** @type {Record<string, number>} */ (map);
  }
}

if (!customElements.get('variant-group-component')) {
  customElements.define('variant-group-component', VariantGroupComponent);
}
