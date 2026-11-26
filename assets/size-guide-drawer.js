import { Component } from '@theme/component';

/** Tab shown whenever the drawer opens. */
const DEFAULT_TAB = 'chart';

/**
 * Content of the ring size guide drawer (snippets/size-guide-drawer.liquid).
 *
 * - Tabs: ARIA tabs with arrow-key, Home and End navigation.
 * - Size finder: suggests the smallest chart size whose circumference fits the
 *   entered measurement ("between two sizes, go up").
 * - Size selection: the finder result and the chart rows select the size in the
 *   section's variant picker when the product has a size option.
 *
 * The chart rows rendered by Liquid are the single source of size data.
 *
 * @typedef {object} Refs
 * @property {HTMLButtonElement[]} tabs - Tab buttons.
 * @property {HTMLElement[]} panels - Tab panels.
 * @property {HTMLInputElement} [input] - Finger circumference input.
 * @property {HTMLElement} [error] - Finder validation message.
 * @property {HTMLElement} [result] - Finder result card.
 * @property {HTMLElement} [resultSize] - Suggested size heading.
 * @property {HTMLElement} [resultText] - Suggested size explanation.
 * @property {HTMLButtonElement} [selectButton] - Selects the suggested size.
 * @property {HTMLTableRowElement[]} [rows] - Size chart rows.
 * @property {HTMLElement} [chatRow] - Chat row shown when the Inbox chat exists.
 * @property {HTMLElement} [status] - Live region for size selection announcements.
 *
 * @extends {Component<Refs>}
 */
class SizeGuideDrawerComponent extends Component {
  requiredRefs = ['tabs', 'panels'];

  /** @type {AbortController | undefined} */
  #controller;

  /** Size suggested by the finder. */
  #suggestedSize = '';

  connectedCallback() {
    super.connectedCallback();

    this.#controller?.abort();
    this.#controller = new AbortController();

    this.#drawer?.addEventListener('dialog:open', this.#handleOpen, {
      signal: this.#controller.signal,
    });

    this.#revealChat();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#controller?.abort();
  }

  /** @returns {HTMLElement | null} The parent dialog-component. */
  get #drawer() {
    return this.closest('dialog-component');
  }

  /**
   * Closes the drawer.
   * @returns {Promise<void>} Settles once the close animation and scroll unlock finish.
   */
  async #close() {
    await /** @type {any} */ (this.#drawer)?.closeDialog?.();
  }

  /** Every open starts on the size chart, with the selected size highlighted. */
  #handleOpen = () => {
    this.showTab(DEFAULT_TAB);
    this.#syncSelectedSize();
  };

  /** @returns {{ size: string, circumference: number }[]} Chart sizes in chart order. */
  get #sizes() {
    return (this.refs.rows ?? [])
      .map((row) => ({ size: row.dataset.size ?? '', circumference: Number.parseFloat(row.dataset.circumference ?? '') }))
      .filter(({ size, circumference }) => size && Number.isFinite(circumference));
  }

  /**
   * Shows the tab named by the event target's `data-tab`.
   * @param {Event} event - Click on a tab or on a shortcut to a tab.
   */
  selectTab(event) {
    const target = /** @type {HTMLElement} */ (event.target);
    const name = target.dataset.tab;
    if (!name) return;

    this.showTab(name, { focus: !target.matches('[role="tab"]') });
  }

  /**
   * Moves between tabs with the arrow keys, Home and End.
   * @param {KeyboardEvent} event - Keydown on a tab.
   */
  handleTabKeydown(event) {
    const { tabs } = this.refs;
    const index = tabs.indexOf(/** @type {HTMLButtonElement} */ (event.target));
    if (index < 0) return;

    const isRtl = getComputedStyle(this).direction === 'rtl';
    const forward = isRtl ? 'ArrowLeft' : 'ArrowRight';
    const back = isRtl ? 'ArrowRight' : 'ArrowLeft';

    /** @type {number | undefined} */
    let next;
    if (event.key === forward) next = (index + 1) % tabs.length;
    else if (event.key === back) next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next === undefined) return;

    event.preventDefault();
    const name = tabs[next]?.dataset.tab;
    if (name) this.showTab(name, { focus: true });
  }

  /**
   * Shows a tab panel.
   * @param {string} name - Tab name: `finder`, `chart` or `tips`.
   * @param {{ focus?: boolean }} [options] - Move focus to the tab.
   */
  showTab(name, { focus = false } = {}) {
    const { tabs, panels } = this.refs;

    for (const tab of tabs) {
      const selected = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus();
    }

    for (const panel of panels) {
      panel.hidden = panel.dataset.tab !== name;
    }

    this.querySelector('.size-guide-drawer__body')?.scrollTo({ top: 0 });
  }

  /**
   * Suggests a size for the entered finger circumference.
   * @param {SubmitEvent} event - Finder form submit.
   */
  findSize(event) {
    event.preventDefault();

    const { input, error, result, resultSize, resultText, selectButton } = this.refs;
    const sizes = this.#sizes;
    if (!input || !error || !result || !resultSize || !resultText || !sizes.length) return;

    const value = Number.parseFloat(input.value);
    const first = sizes[0];
    const last = sizes[sizes.length - 1];
    if (!first || !last) return;

    // Below the smallest size, allow up to one size step before treating it as out of range.
    const step = sizes[1] ? sizes[1].circumference - first.circumference : 0;
    const match =
      Number.isFinite(value) && value >= first.circumference - step
        ? sizes.find(({ circumference }) => circumference >= value)
        : undefined;

    if (!match) {
      error.textContent = this.#format('rangeTemplate', { min: first.circumference, max: last.circumference });
      error.hidden = false;
      input.setAttribute('aria-invalid', 'true');
      result.hidden = true;
      input.focus();
      return;
    }

    error.hidden = true;
    error.textContent = '';
    input.removeAttribute('aria-invalid');

    const label = this.#sizeLabel(match.size);
    const note = this.dataset.resultNote ?? '';
    this.#suggestedSize = match.size;

    resultSize.textContent = label;
    resultText.textContent = [this.#format('matchTemplate', { circumference: value, size: label }), note]
      .filter(Boolean)
      .join(' ');

    if (selectButton) {
      const available = Boolean(this.#findPickerControl(match.size));
      selectButton.hidden = !available;
      selectButton.textContent = this.#format('selectTemplate', { size: match.size });
    }

    result.hidden = false;
  }

  /** Selects the finder's suggested size and closes the drawer. */
  selectResult() {
    if (!this.#suggestedSize || !this.#selectInPicker(this.#suggestedSize)) return;

    this.#highlightRow(this.#suggestedSize);
    this.#close();
  }

  /**
   * Selects the size of a chart row.
   * @param {MouseEvent} event - Click on a chart row.
   */
  selectRow(event) {
    const row = /** @type {HTMLElement} */ (event.target).closest('tr');
    const size = row?.dataset.size;
    if (!size || !this.#selectInPicker(size)) return;

    this.#highlightRow(size);
    if (this.refs.status) {
      this.refs.status.textContent = this.#format('selectedTemplate', { size: this.#sizeLabel(size) });
    }
  }

  /**
   * Opens the Shopify Inbox chat (snippets/chat-drawer.liquid) after this drawer closes,
   * so the modal's scroll lock and focus return don't fight the chat.
   */
  async startChat() {
    const chat = /** @type {any} */ (document.querySelector('shopify-chat'));
    if (!chat || !customElements.get('shopify-chat')) return;

    try {
      await this.#close();
    } catch {
      // Open the chat even if the close animation fails.
    }

    // show() follows the chat's own launcher path (docked drawer or floating panel).
    if (typeof chat.show === 'function') chat.show();
    else chat.setAttribute('open', '');
  }

  /** Highlights the chart row of the size currently selected in the picker. */
  #syncSelectedSize = () => {
    const name = this.dataset.optionName;
    if (!name) return;

    const selected = this.#pickerControls(name).find((control) =>
      control instanceof HTMLInputElement ? control.checked : control.selected
    );
    if (selected) this.#highlightRow(selected.value);
  };

  /** Shows the chat row without a link when the Inbox chat element is defined. */
  #revealChat() {
    const { chatRow } = this.refs;
    if (!chatRow || !document.querySelector('shopify-chat')) return;

    customElements
      .whenDefined('shopify-chat')
      .then(() => {
        if (this.refs.chatRow) this.refs.chatRow.hidden = false;
      })
      .catch(() => {});
  }

  /**
   * @param {string} size - Size value.
   */
  #highlightRow(size) {
    for (const row of this.refs.rows ?? []) {
      const selected = row.dataset.size === size;
      row.classList.toggle('size-guide-drawer__row--selected', selected);
      row.querySelector('button')?.setAttribute('aria-pressed', String(selected));
    }
  }

  /**
   * @param {string} name - Option name.
   * @returns {(HTMLInputElement | HTMLOptionElement)[]} Picker controls for the option.
   */
  #pickerControls(name) {
    const scope = this.closest('.shopify-section') ?? document;
    const picker = scope.querySelector('variant-picker');
    if (!picker) return [];

    return /** @type {(HTMLInputElement | HTMLOptionElement)[]} */ (
      Array.from(picker.querySelectorAll('input[data-option-name], option[data-option-name]'))
    ).filter((control) => control.dataset.optionName === name);
  }

  /**
   * @param {string} size - Size value.
   * @returns {HTMLInputElement | HTMLOptionElement | undefined} Picker control for the size.
   */
  #findPickerControl(size) {
    const name = this.dataset.optionName;
    if (!name) return undefined;

    return this.#pickerControls(name).find((control) => control.value === size);
  }

  /**
   * Selects a size in the variant picker, which then updates the variant as usual.
   * @param {string} size - Size value.
   * @returns {boolean} Whether the size exists in the picker.
   */
  #selectInPicker(size) {
    const control = this.#findPickerControl(size);
    if (!control) return false;

    if (control instanceof HTMLInputElement) {
      if (!control.checked) control.click();
      return true;
    }

    const select = control.closest('select');
    if (select && select.value !== control.value) {
      select.value = control.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  }

  /**
   * @param {string} size - Size value.
   * @returns {string} Size with the merchant's size system prefix, e.g. "US 7".
   */
  #sizeLabel(size) {
    const prefix = this.dataset.sizePrefix?.trim();
    return prefix ? `${prefix} ${size}` : size;
  }

  /**
   * Fills a translated template rendered by Liquid with `[key]` placeholders.
   * @param {string} key - Dataset key of the template.
   * @param {Record<string, string | number>} values - Placeholder values.
   * @returns {string} The filled text.
   */
  #format(key, values) {
    let text = this.dataset[key] ?? '';
    for (const [name, value] of Object.entries(values)) {
      text = text.replaceAll(`[${name}]`, String(value));
    }
    return text;
  }
}

if (!customElements.get('size-guide-drawer-component')) {
  customElements.define('size-guide-drawer-component', SizeGuideDrawerComponent);
}
