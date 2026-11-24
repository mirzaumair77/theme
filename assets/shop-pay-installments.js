import { Component } from '@theme/component';
import { StandardEvents } from '@shopify/events';

/**
 * Keeps the Shop Pay installments message in sync with the selected variant.
 * The buy buttons are not re-rendered on variant change, so this reads the matching
 * block from the section HTML the product select event delivers and copies its
 * message text and visibility. Liquid stays the source of truth for the amount,
 * money format and price-range eligibility. The "Learn more" trigger and dialog
 * are left untouched.
 *
 * @extends {Component}
 */
class ShopPayInstallmentsComponent extends Component {
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
   * @param {Event & { promise?: Promise<{ detail?: { html?: Document, productId?: string, newProduct?: { id: string } } }> }} event
   */
  #handleProductSelect = (event) => {
    if (!(event.target instanceof Element) || event.target.closest('product-card')) return;

    event.promise
      ?.then(({ detail }) => {
        if (!detail?.html) return;

        if (detail.newProduct) {
          this.dataset.productId = detail.newProduct.id;
        } else if (detail.productId && detail.productId !== this.dataset.productId) {
          return;
        }

        const next = detail.html.querySelector(
          `shop-pay-installments-component[data-block-id="${CSS.escape(this.dataset.blockId ?? '')}"]`
        );
        if (!next) return;

        const text = this.querySelector('[data-installments-text]');
        const nextText = next.querySelector('[data-installments-text]');
        if (text && nextText) text.innerHTML = nextText.innerHTML;

        this.hidden = next.hasAttribute('hidden');
      })
      .catch((error) => {
        if (error?.name !== 'AbortError') console.warn('[shop-pay-installments] Event promise rejected:', error);
      });
  };
}

if (!customElements.get('shop-pay-installments-component')) {
  customElements.define('shop-pay-installments-component', ShopPayInstallmentsComponent);
}
