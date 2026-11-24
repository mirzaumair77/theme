import { Component } from '@theme/component';
import { StandardEvents } from '@shopify/events';

/**
 * Shows the selected variant's title (for example the finish) under the product title and
 * keeps it in sync when the shopper changes options. Mirrors product-sku.js.
 *
 * @typedef {object} VariantTitleRefs
 * @property {HTMLElement} title - The element holding the variant title text.
 *
 * @extends {Component<VariantTitleRefs>}
 */
class VariantTitleComponent extends Component {
  requiredRefs = ['title'];

  /** @type {AbortController | undefined} */
  #controller;

  connectedCallback() {
    super.connectedCallback();

    this.#controller?.abort();
    this.#controller = new AbortController();

    const target = this.closest('.shopify-section, dialog');
    target?.addEventListener(StandardEvents.productSelect, this.#handleProductSelect, {
      signal: this.#controller.signal,
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#controller?.abort();
  }

  /**
   * @param {Event & { promise?: Promise<{ detail?: { productId?: string, newProduct?: { id: string }, resource?: { title?: string, options?: string[] } | null } }> }} event
   */
  #handleProductSelect = (event) => {
    if (!(event.target instanceof Element) || event.target.closest('product-card')) return;

    event.promise
      ?.then(({ detail }) => {
        if (!detail) return;

        if (detail.newProduct) {
          this.dataset.productId = detail.newProduct.id;
        } else if (detail.productId && detail.productId !== this.dataset.productId) {
          return;
        }

        if (!detail.resource) return;

        // With a Color option, show just its value (the finish); otherwise the full variant title.
        const { optionIndex } = this.dataset;
        const optionValue = optionIndex ? detail.resource.options?.[Number(optionIndex)] : undefined;
        const fullTitle = detail.resource.title && detail.resource.title !== 'Default Title' ? detail.resource.title : '';
        const title = optionValue || fullTitle;
        this.refs.title.textContent = title;
        this.style.display = title ? 'block' : 'none';
      })
      .catch((error) => {
        if (error?.name !== 'AbortError') console.warn('[variant-title] Event promise rejected:', error);
      });
  };
}

if (!customElements.get('variant-title-component')) {
  customElements.define('variant-title-component', VariantTitleComponent);
}
