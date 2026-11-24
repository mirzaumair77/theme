import { Component } from '@theme/component';
import { formatMoney } from '@theme/money-formatting';
import { CartLinesUpdateEvent, CartErrorEvent } from '@shopify/events';

/*
 * Custom front ends for Selleasy product-page add-on widgets.
 *
 * Selleasy (app embed `lb-upsell`) mounts `<lb-upsell-widget widget="widget#pal|pac|pag">` into
 * the first `.lb-widget-<type>` element and stores its offers on
 * `widget.lbPayload.widget.offers`. Each offer is a product with `handle`, `variants` and an
 * `lb_config` holding the chosen variant (`id`) and `selected`. After the main add to cart,
 * Selleasy adds `widget.getSelectedProducts()` — the `lb_config` of every offer whose
 * `lb_config.selected` is true — to the cart with its `_lb-product` attribution.
 *
 * These components keep Selleasy as the data source: Selleasy renders its widget into a hidden
 * source container and the components read its offers. They add to the cart themselves (with
 * Selleasy's `_lb-product` attribution) instead of relying on Selleasy's post-add flow: Complete
 * the look from its own buttons, Need a chain through the product form's request
 * (`getCartLines()`), clearing `lb_config.selected` so Selleasy does not add it twice. Card details (image, price, swatches) are rendered by Liquid through
 * `sections/section-rendering-add-on-card.liquid`.
 */

const CARD_SECTION_ID = 'section-rendering-add-on-card';

/** @type {Map<string, Promise<Element | null>>} */
const cardCache = new Map();

/**
 * @typedef {object} SelleasyVariant
 * @property {number | string} id
 * @property {string} [title]
 */

/**
 * @typedef {object} SelleasyOffer
 * @property {number | string} id
 * @property {string} [title]
 * @property {string} [handle]
 * @property {SelleasyVariant[]} [variants]
 * @property {{ id?: number | string, selected?: boolean, index?: number, price?: number, image?: string }} [lb_config]
 */

/**
 * @typedef {HTMLElement & { lbPayload?: { widget?: { offers?: SelleasyOffer[] } } }} SelleasyWidget
 */

/**
 * @param {Element | null | undefined} element
 * @returns {SelleasyOffer[]}
 */
function getOffers(element) {
  const offers = /** @type {SelleasyWidget | null | undefined} */ (element)?.lbPayload?.widget?.offers;
  return Array.isArray(offers) ? offers : [];
}

/**
 * @param {SelleasyOffer} offer
 * @returns {string}
 */
function getOfferVariantId(offer) {
  const id = offer.lb_config?.id ?? offer.variants?.[0]?.id;
  return id === undefined || id === null ? '' : String(id);
}

/**
 * @param {SelleasyOffer} offer
 * @returns {string}
 */
function getOfferKey(offer) {
  return `${offer.id}:${offer.lb_config?.index ?? ''}`;
}

/**
 * Fetches the Liquid-rendered card data for an offer's chosen variant, or for `variantId`.
 * @param {SelleasyOffer} offer
 * @param {string} [variantId] - Defaults to the variant Selleasy chose.
 * @returns {Promise<Element | null>}
 */
function fetchCard(offer, variantId = getOfferVariantId(offer)) {
  if (!offer.handle) return Promise.resolve(null);

  const key = `${offer.handle}:${variantId}`;
  const cached = cardCache.get(key);
  if (cached) return cached;

  const root = window.Shopify?.routes?.root ?? '/';
  const url = new URL(`${root}products/${encodeURIComponent(offer.handle)}`, window.location.origin);
  url.searchParams.set('section_id', CARD_SECTION_ID);
  if (variantId) url.searchParams.set('variant', variantId);

  const request = fetch(url)
    .then((response) => {
      if (!response.ok) throw new Error(`Add-on card request failed: ${response.status}`);
      return response.text();
    })
    .then((html) => new DOMParser().parseFromString(html, 'text/html').querySelector('[data-add-on-card]'))
    .catch((error) => {
      cardCache.delete(key);
      throw error;
    });

  cardCache.set(key, request);
  return request;
}

/**
 * Clones a `<template data-*>` from a fetched card.
 * @param {Element | null} card
 * @param {string} selector
 * @returns {DocumentFragment | null}
 */
function cloneCardPart(card, selector) {
  const template = card?.querySelector(selector);
  return template instanceof HTMLTemplateElement ? /** @type {DocumentFragment} */ (template.content.cloneNode(true)) : null;
}

/**
 * @typedef {object} AddOnsRefs
 * @property {HTMLElement} source - Container Selleasy mounts its widget into.
 */

/**
 * Shared lifecycle: find the Selleasy widget, render its offers, stay in sync with its re-renders.
 *
 * @template {AddOnsRefs} [TRefs=AddOnsRefs]
 * @extends {Component<TRefs>}
 */
class AddOnsComponent extends Component {
  requiredRefs = ['source'];

  /** @type {AbortController | undefined} */
  #controller;

  /** @type {SelleasyWidget | null} */
  widget = null;

  /** @type {string} */
  #renderedSignature = '';

  /** @type {number} */
  #renderRequest = 0;

  connectedCallback() {
    super.connectedCallback();

    this.#controller?.abort();
    this.#controller = new AbortController();

    // Selleasy emits `lbWidgetRendered` (bubbling) after each widget render, including variant matches.
    window.addEventListener('lbWidgetRendered', this.#handleWidgetRendered, { signal: this.#controller.signal });
    this.#sync();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#controller?.abort();
  }

  get widgetType() {
    return this.dataset.widgetType || 'pal';
  }

  /** @returns {SelleasyWidget | null} */
  #findWidget() {
    const local = this.refs.source.querySelector('lb-upsell-widget');
    if (local instanceof HTMLElement) return local;

    // Selleasy may be configured with a custom position; consume that widget instead.
    const external = document.querySelector(`lb-upsell-widget[widget="widget#${this.widgetType}"]`);
    return external instanceof HTMLElement ? external : null;
  }

  #handleWidgetRendered = () => {
    cancelAnimationFrame(this.#renderRequest);
    this.#renderRequest = requestAnimationFrame(() => this.#sync());
  };

  async #sync() {
    const widget = this.#findWidget();
    const offers = getOffers(widget).filter((offer) => offer?.handle);

    if (!widget || offers.length === 0) return;

    // This component is the visible front end; keep an externally placed widget out of view.
    if (!this.refs.source.contains(widget)) widget.hidden = true;

    const signature = offers.map((offer) => `${getOfferKey(offer)}:${getOfferVariantId(offer)}`).join('|');
    if (widget === this.widget && signature === this.#renderedSignature) {
      this.syncSelection();
      return;
    }

    this.widget = widget;
    this.#renderedSignature = signature;

    const results = await Promise.allSettled(offers.map((offer) => fetchCard(offer)));

    // A newer render superseded this one, or the component left the page.
    if (signature !== this.#renderedSignature || !this.isConnected) return;

    const items = offers.map((offer, index) => {
      const result = results[index];
      return { offer, card: result?.status === 'fulfilled' ? result.value : null };
    });

    this.renderOffers(items);
    this.syncSelection();
    this.hidden = false;
  }

  /**
   * Updates Selleasy's own selection state, which its add-to-cart flow reads.
   * @param {SelleasyOffer} offer
   * @param {boolean} selected
   */
  setOfferSelected(offer, selected) {
    offer.lb_config = { ...(offer.lb_config ?? {}), selected };
    // Keep the same object reference Selleasy holds.
    const offers = getOffers(this.widget);
    const target = offers.find((candidate) => getOfferKey(candidate) === getOfferKey(offer));
    if (target && target !== offer) target.lb_config = offer.lb_config;
  }

  /**
   * @param {string} key
   * @returns {SelleasyOffer | undefined}
   */
  getOfferByKey(key) {
    return getOffers(this.widget).find((offer) => getOfferKey(offer) === key);
  }

  /**
   * Selleasy's attribution line-item property, in the format Selleasy uses for its own add-ons.
   * @returns {Record<string, string>}
   */
  getAttributionProperties() {
    /** @type {Record<string, string>} */
    const properties = {};
    const triggerId = this.widget?.getAttribute('lb-trigger-product-id');
    const offerId = this.widget?.getAttribute('offer');
    if (triggerId && offerId) properties['_lb-product'] = `${triggerId}#${offerId}`;
    return properties;
  }

  /**
   * @param {{ offer: SelleasyOffer, card: Element | null }[]} _items
   */
  renderOffers(_items) {}

  /** Reflects Selleasy's current selection in the custom UI. */
  syncSelection() {}

  /**
   * Card details from Liquid, falling back to Selleasy's payload if the card request failed.
   * @param {SelleasyOffer} offer
   * @param {Element | null} card
   * @returns {{ title: string, price: string, url: string, image: Node | null, swatches: DocumentFragment | null }}
   */
  describeOffer(offer, card) {
    const title = card?.getAttribute('data-title') || offer.title || '';
    let price = card?.getAttribute('data-price') || '';
    let image = /** @type {Node | null} */ (cloneCardPart(card, '[data-add-on-image]'));
    // Selleasy's fallback price and image describe its own chosen variant only.
    const isOfferVariant = !card || card.getAttribute('data-variant-id') === getOfferVariantId(offer);

    if (!price && isOfferVariant && typeof offer.lb_config?.price === 'number' && this.dataset.moneyFormat) {
      // Matches the Liquid card's money_without_trailing_zeros
      price = formatMoney(offer.lb_config.price, this.dataset.moneyFormat, this.dataset.currency || 'USD').replace(
        /[.,]00(?!\d)/,
        ''
      );
    }

    if (!image && isOfferVariant && offer.lb_config?.image) {
      const img = document.createElement('img');
      img.src = offer.lb_config.image;
      img.alt = title;
      img.loading = 'lazy';
      img.className = 'add-on-card__image';
      image = img;
    }

    const root = window.Shopify?.routes?.root ?? '/';
    const fallbackUrl = offer.handle ? `${root}products/${offer.handle}?variant=${getOfferVariantId(offer)}` : '';

    return {
      title,
      price,
      url: card?.getAttribute('data-url') || (isOfferVariant ? fallbackUrl : ''),
      image,
      swatches: cloneCardPart(card, '[data-add-on-swatches]'),
    };
  }
}

/**
 * @typedef {object} NeedAChainRefs
 * @property {HTMLElement} source
 * @property {HTMLElement} options - Container for the chain options.
 * @property {HTMLTemplateElement} optionTemplate - Markup for one chain option.
 * @property {HTMLElement} selectionTitle - Selected chain title.
 * @property {HTMLElement} selectionPrice - Selected chain price.
 * @property {HTMLButtonElement} [previous] - Scrolls the chain row back.
 * @property {HTMLButtonElement} [next] - Scrolls the chain row forward.
 */

/**
 * "Need a chain?" — single-choice chain picker backed by Selleasy add-on offers.
 *
 * @extends {AddOnsComponent<NeedAChainRefs>}
 */
class NeedAChainComponent extends AddOnsComponent {
  requiredRefs = ['source', 'options', 'optionTemplate', 'selectionTitle', 'selectionPrice'];

  /** @type {AbortController | undefined} */
  #sliderController;

  /** @type {ResizeObserver | undefined} */
  #sliderObserver;

  /** @type {number} */
  #arrowFrame = 0;

  connectedCallback() {
    super.connectedCallback();

    this.#sliderController?.abort();
    this.#sliderObserver?.disconnect();
    this.#sliderController = new AbortController();

    const { options } = this.refs;
    options.addEventListener('scroll', this.#scheduleArrowUpdate, {
      passive: true,
      signal: this.#sliderController.signal,
    });

    // Also covers the block being unhidden once its offers arrive.
    this.#sliderObserver = new ResizeObserver(this.#scheduleArrowUpdate);
    this.#sliderObserver.observe(options);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#sliderController?.abort();
    this.#sliderObserver?.disconnect();
    cancelAnimationFrame(this.#arrowFrame);
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
    const { options } = this.refs;
    const isRtl = getComputedStyle(options).direction === 'rtl';
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    options.scrollBy({
      left: options.clientWidth * 0.8 * direction * (isRtl ? -1 : 1),
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
  }

  #scheduleArrowUpdate = () => {
    cancelAnimationFrame(this.#arrowFrame);
    this.#arrowFrame = requestAnimationFrame(() => {
      const { options, previous, next } = this.refs;
      // scrollLeft is negative in RTL; compare magnitudes.
      const offset = Math.abs(options.scrollLeft);
      const maxOffset = options.scrollWidth - options.clientWidth;

      if (previous) previous.hidden = offset <= 1;
      if (next) next.hidden = offset >= maxOffset - 1;
    });
  };

  /**
   * @param {{ offer: SelleasyOffer, card: Element | null }[]} items
   */
  renderOffers(items) {
    const { options, optionTemplate } = this.refs;
    const addLabel = this.dataset.addLabel ?? '';
    const fragment = document.createDocumentFragment();

    for (const { offer, card } of items) {
      const option = /** @type {DocumentFragment} */ (optionTemplate.content.cloneNode(true));
      const input = option.querySelector('input');
      const media = option.querySelector('[data-option-media]');
      if (!(input instanceof HTMLInputElement)) continue;

      const { title: productTitle, price, image } = this.describeOffer(offer, card);

      // Lead with the chain's length, e.g. "18” Sterling Silver Snake Chain" from variant "18” — Standard".
      const variantTitle = String(
        /** @type {any} */ (offer.lb_config)?.variantTitle ??
          offer.variants?.find((variant) => String(variant.id) === getOfferVariantId(offer))?.title ??
          ''
      );
      const lengthLabel = variantTitle && variantTitle !== 'Default Title' ? variantTitle.split(/\s+[—–/-]\s+/)[0] : '';
      const title = lengthLabel ? `${lengthLabel} ${productTitle}` : productTitle;

      input.value = getOfferKey(offer);
      input.dataset.title = title;
      input.dataset.price = price;
      input.setAttribute('aria-label', [addLabel.replace('[title]', title), price].filter(Boolean).join(', '));

      if (media && image) media.append(image);

      fragment.append(option);
    }

    options.replaceChildren(fragment);
    this.#scheduleArrowUpdate();
  }

  /**
   * Offer key of the chosen chain. This component owns the selection: Selleasy re-renders its
   * widget (e.g. on every variant change) with fresh offers, which would drop a selection
   * stored only in Selleasy's payload.
   */
  #selectedKey = '';

  /** Whether the shopper has chosen; until then Selleasy's preselection (if any) applies. */
  #shopperChose = false;

  syncSelection() {
    const { options, selectionTitle, selectionPrice } = this.refs;
    const priceTemplate = this.dataset.priceTemplate ?? '[price]';
    const offers = getOffers(this.widget);

    if (!this.#shopperChose) {
      const preselected = offers.find((offer) => offer.lb_config?.selected);
      this.#selectedKey = preselected ? getOfferKey(preselected) : '';
    } else if (!offers.some((offer) => getOfferKey(offer) === this.#selectedKey)) {
      this.#selectedKey = '';
    }

    // The product form adds the chain with the main product (getCartLines), so keep Selleasy
    // from adding it a second time after the add to cart.
    for (const offer of offers) {
      if (offer.lb_config?.selected) this.setOfferSelected(offer, false);
    }

    let selected = null;

    for (const input of options.querySelectorAll('input[type="checkbox"]')) {
      if (!(input instanceof HTMLInputElement)) continue;

      const isSelected = Boolean(this.#selectedKey) && input.value === this.#selectedKey && !selected;
      input.checked = isSelected;
      if (isSelected) selected = input;
    }

    selectionTitle.textContent = selected?.dataset.title ?? '';
    selectionPrice.textContent = selected?.dataset.price ? priceTemplate.replace('[price]', selected.dataset.price) : '';
  }

  /**
   * One chain at most: choosing a chain clears the others; choosing it again removes it.
   * Bound through `on:change="/selectChain"`.
   * @param {Event} event
   */
  selectChain(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (!this.getOfferByKey(input.value)) return;

    this.#shopperChose = true;
    this.#selectedKey = input.checked ? input.value : '';
    this.syncSelection();
  }

  /**
   * Cart lines for the chosen chain, read by the product form and added in the same
   * `cart/add` request as the main product so both are added together or not at all.
   * @returns {{ id: number, quantity: number, properties: Record<string, string> }[]}
   */
  getCartLines() {
    if (!this.#selectedKey || this.hidden) return [];

    const offer = this.getOfferByKey(this.#selectedKey);
    const variantId = Number(offer ? getOfferVariantId(offer) : '');
    if (!Number.isFinite(variantId) || variantId <= 0) return [];

    return [{ id: variantId, quantity: 1, properties: this.getAttributionProperties() }];
  }
}

/**
 * @typedef {object} CompleteTheLookRefs
 * @property {HTMLElement} source
 * @property {HTMLElement} viewport - Swiper container.
 * @property {HTMLElement} track - Swiper wrapper holding the product cards.
 * @property {HTMLTemplateElement} cardTemplate - Markup for one product card.
 * @property {HTMLButtonElement} [previous]
 * @property {HTMLButtonElement} [next]
 * @property {HTMLElement} [status] - Polite live region for add-to-cart feedback.
 */

/** @type {Promise<void> | undefined} */
let swiperPromise;

/**
 * Swiper is loaded by `theme.liquid`. Resolves once `window.Swiper` exists: immediately, or after
 * the document finishes parsing (deferred scripts) or loading (async scripts). Rejects if Swiper
 * never becomes available, so the caller keeps its native-scroll fallback.
 * @returns {Promise<void>}
 */
function whenSwiperReady() {
  swiperPromise ??= new Promise((resolve, reject) => {
    const hasSwiper = () => Boolean(/** @type {any} */ (window).Swiper);
    if (hasSwiper()) return resolve();

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => hasSwiper() && resolve(), { once: true });
    }

    if (document.readyState === 'complete') {
      reject(new Error('Swiper is not available'));
      return;
    }

    window.addEventListener(
      'load',
      () => (hasSwiper() ? resolve() : reject(new Error('Swiper is not available'))),
      { once: true }
    );
  });

  return swiperPromise;
}

/**
 * "Complete the look" — Swiper carousel of Selleasy add-on offers. Each card's bag button adds
 * that product to the cart directly, keeping Selleasy's `_lb-product` attribution.
 *
 * @extends {AddOnsComponent<CompleteTheLookRefs>}
 */
class CompleteTheLookComponent extends AddOnsComponent {
  requiredRefs = ['source', 'viewport', 'track', 'cardTemplate'];

  /** @type {any} */
  swiper = null;

  disconnectedCallback() {
    super.disconnectedCallback();
    this.swiper?.destroy(true, true);
    this.swiper = null;
  }

  /**
   * @param {{ offer: SelleasyOffer, card: Element | null }[]} items
   */
  renderOffers(items) {
    const { track, cardTemplate } = this.refs;
    const addLabel = this.dataset.addLabel ?? '';
    const fragment = document.createDocumentFragment();

    for (const { offer, card } of items) {
      const item = /** @type {DocumentFragment} */ (cardTemplate.content.cloneNode(true));
      const { title, price, url, image, swatches: swatchParts } = this.describeOffer(offer, card);

      for (const link of item.querySelectorAll('a[data-card-link]')) {
        if (link instanceof HTMLAnchorElement && url) link.href = url;
      }

      const titleElement = item.querySelector('[data-card-title]');
      if (titleElement) titleElement.textContent = title;

      const priceElement = item.querySelector('[data-card-price]');
      if (priceElement) priceElement.textContent = price;

      const media = item.querySelector('[data-card-media]');
      if (media && image) media.append(image);

      const swatches = item.querySelector('[data-card-swatches]');
      if (swatches && swatchParts) {
        swatches.append(swatchParts);
      } else {
        swatches?.remove();
      }

      const button = item.querySelector('button[data-card-add]');
      if (button instanceof HTMLButtonElement) {
        button.value = getOfferKey(offer);
        // The variant this card adds; swatch selection replaces it.
        button.dataset.variantId = getOfferVariantId(offer);
        button.dataset.title = title;
        button.setAttribute('aria-label', addLabel.replace('[title]', title));
      }

      fragment.append(item);
    }

    this.swiper?.destroy(true, true);
    this.swiper = null;
    track.replaceChildren(fragment);
    this.#initSwiper();
  }

  async #initSwiper() {
    try {
      await whenSwiperReady();
    } catch {
      return; // The track stays a native horizontal scroller.
    }

    const { viewport, previous, next } = this.refs;
    if (!this.isConnected || this.swiper) return;

    const Swiper = /** @type {any} */ (window).Swiper;
    this.swiper = new Swiper(viewport, {
      wrapperClass: 'complete-the-look__track',
      slideClass: 'complete-the-look__card',
      slidesPerView: 3,
      spaceBetween: 8,
      speed: 400,
      watchOverflow: true,
      navigation: {
        prevEl: previous,
        nextEl: next,
        disabledClass: 'complete-the-look__arrow--disabled',
        lockClass: 'complete-the-look__arrow--locked',
      },
      a11y: {
        prevSlideMessage: previous?.getAttribute('aria-label'),
        nextSlideMessage: next?.getAttribute('aria-label'),
        slideRole: 'group',
      },
      breakpoints: {
        750: { slidesPerView: 2.55, spaceBetween: 8 },
      },
    });

    this.classList.add('complete-the-look--ready');
  }

  /** @type {WeakMap<Element, number>} Latest swatch request per card, so stale responses are ignored. */
  #swatchRequests = new WeakMap();

  /**
   * Switches a card to the variant of the chosen color swatch: marks the swatch active, then
   * updates the card's image, price and links, and the variant its bag button adds.
   * Bound through `on:click="/selectSwatch"` on the swatches from the card section.
   * @param {Event} event
   */
  async selectSwatch(event) {
    const swatch = event.target instanceof Element ? event.target.closest('button.add-on-card__swatch') : null;
    const card = swatch?.closest('.complete-the-look__card');
    const button = card?.querySelector('button[data-card-add]');
    if (!(swatch instanceof HTMLButtonElement) || !card || !(button instanceof HTMLButtonElement)) return;

    const variantId = swatch.dataset.variantId ?? '';
    const offer = this.getOfferByKey(button.value);
    if (!variantId || !offer || variantId === button.dataset.variantId) return;

    const previousSwatch = card.querySelector('.add-on-card__swatch[aria-pressed="true"]');
    this.#setActiveSwatch(card, swatch);

    const request = (this.#swatchRequests.get(card) ?? 0) + 1;
    this.#swatchRequests.set(card, request);

    /** @type {Element | null} */
    let source = null;
    try {
      source = await fetchCard(offer, variantId);
    } catch (error) {
      console.warn('[complete-the-look] Variant request failed:', error);
    }

    // A newer swatch click on this card superseded this one.
    if (this.#swatchRequests.get(card) !== request) return;

    if (!source) {
      // Keep the card consistent with the variant its bag button still adds.
      if (previousSwatch instanceof HTMLButtonElement) this.#setActiveSwatch(card, previousSwatch);
      return;
    }

    const { price, url, image } = this.describeOffer(offer, source);
    button.dataset.variantId = variantId;

    const priceElement = card.querySelector('[data-card-price]');
    if (priceElement) priceElement.textContent = price;

    const media = card.querySelector('[data-card-media]');
    if (media && image) media.replaceChildren(image);

    if (url) {
      for (const link of card.querySelectorAll('a[data-card-link]')) {
        if (link instanceof HTMLAnchorElement) link.href = url;
      }
    }
  }

  /**
   * @param {Element} card
   * @param {HTMLButtonElement} active
   */
  #setActiveSwatch(card, active) {
    for (const swatch of card.querySelectorAll('.add-on-card__swatch')) {
      const isActive = swatch === active;
      swatch.classList.toggle('add-on-card__swatch--selected', isActive);
      swatch.setAttribute('aria-pressed', String(isActive));
    }
  }

  /**
   * Adds the card's product to the cart: the variant of its selected swatch, or the variant
   * Selleasy chose. Bound through `on:click="/addToCart"`.
   * @param {Event} event
   */
  async addToCart(event) {
    const button = event.target instanceof Element ? event.target.closest('button[data-card-add]') : null;
    if (!(button instanceof HTMLButtonElement) || button.getAttribute('aria-busy') === 'true') return;

    const offer = this.getOfferByKey(button.value);
    const variantId = button.dataset.variantId || (offer ? getOfferVariantId(offer) : '');
    if (!variantId) return;

    const theme = /** @type {any} */ (window).Theme;
    const sectionIds = [...document.querySelectorAll('cart-items-component')]
      .map((element) => (element instanceof HTMLElement ? element.dataset.sectionId : ''))
      .filter(Boolean);

    const properties = this.getAttributionProperties();

    button.setAttribute('aria-busy', 'true');

    const deferred = CartLinesUpdateEvent.createPromise();
    this.dispatchEvent(
      new CartLinesUpdateEvent({
        action: 'add',
        context: 'product',
        lines: [{ merchandiseId: variantId, quantity: 1 }],
        promise: deferred.promise,
      })
    );

    try {
      const response = await fetch(theme?.routes?.cart_add_url ?? `${window.Shopify?.routes?.root ?? '/'}cart/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          items: [{ id: Number(variantId), quantity: 1, properties }],
          sections: sectionIds.join(','),
        }),
      });
      const result = await response.json();
      if (result.status) throw new Error(result.description || result.message || 'Add to cart failed');

      const cart = await this.#fetchCart(theme);
      deferred.resolve({
        cart: CartLinesUpdateEvent.createCartFromAjaxResponse(cart),
        detail: {
          items: cart.items,
          sections: result.sections,
          source: 'complete-the-look-component',
          sourceId: this.id,
          itemCount: 1,
          didError: false,
        },
      });

      this.#announce(this.dataset.addedLabel?.replace('[title]', button.dataset.title ?? '') ?? '');
      button.dataset.added = 'true';
      setTimeout(() => delete button.dataset.added, 2000);
      this.#openCartDrawer();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.dispatchEvent(new CartErrorEvent({ error: message, code: 'INVALID' }));
      this.#announce(message);

      try {
        const cart = await this.#fetchCart(theme);
        deferred.resolve({
          cart: CartLinesUpdateEvent.createCartFromAjaxResponse(cart),
          detail: { items: cart.items, didError: true, source: 'complete-the-look-component', itemCount: 1 },
        });
      } catch (refreshError) {
        deferred.reject(refreshError);
      }
    } finally {
      button.removeAttribute('aria-busy');
    }
  }

  /**
   * Opens the store's cart drawer after a successful add, the same drawer the header cart
   * button opens. The store's cart app (Monster Cart) keeps its own copy of the cart, so
   * `monster_refresh(true)` reloads it from /cart.js and then opens it; `openCart()` alone
   * would show stale contents. Falls back to `openCart()`, then to the theme's cart drawer.
   */
  #openCartDrawer() {
    const app = /** @type {any} */ (window);
    if (typeof app.monster_refresh === 'function') {
      Promise.resolve(app.monster_refresh(true)).catch((error) => console.warn('[complete-the-look] Cart refresh failed:', error));
      return;
    }

    if (typeof app.openCart === 'function') {
      app.openCart();
      return;
    }

    const drawer = /** @type {any} */ (document.querySelector('theme-drawer:has(cart-drawer-component)'));
    if (drawer && typeof drawer.open === 'function' && !drawer.isOpen) drawer.open();
  }

  /** @param {any} theme */
  async #fetchCart(theme) {
    const url = theme?.routes?.cart_url ? `${theme.routes.cart_url}.js` : `${window.Shopify?.routes?.root ?? '/'}cart.js`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Cart request failed: ${response.status}`);
    return response.json();
  }

  /** @param {string} message */
  #announce(message) {
    const { status } = this.refs;
    if (!status || !message) return;
    status.textContent = '';
    requestAnimationFrame(() => {
      status.textContent = message;
    });
  }
}

if (!customElements.get('need-a-chain-component')) {
  customElements.define('need-a-chain-component', NeedAChainComponent);
}

if (!customElements.get('complete-the-look-component')) {
  customElements.define('complete-the-look-component', CompleteTheLookComponent);
}
