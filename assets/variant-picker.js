import { Component } from '@theme/component';
import { morph, MORPH_OPTIONS } from '@theme/morph';
import { OverflowList } from '@theme/overflow-list';
import { yieldToMainThread, getViewParameterValue, ResizeNotifier } from '@theme/utilities';
import { ProductSelectEvent, StandardEvents } from '@shopify/events';

/** How long a fetched variant response may be reused, in ms. */
const RESPONSE_CACHE_TTL = 60_000;
/** Maximum number of variant responses kept per picker. */
const RESPONSE_CACHE_MAX = 24;

/**
 * @typedef {object} VariantPickerRefs
 * @property {HTMLFieldSetElement[]} fieldsets - The fieldset elements.
 * @property {HTMLElement} [overflowList] - The overflow list element.
 */

/**
 * A custom element that manages a variant picker.
 *
 * @template {import('@theme/component').Refs} [TRefs=VariantPickerRefs]
 * @extends Component<TRefs>
 */
export default class VariantPicker extends Component {
  /** Morphs and reconnects must not re-apply the default size over a later selection. */
  static #defaultSizeHandled = false;

  /** @type {string | undefined} */
  #pendingRequestUrl;

  /** @type {AbortController | undefined} */
  #abortController;

  /** @type {number[][]} */
  #checkedIndices = [];

  /** @type {HTMLInputElement[][]} */
  #radios = [];

  #resizeObserver = new ResizeNotifier(() => this.updateVariantPickerCss());

  /** @type {AbortController | undefined} */
  #swatchHoverController;

  /** @type {number | undefined} */
  #prefetchTimer;

  /**
   * Variant responses (HTML text) keyed by request URL, shared by intent prefetches and
   * selections so a request already in flight is never repeated. Text is re-parsed per use
   * because listeners move nodes out of the parsed document.
   * @type {Map<string, { promise: Promise<string>, expires: number }>}
   */
  #responseCache = new Map();

  /** @type {AbortController | undefined} */
  #listenerController;

  connectedCallback() {
    super.connectedCallback();
    const fieldsets = /** @type {HTMLFieldSetElement[]} */ (this.refs.fieldsets || []);

    fieldsets.forEach((fieldset) => {
      const radios = Array.from(fieldset?.querySelectorAll('input') ?? []);
      this.#radios.push(radios);

      const initialCheckedIndex = radios.findIndex((radio) => radio.dataset.currentChecked === 'true');
      if (initialCheckedIndex !== -1) {
        this.#checkedIndices.push([initialCheckedIndex]);
      }
    });

    this.addEventListener('change', this.variantChanged.bind(this));
    this.#resizeObserver.observe(this);

    // Cart-dependent markup (quantity in cart, inventory) may change after an add.
    this.#listenerController?.abort();
    this.#listenerController = new AbortController();
    document.addEventListener(StandardEvents.cartLinesUpdate, () => this.#responseCache.clear(), {
      signal: this.#listenerController.signal,
    });

    // Hover/press intent handling for the main product page only (not product cards or quick add).
    this.#swatchHoverController?.abort();
    if (this.#isMainProductPicker) {
      this.#swatchHoverController = new AbortController();
      const { signal } = this.#swatchHoverController;
      this.addEventListener('pointerover', this.#handleSwatchPointerOver, { signal });
      this.addEventListener('pointerout', this.#handleSwatchPointerOut, { signal });
      this.addEventListener('pointerdown', this.#handleOptionPointerDown, { signal });
      if (this.#hasUnsyncedSelection()) {
        // The shopper's choice wins over the block's default size.
        VariantPicker.#defaultSizeHandled = true;
        this.#syncUnsyncedSelection();
      } else {
        this.#applyDefaultSize();
      }
    }
  }

  /**
   * The checked radio that never went through `change`: tapped before this module ran, or
   * restored by the browser (back/forward, reload). Server-rendered selections carry
   * `data-current-checked="true"`.
   * @returns {HTMLInputElement | undefined}
   */
  #getUnsyncedInput() {
    const fieldsets = /** @type {HTMLFieldSetElement[]} */ (this.refs.fieldsets || []);
    for (const fieldset of fieldsets) {
      const checked = fieldset.querySelector('input[type="radio"]:checked');
      if (checked instanceof HTMLInputElement && checked.dataset.currentChecked !== 'true') return checked;
    }
    return undefined;
  }

  /** @returns {boolean} */
  #hasUnsyncedSelection() {
    return Boolean(this.#getUnsyncedInput());
  }

  /**
   * Runs an unsynced selection through the normal change flow so the variant, price, media,
   * form, and URL match what the shopper sees. Waits for the section's components so they
   * receive the product select event.
   */
  async #syncUnsyncedSelection() {
    await this.#whenSectionComponentsReady();
    const input = this.#getUnsyncedInput();
    if (!this.isConnected || !input) return;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * Selects the block's default size once per page load, through the normal change flow so the
   * price, form, gallery, and URL stay in sync. A variant in the URL or a shopper's choice wins.
   */
  async #applyDefaultSize() {
    const defaultSize = this.dataset.defaultSize;
    if (!defaultSize || VariantPicker.#defaultSizeHandled) return;
    VariantPicker.#defaultSizeHandled = true;

    const hasChosenVariant = () => {
      const params = new URLSearchParams(window.location.search);
      return params.has('variant') || params.has('option_values');
    };
    if (hasChosenVariant()) return;

    const initialSelection = this.selectedOptionsValues.join(',');
    await this.#whenSectionComponentsReady();

    if (!this.isConnected || hasChosenVariant() || this.selectedOptionsValues.join(',') !== initialSelection) return;

    const sizeInput = Array.from(
      this.querySelectorAll('fieldset:not(.variant-option--swatches) input[type="radio"]')
    ).find(
      (input) =>
        input instanceof HTMLInputElement &&
        input.dataset.optionName?.toLowerCase().includes('size') &&
        input.value.trim().toLowerCase() === defaultSize.toLowerCase()
    );

    if (!(sizeInput instanceof HTMLInputElement) || sizeInput.checked) return;
    if (sizeInput.dataset.optionAvailable !== 'true') return;

    sizeInput.checked = true;
    sizeInput.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * Resolves once the section's custom elements can receive the variant update. Page load is the
   * fallback, so a component that never registers can't block the selection.
   * @returns {Promise<unknown>}
   */
  #whenSectionComponentsReady() {
    const section = this.closest('.shopify-section') ?? document;
    const pendingNames = new Set(Array.from(section.querySelectorAll(':not(:defined)'), (element) => element.localName));
    const defined = Promise.all(Array.from(pendingNames, (name) => customElements.whenDefined(name)));
    const loaded =
      document.readyState === 'complete'
        ? Promise.resolve()
        : new Promise((resolve) => window.addEventListener('load', resolve, { once: true }));

    return pendingNames.size ? Promise.race([defined, loaded]) : Promise.resolve();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#resizeObserver.disconnect();
    this.#swatchHoverController?.abort();
    this.#listenerController?.abort();
    clearTimeout(this.#prefetchTimer);
    this.#responseCache.clear();
  }

  get #isMainProductPicker() {
    return (
      this.localName === 'variant-picker' &&
      this.dataset.templateProductMatch === 'true' &&
      !this.closest('product-card, quick-add-component, quick-add-dialog, featured-product-information')
    );
  }

  /**
   * The option radio (swatch or button, e.g. a size) under a pointer event, in this picker.
   * @param {Event} event
   * @returns {HTMLInputElement | null}
   */
  #getOptionInput(event) {
    const label = event.target instanceof Element ? event.target.closest('.variant-option__button-label') : null;
    const input = label?.querySelector('input[type="radio"]');
    return input instanceof HTMLInputElement && this.contains(label) ? input : null;
  }

  /** @param {HTMLInputElement} input */
  #isSwatchInput(input) {
    return Boolean(input.closest('.variant-option--swatches .variant-option__button-label--has-swatch'));
  }

  /**
   * Mouse hover: shows a swatch's value as the variant title, and prefetches any option's
   * variant. Hover never checks the input, so the selected variant stays active until the
   * shopper picks another option.
   * @param {PointerEvent} event
   */
  #handleSwatchPointerOver = (event) => {
    if (event.pointerType !== 'mouse') return;

    const input = this.#getOptionInput(event);
    if (!input) return;

    if (this.#isSwatchInput(input)) this.#showSwatchTitle(input, input.value);

    clearTimeout(this.#prefetchTimer);
    if (!input.checked) {
      // Short hover intent, so sweeping across the options doesn't request every variant.
      this.#prefetchTimer = window.setTimeout(() => this.#prefetchSelection(input), 80);
    }
  };

  /**
   * Press intent (touch, pen, or mouse): starts the request before the click completes, so the
   * change handler picks up a request already in flight.
   * @param {PointerEvent} event
   */
  #handleOptionPointerDown = (event) => {
    const input = this.#getOptionInput(event);
    if (!input || input.checked) return;
    clearTimeout(this.#prefetchTimer);
    this.#prefetchSelection(input);
  };

  /** @param {PointerEvent} event */
  #handleSwatchPointerOut = (event) => {
    const input = this.#getOptionInput(event);
    if (!input) return;

    // Moving between parts of the same option is not leaving it.
    const label = input.closest('label');
    if (event.relatedTarget instanceof Node && label?.contains(event.relatedTarget)) return;

    clearTimeout(this.#prefetchTimer);
    if (!this.#isSwatchInput(input)) return;

    // Restore the selected value: the checked input is always the active selection.
    const fieldset = input.closest('fieldset');
    const checked = fieldset?.querySelector('input[type="radio"]:checked');
    if (checked instanceof HTMLInputElement) this.#showSwatchTitle(checked, checked.value);
  };

  /**
   * Writes a value into the existing selected-value text of the swatch's option, and into the
   * section's variant title block when that block shows this option.
   * @param {HTMLInputElement} input
   * @param {string} title
   */
  #showSwatchTitle(input, title) {
    const fieldset = input.closest('fieldset');
    for (const element of fieldset?.querySelectorAll('.variant-option__selected-value, .variant-option__swatch-value') ??
      []) {
      if (element.textContent !== title) element.textContent = title;
    }

    // data-input-id is "<option position>-<value index>"; the variant title block stores the 0-based option index.
    const optionIndex = Number.parseInt(input.dataset.inputId ?? '', 10) - 1;
    const variantTitle = this.closest('.shopify-section')?.querySelector(
      `variant-title-component[data-option-index="${optionIndex}"] [ref="title"]`
    );
    if (variantTitle && variantTitle.textContent !== title) variantTitle.textContent = title;
  }

  /**
   * Request URL for selecting `input`: the current selection with this option swapped. Matches
   * what `buildRequestUrl` produces for the main product picker after the input is checked.
   * @param {HTMLInputElement} input
   * @returns {string}
   */
  #getSelectionUrl(input) {
    const fieldset = input.closest('fieldset');
    const optionValueIds = Array.from(
      this.querySelectorAll('select option[selected], fieldset input:checked'),
      (option) => (option instanceof HTMLElement && option.closest('fieldset') === fieldset ? input : option)
    ).map((option) => /** @type {HTMLElement} */ (option).dataset.optionValueId ?? '');

    const productUrl = input.dataset.connectedProductUrl || this.dataset.productUrl;
    const params = [];
    const viewParamValue = getViewParameterValue();
    if (viewParamValue) params.push(`view=${viewParamValue}`);
    if (optionValueIds.length) params.push(`option_values=${optionValueIds.join(',')}`);
    const sectionId = this.#getSectionRenderingId(input);
    if (sectionId) params.push(`section_id=${encodeURIComponent(sectionId)}`);

    return `${productUrl}?${params.join('&')}`;
  }

  /**
   * Section ID for rendering only the product section on a variant change. Every listener that
   * updates (form, price, media, sticky bar, inventory, view payload) lives in that section, so
   * the full page (header, other sections, footer, apps) is not rendered. Omitted when the
   * option loads another product (combined listings), which still morphs all of `main`.
   * @param {HTMLElement} option - The selected option element.
   * @returns {string | undefined}
   */
  #getSectionRenderingId(option) {
    if (!this.#isMainProductPicker) return undefined;
    const currentUrl = this.dataset.productUrl?.split('?')[0];
    const newUrl = option.dataset.connectedProductUrl;
    if (newUrl && newUrl !== currentUrl) return undefined;
    return this.dataset.sectionId || undefined;
  }

  /**
   * Returns the response text for a variant URL, reusing a fresh cached or in-flight request.
   * Not tied to a selection's AbortSignal, so a superseded selection doesn't cancel a request
   * another selection or prefetch shares; stale results are ignored by the caller instead.
   * @param {string} url
   * @returns {Promise<string>}
   */
  #getResponseText(url) {
    const now = Date.now();
    const cached = this.#responseCache.get(url);
    if (cached && cached.expires > now) return cached.promise;

    const promise = fetch(url).then((response) => {
      if (!response.ok) throw new Error(`Variant request failed: ${response.status}`);
      return response.text();
    });

    promise.catch(() => {
      if (this.#responseCache.get(url)?.promise === promise) this.#responseCache.delete(url);
    });

    this.#responseCache.delete(url);
    this.#responseCache.set(url, { promise, expires: now + RESPONSE_CACHE_TTL });
    while (this.#responseCache.size > RESPONSE_CACHE_MAX) {
      const oldest = this.#responseCache.keys().next().value;
      if (oldest === undefined) break;
      this.#responseCache.delete(oldest);
    }

    return promise;
  }

  /**
   * Starts the request for an option the shopper is about to pick (hover or press), so the
   * selection renders without waiting on the network. For swatches, also warms the first
   * gallery images, since the finish usually changes the media.
   * @param {HTMLInputElement} input
   */
  #prefetchSelection(input) {
    const url = this.#getSelectionUrl(input);
    const cached = this.#responseCache.get(url);
    if (cached && cached.expires > Date.now()) return;

    const request = this.#getResponseText(url);
    if (!this.#isSwatchInput(input)) {
      request.catch(() => {});
      return;
    }

    request
      .then((text) => {
        const html = new DOMParser().parseFromString(text, 'text/html');
        for (const image of Array.from(html.querySelectorAll('media-gallery img')).slice(0, 2)) {
          if (!(image instanceof HTMLImageElement)) continue;
          const preload = new Image();
          if (image.sizes) preload.sizes = image.sizes;
          if (image.srcset) preload.srcset = image.srcset;
          preload.src = image.src;
        }
      })
      .catch(() => {});
  }

  /**
   * Handles the variant change event.
   * @param {Event} event - The variant change event.
   */
  variantChanged(event) {
    if (!(event.target instanceof HTMLElement)) return;

    const selectedOption =
      event.target instanceof HTMLSelectElement ? event.target.options[event.target.selectedIndex] : event.target;

    if (!selectedOption) return;

    this.updateSelectedOption(event.target);

    const isOnProductPage =
      this.dataset.templateProductMatch === 'true' &&
      !event.target.closest('product-card') &&
      !event.target.closest('quick-add-dialog');

    // Morph the entire main content for combined listings child products, because changing the product
    // might also change other sections depending on recommendations, metafields, etc.
    const currentUrl = this.dataset.productUrl?.split('?')[0];
    const newUrl = selectedOption.dataset.connectedProductUrl;
    const loadsNewProduct = isOnProductPage && !!newUrl && newUrl !== currentUrl;
    const isOnFeaturedProductSection = Boolean(this.closest('featured-product-information'));

    const morphElementSelector = loadsNewProduct
      ? 'main'
      : isOnFeaturedProductSection
      ? 'featured-product-information'
      : undefined;

    const { optionValueId = '', variantId = '', connectedProductUrl = '' } = selectedOption.dataset;
    this.fetchUpdatedSection(this.buildRequestUrl(selectedOption), {
      morphElementSelector,
      detail: { optionValueId, variantId, connectedProductUrl },
    });

    const url = new URL(window.location.href);

    if (isOnProductPage) {
      if (variantId) {
        url.searchParams.set('variant', variantId);
      } else {
        url.searchParams.delete('variant');
      }
    }

    // Change the path if the option is connected to another product via combined listing.
    if (loadsNewProduct) {
      url.pathname = newUrl;
    }

    if (url.href !== window.location.href) {
      yieldToMainThread().then(() => {
        history.replaceState({}, '', url.toString());
      });
    }
  }

  /**
   * @typedef {object} FieldsetMeasurements
   * @property {HTMLFieldSetElement} fieldset
   * @property {number | undefined} currentIndex
   * @property {number | undefined} previousIndex
   * @property {number | undefined} currentWidth
   * @property {number | undefined} previousWidth
   */

  /**
   * Gets measurements for a single fieldset (read phase).
   * @param {number} fieldsetIndex
   * @returns {FieldsetMeasurements | null}
   */
  #getFieldsetMeasurements(fieldsetIndex) {
    const fieldsets = /** @type {HTMLFieldSetElement[]} */ (this.refs.fieldsets || []);
    const fieldset = fieldsets[fieldsetIndex];
    const checkedIndices = this.#checkedIndices[fieldsetIndex];
    const radios = this.#radios[fieldsetIndex];

    if (!radios || !checkedIndices || !fieldset) return null;

    const [currentIndex, previousIndex] = checkedIndices;

    return {
      fieldset,
      currentIndex,
      previousIndex,
      currentWidth: currentIndex !== undefined ? radios[currentIndex]?.parentElement?.offsetWidth : undefined,
      previousWidth: previousIndex !== undefined ? radios[previousIndex]?.parentElement?.offsetWidth : undefined,
    };
  }

  /**
   * Applies measurements to a fieldset (write phase).
   * @param {FieldsetMeasurements} measurements
   */
  #applyFieldsetMeasurements({ fieldset, currentWidth, previousWidth, currentIndex, previousIndex }) {
    if (currentWidth) {
      fieldset.style.setProperty('--pill-width-current', `${currentWidth}px`);
    } else if (currentIndex !== undefined) {
      fieldset.style.removeProperty('--pill-width-current');
    }

    if (previousWidth) {
      fieldset.style.setProperty('--pill-width-previous', `${previousWidth}px`);
    } else if (previousIndex !== undefined) {
      fieldset.style.removeProperty('--pill-width-previous');
    }
  }

  /**
   * Updates the fieldset CSS.
   * @param {number} fieldsetIndex - The fieldset index.
   */
  updateFieldsetCss(fieldsetIndex) {
    if (Number.isNaN(fieldsetIndex)) return;

    const measurements = this.#getFieldsetMeasurements(fieldsetIndex);
    if (measurements) {
      this.#applyFieldsetMeasurements(measurements);
    }
  }

  /**
   * Updates the selected option.
   * @param {string | Element} target - The target element.
   */
  updateSelectedOption(target) {
    if (typeof target === 'string') {
      const targetElement = this.querySelector(`[data-option-value-id="${target}"]`);

      if (!targetElement) throw new Error('Target element not found');

      target = targetElement;
    }

    if (target instanceof HTMLInputElement) {
      const fieldsetIndex = Number.parseInt(target.dataset.fieldsetIndex || '');
      const inputIndex = Number.parseInt(target.dataset.inputIndex || '');

      if (!Number.isNaN(fieldsetIndex) && !Number.isNaN(inputIndex)) {
        const fieldsets = /** @type {HTMLFieldSetElement[]} */ (this.refs.fieldsets || []);
        const fieldset = fieldsets[fieldsetIndex];
        const checkedIndices = this.#checkedIndices[fieldsetIndex];
        const radios = this.#radios[fieldsetIndex];

        if (radios && checkedIndices && fieldset) {
          // Clear previous checked states
          const [currentIndex, previousIndex] = checkedIndices;

          if (currentIndex !== undefined && radios[currentIndex]) {
            radios[currentIndex].dataset.previousChecked = 'false';
          }
          if (previousIndex !== undefined && radios[previousIndex]) {
            radios[previousIndex].dataset.previousChecked = 'false';
          }

          // Update checked indices array - keep only the last 2 selections
          checkedIndices.unshift(inputIndex);
          checkedIndices.length = Math.min(checkedIndices.length, 2);

          // Update the new states
          const newCurrentIndex = checkedIndices[0]; // This is always inputIndex
          const newPreviousIndex = checkedIndices[1]; // This might be undefined

          // newCurrentIndex is guaranteed to exist since we just added it
          if (newCurrentIndex !== undefined && radios[newCurrentIndex]) {
            radios[newCurrentIndex].dataset.currentChecked = 'true';
          }

          if (newPreviousIndex !== undefined && radios[newPreviousIndex]) {
            radios[newPreviousIndex].dataset.previousChecked = 'true';
            radios[newPreviousIndex].dataset.currentChecked = 'false';
          }

          this.updateFieldsetCss(fieldsetIndex);
        }
      }
      target.checked = true;
    }

    if (target instanceof HTMLSelectElement) {
      const newValue = target.value;
      const newSelectedOption = Array.from(target.options).find((option) => option.value === newValue);

      if (!newSelectedOption) throw new Error('Option not found');

      for (const option of target.options) {
        option.removeAttribute('selected');
      }

      newSelectedOption.setAttribute('selected', 'selected');
    }
  }

  /**
   * Builds the request URL.
   * @param {HTMLElement} selectedOption - The selected option.
   * @param {string | null} [source] - The source.
   * @param {string[]} [sourceSelectedOptionsValues] - The source selected options values.
   * @returns {string} The request URL.
   */
  buildRequestUrl(selectedOption, source = null, sourceSelectedOptionsValues = []) {
    // this productUrl and pendingRequestUrl will be useful for the support of combined listing. It is used when a user changes variant quickly and those products are using separate URLs (combined listing).
    // We create a new URL and abort the previous fetch request if it's still pending.
    let productUrl = selectedOption.dataset.connectedProductUrl || this.#pendingRequestUrl || this.dataset.productUrl;
    this.#pendingRequestUrl = productUrl;
    const params = [];
    const viewParamValue = getViewParameterValue();

    // preserve view parameter, if it exists, for alternative product view testing
    if (viewParamValue) params.push(`view=${viewParamValue}`);

    if (this.selectedOptionsValues.length && !source) {
      params.push(`option_values=${this.selectedOptionsValues.join(',')}`);
    } else if (source === 'product-card') {
      if (this.selectedOptionsValues.length) {
        params.push(`option_values=${sourceSelectedOptionsValues.join(',')}`);
      } else {
        params.push(`option_values=${selectedOption.dataset.optionValueId}`);
      }
    }

    // If variant-picker is a child of some specific sections, we need to append section_id=xxxx to the URL
    const SECTION_ID_MAP = {
      'quick-add-component': 'section-rendering-product-card',
      'swatches-variant-picker-component': 'section-rendering-product-card',
      'featured-product-information': this.closest('featured-product-information')?.id,
    };

    const closestSectionId = /** @type {keyof typeof SECTION_ID_MAP} | undefined */ (
      Object.keys(SECTION_ID_MAP).find((sectionId) => this.closest(sectionId))
    );

    if (closestSectionId) {
      if (productUrl?.includes('?')) {
        productUrl = productUrl.split('?')[0];
      }
      return `${productUrl}?section_id=${SECTION_ID_MAP[closestSectionId]}&${params.join('&')}`;
    }

    // Keep in sync with #getSelectionUrl so prefetched responses match.
    const sectionId = this.#getSectionRenderingId(selectedOption);
    if (sectionId) params.push(`section_id=${encodeURIComponent(sectionId)}`);

    return `${productUrl}?${params.join('&')}`;
  }

  /**
   * Fetches the updated section.
   * @param {string} requestUrl - The request URL.
   * @param {object} [options] - Request options.
   * @param {string} [options.morphElementSelector] - The selector of the element to be morphed. By default, only the variant picker is morphed.
   * @param {{ optionValueId?: string, variantId?: string, connectedProductUrl?: string }} [options.detail] - Synchronous product select event detail.
   */
  fetchUpdatedSection(requestUrl, { morphElementSelector, detail = {} } = {}) {
    const { optionValueId = '', variantId, connectedProductUrl = '' } = detail;
    // We use this to abort the previous fetch request if it's still pending.
    this.#abortController?.abort();
    this.#abortController = new AbortController();

    const deferredEventPromise = ProductSelectEvent.createPromise();
    const selectedOptions = this.getAllSelectedOptions();

    this.dispatchEvent(
      new ProductSelectEvent({
        product: {
          id: this.dataset.productId ?? '',
          title: this.dataset.productTitle ?? '',
          handle: this.dataset.productHandle ?? '',
        },
        selectedOptions,
        detail: {
          optionValueId,
          variantId,
          connectedProductUrl,
        },
        promise: deferredEventPromise.promise,
      })
    );

    const { signal } = this.#abortController;
    // Reuses a prefetched, in-flight, or recently fetched response for this exact selection.
    // A newer selection supersedes this one: its result is discarded via the abort signal.
    const htmlPromise = this.#getResponseText(requestUrl).then((responseText) => {
      if (signal.aborted) throw signal.reason;
      return new DOMParser().parseFromString(responseText, 'text/html');
    });

    htmlPromise
      .then((html) => {
        this.#pendingRequestUrl = undefined;
        // Defer is only useful for the initial rendering of the page. Remove it here.
        html.querySelector('overflow-list[defer]')?.removeAttribute('defer');

        const variantPickerJsonScript = html.querySelector(`variant-picker script[type="application/json"]`);
        const textContent = variantPickerJsonScript?.textContent;

        if (!textContent) {
          deferredEventPromise.resolve({
            variant: null,
            detail: {
              html,
              productId: this.dataset.productId ?? '',
              sourceId: this.selectedOptionId,
              resource: null,
            },
          });
          return;
        }

        let newProduct;

        if (morphElementSelector === 'main') {
          this.updateMain(html);
        } else if (morphElementSelector) {
          this.updateElement(html, morphElementSelector);
        } else {
          const { overflowList } = this.refs;
          const wasSwatchesExpanded =
            overflowList instanceof OverflowList && overflowList.getAttribute('disabled') === 'true';

          newProduct = this.updateVariantPicker(html);

          if (wasSwatchesExpanded) {
            const overflowListAfterMorph = overflowList;
            if (overflowListAfterMorph instanceof OverflowList) {
              overflowListAfterMorph.showAll();
            }
          }
        }

        // Resolve the ProductSelectEvent promise with all data needed by listeners
        if (this.selectedOptionId) {
          const variantData = JSON.parse(textContent);

          if (variantData && typeof variantData === 'object') {
            const productViewAttr = variantPickerJsonScript
              ?.closest('[view-event-payload]')
              ?.getAttribute('view-event-payload')
              ?.trim();

            deferredEventPromise.resolve({
              variant: (productViewAttr && JSON.parse(productViewAttr))?.product?.selectedVariant ?? null,
              detail: {
                html,
                productId: this.dataset.productId ?? '',
                newProduct,
                sourceId: this.selectedOptionId,
                resource: variantData,
              },
            });

            return;
          }
        }

        // Variant data is null/invalid (e.g. unavailable variant combination) —
        // still include detail with html so listeners can update UI (disable buttons, morph text)
        deferredEventPromise.resolve({
          variant: null,
          detail: {
            html,
            productId: this.dataset.productId ?? '',
            newProduct,
            sourceId: this.selectedOptionId,
            resource: null,
          },
        });
      })
      .catch((error) => {
        deferredEventPromise.reject(error);
        if (error.name === 'AbortError') {
          console.warn('Fetch aborted by user');
        } else {
          console.error(error);
        }
      });
  }

  /**
   * @typedef {Object} NewProduct
   * @property {string} id
   * @property {string} url
   */

  /**
   * Re-renders the variant picker.
   * @param {Document | Element} newHtml - The new HTML.
   * @returns {NewProduct | undefined} Information about the new product if it has changed, otherwise undefined.
   */
  updateVariantPicker(newHtml) {
    /** @type {NewProduct | undefined} */
    let newProduct;

    const newVariantPickerSource = newHtml.querySelector(this.tagName.toLowerCase());

    if (!newVariantPickerSource) {
      throw new Error('No new variant picker source found');
    }

    // For combined listings, the product might have changed, so update the related data attribute.
    if (newVariantPickerSource instanceof HTMLElement) {
      const newProductId = newVariantPickerSource.dataset.productId;
      const newProductUrl = newVariantPickerSource.dataset.productUrl;

      if (newProductId && newProductUrl && this.dataset.productId !== newProductId) {
        newProduct = { id: newProductId, url: newProductUrl };
      }

      this.dataset.productId = newProductId;
      this.dataset.productUrl = newProductUrl;
    }

    morph(this, newVariantPickerSource, {
      ...MORPH_OPTIONS,
      getNodeKey: (node) => {
        if (!(node instanceof HTMLElement)) return undefined;
        const key = node.dataset.key;
        return key;
      },
    });
    this.updateVariantPickerCss();

    return newProduct;
  }

  updateVariantPickerCss() {
    const fieldsets = /** @type {HTMLFieldSetElement[]} */ (this.refs.fieldsets || []);

    // Batch all reads first across all fieldsets to avoid layout thrashing
    const measurements = fieldsets.map((_, index) => this.#getFieldsetMeasurements(index)).filter((m) => m !== null);

    // Batch all writes after all reads
    for (const measurement of measurements) {
      this.#applyFieldsetMeasurements(measurement);
    }
  }

  /**
   * Re-renders the desired element.
   * @param {Document} newHtml - The new HTML.
   * @param {string} elementSelector - The selector of the element to re-render.
   */
  updateElement(newHtml, elementSelector) {
    const element = this.closest(elementSelector);
    const newElement = newHtml.querySelector(elementSelector);

    if (!element || !newElement) {
      throw new Error(`No new element source found for ${elementSelector}`);
    }

    morph(element, newElement);
  }

  /**
   * Re-renders the entire main content.
   * @param {Document} newHtml - The new HTML.
   */
  updateMain(newHtml) {
    const main = document.querySelector('main');
    const newMain = newHtml.querySelector('main');

    if (!main || !newMain) {
      throw new Error('No new main source found');
    }

    morph(main, newMain);
  }

  /**
   * Gets the selected option.
   * @returns {HTMLInputElement | HTMLOptionElement | undefined} The selected option.
   */
  get selectedOption() {
    const selectedOption = this.querySelector('select option[selected], fieldset input:checked');

    if (!(selectedOption instanceof HTMLInputElement || selectedOption instanceof HTMLOptionElement)) {
      return undefined;
    }

    return selectedOption;
  }

  /**
   * Gets all the selected options.
   * @returns {{name: string, value: string}[]} All the currently selected options.
   */
  getAllSelectedOptions() {
    /** @type {{name: string, value: string}[]} */
    const options = [];

    // For <select> elements, use .selectedOptions to get the current selection
    // (the [selected] HTML attribute only reflects the initial state, not user changes)
    for (const select of this.querySelectorAll('select')) {
      const selected = select.selectedOptions[0];
      if (selected?.dataset?.optionName) {
        options.push({ name: selected.dataset.optionName, value: selected.value });
      }
    }

    // For radio/checkbox fieldsets, :checked reflects the current state
    /** @type {NodeListOf<HTMLInputElement>} */
    const checkedInputs = this.querySelectorAll('fieldset input:checked');
    for (const input of checkedInputs) {
      if (input.dataset?.optionName) {
        options.push({ name: input.dataset.optionName, value: input.value });
      }
    }

    return options;
  }

  /**
   * Gets the selected option ID.
   * @returns {string | undefined} The selected option ID.
   */
  get selectedOptionId() {
    const { selectedOption } = this;
    if (!selectedOption) return undefined;
    const { optionValueId } = selectedOption.dataset;

    if (!optionValueId) {
      throw new Error('No option value ID found');
    }

    return optionValueId;
  }

  /**
   * Gets the selected options values.
   * @returns {string[]} The selected options values.
   */
  get selectedOptionsValues() {
    /** @type HTMLElement[] */
    const selectedOptions = Array.from(this.querySelectorAll('select option[selected], fieldset input:checked'));

    return selectedOptions.map((option) => {
      const { optionValueId } = option.dataset;

      if (!optionValueId) throw new Error('No option value ID found');

      return optionValueId;
    });
  }
}

if (!customElements.get('variant-picker')) {
  customElements.define('variant-picker', VariantPicker);
}
