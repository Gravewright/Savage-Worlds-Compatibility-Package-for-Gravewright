// Native actor and item names share this public document constraint.
export const DOCUMENT_NAME_MAX = 120;

const translations = new WeakMap();
const nameOrders = new WeakMap();

/** Reorder visible rows/options in place, retaining authored data and focus. */
export function bindNameOrder(container, getLocale) {
  const refresh = () => {
    const children = [...container.children], named = children.filter(node => node.hasAttribute('data-gws-sort-name'));
    const collator = new Intl.Collator(getLocale?.() || 'en', {usage: 'sort', sensitivity: 'base', numeric: true});
    named.sort((left, right) => collator.compare(left.dataset.gwsSortName, right.dataset.gwsSortName));
    let index = 0;
    const ordered = children.map(node => node.hasAttribute('data-gws-sort-name') ? named[index++] : node);
    if (ordered.every((node, position) => node === children[position])) return;
    const value = container.value, focused = container.ownerDocument.activeElement;
    container.append(...ordered);
    if (value !== undefined) container.value = value;
    if (container.contains(focused)) focused.focus({preventScroll: true});
  };
  nameOrders.set(container, refresh); refresh(); return container;
}

/** Bind only package-authored labels; document names and player text stay intact. */
export function bindTranslation(node, property, getText) {
  if (typeof getText !== 'function') {
    translations.get(node)?.delete(property);
    if (property === 'textContent') node.textContent = getText;
    else if (property === 'value') node.value = getText;
    else node.setAttribute(property, getText);
    return node;
  }
  let bindings = translations.get(node);
  if (!bindings) {bindings = new Map(); translations.set(node, bindings);}
  const binding = bindings.get(property) || {};
  binding.getText = getText;
  bindings.set(property, binding);
  const value = getText();
  if (property === 'textContent') {
    if (binding.textNode?.parentNode === node) binding.textNode.nodeValue = value;
    else {node.textContent = value; binding.textNode = node.firstChild;}
  }
  else if (property === 'value') node.value = value;
  else node.setAttribute(property, value);
  return node;
}

/** Refresh existing controls without changing values, focus, or pending actions. */
export function refreshTranslations(root) {
  const nodes = [root, ...root.querySelectorAll('*')];
  for (const node of nodes) {
    for (const [property, binding] of translations.get(node) || []) {
      // A later explicit write supersedes a status or result label.
      if (property === 'textContent' && binding.textNode && binding.textNode.parentNode !== node) {translations.get(node).delete(property); continue;}
      bindTranslation(node, property, binding.getText);
    }
  }
  // Named choices must compare their refreshed labels when the language changes.
  for (const node of nodes) nameOrders.get(node)?.();
}

export function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) bindTranslation(node, 'textContent', text);
  return node;
}

export function get(data, path) { return path.split('.').reduce((value, key) => value?.[key], data); }
export function set(data, path, value) {
  const parts = path.split('.');
  if (parts.some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) throw new TypeError('Invalid field');
  let target = data;
  for (const key of parts.slice(0, -1)) target = target[key] ??= {};
  target[parts.at(-1)] = value;
}

const PATHS = {
  image: ['M4 4h16v16H4z', 'm4 16 5-5 4 4 3-3 4 4', 'M8 8h.01'],
  dice: ['m12 2 9 5v10l-9 5-9-5V7z', 'm3 7 9 2 9-2-5 10H8L3 7', 'm12 2-4 15 4 5 4-5-4-15', 'm3 17 9-8 9 8'],
  d4: ['M12 2 22 22H2Z'],
  d6: ['M2 2H22V22H2Z'],
  d8: ['M7.858 2H16.142L22 7.858V16.142L16.142 22H7.858L2 16.142V7.858Z'],
  d10: ['M12 2 17.878 3.910 21.511 8.910 21.511 15.090 17.878 20.090 12 22 6.122 20.090 2.489 15.090 2.489 8.910 6.122 3.910Z'],
  d12: ['M9.321 2H14.679L19.321 4.679 22 9.321V14.679L19.321 19.321 14.679 22H9.321L4.679 19.321 2 14.679V9.321L4.679 4.679Z'],
  coins: ['M4 5c0-3 12-3 12 0s-12 3-12 0', 'M4 5v5c0 3 12 3 12 0V5', 'M4 10v5c0 3 12 3 12 0', 'M8 16v4c0 3 12 3 12 0v-9'],
  wound: ['m5 9 4-4a3 3 0 0 1 4 0l6 6a3 3 0 0 1 0 4l-4 4a3 3 0 0 1-4 0l-6-6a3 3 0 0 1 0-4Z', 'm9 9 6 6', 'M9 13h.01M13 9h.01'],
  battery: ['M3 6h16v12H3z', 'M19 10h3v4h-3', 'M7 12h8'],
  shield: ['M12 2 3 6v6c0 6 9 10 9 10s9-4 9-10V6z', 'M12 6v12'],
  heart: ['M12 21 3 12C-2 3 8-1 12 7c4-8 14-4 9 5Z'],
  boot: ['M3 3h8v8l3 3 5 1a3 3 0 0 1 2 3v3H3Z', 'M3 7h8M3 18h18M11 11l-3 2M14 14l-3 2'],
  sword: ['m17 2 5 0 0 5-12 12-5-5z', 'm3 14 7 7', 'm2 22 5-5'],
  bag: ['M5 7h14v15H5z', 'M8 7V3h8v4', 'M5 12h14'],
  star: ['m12 2 3 6 7 1-5 5 1 8-6-4-6 4 1-8-5-5 7-1Z'],
  book: ['M12 5C8 2 3 3 2 4v16c4-2 7-2 10 0 3-2 6-2 10 0V4c-1-1-6-2-10 1Z', 'M12 5v15'],
  edit: ['m16 3 5 5-12 12-6 1 1-6Z', 'm14 5 5 5'],
  trash: ['M3 6h18M9 6V3h6v3M5 6l1 16h12l1-16M10 10v8M14 10v8'],
};
export function icon(doc, name) {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.classList.add('gws-icon');
  for (const d of PATHS[name] || PATHS.star) { const path = doc.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', d); svg.append(path); }
  return svg;
}

let modalSequence = 0;
export function openModal(api, doc, title, signal, closeLabel) {
  const section = el(doc, 'section', 'gws-modal'); section.setAttribute('translate', 'no');
  bindTranslation(section, 'aria-label', title); section.dataset.movable = '';
  const header = el(doc, 'header', 'gws-modal-title'); header.dataset.moveHandle = '';
  const heading = el(doc, 'h2', '', title), close = el(doc, 'button', 'gws-button gws-modal-close', '×');
  heading.id = `gws-modal-heading-${++modalSequence}`; section.setAttribute('aria-labelledby', heading.id);
  close.type = 'button'; bindTranslation(close, 'aria-label', closeLabel); close.onclick = () => section.close();
  header.append(heading, close); section.append(header);
  const opener = doc.activeElement, abort = () => section.close(true);
  let selection;
  try {
    if (typeof opener?.selectionStart === 'number') selection = {start: opener.selectionStart, end: opener.selectionEnd, direction: opener.selectionDirection, value: opener.value};
  } catch { /* Number and file inputs do not expose a text selection. */ }
  signal?.addEventListener('abort', abort, {once: true});
  section.addEventListener('close', () => {
    signal?.removeEventListener('abort', abort);
    queueMicrotask(() => {
      if (!opener?.isConnected || opener.closest('[inert]') || opener.disabled) return;
      opener.focus({preventScroll: true});
      if (selection && opener.value === selection.value) opener.setSelectionRange?.(selection.start, selection.end, selection.direction);
    });
  }, {once: true});
  const mounted = api.ui.openModal(section, {nested: true});
  // Preserve native Escape, coalescing, flush rejection and forced-close behavior.
  const nativeClose = section.close.bind(section);
  section.close = force => {
    const result = nativeClose(force);
    if (force !== true && result?.then) {
      close.setAttribute('aria-busy', 'true');
      const finished = () => close.removeAttribute?.('aria-busy');
      void Promise.resolve(result).then(finished, finished);
    }
    return result;
  };
  queueMicrotask(() => {
    if (!section.isConnected || section.closest('[inert]')) return;
    // Callers may already have focused Cancel or a specific field after adding
    // the modal body; the default must not move focus away from that control.
    if (doc.activeElement !== close && section.contains?.(doc.activeElement)) return;
    const controls = [...section.querySelectorAll('[data-gws-autofocus]'), ...section.querySelectorAll('input,textarea,select')];
    controls.find(control => !control.disabled && control.getClientRects().length)?.focus();
  });
  return mounted;
}
