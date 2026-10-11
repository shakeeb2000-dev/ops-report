/* A very small DOM + IndexedDB stand-in, just enough to actually boot the app
   in Node and catch runtime errors before they reach a phone.

   Supports the subset the app really uses: id / class / tag / [attr="v"]
   selectors, innerHTML assignment, dataset, classList, delegated events via
   closest(), and an in-memory IndexedDB.
*/

const VOID_TAGS = new Set(['input', 'br', 'hr', 'img', 'meta', 'link', 'source']);

function parseAttrs(raw) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(raw))) {
    attrs[m[1].toLowerCase()] = m[2] !== undefined ? m[2]
      : m[3] !== undefined ? m[3]
      : m[4] !== undefined ? m[4] : '';
  }
  return attrs;
}

/* Returns an array of top-level Elements. Text is kept only as .text. */
function parseHTML(html, doc) {
  const root = { children: [], tag: '#root' };
  const stack = [root];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let last = 0;
  let m;

  while ((m = tagRe.exec(html))) {
    const text = html.slice(last, m.index).trim();
    if (text) {
      const parent = stack[stack.length - 1];
      parent.text = (parent.text || '') + text;
    }
    last = tagRe.lastIndex;

    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const selfClose = m[4] === '/' || VOID_TAGS.has(tag);

    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
      continue;
    }

    const el = new Element(tag, parseAttrs(m[3]), doc);
    stack[stack.length - 1].children.push(el);
    el.parentNode = stack[stack.length - 1];
    if (!selfClose) stack.push(el);
  }
  const tail = html.slice(last).trim();
  if (tail) {
    const parent = stack[stack.length - 1];
    parent.text = (parent.text || '') + tail;
  }
  return root.children;
}

class ClassList {
  constructor(el) { this.el = el; }
  get _list() { return (this.el.attrs.class || '').split(/\s+/).filter(Boolean); }
  _write(list) { this.el.attrs.class = list.join(' '); }
  add(...names) {
    const l = this._list;
    names.forEach(n => { if (!l.includes(n)) l.push(n); });
    this._write(l);
  }
  remove(...names) { this._write(this._list.filter(c => !names.includes(c))); }
  contains(n) { return this._list.includes(n); }
  toggle(n) { this.contains(n) ? this.remove(n) : this.add(n); }
}

class Element {
  constructor(tag, attrs, doc) {
    this.tag = tag;
    this.attrs = attrs || {};
    this.children = [];
    this.text = '';
    this.doc = doc;
    this.listeners = {};
    this.style = { cssText: '', setProperty() {} };
    this.parentNode = null;
    this._classList = new ClassList(this);
  }

  get tagName() { return this.tag.toUpperCase(); }
  get classList() { return this._classList; }
  get className() { return this.attrs.class || ''; }
  set className(v) { this.attrs.class = v; }
  get id() { return this.attrs.id || ''; }

  get hidden() { return this.attrs.hidden !== undefined; }
  set hidden(v) {
    if (v) this.attrs.hidden = '';
    else delete this.attrs.hidden;
  }

  get value() { return this.attrs.value !== undefined ? this.attrs.value : ''; }
  set value(v) { this.attrs.value = v; }

  get textContent() { return this.text; }
  set textContent(v) { this.text = String(v); this.children = []; }

  get dataset() {
    const out = {};
    Object.keys(this.attrs).forEach(k => {
      if (k.startsWith('data-')) {
        const name = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        out[name] = this.attrs[k];
      }
    });
    return out;
  }

  getAttribute(n) {
    const v = this.attrs[n.toLowerCase()];
    return v !== undefined ? v : null;
  }
  setAttribute(n, v) { this.attrs[n.toLowerCase()] = String(v); }
  removeAttribute(n) { delete this.attrs[n.toLowerCase()]; }
  hasAttribute(n) { return this.attrs[n.toLowerCase()] !== undefined; }

  get innerHTML() { return this._html || ''; }
  set innerHTML(html) {
    this._html = String(html);
    this.children = parseHTML(this._html, this.doc);
    this.children.forEach(c => { c.parentNode = this; });
  }

  get files() { return this._files || []; }

  appendChild(el) { el.parentNode = this; this.children.push(el); return el; }
  prepend(el) { el.parentNode = this; this.children.unshift(el); return el; }
  remove() {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter(c => c !== this);
    }
  }
  select() {}
  focus() {}
  click() { this.dispatch('click'); }
  scrollIntoView() {}

  descendants() {
    const out = [];
    const walk = (node) => node.children.forEach(c => { out.push(c); walk(c); });
    walk(this);
    return out;
  }

  matches(sel) {
    return String(sel).split(',').map(s => s.trim()).some(p => matchSimple(this, p));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) { return this.descendants().filter(el => el.matches(sel)); }
  closest(sel) {
    let node = this;
    while (node) {
      if (node.matches && node.matches(sel)) return node;
      node = node.parentNode;
    }
    return null;
  }

  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn);
  }
  /* Bubbles up the tree so delegated handlers using closest() fire. */
  dispatch(type, extra = {}) {
    const event = Object.assign(
      { type, target: this, preventDefault() {}, stopPropagation() {} }, extra);
    let node = this;
    while (node) {
      (node.listeners[type] || []).slice().forEach(fn => fn.call(node, event));
      node = node.parentNode;
    }
    return event;
  }
}

function matchSimple(el, part) {
  const m = String(part).match(/^([a-zA-Z][a-zA-Z0-9-]*)?((?:[#.][-\w]+|\[[^\]]+\])*)$/);
  if (!m) return false;
  if (m[1] && el.tag !== m[1].toLowerCase()) return false;
  const tokens = (m[2] || '').match(/[#.][-\w]+|\[[^\]]+\]/g) || [];
  if (!m[1] && !tokens.length) return false;
  return tokens.every(tok => {
    if (tok[0] === '#') return el.id === tok.slice(1);
    if (tok[0] === '.') return el.classList.contains(tok.slice(1));
    const inner = tok.slice(1, -1);
    const eq = inner.match(/^([^=\]]+)=["']?([^"'\]]*)["']?$/);
    if (eq) return el.getAttribute(eq[1]) === eq[2];
    return el.hasAttribute(inner);
  });
}

function createDocument(html) {
  const doc = {};
  const root = new Element('html', {}, doc);
  parseHTML(html, doc).forEach(c => root.appendChild(c));
  const bodyEl = root.querySelector('body') || root;

  doc.documentElement = root;
  doc.body = bodyEl;
  doc.head = root.querySelector('head') || root;
  doc.querySelector = (s) => (root.matches(s) ? root : root.querySelector(s));
  doc.querySelectorAll = (s) => root.querySelectorAll(s);
  doc.getElementById = (id) => root.querySelector('#' + id);
  doc.createElement = (tag) => new Element(tag, {}, doc);
  doc.addEventListener = (t, fn) => root.addEventListener(t, fn);
  doc.execCommand = () => true;
  doc.__root = root;
  return doc;
}

function createIndexedDB(seed) {
  const stores = { reports: new Map() };
  if (seed) seed.forEach(rec => stores.reports.set(rec.id, rec));

  return {
    __stores: stores,
    open() {
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null };
      setTimeout(() => {
        const db = {
          objectStoreNames: { contains: (n) => n in stores },
          createObjectStore(name) { stores[name] = stores[name] || new Map(); return {}; },
          transaction(name) {
            const tx = { oncomplete: null, onerror: null };
            const store = {
              put(rec) { stores[name].set(rec.id, JSON.parse(JSON.stringify(rec))); return { result: rec.id }; },
              get(id) {
                const hit = stores[name].get(id);
                return { result: hit ? JSON.parse(JSON.stringify(hit)) : undefined };
              },
              delete(id) { stores[name].delete(id); return {}; },
              getAll() {
                return { result: Array.from(stores[name].values()).map(r => JSON.parse(JSON.stringify(r))) };
              }
            };
            tx.objectStore = () => store;
            setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 0);
            return tx;
          }
        };
        req.result = db;
        if (req.onsuccess) req.onsuccess();
      }, 0);
      return req;
    }
  };
}

module.exports = { createDocument, createIndexedDB, Element, parseHTML };
