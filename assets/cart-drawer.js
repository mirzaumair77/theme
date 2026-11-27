import { Component } from '@theme/component';
import { CartErrorEvent, CartLinesUpdateEvent, StandardEvents } from '@shopify/events';
import { fetchConfig, prefersReducedMotion } from '@theme/utilities';
import { morphSection, sectionRenderer } from '@theme/section-renderer';

/** Section Rendering API target for the drawer (`sections/cart-drawer-section.liquid`). */
const SECTION_ID = 'cart-drawer-section';

/**
 * Protection state from the last cart read (or the page's cart), so opening the drawer can add
 * the protection line with one request instead of a read, a write and a section render. Cleared
 * whenever the cart changes. Used by `cart-drawer-checkout`.
 * @type {{ plan: { variantId: number, feeCents: number } | null, lineCount: number } | null}
 */
let knownProtection = null;

/**
 * Posts a cart mutation that also renders the drawer section, then morphs the drawer.
 *
 * @param {string} url - A cart AJAX endpoint.
 * @param {Record<string, unknown>} payload - The request body, without `sections`.
 * @returns {Promise<any>} The parsed response.
 */
async function mutateCart(url, payload) {
  // Any drawer cart change can shift the protection tier; the next protection sync re-reads it.
  knownProtection = null;
  sectionRenderer.abortRender(SECTION_ID);

  const response = await fetch(
    url,
    fetchConfig('json', {
      body: JSON.stringify({ ...payload, sections: SECTION_ID, sections_url: window.location.pathname }),
    })
  );
  const data = await response.json();

  if (!response.ok || data.status) {
    throw new Error(data.description || data.message || 'Cart update failed');
  }

  const html = data.sections?.[SECTION_ID];
  if (html) {
    await morphSection(SECTION_ID, html, { mode: 'hydration', injectStylesheet: true });
  }

  return data;
}

/**
 * Cart-specific behaviour for the drawer. Dialog lifecycle (open, close, focus, Escape,
 * backdrop) is owned by the surrounding `<theme-drawer modal>`; line mutations by the nested
 * `<cart-items-component>`.
 *
 * @extends {Component}
 */
class CartDrawerComponent extends Component {
  /** Pinned note + footer may use at most this share of the scroll area before the column scrolls as one. */
  static #PINNED_MAX_RATIO = 0.7;

  /**
   * From this drawer (window) height up, the header and footer always stay fixed and only the
   * content area scrolls, however tall the footer grows. Only shorter drawers may fall back to
   * scrolling as one column, where the footer would leave no usable content area.
   */
  static #ALWAYS_PINNED_MIN_HEIGHT = 670;

  /** @type {AbortController | undefined} */
  #controller;

  /** @type {ResizeObserver | undefined} */
  #resizeObserver;

  /** @type {MutationObserver | undefined} */
  #structureObserver;

  #layoutFrame = 0;

  /** @type {import('@theme/theme-drawer').ThemeDrawer | null} */
  get #themeDrawer() {
    return /** @type {import('@theme/theme-drawer').ThemeDrawer | null} */ (this.closest('theme-drawer'));
  }

  connectedCallback() {
    super.connectedCallback();
    this.#controller = new AbortController();
    document.addEventListener(StandardEvents.cartLinesUpdate, this.#handleCartLinesUpdate, {
      signal: this.#controller.signal,
    });

    this.addEventListener('cart-drawer:panel-toggle', this.#handlePanelToggle, { signal: this.#controller.signal });

    this.#resizeObserver = new ResizeObserver(this.#scheduleLayout);
    // Empty ↔ filled renders and the optimistic empty state swap the pinned elements.
    this.#structureObserver = new MutationObserver(() => this.#bindLayout());
    this.#bindLayout();
  }

  updatedCallback() {
    super.updatedCallback();
    // A full section morph can reset this element's attributes; re-measure.
    this.#bindLayout();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#controller?.abort();
    this.#resizeObserver?.disconnect();
    this.#structureObserver?.disconnect();
    cancelAnimationFrame(this.#layoutFrame);
  }

  /** @returns {HTMLElement | null} */
  get #items() {
    return this.querySelector('cart-items-component');
  }

  /** @returns {HTMLElement[]} The pinned order note and footer. */
  get #pinned() {
    const items = this.#items;
    return items
      ? /** @type {HTMLElement[]} */ ([...items.querySelectorAll(':scope > .cart-drawer__note, :scope > .cart-drawer__footer')])
      : [];
  }

  #bindLayout() {
    this.#resizeObserver?.disconnect();
    this.#structureObserver?.disconnect();

    this.#resizeObserver?.observe(this);
    for (const element of this.#pinned) this.#resizeObserver?.observe(element);

    const items = this.#items;
    if (items) this.#structureObserver?.observe(items, { childList: true });

    this.#scheduleLayout();
  }

  #scheduleLayout = () => {
    cancelAnimationFrame(this.#layoutFrame);
    this.#layoutFrame = requestAnimationFrame(() => this.#updateLayout());
  };

  /**
   * Keeps the note and footer pinned (only the content area scrolls). On a drawer shorter than
   * `#ALWAYS_PINNED_MIN_HEIGHT`, if they would leave too little room for the line items, the whole
   * column scrolls instead so every part stays reachable.
   */
  #updateLayout() {
    const items = this.#items;
    const available = items?.clientHeight ?? 0;
    // Closed drawer: nothing to measure yet; the observer fires again when it opens.
    if (!available) return;

    // Count the order note by its summary row only: opening it must not flip the layout (that
    // re-flow made the drawer jump as if the page scrolled). The open field still fits, since a
    // pinned layout always leaves at least 30% of the scroll area free.
    const pinnedHeight = this.#pinned.reduce((total, element) => {
      const summary = element.querySelector('.cart-drawer__note-summary');
      return total + (summary instanceof HTMLElement ? summary.offsetHeight : element.offsetHeight);
    }, 0);
    const shortDrawer = this.getBoundingClientRect().height < CartDrawerComponent.#ALWAYS_PINNED_MIN_HEIGHT;
    const tooTall = shortDrawer && pinnedHeight / available > CartDrawerComponent.#PINNED_MAX_RATIO;
    this.toggleAttribute('data-footer-static', tooTall);
    // Pinned content fits exactly; drop any offset left from the scrolling layout.
    if (!tooTall && items) items.scrollTop = 0;

    // The open note panel may take the room above the pinned footer (the line list shrinks and
    // scrolls); beyond that it scrolls inside itself. On a short drawer the column scrolls, so the
    // panel keeps a share of the visible area instead.
    const room = tooTall ? available * 0.6 : available - pinnedHeight;
    this.style.setProperty('--cart-drawer-note-max', `${Math.max(160, Math.floor(room))}px`);
  }

  /**
   * The delivery calendar opens inside the note panel, which scrolls on its own (see
   * `--cart-drawer-note-max`). Scroll that panel, not the drawer or page, so the whole calendar
   * shows without moving its start out of view.
   * @param {Event} event
   */
  #handlePanelToggle = (event) => {
    const panel = event.target instanceof HTMLElement ? event.target : null;
    const open = /** @type {CustomEvent<{ open: boolean }>} */ (event).detail?.open === true;
    const field = panel?.closest('.cart-drawer__note-field');
    if (!open || !panel || !(field instanceof HTMLElement)) return;

    const calendar = panel.querySelector('.cart-drawer__calendar') ?? panel;
    const view = field.getBoundingClientRect();
    const box = calendar.getBoundingClientRect();
    const shift = Math.min(box.bottom - view.bottom + 12, box.top - view.top);
    if (shift > 0) field.scrollBy({ top: shift, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  };

  /**
   * Submits the shipping-country form when the shopper picks a new country.
   * @param {Event} event
   */
  submitCountry(event) {
    if (!(event.target instanceof HTMLSelectElement)) return;
    event.target.form?.submit();
  }

  /**
   * Opens the drawer after a product is added elsewhere on the page, when the merchant enabled it.
   * @param {CartLinesUpdateEvent} event
   */
  #handleCartLinesUpdate = (event) => {
    if (!this.hasAttribute('auto-open') || event.action !== 'add') return;
    // Adds made inside the drawer (upsell, free gift) never re-open it.
    if (event.target instanceof Node && this.contains(event.target)) return;

    // Defer until a source modal (e.g. quick add) has closed so its focus restoration runs first.
    const sourceModal = /** @type {HTMLDialogElement | null} */ (
      event.target instanceof Element ? event.target.closest('dialog:modal') : null
    );

    event.promise
      ?.then(({ detail }) => {
        if (detail?.didError) return;

        const open = () => this.#themeDrawer?.open();
        if (sourceModal?.open) {
          sourceModal.addEventListener('close', open, { once: true });
        } else {
          open();
        }
      })
      .catch((error) => {
        if (error?.name !== 'AbortError') console.warn('[cart-drawer] Event promise rejected:', error);
      });
  };
}

if (!customElements.get('cart-drawer-component')) {
  customElements.define('cart-drawer-component', CartDrawerComponent);
}

/**
 * Keeps the free gift line in sync with the cart. The drawer's Liquid decides what the cart
 * needs (`data-action`: add | set | remove | none) on every render; this element applies it.
 * Rendering after each mutation re-evaluates the state, so the loop settles at `none`.
 */
class CartFreeGift extends HTMLElement {
  static observedAttributes = ['data-action', 'data-key'];

  /** Last action attempted, so a failing add (e.g. sold out) is not retried on every render. */
  static #lastAttempt = '';

  /** @type {Promise<void> | null} */
  static #pending = null;

  /** @type {AbortController | undefined} */
  #controller;

  #scheduled = false;

  connectedCallback() {
    this.#controller = new AbortController();
    this.addEventListener('change', this.#handleToggle, { signal: this.#controller.signal });
    this.#schedule();
  }

  disconnectedCallback() {
    this.#controller?.abort();
  }

  /**
   * @param {string} _name
   * @param {string | null} oldValue
   * @param {string | null} newValue
   */
  attributeChangedCallback(_name, oldValue, newValue) {
    if (oldValue !== null && oldValue !== newValue && this.isConnected) this.#schedule();
  }

  #schedule() {
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      this.#reconcile();
    });
  }

  async #reconcile() {
    if (CartFreeGift.#pending) {
      await CartFreeGift.#pending;
      if (!this.isConnected) return;
    }

    const { action = 'none', key = '', variantId = '' } = this.dataset;

    if (action === 'none') {
      CartFreeGift.#lastAttempt = '';
      return;
    }

    const attempt = `${action}:${key || variantId}`;
    if (CartFreeGift.#lastAttempt === attempt) return;
    CartFreeGift.#lastAttempt = attempt;

    CartFreeGift.#pending = this.#apply(action, key, variantId).finally(() => {
      CartFreeGift.#pending = null;
    });
  }

  /**
   * @param {string} action
   * @param {string} key
   * @param {string} variantId
   */
  async #apply(action, key, variantId) {
    try {
      if (action === 'add') {
        if (!variantId) return;
        await mutateCart(Theme.routes.cart_add_url, {
          items: [{ id: Number(variantId), quantity: 1, properties: { _free_gift: 'true' } }],
        });
      } else if (key) {
        await mutateCart(`${Theme.routes.cart_change_url}.js`, { id: key, quantity: action === 'set' ? 1 : 0 });
      }
    } catch (error) {
      this.#reportError(error);
    }
  }

  /**
   * The shopper's gift switch. Opting out removes the gift and records the choice in a cart
   * attribute so it is not re-added; opting back in clears it and the next render re-adds it.
   * @param {Event} event
   */
  #handleToggle = async (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.name !== 'free_gift') return;

    input.disabled = true;
    CartFreeGift.#lastAttempt = '';

    /** @type {Record<string, unknown>} */
    const payload = { attributes: { _free_gift_opt_out: input.checked ? '' : 'true' } };
    const { key } = this.dataset;
    if (!input.checked && key) payload.updates = { [key]: 0 };

    try {
      await mutateCart(`${Theme.routes.cart_update_url}.js`, payload);
    } catch (error) {
      input.checked = !input.checked;
      this.#reportError(error);
    } finally {
      input.disabled = false;
    }
  };

  /** @param {unknown} error */
  #reportError(error) {
    if (error instanceof Error && error.name === 'AbortError') return;
    const message = error instanceof Error ? error.message : 'Free gift update failed';
    console.warn('[cart-drawer] Free gift:', message);
    this.dispatchEvent(new CartErrorEvent({ error: message, code: 'INVALID' }));
  }
}

if (!customElements.get('cart-free-gift')) {
  customElements.define('cart-free-gift', CartFreeGift);
}

/** @type {Promise<void> | null} */
let swiperLoader = null;

/**
 * Resolves once the theme's self-hosted Swiper (`swiper-bundle.min.js`) is available. The layout
 * only loads it on some templates, so the drawer injects it on demand everywhere else.
 * @param {string | undefined} src
 * @returns {Promise<void>}
 */
function loadSwiper(src) {
  if (/** @type {any} */ (window).Swiper) return Promise.resolve();
  if (swiperLoader) return swiperLoader;

  swiperLoader = new Promise((resolve, reject) => {
    let script = /** @type {HTMLScriptElement | null} */ (document.querySelector('script[src*="swiper-bundle"]'));
    if (!script) {
      if (!src) return reject(new Error('Swiper source missing'));
      script = document.createElement('script');
      script.src = src;
      script.async = true;
      document.head.append(script);
    }
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener('error', () => reject(new Error('Swiper failed to load')), { once: true });
  }).catch((error) => {
    swiperLoader = null;
    throw error;
  });

  return swiperLoader;
}

/**
 * "You might also like" carousel on the theme's Swiper (same setup as the bestseller slider:
 * BEM wrapper/slide classes, external arrows). Until Swiper is ready, or if it fails to load,
 * the track scrolls natively. Also handles swatch price updates and add-to-bag through the
 * cart events the rest of the theme listens to.
 */
class CartDrawerUpsell extends HTMLElement {
  /** @type {AbortController | undefined} */
  #controller;

  /** @type {any} */
  #swiper = null;

  /** @type {MutationObserver | undefined} */
  #morphObserver;

  #frame = 0;

  connectedCallback() {
    this.#controller = new AbortController();
    const { signal } = this.#controller;

    this.addEventListener('click', this.#handleClick, { signal });
    this.addEventListener('change', this.#handleChange, { signal });
    this.addEventListener('submit', this.#handleSubmit, { signal });
    // Native-scroll fallback: `scroll` does not bubble, so capture it.
    this.addEventListener('scroll', this.#scheduleNavUpdate, { signal, capture: true, passive: true });

    // A drawer re-render morphs the slider back to its server markup, dropping Swiper's classes
    // and inline styles. Rebuild when the container loses Swiper's initialized class.
    this.#morphObserver = new MutationObserver(() => {
      if (this.#swiper && !this.#slider?.classList.contains('swiper-initialized')) this.#rebuild();
    });

    this.#scheduleNavUpdate();
    loadSwiper(this.dataset.swiperSrc)
      .then(() => {
        if (this.isConnected) this.#init();
      })
      .catch((error) => console.warn('[cart-drawer] Upsell slider falls back to native scroll:', error));
  }

  disconnectedCallback() {
    this.#controller?.abort();
    this.#morphObserver?.disconnect();
    this.#destroy();
    cancelAnimationFrame(this.#frame);
  }

  /** @returns {HTMLElement | null} */
  get #slider() {
    return this.querySelector('[data-upsell-slider]');
  }

  /** @returns {HTMLElement | null} */
  get #track() {
    return this.querySelector('[data-upsell-track]');
  }

  #init() {
    const slider = this.#slider;
    const SwiperClass = /** @type {any} */ (window).Swiper;
    if (!slider || !SwiperClass || this.#swiper) return;

    this.#swiper = new SwiperClass(slider, {
      wrapperClass: 'cart-drawer__upsell-track',
      slideClass: 'cart-drawer__card',
      slideActiveClass: 'cart-drawer__card--active',
      slidesPerView: 2.6,
      spaceBetween: 10,
      slidesOffsetBefore: 16,
      slidesOffsetAfter: 16,
      breakpoints: {
        769: { slidesPerView: 3.3, slidesOffsetBefore: 20, slidesOffsetAfter: 20 },
      },
      speed: prefersReducedMotion() ? 0 : 500,
      watchOverflow: true,
      a11y: {
        containerRoleDescriptionMessage: 'carousel',
        slideRole: 'group',
      },
      on: {
        slideChange: () => this.#updateNav(),
        resize: () => this.#updateNav(),
        lock: () => this.#updateNav(),
        unlock: () => this.#updateNav(),
      },
    });

    this.#morphObserver?.disconnect();
    this.#morphObserver?.observe(slider, { attributes: true, attributeFilter: ['class'] });
    this.#updateNav();
  }

  #destroy() {
    this.#swiper?.destroy(true, true);
    this.#swiper = null;
  }

  #rebuild() {
    cancelAnimationFrame(this.#frame);
    this.#frame = requestAnimationFrame(() => {
      this.#destroy();
      this.#init();
    });
  }

  #scheduleNavUpdate = () => {
    if (this.#swiper) return;
    cancelAnimationFrame(this.#frame);
    this.#frame = requestAnimationFrame(() => this.#updateNav());
  };

  #updateNav() {
    let atStart = true;
    let atEnd = true;

    if (this.#swiper) {
      atStart = this.#swiper.isBeginning;
      atEnd = this.#swiper.isEnd;
    } else {
      const track = this.#track;
      if (track) {
        // scrollLeft is negative in RTL, so compare magnitudes.
        const position = Math.abs(track.scrollLeft);
        atStart = position <= 1;
        atEnd = position >= track.scrollWidth - track.clientWidth - 1;
      }
    }

    for (const button of this.querySelectorAll('[data-direction]')) {
      if (!(button instanceof HTMLButtonElement)) continue;
      button.disabled = button.dataset.direction === '-1' ? atStart : atEnd;
    }
  }

  /** @param {MouseEvent} event */
  #handleClick = (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-direction]') : null;
    if (!(button instanceof HTMLButtonElement)) return;

    const forward = button.dataset.direction === '1';

    if (this.#swiper) {
      if (forward) this.#swiper.slideNext();
      else this.#swiper.slidePrev();
      return;
    }

    const track = this.#track;
    if (!track) return;

    const card = track.firstElementChild;
    const gap = parseFloat(getComputedStyle(track).columnGap) || 0;
    const step = card ? card.getBoundingClientRect().width + gap : track.clientWidth;
    const isRtl = getComputedStyle(track).direction === 'rtl';
    const direction = (forward ? 1 : -1) * (isRtl ? -1 : 1);

    track.scrollBy({ left: direction * step, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  };

  /** @param {Event} event */
  #handleChange = (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.name !== 'id' || !input.dataset.price) return;

    const price = input.form?.querySelector('[data-upsell-price]');
    if (price) price.textContent = input.dataset.price;
  };

  /** @param {SubmitEvent} event */
  #handleSubmit = async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.hasAttribute('data-upsell-form')) return;

    event.preventDefault();

    const variantId = Number(new FormData(form).get('id'));
    if (!variantId) return;

    const submitButton = form.querySelector('[type="submit"]');
    if (submitButton instanceof HTMLButtonElement) submitButton.disabled = true;

    const deferred = CartLinesUpdateEvent.createPromise();
    this.dispatchEvent(
      new CartLinesUpdateEvent({
        action: 'add',
        context: 'dialog',
        lines: [{ merchandiseId: String(variantId), quantity: 1 }],
        promise: deferred.promise,
      })
    );

    try {
      const response = await fetch(
        Theme.routes.cart_add_url,
        fetchConfig('json', {
          body: JSON.stringify({
            items: [{ id: variantId, quantity: 1 }],
            sections: SECTION_ID,
            sections_url: window.location.pathname,
          }),
        })
      );
      const data = await response.json();
      if (!response.ok || data.status) throw new Error(data.description || data.message || 'Add to cart failed');

      const cartResponse = await fetch(`${Theme.routes.cart_url}.js`, { headers: { Accept: 'application/json' } });
      const cart = await cartResponse.json();

      // `cart-items-component` morphs the drawer from `detail.sections`.
      deferred.resolve({
        cart: CartLinesUpdateEvent.createCartFromAjaxResponse(cart),
        detail: { sections: data.sections, items: cart.items, source: 'cart-drawer-upsell', didError: false },
      });
    } catch (error) {
      deferred.reject(error);
      const message = error instanceof Error ? error.message : 'Add to cart failed';
      this.dispatchEvent(new CartErrorEvent({ error: message, code: 'INVALID' }));
      if (submitButton instanceof HTMLButtonElement) submitButton.disabled = false;
    }
  };
}

if (!customElements.get('cart-drawer-upsell')) {
  customElements.define('cart-drawer-upsell', CartDrawerUpsell);
}

/** Cart attribute that carries the requested delivery date to the order (Admin > order > Additional details). */
const DELIVERY_DATE_ATTRIBUTE = 'Delivery date';

/**
 * A local calendar date as `YYYY-MM-DD`, the format of `<input type="date">`.
 * @param {Date} date
 * @returns {string}
 */
function toIsoDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Days from today to the earliest selectable delivery date. The setting is a gap of full days
 * left free after today: 3 means an order on Nov 27 skips Nov 28-30 and can be delivered from
 * Dec 1. 0 means no gap. Mirrors `delivery_lead_days` in snippets/cart-drawer.liquid.
 * @param {number} minDays - Theme setting "Minimum days before delivery date".
 * @returns {number}
 */
function leadDays(minDays) {
  return minDays > 0 ? minDays + 1 : 0;
}

/**
 * @param {string} isoDate - `YYYY-MM-DD`.
 * @returns {Date} Local midnight of that date.
 */
function fromIsoDate(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1);
}

/**
 * "Pick a date" calendar in the order note panel. The chosen date is saved as a cart attribute,
 * which Shopify copies onto the order. Dates before today plus the minimum gap
 * (Theme settings > Cart drawer) are disabled.
 *
 * The native `<input type="date">` holds the value and submits with the drawer's cart form; it is
 * the visible control until this script runs. Once enhanced it is hidden and the trigger button
 * opens an inline month grid (arrow keys, Home/End, Page Up/Down, Escape).
 */
class CartDeliveryDate extends HTMLElement {
  /** @type {AbortController | undefined} */
  #controller;

  /** @type {AbortController | undefined} */
  #request;

  /** First day of the month on screen. */
  #view = new Date();

  connectedCallback() {
    this.#controller = new AbortController();
    const { signal } = this.#controller;
    this.addEventListener('change', this.#handleChange, { signal });

    this.#clearStaleDate();

    const { trigger, calendar, label } = this.#refs;
    if (!trigger || !calendar) return;

    this.addEventListener('click', this.#handleClick, { signal });
    this.addEventListener('keydown', this.#handleKeydown, { signal });
    label?.addEventListener('click', () => trigger.focus({ preventScroll: true }), { signal });
    // Collapsing the note panel also collapses the calendar.
    this.closest('details')?.addEventListener('toggle', (event) => {
      if (event.target instanceof HTMLDetailsElement && !event.target.open) this.#close(false);
    }, { signal });

    label?.removeAttribute('for');
    trigger.hidden = false;
    this.toggleAttribute('data-enhanced', true);
    this.#renderWeekdays();
    this.#updateTrigger();
  }

  disconnectedCallback() {
    this.#controller?.abort();
    this.#request?.abort();
  }

  get #refs() {
    /** @param {string} selector */
    const find = (selector) => this.querySelector(selector);
    const input = find('.cart-drawer__date-input');
    return {
      input: input instanceof HTMLInputElement ? input : null,
      label: /** @type {HTMLElement | null} */ (find('.cart-drawer__date-label')),
      trigger: /** @type {HTMLButtonElement | null} */ (find('.cart-drawer__date-trigger')),
      value: /** @type {HTMLElement | null} */ (find('.cart-drawer__date-value')),
      calendar: /** @type {HTMLElement | null} */ (find('.cart-drawer__calendar')),
      month: /** @type {HTMLElement | null} */ (find('.cart-drawer__calendar-month')),
      weekdays: /** @type {HTMLElement | null} */ (find('[data-calendar-weekdays]')),
      days: /** @type {HTMLElement | null} */ (find('[data-calendar-days]')),
      error: /** @type {HTMLElement | null} */ (find('.cart-drawer__date-error')),
    };
  }

  /**
   * Earliest allowed date: the later of the server's date (store timezone) and the shopper's
   * own date, each after the minimum gap (`leadDays`). Keeps cached markup from allowing a date
   * inside the gap.
   * @returns {string}
   */
  get #minimum() {
    const days = Number.parseInt(this.dataset.minDays ?? '0', 10) || 0;
    const local = new Date();
    local.setDate(local.getDate() + leadDays(Math.max(0, days)));
    const localMin = toIsoDate(local);
    const serverMin = this.dataset.minDate ?? '';
    return serverMin > localMin ? serverMin : localMin;
  }

  get #locale() {
    return document.documentElement.lang || undefined;
  }

  /**
   * @param {Date} date
   * @param {Intl.DateTimeFormatOptions} options
   */
  #format(date, options) {
    return new Intl.DateTimeFormat(this.#locale, options).format(date);
  }

  /**
   * A date saved on an earlier visit (or under an older, shorter gap) that is no longer far enough
   * ahead is removed from the cart, so it never reaches the order. Liquid already leaves such a
   * date out of the input, so the saved cart attribute (`data-saved-date`) is checked as well.
   */
  #clearStaleDate() {
    const { input } = this.#refs;
    if (!input) return;
    const minimum = this.#minimum;
    input.min = minimum;
    const saved = this.dataset.savedDate ?? '';
    const stale = (input.value && input.value < minimum) || (saved && saved < minimum);
    if (!stale) return;
    input.value = '';
    this.dataset.savedDate = '';
    this.#save('');
  }

  #updateTrigger() {
    const { input, trigger, value } = this.#refs;
    if (!trigger || !value) return;
    const selected = input?.value ?? '';
    value.textContent = selected
      ? this.#format(fromIsoDate(selected), { dateStyle: 'long' })
      : this.dataset.placeholder ?? '';
    trigger.toggleAttribute('data-has-value', Boolean(selected));
  }

  #renderWeekdays() {
    const { weekdays } = this.#refs;
    if (!weekdays || weekdays.childElementCount) return;
    // 2024-01-01 was a Monday; weeks start on Monday as in the design.
    for (let index = 0; index < 7; index++) {
      const date = new Date(2024, 0, 1 + index);
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.abbr = this.#format(date, { weekday: 'long' });
      cell.textContent = this.#format(date, { weekday: 'short' });
      weekdays.append(cell);
    }
  }

  /**
   * Draws the month in `#view`. One day button is tabbable (roving tabindex).
   * @param {string} [focusIso] - Day to make tabbable, if it is in this month.
   */
  #renderMonth(focusIso) {
    const { input, calendar, month, days } = this.#refs;
    if (!calendar || !month || !days) return;

    const minimum = this.#minimum;
    const selected = input?.value ?? '';
    const year = this.#view.getFullYear();
    const monthIndex = this.#view.getMonth();
    const minDate = fromIsoDate(minimum);

    month.textContent = this.#format(this.#view, { month: 'long', year: 'numeric' });
    const previous = calendar.querySelector('[data-month-step="-1"]');
    if (previous instanceof HTMLButtonElement) {
      previous.disabled = year * 12 + monthIndex <= minDate.getFullYear() * 12 + minDate.getMonth();
    }

    const offset = (new Date(year, monthIndex, 1).getDay() + 6) % 7;
    const count = new Date(year, monthIndex + 1, 0).getDate();
    const isos = Array.from({ length: count }, (_, index) => toIsoDate(new Date(year, monthIndex, index + 1)));
    const enabled = isos.filter((iso) => iso >= minimum);
    const tabbable = [focusIso, selected].find((iso) => iso && enabled.includes(iso)) ?? enabled[0];

    const rows = [];
    let row = document.createElement('tr');
    for (let index = 0; index < offset; index++) row.append(document.createElement('td'));

    for (const iso of isos) {
      const cell = document.createElement('td');
      cell.setAttribute('role', 'gridcell');
      cell.setAttribute('aria-selected', String(iso === selected));

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cart-drawer__day';
      button.dataset.date = iso;
      button.textContent = String(Number(iso.slice(8)));
      button.setAttribute('aria-label', this.#format(fromIsoDate(iso), { dateStyle: 'full' }));
      button.setAttribute('aria-pressed', String(iso === selected));
      button.tabIndex = iso === tabbable ? 0 : -1;
      button.disabled = iso < minimum;
      cell.append(button);
      row.append(cell);

      if (row.childElementCount === 7) {
        rows.push(row);
        row = document.createElement('tr');
      }
    }
    if (row.childElementCount) {
      while (row.childElementCount < 7) row.append(document.createElement('td'));
      rows.push(row);
    }
    days.replaceChildren(...rows);
  }

  get #isOpen() {
    return this.#refs.trigger?.getAttribute('aria-expanded') === 'true';
  }

  #open() {
    const { input, trigger, calendar } = this.#refs;
    if (!trigger || !calendar) return;

    const start = fromIsoDate(input?.value || this.#minimum);
    this.#view = new Date(start.getFullYear(), start.getMonth(), 1);
    this.#renderMonth();

    calendar.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    this.#focusDay();
    this.#announce(true);
  }

  /** @param {boolean} [restoreFocus] */
  #close(restoreFocus = true) {
    const { trigger, calendar } = this.#refs;
    if (!trigger || !calendar) return;
    if (calendar.hidden) return;
    calendar.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus({ preventScroll: true });
    this.#announce(false);
  }

  #focusDay() {
    const day = this.querySelector('.cart-drawer__day[tabindex="0"]');
    if (day instanceof HTMLElement) day.focus({ preventScroll: true });
  }

  /**
   * Tells the drawer the calendar opened or closed; it gives the panel room and scrolls it into
   * view (see `CartDrawerComponent`). `scrollIntoView` is avoided: it also scrolls the page.
   * @param {boolean} open
   */
  #announce(open) {
    this.dispatchEvent(new CustomEvent('cart-drawer:panel-toggle', { bubbles: true, detail: { open } }));
  }

  /** @param {string} iso */
  #select(iso) {
    const { input } = this.#refs;
    if (!input) return;
    input.value = iso;
    this.#updateTrigger();
    this.#close();
    this.#commit();
  }

  /** @param {MouseEvent} event */
  #handleClick = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const { trigger } = this.#refs;

    if (trigger && target?.closest('.cart-drawer__date-trigger') === trigger) {
      if (this.#isOpen) this.#close();
      else this.#open();
      return;
    }

    const step = target?.closest('[data-month-step]');
    if (step instanceof HTMLButtonElement && !step.disabled) {
      const direction = Number(step.dataset.monthStep);
      this.#view = new Date(this.#view.getFullYear(), this.#view.getMonth() + direction, 1);
      this.#renderMonth();
      // A disabled previous button would drop focus to the body.
      if (step.disabled) this.querySelector('[data-month-step="1"]')?.focus?.({ preventScroll: true });
      return;
    }

    const day = target?.closest('.cart-drawer__day');
    if (day instanceof HTMLButtonElement && !day.disabled && day.dataset.date) this.#select(day.dataset.date);
  };

  /** @param {KeyboardEvent} event */
  #handleKeydown = (event) => {
    if (!this.#isOpen) return;

    if (event.key === 'Escape') {
      // Close the calendar only; the drawer skips Escape that was already handled.
      event.preventDefault();
      event.stopPropagation();
      this.#close();
      return;
    }

    const day = event.target instanceof HTMLElement ? event.target.closest('.cart-drawer__day') : null;
    if (!(day instanceof HTMLElement) || !day.dataset.date) return;

    const date = fromIsoDate(day.dataset.date);
    const weekday = (date.getDay() + 6) % 7;
    /** @type {Record<string, () => void>} */
    const moves = {
      ArrowLeft: () => date.setDate(date.getDate() - 1),
      ArrowRight: () => date.setDate(date.getDate() + 1),
      ArrowUp: () => date.setDate(date.getDate() - 7),
      ArrowDown: () => date.setDate(date.getDate() + 7),
      Home: () => date.setDate(date.getDate() - weekday),
      End: () => date.setDate(date.getDate() + 6 - weekday),
      PageUp: () => date.setMonth(date.getMonth() - 1),
      PageDown: () => date.setMonth(date.getMonth() + 1),
    };
    const move = moves[event.key];
    if (!move) return;

    event.preventDefault();
    move();
    const minimum = this.#minimum;
    const iso = toIsoDate(date) < minimum ? minimum : toIsoDate(date);
    const target = fromIsoDate(iso);
    this.#view = new Date(target.getFullYear(), target.getMonth(), 1);
    this.#renderMonth(iso);
    this.#focusDay();
  };

  /** Native input (fallback without the calendar, or browser autofill). */
  #handleChange = (/** @type {Event} */ event) => {
    if (event.target !== this.#refs.input) return;
    this.#updateTrigger();
    this.#commit();
  };

  /** Validates the current value against the minimum and stores it on the cart. */
  #commit() {
    const { input, trigger, error } = this.#refs;
    if (!input) return;

    const minimum = this.#minimum;
    input.min = minimum;
    const value = input.value;
    const invalid = Boolean(value) && value < minimum;

    this.toggleAttribute('data-invalid', invalid);
    input.setAttribute('aria-invalid', String(invalid));
    trigger?.setAttribute('aria-invalid', String(invalid));
    const message = invalid
      ? (this.dataset.errorTemplate ?? '').replace('[date]', this.#format(fromIsoDate(minimum), { dateStyle: 'medium' }))
      : '';
    if (error && error.textContent !== message) error.textContent = message;

    // An invalid date never stays on the order.
    this.#save(invalid ? '' : value);
  }

  /**
   * Stores the date on the cart. An empty value removes the attribute.
   * @param {string} value
   */
  async #save(value) {
    this.#request?.abort();
    const request = new AbortController();
    this.#request = request;

    try {
      const response = await fetch(`${Theme.routes.cart_update_url}.js`, {
        ...fetchConfig('json', { body: JSON.stringify({ attributes: { [DELIVERY_DATE_ATTRIBUTE]: value } }) }),
        signal: request.signal,
        // Finishes even if the shopper heads to checkout straight after picking a date.
        keepalive: true,
      });
      if (!response.ok) throw new Error(`Cart update failed (${response.status})`);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      const { error: errorElement } = this.#refs;
      if (errorElement) errorElement.textContent = this.dataset.saveError ?? '';
    } finally {
      if (this.#request === request) this.#request = undefined;
    }
  }
}

if (!customElements.get('cart-delivery-date')) {
  customElements.define('cart-delivery-date', CartDeliveryDate);
}

/** Remembers the shopper's package protection choice for the current visit. */
const PROTECTION_STORAGE_KEY = 'cart-drawer:package-protection';

/**
 * SavedBy's storefront global. The app embed first defines it with its inline config; SavedBy's
 * script then replaces it with its app instance, which moves `feeTiers` out of `config`.
 * @returns {any}
 */
function savedByGlobal() {
  return /** @type {any} */ (window).SavedBy;
}

/** SavedBy is installed and switched on for this store. */
function savedByActive() {
  return savedByGlobal()?.status === 'ACTIVE';
}

/**
 * SavedBy's fee tiers, lowest cart value first.
 * @returns {Array<{ max: number, price: number, variantId: number }>}
 */
function savedByTiers() {
  const savedBy = savedByGlobal();
  const source = Array.isArray(savedBy?.feeTiers) && savedBy.feeTiers.length ? savedBy.feeTiers : savedBy?.config?.feeTiers;
  if (!Array.isArray(source)) return [];
  return source
    .map((tier) => ({ max: Number(tier?.max), price: Number(tier?.price), variantId: Number(tier?.variantId) }))
    .filter((tier) => Number.isFinite(tier.max) && Number.isFinite(tier.price) && tier.variantId > 0)
    .sort((a, b) => a.max - b.max);
}

/** @returns {Set<string>} Product GIDs that SavedBy never covers. */
function savedByExcludedProducts() {
  const config = savedByGlobal()?.config ?? {};
  return new Set([...(config.excludedProducts ?? []), ...(config.widgetExcludedProducts ?? [])].map(String));
}

/** Presentment currency rate; SavedBy's tier limits are in the shop currency. */
function currencyRate() {
  const rate = Number(/** @type {any} */ (window).Shopify?.currency?.rate);
  return Number.isFinite(rate) && rate > 0 ? rate : 1;
}

/**
 * Package protection lines, matched like the drawer's Liquid (vendor contains "savedby").
 * @param {{ vendor?: string }} item
 */
function isProtectionLine(item) {
  return String(item?.vendor ?? '').toLowerCase().includes('savedby');
}

/**
 * @typedef {{ variantId: number, feeCents: number }} ProtectionPlan
 * The SavedBy fee variant for a cart and its fee in the cart's currency.
 */

/**
 * Chooses the SavedBy tier for a cart the way SavedBy's own widget does: by the pre-discount value
 * of shippable, covered lines. SavedBy's widget stops offering protection above its highest tier;
 * the store keeps offering it there at the highest tier.
 * @param {{ items?: any[] }} cart
 * @returns {ProtectionPlan | null} Null when SavedBy is off or nothing in the cart can be protected.
 */
function protectionPlan(cart) {
  if (!savedByActive()) return null;
  const tiers = savedByTiers();
  if (!tiers.length) return null;

  const excluded = savedByExcludedProducts();
  const covered = (cart.items ?? []).filter(
    (item) =>
      item.requires_shipping && !isProtectionLine(item) && !excluded.has(`gid://shopify/Product/${item.product_id}`)
  );
  // The free gift follows purchased products; on its own it is nothing to protect.
  if (!covered.some((item) => !item.properties?._free_gift)) return null;

  const valueCents = covered.reduce((sum, item) => sum + Number(item.line_price || 0), 0);
  if (valueCents <= 0) return null;

  const rate = currencyRate();
  const tier = tiers.find((candidate) => valueCents / 100 <= candidate.max * rate) ?? tiers[tiers.length - 1];
  if (!tier) return null;
  return { variantId: tier.variantId, feeCents: Math.round(tier.price * rate * 100) };
}

/**
 * @param {number} cents
 * @param {string} currency
 */
function formatMoney(cents, currency) {
  try {
    return new Intl.NumberFormat(document.documentElement.lang || undefined, {
      style: 'currency',
      currency: currency || 'USD',
    }).format(cents / 100);
  } catch {
    return (cents / 100).toFixed(2);
  }
}

/** @returns {Promise<any>} The live cart. */
async function readCart() {
  const response = await fetch(`${Theme.routes.cart_url}.js`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Cart read failed (${response.status})`);
  return response.json();
}

/**
 * Adds one protection line without rendering the drawer section, so the write is as short as
 * possible; the drawer is re-rendered afterwards.
 * @param {number} variantId
 */
async function addProtectionLine(variantId) {
  knownProtection = null;
  const response = await fetch(
    `${Theme.routes.cart_update_url}.js`,
    fetchConfig('json', { body: JSON.stringify({ updates: { [variantId]: 1 }, attributes: { '_SavedBy-internal': 1 } }) })
  );
  const data = await response.json();
  if (!response.ok || data.status) throw new Error(data.description || data.message || 'Cart update failed');
}

/** Resolves once in-flight quantity changes (which address lines by index) have finished. */
async function waitForQuantityUpdates() {
  const CartItems = /** @type {any} */ (customElements.get('cart-items-component'));
  const pending = CartItems?.pendingQuantityUpdates;
  if (Array.isArray(pending) && pending.length) await Promise.allSettled(pending);
}

let checkoutHookRegistered = false;

/**
 * SavedBy checkout hook, used only by the fallback path (SavedBy active without fee tiers): SavedBy
 * updates the cart over AJAX and clicks the checkout target (handled in `#handleTargetClick`).
 */
function registerSavedByCheckoutHook() {
  const savedBy = savedByGlobal();
  if (checkoutHookRegistered || typeof savedBy?.onCheckout !== 'function') return;
  checkoutHookRegistered = true;
  savedBy.onCheckout(() => ({ useAjax: true }));
}

/**
 * @typedef {'synced' | 'unavailable'} ProtectionSyncResult
 * `synced`: the cart matches the switch. `unavailable`: SavedBy is active but exposes no fee
 * tiers, so only SavedBy's own checkout control can add protection.
 */

/**
 * Package protection switch and checkout buttons from the design, backed by the SavedBy app.
 *
 * The switch row is shown whenever SavedBy is active and the cart holds something to protect; its
 * fee is SavedBy's tier for the cart. The switch is the source of truth and the cart follows it
 * while the drawer is open: on adds exactly one SavedBy line of the current tier, off removes every
 * SavedBy line. Closing the drawer removes the line again, because SavedBy's storefront script
 * strips a protection line with a redirect on every page load. Both checkout paths leave from the
 * open drawer, so they see the chosen state: "Continue to checkout" waits for the sync queue, and
 * a Shop Pay click made while a protection change is being written continues to Shop Pay once the
 * cart is settled (`#handleWalletClick`).
 *
 * Syncs run one at a time, and each reads the switch, the drawer state and the live cart when it
 * starts, so rapid changes settle on the final state.
 *
 * SavedBy also attaches to the hidden `button[name='checkout']` target and inserts
 * `<savedby-checkout-plus>` after it. Those stay visually hidden; its Checkout+ control is only
 * used as a fallback when SavedBy exposes no fee tiers.
 */
class CartDrawerCheckout extends HTMLElement {
  /** Shared across instances: a section morph can replace this element mid-sync. */
  static #queue = /** @type {Promise<unknown>} */ (Promise.resolve());

  /** Active Shop Pay holds (see `#hold`). */
  static #holds = 0;

  /** @type {Array<() => void>} Shop Pay clicks waiting for the holds to clear. */
  static #settledWaiters = [];

  /** @type {AbortController | undefined} */
  #controller;

  /** @type {MutationObserver | undefined} */
  #drawerObserver;

  /** Fallback checkout in progress (SavedBy's own control is updating the cart). */
  #intent = false;

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #busyTimer;

  connectedCallback() {
    this.#controller = new AbortController();
    const { signal } = this.#controller;

    this.addEventListener('click', this.#handleClick, { signal });
    // Capture: runs before the hidden target's native form submission.
    this.addEventListener('click', this.#handleTargetClick, { signal, capture: true });
    // Capture: stops a Shop Pay click (e.g. from the keyboard) while the cart is being synced.
    this.addEventListener('click', this.#handleWalletClick, { signal, capture: true });
    this.addEventListener('change', this.#handleChange, { signal });
    window.addEventListener('SavedBy:ready', this.#refresh, { signal });
    document.addEventListener(StandardEvents.cartLinesUpdate, this.#handleCartLinesUpdate, { signal });
    // Returning from checkout via back/forward cache must not leave the buttons locked.
    window.addEventListener(
      'pageshow',
      (event) => {
        if (!event.persisted) return;
        this.#setBusy(false);
        this.#refresh();
      },
      { signal }
    );

    const toggle = this.#toggle;
    if (toggle) toggle.checked = this.#readPreference();

    // Opening the drawer adds the chosen protection; closing it removes the line again.
    const drawer = this.closest('theme-drawer');
    if (drawer) {
      this.#drawerObserver = new MutationObserver(this.#handleDrawerToggle);
      this.#drawerObserver.observe(drawer, { attributes: true, attributeFilter: ['open'] });
    }

    this.#setSyncing(CartDrawerCheckout.#holds > 0);

    // While the drawer is closed, the cart SavedBy embeds in the page is enough to show the row
    // and lets opening the drawer add protection with a single request.
    const pageCart = savedByGlobal()?.cart;
    if (!this.#drawerOpen && pageCart && !(pageCart.items ?? []).some(isProtectionLine)) {
      const plan = protectionPlan(pageCart);
      this.#render(plan, pageCart);
      knownProtection = { plan, lineCount: 0 };
    } else {
      this.#refresh();
    }
  }

  disconnectedCallback() {
    this.#controller?.abort();
    this.#drawerObserver?.disconnect();
    clearTimeout(this.#busyTimer);
  }

  /** @returns {HTMLElement | null} */
  get #savedBy() {
    return this.querySelector(':scope > savedby-checkout-plus');
  }

  /** @returns {HTMLElement | null} */
  get #target() {
    return this.querySelector(':scope > .cart-drawer__savedby-target');
  }

  /** @returns {HTMLInputElement | null} */
  get #toggle() {
    const toggle = this.querySelector('#CartDrawer-Protection');
    return toggle instanceof HTMLInputElement ? toggle : null;
  }

  /** @returns {HTMLElement | null} */
  get #row() {
    return this.querySelector('.cart-drawer__protection');
  }

  get #drawerOpen() {
    return Boolean(this.closest('theme-drawer')?.hasAttribute('open'));
  }

  /** Background sync: Shop Pay is only held while it actually writes to the cart. */
  #refresh = () => {
    this.#queueSync().catch(this.#reportSyncError);
  };

  /** Opening adds the chosen protection (Shop Pay waits for it); closing removes the line. */
  #handleDrawerToggle = () => {
    const opened = this.#drawerOpen;
    this.#queueSync({ block: opened, fast: opened }).catch(this.#reportSyncError);
  };

  /** @param {Event} event */
  #handleChange = (event) => {
    if (event.target !== this.#toggle) return;
    try {
      sessionStorage.setItem(PROTECTION_STORAGE_KEY, this.#toggle?.checked ? '1' : '0');
    } catch {
      // Storage can be unavailable (private mode); the switch still works for this page.
    }
    // Shop Pay waits until the cart matches the new choice.
    this.#queueSync({ block: true }).catch(this.#reportSyncError);
  };

  /**
   * Products were added, changed or removed elsewhere: the fee tier may differ, or the cart may
   * now hold nothing to protect. Re-sync once that change has settled.
   * @param {Event} event
   */
  #handleCartLinesUpdate = (event) => {
    knownProtection = null;
    const { promise } = /** @type {{ promise?: Promise<unknown> }} */ (event);
    Promise.resolve(promise)
      .catch(() => {})
      .then(() => {
        if (this.isConnected) this.#refresh();
      });
  };

  /** @returns {boolean} */
  #readPreference() {
    try {
      return sessionStorage.getItem(PROTECTION_STORAGE_KEY) !== '0';
    } catch {
      return true;
    }
  }

  /**
   * Holds Shop Pay (and keyboard activation of it) while the cart is about to change. Counted
   * across instances, since a section morph can replace this element mid-sync.
   * @param {number} delta
   */
  static #hold(delta) {
    CartDrawerCheckout.#holds = Math.max(0, CartDrawerCheckout.#holds + delta);
    for (const element of document.querySelectorAll('cart-drawer-checkout')) {
      if (element instanceof CartDrawerCheckout) element.#setSyncing(CartDrawerCheckout.#holds > 0);
    }
    if (CartDrawerCheckout.#holds === 0) {
      for (const resolve of CartDrawerCheckout.#settledWaiters.splice(0)) resolve();
    }
  }

  /**
   * Adds a cart sync to the shared queue.
   * @param {{ block?: boolean, fast?: boolean, render?: boolean }} [options]
   *   `block`: hold Shop Pay for the whole sync (the shopper just changed what the cart must hold);
   *   writes always hold it. `fast`: add protection from the known state with one request.
   *   `render`: re-render the drawer even if the cart needs no change.
   * @returns {Promise<ProtectionSyncResult>}
   */
  #queueSync({ block = false, fast = false, render = false } = {}) {
    if (block) CartDrawerCheckout.#hold(1);

    const run = CartDrawerCheckout.#queue.then(() => this.#applyProtection({ fast, render }));
    CartDrawerCheckout.#queue = run.catch(() => {});

    return block ? run.finally(() => CartDrawerCheckout.#hold(-1)) : run;
  }

  /**
   * Opening the drawer with a known cart: add the protection line with one short request, then
   * re-render the drawer and double-check the cart in the background without holding Shop Pay.
   * @returns {Promise<boolean>} Whether the fast path applied.
   */
  async #addKnownProtection() {
    const known = knownProtection;
    if (!known?.plan || known.lineCount !== 0 || !this.#toggle?.checked || !this.#drawerOpen) return false;

    await waitForQuantityUpdates();
    if (knownProtection !== known) return false;

    await addProtectionLine(known.plan.variantId);
    this.#queueSync({ render: true }).catch(this.#reportSyncError);
    return true;
  }

  /**
   * Shows the switch row for the cart and brings the cart in line with the switch: one SavedBy
   * line of the current tier while the switch is on and the drawer open, none otherwise. Re-reads
   * the cart after writing until nothing is left to do, so a change that lands meanwhile (another
   * script, a tier shift) is still corrected.
   * @param {{ fast?: boolean, render?: boolean }} options
   * @returns {Promise<ProtectionSyncResult>}
   */
  async #applyProtection({ fast = false, render = false }) {
    for (let pass = 0; pass < 3; pass++) {
      // A section morph may have replaced this element; use the live one.
      const host = this.isConnected ? this : document.querySelector('cart-drawer-checkout');
      if (!(host instanceof CartDrawerCheckout)) return 'synced';

      if (fast && pass === 0 && (await host.#addKnownProtection())) return 'synced';

      await waitForQuantityUpdates();

      const cart = await readCart();
      /** @type {Array<{ key: string, vendor: string, variant_id: number, quantity: number, final_line_price: number }>} */
      const items = cart.items ?? [];
      const lines = items.filter(isProtectionLine);
      const plan = protectionPlan(cart);
      host.#render(plan, cart);

      if (!plan && savedByActive() && !savedByTiers().length && !lines.length) return 'unavailable';

      const protect = Boolean(plan && host.#toggle?.checked && host.#drawerOpen);
      const wanted = protect && plan ? plan.variantId : null;

      const keep = wanted ? lines.find((line) => Number(line.variant_id) === wanted) : undefined;
      /** @type {Record<string, number>} */
      const updates = {};
      for (const line of lines) {
        if (line !== keep) updates[line.key] = 0;
        else if (line.quantity !== 1) updates[line.key] = 1;
      }
      const needsAdd = Boolean(wanted && !keep);

      if (!Object.keys(updates).length && !needsAdd) {
        knownProtection = { plan, lineCount: lines.length };
        if (render) {
          await sectionRenderer.renderSection(SECTION_ID, { cache: false, mode: 'hydration', injectStylesheet: true });
        }
        return 'synced';
      }

      const drawer = host.closest('cart-drawer-component');
      drawer?.toggleAttribute('data-protection-syncing', true);
      CartDrawerCheckout.#hold(1);
      try {
        // Line keys and variant IDs are sent separately: removals first, then the new tier.
        if (Object.keys(updates).length) {
          await mutateCart(`${Theme.routes.cart_update_url}.js`, {
            updates,
            attributes: { '_SavedBy-internal': wanted ? 1 : 0 },
          });
        }
        if (needsAdd && wanted) {
          await mutateCart(`${Theme.routes.cart_update_url}.js`, {
            updates: { [wanted]: 1 },
            attributes: { '_SavedBy-internal': 1 },
          });
        }
      } finally {
        CartDrawerCheckout.#hold(-1);
        drawer?.toggleAttribute('data-protection-syncing', false);
      }
    }
    return 'synced';
  }

  /**
   * Shows or hides the switch row and its fee: the protection line's price once it is in the cart
   * (what the shopper pays), otherwise the tier price.
   * @param {ProtectionPlan | null} plan
   * @param {{ items?: any[], currency?: string }} cart
   */
  #render(plan, cart) {
    const row = this.#row;
    if (!row) return;
    row.hidden = !plan;
    if (!plan) return;

    const line = (cart.items ?? []).find(
      (item) => isProtectionLine(item) && Number(item.variant_id) === plan.variantId
    );
    const cents = line ? Math.round(Number(line.final_line_price) / Math.max(1, Number(line.quantity))) : plan.feeCents;
    const fee = formatMoney(cents, cart.currency ?? '');
    const target = row.querySelector('[data-protection-fee]');
    if (target && target.textContent !== fee) target.textContent = fee;
  }

  /** @param {boolean} syncing */
  #setSyncing(syncing) {
    this.toggleAttribute('data-protection-syncing', syncing);
  }

  /** @param {unknown} error */
  #reportSyncError = (error) => {
    if (error instanceof Error && error.name === 'AbortError') return;
    const message = error instanceof Error ? error.message : 'Package protection update failed';
    console.warn('[cart-drawer] Package protection:', message);
    this.dispatchEvent(new CartErrorEvent({ error: message, code: 'SERVICE_UNAVAILABLE' }));
  };

  /**
   * Visible "Continue to checkout": finish any protection sync first, then leave for checkout.
   * @param {MouseEvent} event
   */
  #handleClick = async (event) => {
    const trigger = event.target instanceof Element ? event.target.closest('[data-checkout]') : null;
    if (!(trigger instanceof HTMLElement)) return;
    event.preventDefault();
    if (this.#intent || this.hasAttribute('aria-busy')) return;

    this.#setBusy(true);

    /** @type {ProtectionSyncResult | 'failed'} */
    const result = await this.#queueSync().catch((error) => {
      this.#reportSyncError(error);
      return /** @type {const} */ ('failed');
    });

    // SavedBy exposes no fee tiers: let its own control update the cart.
    if (result === 'unavailable' && this.#startCheckout()) return;

    window.location.href = '/checkout';
  };

  /**
   * Shopify's Shop Pay button checks out the cart as it is. When the cart already matches the
   * switch, the click goes to Shopify's button untouched. While a protection change is still being
   * written (e.g. right after the drawer opens), the click is kept instead of dropped: once the
   * cart is settled the shopper goes to Shop Pay through Shopify's cart checkout URL
   * (`/checkout?payment=shop_pay`), so a single click always proceeds. Replaying the click on
   * Shopify's button is not an option: it ignores clicks that scripts dispatch.
   * @param {MouseEvent} event
   */
  #handleWalletClick = (event) => {
    if (CartDrawerCheckout.#holds === 0) return;
    if (!event.composedPath().some((node) => node instanceof Element && node.localName === 'cart-drawer-wallets')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (this.hasAttribute('aria-busy')) return;

    this.#setBusy(true);
    CartDrawerCheckout.#whenSettled().then(() => {
      window.location.href = '/checkout?payment=shop_pay';
    });
  };

  /** @returns {Promise<void>} Resolves once no protection change is being written. */
  static #whenSettled() {
    if (CartDrawerCheckout.#holds === 0) return Promise.resolve();
    return new Promise((resolve) => CartDrawerCheckout.#settledWaiters.push(resolve));
  }

  /**
   * Fallback: hands checkout to SavedBy's own Checkout+ (protected) or opt-out control.
   * @returns {boolean} Whether SavedBy took over.
   */
  #startCheckout() {
    const savedBy = this.#savedBy;
    if (!savedBy) return false;

    registerSavedByCheckoutHook();

    const control = this.#toggle?.checked
      ? savedBy.querySelector('[slot="savedby-checkout-button"]')
      : savedBy.shadowRoot?.querySelector('.sb__non-covered-link');
    if (!(control instanceof HTMLElement)) return false;

    this.#intent = true;
    control.click();
    return true;
  }

  /**
   * Fallback path: SavedBy clicks the hidden target once its cart update is done (or failed).
   * @param {MouseEvent} event
   */
  #handleTargetClick = (event) => {
    if (!this.#intent || event.target !== this.#target) return;
    event.preventDefault();
    event.stopPropagation();
    window.location.href = '/checkout';
  };

  /**
   * Blocks repeat clicks while checkout is prepared; releases them if no navigation followed.
   * @param {boolean} busy
   */
  #setBusy(busy) {
    clearTimeout(this.#busyTimer);
    if (!busy) {
      this.removeAttribute('aria-busy');
      this.#intent = false;
      return;
    }
    this.setAttribute('aria-busy', 'true');
    this.#busyTimer = setTimeout(() => this.#setBusy(false), 15000);
  }
}

if (!customElements.get('cart-drawer-checkout')) {
  customElements.define('cart-drawer-checkout', CartDrawerCheckout);
}

/** Tag of the Shop Pay wallet inside Shopify's accelerated checkout component. */
const SHOP_PAY_WALLET_SELECTOR = 'shop-pay-wallet-button';

/**
 * Finds the first match in a tree, including inside open shadow roots.
 * @param {ParentNode} root
 * @param {string} selector
 * @returns {Element | null}
 */
function deepQuery(root, selector) {
  const match = root.querySelector(selector);
  if (match) return match;
  for (const element of root.querySelectorAll('*')) {
    if (!element.shadowRoot) continue;
    const nested = deepQuery(element.shadowRoot, selector);
    if (nested) return nested;
  }
  return null;
}

/**
 * Wraps `content_for_additional_checkout_buttons` and keeps only Shopify's native Shop Pay
 * button visible: the other wallets (PayPal, Google Pay, Amazon Pay, ...) next to it are hidden.
 * Shopify renders the wallets asynchronously, so the tree is re-checked as it changes.
 * The wrapper stays hidden until Shop Pay is found, so other wallets never flash in. The
 * "Buy with Shop Pay" face in the markup is visual only; Shopify's button takes the click.
 */
class CartDrawerWallets extends HTMLElement {
  /** @type {MutationObserver | undefined} */
  #observer;

  /** @type {WeakSet<Node>} */
  #observedRoots = new WeakSet();

  connectedCallback() {
    this.#observedRoots = new WeakSet();
    this.#observer = new MutationObserver(this.#filter);
    this.#observe(this);
    this.#filter();
  }

  disconnectedCallback() {
    this.#observer?.disconnect();
  }

  /** @param {Node} root */
  #observe(root) {
    if (this.#observedRoots.has(root)) return;
    this.#observedRoots.add(root);
    this.#observer?.observe(root, { childList: true, subtree: true });
  }

  #filter = () => {
    // Watch every open shadow root on the way, since Shopify may render wallets inside one.
    for (const element of this.querySelectorAll('*')) {
      if (element.shadowRoot) this.#observe(element.shadowRoot);
    }

    const shopPay = deepQuery(this, SHOP_PAY_WALLET_SELECTOR);
    if (!(shopPay instanceof HTMLElement)) {
      this.removeAttribute('data-shop-pay-ready');
      return;
    }

    const parent = shopPay.parentNode;
    if (parent instanceof ShadowRoot) this.#observe(parent);

    for (const sibling of parent?.children ?? []) {
      if (!(sibling instanceof HTMLElement)) continue;
      const isShopPay = sibling === shopPay;
      if (isShopPay && sibling.style.display === 'none') sibling.style.removeProperty('display');
      if (!isShopPay && sibling.style.display !== 'none') sibling.style.setProperty('display', 'none', 'important');
    }

    this.setAttribute('data-shop-pay-ready', '');
  };
}

if (!customElements.get('cart-drawer-wallets')) {
  customElements.define('cart-drawer-wallets', CartDrawerWallets);
}
