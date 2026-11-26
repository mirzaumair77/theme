import { Component } from '@theme/component';
import { CartErrorEvent, CartLinesUpdateEvent, StandardEvents } from '@shopify/events';
import { fetchConfig, prefersReducedMotion } from '@theme/utilities';
import { morphSection, sectionRenderer } from '@theme/section-renderer';

/** Section Rendering API target for the drawer (`sections/cart-drawer-section.liquid`). */
const SECTION_ID = 'cart-drawer-section';

/**
 * Posts a cart mutation that also renders the drawer section, then morphs the drawer.
 *
 * @param {string} url - A cart AJAX endpoint.
 * @param {Record<string, unknown>} payload - The request body, without `sections`.
 * @returns {Promise<any>} The parsed response.
 */
async function mutateCart(url, payload) {
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
   * Keeps the note and footer pinned unless, on a short drawer, they would leave too little room
   * for the line items; then the whole column scrolls so every part stays reachable.
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
    const tooTall = pinnedHeight / available > CartDrawerComponent.#PINNED_MAX_RATIO;
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
   * own date, each plus the minimum gap. Keeps cached markup from allowing a past date.
   * @returns {string}
   */
  get #minimum() {
    const days = Number.parseInt(this.dataset.minDays ?? '0', 10) || 0;
    const local = new Date();
    local.setDate(local.getDate() + days);
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

  /** A date saved on an earlier visit that is no longer far enough ahead is dropped. */
  #clearStaleDate() {
    const { input } = this.#refs;
    if (!input) return;
    const minimum = this.#minimum;
    input.min = minimum;
    if (input.value && input.value < minimum) {
      input.value = '';
      this.#save('');
    }
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

let checkoutHookRegistered = false;

/**
 * SavedBy checkout hook, used only by the fallback path (no fee tiers available): SavedBy updates
 * the cart over AJAX and clicks the checkout target (`useAjax`, handled in `#handleTargetClick`).
 */
function registerSavedByCheckoutHook() {
  const savedBy = /** @type {any} */ (window).SavedBy;
  if (checkoutHookRegistered || typeof savedBy?.onCheckout !== 'function') return;
  checkoutHookRegistered = true;
  savedBy.onCheckout(() => ({ useAjax: true }));
}

/** @returns {Array<{ max: number, variantId: number | string }>} SavedBy's fee tiers, if exposed. */
function savedByTiers() {
  const tiers = /** @type {any} */ (window).SavedBy?.config?.feeTiers;
  return Array.isArray(tiers) ? tiers : [];
}

/**
 * The SavedBy fee tier variant for a cart total, from SavedBy's own storefront config.
 * @param {number} totalCents - Cart total without protection lines.
 * @returns {number | null}
 */
function savedByTierVariant(totalCents) {
  const tiers = savedByTiers();
  if (!tiers.length) return null;

  const total = totalCents / 100;
  const sorted = [...tiers].sort((a, b) => Number(a.max) - Number(b.max));
  const tier = sorted.find((candidate) => total <= Number(candidate.max)) ?? sorted[sorted.length - 1];
  const variantId = Number(tier?.variantId);
  return Number.isFinite(variantId) && variantId > 0 ? variantId : null;
}

/**
 * Package protection lines, matched like the drawer's Liquid (vendor contains "savedby").
 * @param {{ vendor?: string }} item
 */
function isProtectionLine(item) {
  return String(item?.vendor ?? '').toLowerCase().includes('savedby');
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

/** Resolves once in-flight quantity changes (which address lines by index) have finished. */
async function waitForQuantityUpdates() {
  const CartItems = /** @type {any} */ (customElements.get('cart-items-component'));
  const pending = CartItems?.pendingQuantityUpdates;
  if (Array.isArray(pending) && pending.length) await Promise.allSettled(pending);
}

/**
 * @typedef {'synced' | 'unavailable'} ProtectionSyncResult
 * `synced`: the cart matches the switch. `unavailable`: SavedBy is not attached or exposes no
 * fee tiers, so the cart was left untouched.
 */

/**
 * Package protection switch and checkout button from the design, backed by the SavedBy app.
 *
 * The switch is the source of truth and the cart follows it: turning it on adds exactly one
 * SavedBy line (the fee tier for the current product total, from SavedBy's config), turning it off
 * removes every SavedBy line. Syncs also run when SavedBy attaches and after other cart changes
 * (the tier follows the total; an emptied cart drops protection). All syncs run one at a time and
 * each reads the switch and the live cart when it starts, so rapid toggling settles on the final
 * choice. "Continue to checkout" waits for the queue before leaving, and Shopify's accelerated
 * buttons (Shop Pay) are blocked while a sync runs, so every checkout path sees the chosen state.
 *
 * SavedBy attaches to the hidden `button[name='checkout']` target and inserts
 * `<savedby-checkout-plus>` (its Checkout+ button, opt-out link and fee) after it. Those stay
 * visually hidden; this element mirrors SavedBy's fee in the switch row. If SavedBy exposes no fee
 * tiers, checkout falls back to clicking SavedBy's own Checkout+ or opt-out control. Without
 * SavedBy, the switch stays hidden and checkout is a plain GET /checkout.
 */
class CartDrawerCheckout extends HTMLElement {
  /** Shared across instances: a section morph can replace this element mid-sync. */
  static #queue = /** @type {Promise<unknown>} */ (Promise.resolve());

  static #queued = 0;

  /** @type {AbortController | undefined} */
  #controller;

  /** @type {MutationObserver | undefined} */
  #childObserver;

  /** @type {MutationObserver | undefined} */
  #feeObserver;

  /** @type {ShadowRoot | null} */
  #observedRoot = null;

  /** Whether the switch row was visible at the last check; its first appearance syncs the cart. */
  #wasAvailable = false;

  /** @type {{ protect: boolean } | null} */
  #intent = null;

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #busyTimer;

  connectedCallback() {
    this.#controller = new AbortController();
    const { signal } = this.#controller;

    this.addEventListener('click', this.#handleClick, { signal });
    // Capture: runs before the hidden target's native form submission.
    this.addEventListener('click', this.#handleTargetClick, { signal, capture: true });
    this.addEventListener('change', this.#handleChange, { signal });
    window.addEventListener('SavedBy:ready', this.#sync, { signal });
    document.addEventListener(StandardEvents.cartLinesUpdate, this.#handleCartLinesUpdate, { signal });
    // Returning from checkout via back/forward cache must not leave the buttons locked.
    window.addEventListener('pageshow', (event) => event.persisted && this.#setBusy(false), { signal });

    const toggle = this.#toggle;
    if (toggle) toggle.checked = this.#readPreference();

    // SavedBy inserts its element asynchronously; watch direct children for it.
    this.#childObserver = new MutationObserver(this.#sync);
    this.#childObserver.observe(this, { childList: true });
    this.#feeObserver = new MutationObserver(this.#sync);

    this.#wasAvailable = false;
    this.#sync();
    if (CartDrawerCheckout.#queued > 0) this.#setSyncing(true);
  }

  disconnectedCallback() {
    this.#controller?.abort();
    this.#childObserver?.disconnect();
    this.#feeObserver?.disconnect();
    this.#observedRoot = null;
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

  /** The switch is on screen, so the shopper's choice is meaningful. */
  get #available() {
    const row = this.#row;
    return Boolean(row && !row.hidden);
  }

  #sync = () => {
    const savedBy = this.#savedBy;
    const row = this.#row;
    if (!row) return;

    const root = savedBy?.shadowRoot ?? null;
    if (root && root !== this.#observedRoot) {
      this.#feeObserver?.disconnect();
      this.#feeObserver?.observe(root, { childList: true, subtree: true, characterData: true });
      this.#observedRoot = root;
    }

    const fee = root?.querySelector('[name="fee"]')?.textContent?.trim();
    row.hidden = !savedBy || !fee;

    const feeTarget = row.querySelector('[data-protection-fee]');
    if (fee && feeTarget && feeTarget.textContent !== fee) feeTarget.textContent = fee;

    // The switch just appeared (SavedBy attached): make the cart match its saved state.
    const available = !row.hidden;
    if (available && !this.#wasAvailable) this.#queueSync().catch(this.#reportSyncError);
    this.#wasAvailable = available;
  };

  /** @param {Event} event */
  #handleChange = (event) => {
    if (event.target !== this.#toggle) return;
    try {
      sessionStorage.setItem(PROTECTION_STORAGE_KEY, this.#toggle?.checked ? '1' : '0');
    } catch {
      // Storage can be unavailable (private mode); the switch still works for this page.
    }
    this.#queueSync().catch(this.#reportSyncError);
  };

  /**
   * Products were added, changed or removed elsewhere: the fee tier may differ, or the cart may
   * now hold only protection. Re-sync once that change has settled.
   * @param {Event} event
   */
  #handleCartLinesUpdate = (event) => {
    const { promise } = /** @type {{ promise?: Promise<unknown> }} */ (event);
    Promise.resolve(promise)
      .catch(() => {})
      .then(() => {
        if (this.isConnected && this.#available) this.#queueSync().catch(this.#reportSyncError);
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
   * Adds a cart sync to the shared queue.
   * @returns {Promise<ProtectionSyncResult>}
   */
  #queueSync() {
    CartDrawerCheckout.#queued += 1;
    this.#setSyncing(true);

    const run = CartDrawerCheckout.#queue.then(() => this.#applyProtection());
    CartDrawerCheckout.#queue = run.catch(() => {});

    return run.finally(() => {
      CartDrawerCheckout.#queued -= 1;
      if (CartDrawerCheckout.#queued === 0) {
        // The element that queued the sync may have been replaced by a morph.
        for (const element of document.querySelectorAll('cart-drawer-checkout')) {
          if (element instanceof CartDrawerCheckout) element.#setSyncing(false);
        }
      }
    });
  }

  /**
   * Brings the cart in line with the switch: one SavedBy line of the current tier when on, none
   * when off or when no products remain. Re-reads the cart after writing until nothing is left
   * to do, so a change that lands meanwhile (another script, a tier shift) is still corrected.
   * @returns {Promise<ProtectionSyncResult>}
   */
  async #applyProtection() {
    for (let pass = 0; pass < 3; pass++) {
      // A section morph may have replaced this element; use the live one.
      const host = this.isConnected ? this : document.querySelector('cart-drawer-checkout');
      if (!(host instanceof CartDrawerCheckout) || !host.#available || !savedByTiers().length) return 'unavailable';

      await waitForQuantityUpdates();

      const protect = Boolean(host.#toggle?.checked);
      const cart = await readCart();
      /** @type {Array<{ key: string, vendor: string, variant_id: number, quantity: number, final_line_price: number, properties?: Record<string, unknown> | null }>} */
      const items = cart.items ?? [];
      const lines = items.filter(isProtectionLine);
      // The free gift follows purchased products, so it does not count as something to protect.
      const products = items.filter((item) => !isProtectionLine(item) && !item.properties?._free_gift);

      const productTotal = products.reduce((sum, item) => sum + item.final_line_price, 0);
      const wanted = protect && products.length ? savedByTierVariant(productTotal) : null;
      if (protect && products.length && !wanted) return 'unavailable';

      const keep = wanted ? lines.find((line) => Number(line.variant_id) === wanted) : undefined;
      /** @type {Record<string, number>} */
      const updates = {};
      for (const line of lines) {
        if (line !== keep) updates[line.key] = 0;
        else if (line.quantity !== 1) updates[line.key] = 1;
      }
      const needsAdd = Boolean(wanted && !keep);

      if (!Object.keys(updates).length && !needsAdd) return 'synced';

      const drawer = host.closest('cart-drawer-component');
      drawer?.toggleAttribute('data-protection-syncing', true);
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
        drawer?.toggleAttribute('data-protection-syncing', false);
      }
    }
    return 'synced';
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
    let result = await this.#queueSync().catch((error) => {
      this.#reportSyncError(error);
      return /** @type {const} */ ('failed');
    });

    // SavedBy is active on the store but has not attached yet (e.g. a click right after the cart
    // filled). Wait briefly so the shopper's choice is applied instead of skipped.
    if (result === 'unavailable' && !this.#available && /** @type {any} */ (window).SavedBy?.status === 'ACTIVE') {
      if (await this.#waitForSavedBy(4000)) {
        result = await this.#queueSync().catch(() => /** @type {const} */ ('failed'));
      }
    }

    if (result === 'synced') {
      window.location.href = '/checkout';
      return;
    }

    // No fee tiers (or the sync failed): let SavedBy's own control update the cart.
    if (this.#startCheckout()) return;

    this.#setBusy(false);
    window.location.href = '/checkout';
  };

  /**
   * Fallback: hands checkout to SavedBy's own Checkout+ (protected) or opt-out control.
   * @returns {boolean} Whether SavedBy took over.
   */
  #startCheckout() {
    const savedBy = this.#savedBy;
    if (!savedBy || !this.#available) return false;

    registerSavedByCheckoutHook();

    const protect = Boolean(this.#toggle?.checked);
    const control = protect
      ? savedBy.querySelector('[slot="savedby-checkout-button"]')
      : savedBy.shadowRoot?.querySelector('.sb__non-covered-link');
    if (!(control instanceof HTMLElement)) return false;

    this.#intent = { protect };
    this.#setBusy(true);
    control.click();
    return true;
  }

  /**
   * @param {number} timeout
   * @returns {Promise<boolean>} Whether SavedBy attached (fee shown) within the timeout.
   */
  async #waitForSavedBy(timeout) {
    const start = performance.now();
    while (performance.now() - start < timeout) {
      this.#sync();
      if (this.#savedBy && this.#available) return true;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return false;
  }

  /**
   * Fallback path: SavedBy clicks the hidden target once its cart update is done (or failed).
   * Run a final sync, then continue to checkout.
   * @param {MouseEvent} event
   */
  #handleTargetClick = (event) => {
    if (!this.#intent || event.target !== this.#target) return;

    event.preventDefault();
    event.stopPropagation();

    this.#queueSync()
      .catch((error) => console.warn('[cart-drawer] Package protection check failed:', error))
      .finally(() => {
        window.location.href = '/checkout';
      });
  };

  /**
   * Blocks repeat clicks while checkout is prepared; releases them if no navigation followed.
   * @param {boolean} busy
   */
  #setBusy(busy) {
    clearTimeout(this.#busyTimer);
    if (!busy) {
      this.removeAttribute('aria-busy');
      this.#intent = null;
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
