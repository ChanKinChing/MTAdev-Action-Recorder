/* ===================================================
   xpath_core.js — MTAdev Action Recorder xpath 生成核心
   由 build_xpath_core.js 自動從 content_recorder.js 抽出，請勿手改
   原始碼: content_recorder.js
   =================================================== */
(function (global) {
  var DATA_TEST_ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-id'];
  var EVENT_ATTRS = ['ng-click', '(click)', '@click', 'onclick', 'ng-change', '(change)', '@change', 'onchange'];
  function esc(val) {
    return val.replace(/"/g, '\\"');
  }
  function hasAttrName(el) {
    if (!el || el.nodeType !== 1 || !el.getAttribute) return false;
    var id = el.getAttribute('id');
    var nm = el.getAttribute('name');
    return (id && id.trim() !== '') || (nm && nm.trim() !== '');
  }
  function usableAttrVal(v) {
    if (typeof v !== 'string') return false;
    v = v.trim();
    if (v === '') return false;
    if (v.indexOf(',') >= 0) return false;
    if (v.indexOf('"') >= 0) return false;
    return true;
  }
  function attrLocator(el, attr) {
    var v = el.getAttribute && el.getAttribute(attr);
    if (!usableAttrVal(v)) return null;
    return '//*[@' + attr + '="' + esc(v.trim()) + '"]';
  }
  function attrTest(name) {
    if (/^[A-Za-z_][A-Za-z0-9_.\-]*$/.test(name)) return '@' + name;
    return '@*[name()="' + name + '"]';
  }
  function stripAttrSuffix(xp) {
    if (!xp) return xp;
    var i = xp.lastIndexOf('/@');
    if (i < 0) return xp;
    var tail = xp.slice(i + 2);
    if (/^[\w:.-]+$/.test(tail)) return xp.slice(0, i);
    return xp;
  }
  function bestAttrLocator(el) {
    if (!el || el.nodeType !== 1 || !el.getAttribute) return null;
    var tag = (el.tagName || '').toLowerCase();
    var l, i;
    l = attrLocator(el, 'id');
    if (l) return l;
    l = attrLocator(el, 'name');
    if (l) return l;
    for (i = 0; i < DATA_TEST_ATTRS.length; i++) {
      l = attrLocator(el, DATA_TEST_ATTRS[i]);
      if (l) return l;
    }
    for (i = 0; i < EVENT_ATTRS.length; i++) {
      var ev = el.getAttribute(EVENT_ATTRS[i]);
      if (!usableAttrVal(ev)) continue;
      var base = '//*[' + attrTest(EVENT_ATTRS[i]) + '="' + esc(ev.trim()) + '"]';
      var ty = el.getAttribute('type');
      if ((tag === 'button' || tag === 'input') && usableAttrVal(ty)) {
        return base.slice(0, -1) + ' and @type="' + esc(ty.trim()) + '"]';
      }
      return base;
    }
    return null;
  }
  function xpathMatchCount(xp) {
    try {
      var snap = document.evaluate(stripAttrSuffix(xp), document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      return snap.snapshotLength;
    } catch (_) { return -1; }
  }
  function isUniqueTo(xp, el) {
    if (xpathMatchCount(xp) !== 1) return false;
    try {
      var r = document.evaluate(stripAttrSuffix(xp), document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return r.singleNodeValue === el;
    } catch (_) { return false; }
  }
  function indexedVariant(xp, el) {
    if (!xp) return null;
    try {
      var snap = document.evaluate(stripAttrSuffix(xp), document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (var i = 0; i < snap.snapshotLength; i++) {
        if (snap.snapshotItem(i) === el) {
          var v = '(' + xp + ')[' + (i + 1) + ']';
          return isUniqueTo(v, el) ? v : null;
        }
      }
    } catch (_) {}
    return null;
  }
  function tagSegment(el) {
    var tag = (el.tagName || '').toLowerCase();
    var parent = el.parentElement;
    if (parent) {
      var sibs = Array.prototype.filter.call(parent.children, function (s) {
        return (s.tagName || '').toLowerCase() === tag;
      });
      if (sibs.length > 1) tag += '[' + (sibs.indexOf(el) + 1) + ']';
    }
    return tag;
  }
  function buildStructural(nodes, startIdx, target, initialLastKept) {
    var segs = [];
    var lastKept = initialLastKept || null;
    for (var j = startIdx; j < nodes.length; j++) {
      var node = nodes[j];
      var isTarget = (node === target);
      var tg = (node.tagName || '').toLowerCase();
      if (!isTarget && (tg === 'div' || tg === 'span')) continue;
      var seg = tagSegment(node);
      if (lastKept && node.parentElement === lastKept) {
        segs.push('/' + seg);
      } else {
        segs.push('//' + seg);
      }
      lastKept = node;
    }
    return segs.join('');
  }
  function buildIndexedTail(nodes, startIdx, target, initialLastKept) {
    var segs = [];
    var lastKept = initialLastKept || null;
    for (var j = startIdx; j < nodes.length; j++) {
      var node = nodes[j];
      var tag = (node.tagName || '').toLowerCase();
      var seg = tag;
      var p = node.parentElement;
      if (p) {
        var sibs = Array.prototype.filter.call(p.children, function (s) {
          return (s.tagName || '').toLowerCase() === tag;
        });
        seg = tag + '[' + (sibs.indexOf(node) + 1) + ']';
      }
      if (lastKept && node.parentElement === lastKept) {
        segs.push('/' + seg);
      } else {
        segs.push('//' + seg);
      }
      lastKept = node;
    }
    return segs.join('');
  }
  function generateXPath(el) {
    if (!el || el === document || el === document.documentElement) return '/html';
    var tag = (el.tagName || '').toLowerCase();
    if (!tag) return '';

    /* 建立 上->下 的節點鏈（不含 html） */
    var nodes = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && cur !== document) {
      nodes.unshift(cur);
      cur = cur.parentElement;
    }

    /* ① 目標自身屬性 locator（id/name/data/事件+and @type）-> 驗證唯一才用；
       不唯一時嘗試 (locator)[n] 消歧義 */
    var ownAttr = bestAttrLocator(el);
    var ownAttrUnique = !!(ownAttr && isUniqueTo(ownAttr, el));
    if (ownAttrUnique) return ownAttr;
    if (ownAttr) {
      var ownIdx = indexedVariant(ownAttr, el);
      if (ownIdx) return ownIdx;
    }

    /* ② 錨點鏈（各祖先屬性 locator）+ 結構尾 -> 驗證唯一才用 */
    var anchorIdx = -1;
    var anchorPath = [];
    for (var k = 0; k < nodes.length - 1; k++) {
      var al = bestAttrLocator(nodes[k]);
      if (al) {
        anchorPath.push(al);
        anchorIdx = k;
      }
    }
    if (anchorIdx >= 0) {
      var chain = anchorPath.join('') + buildStructural(nodes, anchorIdx + 1, el, nodes[anchorIdx]);
      if (isUniqueTo(chain, el)) return chain;
      /* ②b 錨點鏈 + 每層索引結構尾 -> 驗證唯一才用 */
      var chainIdx = anchorPath.join('') + buildIndexedTail(nodes, anchorIdx + 1, el, nodes[anchorIdx]);
      if (isUniqueTo(chainIdx, el)) return chainIdx;
      /* ②c 錨點鏈仍多個命中 -> (chain)[n] 消歧義 */
      var chainVar = indexedVariant(chainIdx, el);
      if (chainVar) return chainVar;
    }

    /* ③ text() 單一（無唯一屬性 locator + 無子元素 + 固定短文字）-> 驗證唯一才用。
       text() 要求 text node 完全等於字面值，故需 textContent 無前導/尾隨空白（trim 後等於原值），
       否則 ' Hello ' 這類元素用 trim 值做 [text()="Hello"] 永遠匹配不到。 */
    var txRaw = el.textContent ? el.textContent : '';
    var tx = txRaw.trim();
    if (!ownAttrUnique && usableAttrVal(tx) && tx.length <= 40 && el.children.length === 0 && txRaw === tx) {
      var textLoc = '//*[text()="' + esc(tx) + '"]';
      if (isUniqueTo(textLoc, el)) return textLoc;
      var textVar = indexedVariant(textLoc, el);
      if (textVar) return textVar;
    }

    /* ④ class 單一 -> 驗證唯一才用（極少命中） */
    var cls = el.getAttribute && el.getAttribute('class');
    if (!ownAttrUnique && usableAttrVal(cls)) {
      var clsLoc = '//*[@class="' + esc(cls.trim()) + '"]';
      if (isUniqueTo(clsLoc, el)) return clsLoc;
      var clsVar = indexedVariant(clsLoc, el);
      if (clsVar) return clsVar;
    }

    /* ⑤ 兜底：最深的「驗證過唯一」屬性祖先作錨 + 每層索引結構尾（相對結構，非 /html 絕對）；
       祖先屬性多個命中時先試 (locator)[n] 錨 */
    for (var q = nodes.length - 1; q >= 0; q--) {
      var aLoc = bestAttrLocator(nodes[q]);
      if (aLoc) {
        if (isUniqueTo(aLoc, nodes[q])) {
          return aLoc + buildIndexedTail(nodes, q + 1, el, nodes[q]);
        }
        var aIdx = indexedVariant(aLoc, nodes[q]);
        if (aIdx) {
          return aIdx + buildIndexedTail(nodes, q + 1, el, nodes[q]);
        }
      }
    }

    /* ⑥ 完全無唯一屬性 -> /html 絕對路徑 + 每層同標籤索引，驗證唯一才用。
       每層都帶索引後必然唯一；若仍失敗（Shadow DOM 等）退回最上層節點相對索引路徑 */
    var absPath = '//html' + buildIndexedTail(nodes, 0, el);
    if (isUniqueTo(absPath, el)) return absPath;
    if (nodes[0]) {
      return '//' + (nodes[0].tagName || '').toLowerCase() + buildIndexedTail(nodes, 1, el, nodes[0]);
    }
    return '//body' + buildIndexedTail(nodes, 0, el);
  }
  function resolveClickTarget(el) {
    if (!el || el.nodeType !== 1 || !el.closest) return el;
    var sel = [
      'button',
      '[role="button"]',
      '[role="menuitem"]',
      'a[href]',
      '[ng-click]',
      '[data-ng-click]',
      '[onclick]',
      'select',
      'input:not([type="text"]):not([type="email"]):not([type="password"]):not([type="search"]):not([type="tel"]):not([type="url"]):not([type="number"])'
    ].join(', ');
    var t = el.closest(sel);
    if (t) return t;
    /* Angular 屬性含括號 (click)，不能放進 CSS 選擇器，手動向上找 */
    var n = el;
    while (n && n.nodeType === 1) {
      if (n.hasAttribute('(click)') || n.hasAttribute('(keyup.enter)')) return n;
      n = n.parentElement;
    }
    return el;
  }
  function stateClassOnParent(el) {
    if (!el || el.nodeType !== 1) return false;
    if ((el.tagName || '').toLowerCase() !== 'button') return false;
    if (!hasAttrName(el)) return false;
    var p = el.parentElement;
    if (!p) return false;
    var pCls = p.getAttribute('class') || '';
    var eCls = el.getAttribute('class') || '';
    return /btn-rect|ng-star-inserted/.test(pCls) && !/btn-rect|ng-star-inserted/.test(eCls);
  }
  function isTextInput(el) {
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'textarea') return true;
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      return ['text', 'email', 'password', 'search', 'tel', 'url', 'number'].includes(t);
    }
    return false;
  }
  function optionLabel(o) {
    if (!o) return '';
    var t = (o.textContent || o.text || '').trim();
    if (t) return t;
    return optionValue(o);
  }
  function optionValue(o) {
    if (!o) return '';
    var v = o.getAttribute ? o.getAttribute('value') : null;
    if (v !== null && v !== '') return v;
    return o.value != null ? o.value : '';
  }
  global.XPathCore = {
    DATA_TEST_ATTRS: DATA_TEST_ATTRS,
    EVENT_ATTRS: EVENT_ATTRS,
    esc: esc,
    hasAttrName: hasAttrName,
    usableAttrVal: usableAttrVal,
    attrLocator: attrLocator,
    attrTest: attrTest,
    stripAttrSuffix: stripAttrSuffix,
    bestAttrLocator: bestAttrLocator,
    xpathMatchCount: xpathMatchCount,
    isUniqueTo: isUniqueTo,
    indexedVariant: indexedVariant,
    tagSegment: tagSegment,
    buildStructural: buildStructural,
    buildIndexedTail: buildIndexedTail,
    generateXPath: generateXPath,
    resolveClickTarget: resolveClickTarget,
    stateClassOnParent: stateClassOnParent,
    isTextInput: isTextInput,
    optionLabel: optionLabel,
    optionValue: optionValue,
  };
})(typeof window !== "undefined" ? window : this);
