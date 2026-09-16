'use strict';
// Minimal DOM stand-in for driving the delivered mobile render code (server/public/app.js)
// in a VM. It implements only the element API that code uses, plus helpers so tests can
// assert on what a user would actually see rather than on implementation details.

function createNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    style: {},
    children: [],
    ownText: '',
    get textContent() {
      return node.children.length ? node.children.map(c => c.textContent).join('') : node.ownText;
    },
    set textContent(value) {
      node.ownText = String(value);
      node.children = [];
    },
    appendChild(child) {
      node.children.push(child);
      return child;
    },
    append(...kids) {
      for (const kid of kids) node.appendChild(kid);
    },
    // A document fragment contributes its children, matching real replaceChildren semantics.
    replaceChildren(...kids) {
      node.children = [];
      node.ownText = '';
      for (const kid of kids) {
        if (!kid) continue;
        if (kid.isFragment) node.children.push(...kid.children);
        else node.appendChild(kid);
      }
    },
  };
  return node;
}

function createDocument(ids) {
  const elements = new Map(ids.map(id => [id, createNode('div')]));
  return {
    elements,
    getElementById: id => elements.get(id) || null,
    createElement: tag => createNode(tag),
    createDocumentFragment: () => {
      const fragment = createNode('#fragment');
      fragment.isFragment = true;
      return fragment;
    },
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
