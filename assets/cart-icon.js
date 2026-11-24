import { Component } from '@theme/component';
import { onAnimationEnd } from '@theme/utilities';
import { StandardEvents, CartLinesUpdateEvent } from '@shopify/events';

/** Fired on `document` with `{ count }` whenever the real cart count has been re-read from /cart.js. */
const CART_COUNT_EVENT = 'cart-icon:count';

/** Cart mutations made outside the theme's events (Monster Cart, Replo, custom blocks, other apps). */
const CART_MUTATION_PATH = /\/cart\/(add|change|update|clear)(\.js|\.json)?\/?$/;

/**
 * Keeps every <cart-icon> in sync with the real cart, however the cart was changed.
 *
 * The theme's own add-to-cart flows announce changes with `CartLinesUpdateEvent`, but the store's
 * cart app and several custom blocks call the Cart AJAX API directly. Watching completed cart
 * mutations (fetch + XHR) and re-reading /cart.js covers all of them without per-app glue.
 */
const cartSync = (() => {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {AbortController | undefined} */
  let inFlight;

  const cartUrl = () => {
    const base = /** @type {any} */ (window).Theme?.routes?.cart_url ?? `${window.Shopify?.routes?.root ?? '/'}cart`;
    return `${base.replace(/\/$/, '')}.js`;
  };

  /** @param {string | URL | Request} input */
  const isCartMutation = (input) => {
    try {
      const raw = input instanceof Request ? input.url : String(input);
      return CART_MUTATION_PATH.test(new URL(raw, window.location.origin).pathname);
    } catch (_) {
      return false;
    }
  };

  const refresh = async () => {
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;

    try {
      const response = await nativeFetch(cartUrl(), {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) return;

      const cart = await response.json();
      if (controller.signal.aborted || typeof cart?.item_count !== 'number') return;

      document.dispatchEvent(new CustomEvent(CART_COUNT_EVENT, { detail: { count: cart.item_count } }));
    } catch (error) {
      if (/** @type {Error} */ (error)?.name !== 'AbortError') console.warn('[cart-icon] Cart refresh failed:', error);
    }
  };

  /** Debounced so bursts of cart calls (e.g. add + add-ons, quantity steppers) trigger one read. */
  const schedule = (delay = 120) => {
    clearTimeout(timer);
    timer = setTimeout(refresh, delay);
  };

  const nativeFetch = window.fetch.bind(window);

  if (!(/** @type {any} */ (window).__cartIconSyncInstalled)) {
    /** @type {any} */ (window).__cartIconSyncInstalled = true;

    window.fetch = function (input, init) {
      const promise = nativeFetch(input, init);
      if (isCartMutation(input)) {
        promise.then(() => schedule()).catch(() => schedule());
      }
      return promise;
    };

    const { open, send } = XMLHttpRequest.prototype;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      /** @type {any} */ (this).__cartIconMutation = isCartMutation(url);
      // @ts-ignore - forwarding the original overload arguments
      return open.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (body) {
      if (/** @type {any} */ (this).__cartIconMutation) {
        this.addEventListener('loadend', () => schedule(), { once: true });
      }
      return send.call(this, body);
    };

    // Cart changed in another tab, or the page came back from the back/forward cache.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') schedule(0);
    });
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) schedule(0);
    });
  }

  return { schedule };
})();

/**
 * A custom element that displays a cart icon.
 *
 * @typedef {object} Refs
 * @property {HTMLElement} cartBubble - The cart bubble element.
 * @property {HTMLElement} cartBubbleText - The cart bubble text element.
 * @property {HTMLElement} cartBubbleCount - The cart bubble count element.
 *
 * @extends {Component<Refs>}
 */
class CartIcon extends Component {
  requiredRefs = ['cartBubble', 'cartBubbleText', 'cartBubbleCount'];

  /** @type {number} The last count rendered (the text is blank above 99, so it is tracked here). */
  #count = 0;

  /** @type {AbortController | undefined} */
  #listeners;

  connectedCallback() {
    super.connectedCallback();

    this.#count = this.#readRenderedCount();

    this.#listeners?.abort();
    this.#listeners = new AbortController();
    const { signal } = this.#listeners;

    document.addEventListener(StandardEvents.cartLinesUpdate, this.onCartUpdate, { signal });
    document.addEventListener(CART_COUNT_EVENT, this.onCartCount, { signal });
    window.addEventListener('pageshow', this.onPageShow, { signal });

    this.ensureCartBubbleIsCorrect();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#listeners?.abort();
  }

  /** Count from the server-rendered markup (Liquid hides the bubble when the cart is empty). */
  #readRenderedCount() {
    if (this.refs.cartBubble?.classList.contains('visually-hidden')) return 0;
    const parsed = parseInt(this.refs.cartBubbleCount?.textContent?.trim() ?? '', 10);
    return Number.isFinite(parsed) ? parsed : 100;
  }

  /**
   * Handles the page show event when the page is restored from cache.
   * @param {PageTransitionEvent} event - The page show event.
   */
  onPageShow = (event) => {
    if (event.persisted) {
      this.ensureCartBubbleIsCorrect();
    }
  };

  /**
   * Handles the theme's cart update event.
   * @param {CartLinesUpdateEvent} event - The cart update event.
   */
  onCartUpdate = (event) => {
    event.promise
      ?.then(({ cart, detail }) => {
        const itemCount = cart?.totalQuantity ?? detail?.itemCount;
        if (typeof itemCount === 'number') this.renderCartBubble(itemCount);
      })
      .catch((error) => {
        if (error?.name !== 'AbortError') console.warn('[cart-icon] Event promise rejected:', error);
        // The event failed, but the cart may still have changed: re-read it.
        cartSync.schedule(0);
      });
  };

  /**
   * Handles a fresh count read from /cart.js after a cart change made outside the theme's events.
   * @param {Event} event
   */
  onCartCount = (event) => {
    const count = /** @type {CustomEvent<{ count: number }>} */ (event).detail?.count;
    if (typeof count === 'number') this.renderCartBubble(count);
  };

  /**
   * Renders the cart bubble.
   * @param {number} itemCount - The absolute number of items in the cart.
   * @param {boolean} [animate=true] - Whether to animate the bubble.
   */
  renderCartBubble = async (itemCount, animate = true) => {
    const { cartBubble, cartBubbleText, cartBubbleCount } = this.refs;
    if (!cartBubble || !cartBubbleCount) return;

    const count = Math.max(0, Math.trunc(itemCount));
    const changed = count !== this.#count;
    const isEmpty = count === 0;

    this.#count = count;

    cartBubbleCount.textContent = count < 100 ? String(count) : '';
    cartBubbleCount.classList.toggle('hidden', isEmpty);
    cartBubble.classList.toggle('visually-hidden', isEmpty);
    cartBubble.toggleAttribute('data-maintain-ratio', count <= 99);
    this.classList.toggle('header-actions__cart-icon--has-cart', !isEmpty);

    try {
      sessionStorage.setItem('cart-count', JSON.stringify({ value: String(count), timestamp: Date.now() }));
    } catch (_) {
      // Storage can be unavailable (private mode, blocked site data).
    }

    // Only animate a real change, so repeat notifications for the same cart stay still.
    if (!animate || !changed || isEmpty || !cartBubbleText) return;

    // Let the browser paint the now-visible bubble before animating it.
    await new Promise((resolve) => requestAnimationFrame(resolve));

    cartBubble.classList.add('cart-bubble--animating');
    await onAnimationEnd(cartBubbleText);
    cartBubble.classList.remove('cart-bubble--animating');
  };

  /**
   * Corrects a count restored from the back/forward cache or a cached page.
   */
  ensureCartBubbleIsCorrect = () => {
    if (!this.refs.cartBubbleCount) return;

    let stored = null;
    try {
      stored = sessionStorage.getItem('cart-count');
    } catch (_) {
      // no-op
    }

    if (stored !== null) {
      try {
        const { value, timestamp } = JSON.parse(stored);
        const count = parseInt(value, 10);

        // Only trust a recent value; otherwise the live cart read below settles it.
        if (Date.now() - timestamp < 10000 && count >= 0 && count !== this.#count) {
          this.renderCartBubble(count, false);
        }
      } catch (_) {
        // no-op
      }
    }
  };
}

if (!customElements.get('cart-icon')) {
  customElements.define('cart-icon', CartIcon);
}
