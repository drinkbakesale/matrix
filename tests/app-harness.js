'use strict';
// Minimal DOM stand-in for driving the delivered render code (server/public/*.js) in a VM.
// It implements only the element API that code uses, plus helpers so tests can assert on
// what a user would actually see rather than on implementation details.
//
// It is NOT a browser: it has no layout, no Selection and no clipboard, so it cannot stand
// in for the WebKit acceptance tests under tests/acceptance/.

function matchesClass(node, selector) {
  return String(selector).split(',').some(part => {
    const cls = part.trim().replace(/^\./, '');
    return cls && String(node.className).split(/\s+/).includes(cls);
  });
}

function createNode(tag) {
  const listeners = {};
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    style: {},
    dataset: {},
    children: [],
    parent: null,
    ownText: '',
    hidden: false,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    listeners,
    get textContent() {
      return node.children.length ? node.children.map(c => c.textContent).join('') : node.ownText;
    },
    set textContent(value) {
      node.ownText = String(value);
      node.children = [];
    },
    get isConnected() {
      return node.parent !== null;
    },
    appendChild(child) {
      child.parent = node;
      node.children.push(child);
      return child;
    },
    append(...kids) {
      for (const kid of kids) node.appendChild(kid);
    },
    // A document fragment contributes its children, matching real replaceChildren semantics.
    replaceChildren(...kids) {
      for (const old of node.children) old.parent = null;
      node.children = [];
      node.ownText = '';
      for (const kid of kids) {
        if (!kid) continue;
        if (kid.isFragment) for (const grand of kid.children) node.appendChild(grand);
        else node.appendChild(kid);
      }
    },
    remove() {
      if (!node.parent) return;
      const siblings = node.parent.children;
      const at = siblings.indexOf(node);
      if (at >= 0) siblings.splice(at, 1);
      node.parent = null;
    },
    contains(other) {
      for (let cur = other; cur; cur = cur.parent) if (cur === node) return true;
      return false;
    },
    querySelector(selector) {
      return walk(node).find(n => matchesClass(n, selector)) || null;
    },
    querySelectorAll(selector) {
      return walk(node).filter(n => matchesClass(n, selector));
    },
    getBoundingClientRect() {
      return { x: 0, y: 0, top: 0, left: 0, width: 0, height: 0 };
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter(f => f !== fn);
    },
    dispatch(type, event) { for (const fn of listeners[type] || []) fn(event || {}); },
    focus() {},
    blur() {},
  };
  return node;
}

function createDocument(ids) {
  const elements = new Map(ids.map(id => [id, createNode('div')]));
  const listeners = {};
  return {
    elements,
    listeners,
    getElementById: id => elements.get(id) || null,
    createElement: tag => createNode(tag),
    createDocumentFragment: () => {
      const fragment = createNode('#fragment');
      fragment.isFragment = true;
      return fragment;
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    dispatch(type, event) { for (const fn of listeners[type] || []) fn(event || {}); },
  };
}

// Every node in the tree, depth first.
function walk(node, out = []) {
  for (const child of node.children) {
    out.push(child);
    walk(child, out);
  }
  return out;
}

function nodesByClass(root, className) {
  return walk(root).filter(n => String(n.className).split(/\s+/).includes(className));
}

function textByClass(root, className) {
  return nodesByClass(root, className).map(n => n.textContent);
}

module.exports = { createNode, createDocument, walk, nodesByClass, textByClass };
