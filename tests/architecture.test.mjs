import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {dirname, extname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSheet, createItemSheet, COLLECTIONS, ITEM_TYPE_IDS} from '../model.js';
import {openModal} from '../ui.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const excluded = new Set(['tests', 'scripts', 'dist', 'node_modules', '.git', '.venv', '__pycache__']);
function files(directory, extensions, skip = () => false) {
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    if (entry.name.startsWith('.') || excluded.has(entry.name) || skip(entry)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path, extensions, skip);
    return entry.isFile() && extensions.has(extname(entry.name)) ? [path] : [];
  });
}
const runtime = files(root, new Set(['.js', '.html', '.css', '.svg']));
const read = path => readFileSync(path, 'utf8');

test('package markup and controls use native modals without browser dialogs', () => {
  const forbidden = [
    /<\s*\/?\s*dialog\b/i,
    /\bcreateElement\s*\(\s*['"`]dialog['"`]/,
    /\b(?:el|element)\s*\(\s*\w+\s*,\s*['"`]dialog['"`]/,
    /\b(?:HTMLDialogElement|showModal)\b/,
    /(?<![\w$.])(?:alert|confirm|prompt)\s*\(/,
    /\b(?:window|globalThis|self)\s*(?:\.\s*|\[\s*['"])(?:alert|confirm|prompt)\b/,
  ];
  for (const path of runtime) for (const pattern of forbidden) {
    assert.doesNotMatch(read(path), pattern, `${relative(root, path)} must use api.ui.openModal`);
  }
});

test('runtime imports resolve inside this package and use no host implementation files', () => {
  for (const path of runtime.filter(path => path.endsWith('.js'))) {
    const imports = [...read(path).matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)].map(match => match[1]);
    for (const imported of imports) {
      assert.match(imported, /^\.\.?\//, `${relative(root, path)} has an external dependency`);
      const target = resolve(dirname(path), imported), inside = relative(root, target);
      assert.ok(inside && inside !== '..' && !inside.startsWith(`..${sep}`) && !inside.startsWith(sep), `${imported} escapes the package`);
      assert.ok(existsSync(target), `${imported} is missing`);
      assert.ok(!inside.split(sep).some(part => excluded.has(part)), `${imported} depends on development files`);
    }
  }
});

test('runtime uses the public SDK rather than hardcoded host transport or asset URLs', () => {
  for (const path of runtime.filter(path => path.endsWith('.js'))) {
    assert.doesNotMatch(read(path), /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/, `${relative(root, path)} bypasses the host SDK`);
    assert.doesNotMatch(read(path), /['"`]\/+(?:api|static)\//, `${relative(root, path)} hardcodes a host implementation path`);
  }
});

test('manifest and default structures provide empty sheets and templates only', () => {
  const manifest = JSON.parse(read(join(root, 'manifest.json')));
  assert.equal(manifest.id, 'gravewright.savage-worlds');
  assert.equal(Object.hasOwn(manifest, 'content'), false);
  assert.equal(Object.hasOwn(manifest, 'django'), false);
  assert.deepEqual(manifest.system.combat, {formula:'0',manualInput:'number',showRoll:false,requiresProvider:true});
  assert.deepEqual(manifest.system.itemTypes.map(type => type.id).sort(), [...ITEM_TYPE_IDS].sort());
  for (const collection of COLLECTIONS) assert.deepEqual(createSheet()[collection], []);
  for (const type of ITEM_TYPE_IDS) assert.equal(createItemSheet(type).description, '');
  for (const directory of ['content', 'compendiums', 'catalogs', 'rules']) assert.equal(existsSync(join(root, directory)), false);
});

class Element {
  constructor(tag) { this.localName = tag; this.children = []; this.dataset = {}; this.listeners = new Map(); this.isConnected = false; }
  setAttribute(name, value) { (this.attributes ??= {})[name] = value; }
  append(...children) { this.children.push(...children); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  removeEventListener(name, callback) { if (this.listeners.get(name) === callback) this.listeners.delete(name); }
  closest() { return null; }
  querySelectorAll() { return this.controls ?? []; }
}

test('modal helper delegates a section to the SDK, restores focus and closes on abort', async () => {
  for (const abort of [false, true]) {
    let focused = 0, initialFocus = 0, opened, forced;
    const created = [];
    const doc = {activeElement: {isConnected: true, closest() { return null; }, focus() { focused++; }}, createElement(tag) {
      created.push(tag); return new Element(tag);
    }};
    const controller = new AbortController();
    const api = {ui: {openModal(element, options) {
      opened = {element, options};
      element.isConnected = true;
      element.close = force => { forced = force; element.isConnected = false; element.listeners.get('close')?.(); };
      return element;
    }}};
    const modal = openModal(api, doc, 'Custom title', controller.signal, 'Close');
    assert.equal(modal, opened.element);
    assert.equal(modal.localName, 'section');
    assert.deepEqual(opened.options, {nested: true});
    assert.equal(modal.attributes['aria-label'], 'Custom title');
    assert.equal(created.includes('dialog'), false);
    modal.controls = [{disabled: false, getClientRects() { return [{}]; }, focus() { initialFocus++; }}];
    await Promise.resolve();
    assert.equal(initialFocus, 1);
    if (abort) controller.abort();
    else modal.children[0].children[1].onclick();
    await Promise.resolve();
    assert.equal(forced, abort ? true : undefined);
    assert.equal(focused, 1);
  }
});

function hostRoot() {
  const isHost = path => existsSync(join(path, 'gravewright/modules/static/gravewright_modules/modal-api.js')) && existsSync(join(path, 'config/settings.py'));
  if (process.env.GRAVEWRIGHT_TEST_HOST_ROOT) {
    const path = resolve(process.env.GRAVEWRIGHT_TEST_HOST_ROOT);
    assert.ok(isHost(path), 'GRAVEWRIGHT_TEST_HOST_ROOT must point to a Gravewright source checkout');
    return path;
  }
  for (let path = dirname(root); path !== dirname(path); path = dirname(path)) if (isHost(path)) return path;
  return null;
}
const host = hostRoot();
test('host runtime contains no hardcoded Savage Worlds system identity or data model', {
  skip: !host && 'Set GRAVEWRIGHT_TEST_HOST_ROOT to audit a standalone package against a host checkout',
}, () => {
  const extensions = new Set(['.py', '.js', '.css', '.html', '.json']);
  const skip = entry => entry.name === 'fixtures' || /^test(?:_|\.|-)/.test(entry.name) || /^test.*\.(?:py|js|mjs)$/.test(entry.name);
  for (const directory of ['gravewright', 'config', 'api', 'scripts']) for (const path of files(join(host, directory), extensions, skip)) {
    assert.doesNotMatch(read(path), /gravewright\.savage-worlds|savageWorlds|\bSWADE\b|Savage\s+Worlds/i,
      `${relative(host, path)} must remain independent of installed systems`);
  }
});
