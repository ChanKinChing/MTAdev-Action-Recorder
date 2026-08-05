(function () {
  if (window.__mtarec_active) return;
  window.__mtarec_active = true;

  /* =========================================================
     STATE
     ========================================================= */
  let isRecording = false;
  let badgeEl = null;
  let dropdownEl = null;
  let moreMenuEl = null;
  let panelEl = null;
  let isDragging = false;
  let dragOffX = 0, dragOffY = 0;
  let locSteps = [];
  let playSteps = [];
  let recordStartUrl = '';
  let isPlaying = false;
  let playAbort = false;
  let isPaused = false;
  let isMinimized = false;
  let dragStarted = false;
  let pickModeAction = null;
  let highlightedEl = null;
  let mmPersistent = false;
  let mmHideTimer = null;
  let dropHideTimer = null;
  let pendingPtr = null;

  function addPlaybackBorder() {
    var el = document.createElement('div');
    el.id = '__mtarec_playback_border';
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;border:5px solid #e53935;pointer-events:none;z-index:2147483646;box-sizing:border-box;';
    document.body.appendChild(el);
  }

  /* --- pick up pending playback from storage (new tab playback) --- */
  chrome.storage.local.get('mtarec_pending_playback', function (data) {
    if (data.mtarec_pending_playback) {
      var pp = data.mtarec_pending_playback;
      chrome.storage.local.remove('mtarec_pending_playback');
      if (pp.steps && pp.steps.length > 0) {
        playSteps = pp.steps.map(function (s) {
          return { action: s.action, el: null, xpath: s.xpath, value: s.value };
        });
        locSteps = playSteps.slice();
        addPlaybackBorder();
        setTimeout(executeLocalPlayback, 800);
      }
    }
  });

  /* =========================================================
     XPATH  GENERATOR（九條鐵律，依 data/ CSV 2087 steps 推導）:
     R1 一律通配符           -> //*[@attr="值"]，不混 tag 前綴
     R2 屬性優先序           -> id → name → data-* → 事件屬性(button/input 併 and @type) → text() → class
     R3 候選值含逗號/雙引號   -> 跳過（避免炸 CSV / 破壞解析）
     R4 禁 contains/starts-with/ends-with（僅精確等於）
     R5 多條件僅用 and
     R6 方案A（唯一屬性祖先鏈）-> 全鏈接具唯一屬性祖先，最深在最後，再接結構尾
     R7 數字索引僅最後手段     -> 同標籤兄弟才加 [n]
     R8 精確 text()           -> //*[text()="值"]（無屬性 + 固定短文字）
     R9 ng-if 元素自動補 present（見 sendStep）
     assert_class 目標為 state class 在父層的 button -> 尾綴 /..
     ========================================================= */
  function esc(val) {
    return val.replace(/"/g, '\\"');
  }

  function hasAttrName(el) {
    if (!el || el.nodeType !== 1 || !el.getAttribute) return false;
    var id = el.getAttribute('id');
    var nm = el.getAttribute('name');
    return (id && id.trim() !== '') || (nm && nm.trim() !== '');
  }

  /* R3: 屬性值是否可作為 locator 候選（非空、不含逗號/雙引號） */
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

  var DATA_TEST_ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-id'];
  var EVENT_ATTRS = ['ng-click', '(click)', '@click', 'onclick', 'ng-change', '(change)', '@change', 'onchange'];

  /* 屬性名是合法 NCName 就用 @name，否則（如 Angular 的 (click)/@click）改用 @*[name()="..."]，
     避免 @(click) 這種 XPath 語法錯誤被 document.evaluate 拋出而永遠驗證失敗 */
  function attrTest(name) {
    if (/^[A-Za-z_][A-Za-z0-9_.\-]*$/.test(name)) return '@' + name;
    return '@*[name()="' + name + '"]';
  }

  /* 剝離結尾的 /@attr（assert_attribute_value / get_attribute_value 附加）。
     只用「結尾恰好是 /@ 屬性名」才剝，避免誤切屬性值內含的 /@（如 @data-x="a/@b"） */
  function stripAttrSuffix(xp) {
    if (!xp) return xp;
    var i = xp.lastIndexOf('/@');
    if (i < 0) return xp;
    var tail = xp.slice(i + 2);
    if (/^[\w:.-]+$/.test(tail)) return xp.slice(0, i);
    return xp;
  }

  /* R2 屬性層：id → name → data-* → 事件屬性。無可用屬性回 null */
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

  /* ---- 即時 DOM 驗證 --------------------------------------------------
      record 當下直接在頁面查證：候選路徑是否「唯一」且「就是目標元素」。
      （Shadow DOM 內元素 document.evaluate 找不到 -> 傳回 false，自動退到結構路徑） */
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

  /* 候選路徑命中多個元素時，用 (xp)[n] 鎖定目標在 document order 的位置。
     n=目標在快照中的 index+1；產生後再用 isUniqueTo 驗證真的唯一才回傳，否則 null */
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

  /* R7: 同標籤兄弟才加 [n] */
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

  /* 結構尾：跳過非目標的 div/span；直接子代用 '/', 跳層用 '//'
     initialLastKept: 前一段最後保留的元素（錨點），使第一段直接子代輸出 '/' */
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

  /* 兜底：每層都帶索引的結構尾（含 div/span，不跳層），儘量提高唯一性 */
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

  /* 點擊時解析到真正負責動作的元素（使用者常點到元素內的子元素/文字）：
     button → role=button → a[href] → 具 click 事件屬性的元素 → select/input[可點擊] */
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

  /* 模擬 /.. 型態：button 有 name/id，但 state class 在父層（如 mailItemTabBtn 的
     btn-rect-selected / ng-star-inserted），assert_class 目標為父層 -> 以 namedButton/.. 表達 */
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

  /* =========================================================
     EVENT  HANDLERS
     ========================================================= */
  function isTextInput(el) {
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'textarea') return true;
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      return ['text', 'email', 'password', 'search', 'tel', 'url', 'number'].includes(t);
    }
    return false;
  }

  /* 判斷元素是否該被當成 click 目標錄製（與 onClick 的 input 過濾邏輯一致） */
  function isClickableTarget(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'select') return false; /* select 由 change 錄成 dropdown，點擊不另錄 */
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (['checkbox', 'radio'].includes(t)) return true;
      return !isTextInput(el);
    }
    return true;
  }

  function clearPendingPtr() {
    if (pendingPtr) {
      clearTimeout(pendingPtr.timer);
      pendingPtr = null;
    }
  }

  function flushPendingPtr() {
    if (!pendingPtr) return;
    const p = pendingPtr;
    pendingPtr = null;
    sendStep(p.xpath, '', 'click', p.el);
  }

  /* pointerdown 兜底錄製：有些頁面在 mousedown 時就處理動作並移除/重繪按鈕，或抑制 click 事件，
     導致 document 的 click 永遠不派發。此處先暫存，若短時間內沒收到 click 則補錄。 */
  function onPointerDown(e) {
    if (!isRecording) return;
    if (e.button !== 0) return;
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    if (badgeEl && badgeEl.contains(el)) return;
    if (pickModeAction) return;
    const clickEl = resolveClickTarget(el) || el;
    if (!isClickableTarget(clickEl)) return;
    clearPendingPtr();
    pendingPtr = {
      xpath: generateXPath(clickEl),
      el: clickEl,
      startX: e.clientX,
      startY: e.clientY,
      timer: setTimeout(flushPendingPtr, 700)
    };
  }

  /* 按下後移動超過 4px 視為拖曳，取消 pending，避免誤錄成 click */
  function onPointerMoveCancel(e) {
    if (!pendingPtr) return;
    if (Math.abs(e.clientX - pendingPtr.startX) > 4 || Math.abs(e.clientY - pendingPtr.startY) > 4) {
      clearPendingPtr();
    }
  }

  function onClick(e) {
    if (!isRecording) return;
    const el = e.target;
    if (badgeEl && badgeEl.contains(el)) return;
    clearPendingPtr();

    if (pickModeAction) {
      e.preventDefault();
      e.stopPropagation();
      var clickEl = (pickModeAction === 'click' || pickModeAction === 'assert_class') ? resolveClickTarget(el) : el;
      var xpath = generateXPath(clickEl);
      var val = '';
      switch (pickModeAction) {
        case 'check_presence_to_continue':
          val = 'present';
          break;
        case 'click':
          val = '';
          break;
        case 'type':
          val = prompt('Text to type:');
          if (val == null) { exitPickMode(); return; }
          break;
        case 'dropdown':
          val = prompt('Option value:');
          if (val == null) { exitPickMode(); return; }
          break;
        case 'press':
          val = prompt('Key to press:');
          if (val == null) { exitPickMode(); return; }
          break;
        case 'assert_text':
          val = prompt('Expected text:', clickEl.textContent ? clickEl.textContent.trim() : '');
          if (val == null) { exitPickMode(); return; }
          break;
        case 'assert_attribute_value':
          var attrName = prompt('Attribute name:');
          if (attrName == null) { exitPickMode(); return; }
          var curAttr = clickEl.getAttribute ? clickEl.getAttribute(attrName) : null;
          var expVal = prompt('Expected value:', curAttr == null ? '' : curAttr);
          if (expVal == null) { exitPickMode(); return; }
          xpath = xpath + '/@' + attrName;
          val = expVal;
          break;
        case 'assert_class':
          var classParent = stateClassOnParent(clickEl) ? clickEl.parentElement : clickEl;
          var curCls = classParent && classParent.getAttribute ? (classParent.getAttribute('class') || '') : '';
          val = prompt('Expected class:', curCls);
          if (val == null) { exitPickMode(); return; }
          if (stateClassOnParent(clickEl)) xpath = xpath + '/..';
          break;
        case 'get_text':
          val = prompt('Variable name:');
          if (val == null) { exitPickMode(); return; }
          break;
        case 'get_attribute_value':
          var attrName2 = prompt('Attribute name:');
          if (attrName2 == null) { exitPickMode(); return; }
          var varName = prompt('Variable name:');
          if (varName == null) { exitPickMode(); return; }
          xpath = xpath + '/@' + attrName2;
          val = varName;
          break;
      }
      sendStep(xpath, val, pickModeAction, clickEl);
      exitPickMode();
      return;
    }

    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'select') return; /* 由 change 錄 dropdown，click 不另錄 */
    if (tag === 'label') {
      /* 點 <label> 時瀏覽器會合成 click 到關聯的 input，避免 label 與 input 各錄一次 */
      var lblCtrl = el.htmlFor ? document.getElementById(el.htmlFor) : (el.control || null);
      if (lblCtrl && lblCtrl.tagName && lblCtrl.tagName.toLowerCase() === 'input') return;
    }
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (['checkbox', 'radio'].includes(t)) {
        sendStep(generateXPath(resolveClickTarget(el)), '', 'click', el);
      } else if (!isTextInput(el)) {
        sendStep(generateXPath(resolveClickTarget(el)), '', 'click', el);
      }
      return;
    }
    sendStep(generateXPath(resolveClickTarget(el)), '', 'click', el);
  }

  /* dropdown 改錄 option 的可見文字 label（中/英文皆可，避免錄到 value 屬性的
     string:前綴 或 Hex 代碼）。優先文字，文字為空才回退 value 屬性 */
  function optionLabel(o) {
    if (!o) return '';
    var t = (o.textContent || o.text || '').trim();
    if (t) return t;
    return optionValue(o);
  }

  /* option 的 value 屬性：優先 o.getAttribute('value')，無則回退 o.value
     （o.value 在 option 無 value 屬性時等於顯示文字 label） */
  function optionValue(o) {
    if (!o) return '';
    var v = o.getAttribute ? o.getAttribute('value') : null;
    if (v !== null && v !== '') return v;
    return o.value != null ? o.value : '';
  }

  function onChange(e) {
    if (!isRecording) return;
    const el = e.target;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'select') {
      var val = '';
      if (el.multiple) {
        val = Array.from(el.selectedOptions).map(optionLabel).join(';');
      } else {
        val = el.selectedIndex >= 0 ? optionLabel(el.options[el.selectedIndex]) : '';
      }
      sendStep(generateXPath(el), val, 'dropdown', el);
    } else if (isTextInput(el)) {
      var xp = generateXPath(el);
      if (el.value) {
        sendStep(xp, el.value, 'type', el);
      } else if (wasFieldTyped(xp)) {
        /* 欄位被清空（先前錄過非空 type 的同欄位）-> 補錄空值 type 表達清空 */
        sendStep(xp, '', 'type', el);
      }
    }
  }

  /* 判斷某欄位是否錄過非空 type（供清空補錄判斷） */
  function wasFieldTyped(xp) {
    for (var i = locSteps.length - 1; i >= 0; i--) {
      var s = locSteps[i];
      if (s.action === 'type' && s.xpath === xp) return !!s.value;
      if (s.action === 'dropdown' && s.xpath === xp) return false;
    }
    return false;
  }

  function onKeyDown(e) {
    if (!isRecording) return;
    if (pickModeAction) return;
    const controlKeys = ['Tab', 'Enter', 'Escape', 'Delete', 'Backspace'];
    if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return;
      if (badgeEl && badgeEl.contains(el)) return;
      sendStep(generateXPath(el), 'CTRL+A', 'press', el);
      return;
    }
    if (!controlKeys.includes(e.key)) return;
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return;
    if (badgeEl && badgeEl.contains(el)) return;
    if (e.key === 'Enter' && isTextInput(el)) return;
    sendStep(generateXPath(el), e.key.toUpperCase(), 'press', el);
  }

  /* =========================================================
     PICK  MODE  (generalized from checkElementMode)
     ========================================================= */
  function onPickHover(e) {
    if (!pickModeAction) return;
    var el = e.target;
    if (badgeEl && badgeEl.contains(el)) return;
    if (pickModeAction === 'click' || pickModeAction === 'assert_class') el = resolveClickTarget(el) || el;
    if (el === highlightedEl) return;
    clearPickHighlight();
    el.setAttribute('data-mtarec-pick-shadow', el.style.boxShadow || '');
    el.style.outline = '2px solid #ff1744';
    el.style.outlineOffset = '-2px';
    el.style.boxShadow = '0 0 12px 3px rgba(255,23,68,0.55)';
    highlightedEl = el;
  }

  function onPickUnhover(e) {
    if (!pickModeAction) return;
    var el = e.target;
    if (el === highlightedEl) {
      el.style.outline = '';
      el.style.boxShadow = el.getAttribute('data-mtarec-pick-shadow') || '';
      el.removeAttribute('data-mtarec-pick-shadow');
      highlightedEl = null;
    }
  }

  function enterPickMode(action) {
    pickModeAction = action;
    hideMoreMenu();
    var btn = badgeEl && badgeEl.querySelector('.mtarec-btn-more');
    if (btn) btn.classList.add('active');
  }

  function exitPickMode() {
    pickModeAction = null;
    clearPickHighlight();
    var btn = badgeEl && badgeEl.querySelector('.mtarec-btn-more');
    if (btn) btn.classList.remove('active');
  }

  function clearPickHighlight() {
    if (highlightedEl) {
      highlightedEl.style.outline = '';
      highlightedEl.style.boxShadow = highlightedEl.getAttribute('data-mtarec-pick-shadow') || '';
      highlightedEl.removeAttribute('data-mtarec-pick-shadow');
      highlightedEl = null;
    }
  }

  /* =========================================================
     MORE  MENU
     ========================================================= */
  var MORE_ITEMS = [
    { action: 'open', emoji: '\u{1F310}', label: 'Open' },
    { action: 'pause', emoji: '\u23F8\uFE0F', label: 'Pause...' },
    { action: 'click', emoji: '\u{1F5B1}\uFE0F', label: 'Click...' },
    { action: 'type', emoji: '\u2328\uFE0F', label: 'Type...' },
    { action: 'dropdown', emoji: '\u{1F53D}', label: 'Dropdown...' },
    { action: 'press', emoji: '\u{1F511}', label: 'Press Key...' },
    { action: 'present', emoji: '\u2705', label: 'Present' },
    { action: 'not_present', emoji: '\u274C', label: 'Not Present' },
    { action: 'visible', emoji: '\u{1F441}\uFE0F', label: 'Visible' },
    { action: 'not_visible', emoji: '\u{1F6AB}', label: 'Not Visible' },
    { action: 'assert_text', emoji: '\u{1F4DD}', label: 'Assert Text...' },
    { action: 'assert_attribute_value', emoji: '\u{1F3F7}\uFE0F', label: 'Assert Attr...' },
    { action: 'assert_class', emoji: '\u{1F3AF}', label: 'Assert Class...' },
    { action: 'compare_eq', emoji: '\u2696\uFE0F', label: 'Compare Eq...' },
    { action: 'get_text', emoji: '\u{1F524}', label: 'Get Text...' },
    { action: 'get_attribute_value', emoji: '\u{1F516}', label: 'Get Attr...' },
    { action: 'check_presence_to_continue', emoji: '\u{1F504}', label: 'Check Presence...' },
    { action: 'end_check_presence_to_continue', emoji: '\u23F9\uFE0F', label: 'End Check Presence' },
    { action: 'print', emoji: '\u{1F5A8}\uFE0F', label: 'Print...' },
    { action: 'check_file_downloaded', emoji: '\u{1F4E5}', label: 'File Download...' },
  ];

  function handleMoreItem(action) {
    if (action === 'open') {
      sendStep('', window.location.href, 'open');
      hideMoreMenu();
      return;
    }
    if (action === 'pause') {
      var secs = prompt('Wait seconds:');
      if (secs == null) { hideMoreMenu(); return; }
      sendStep('', String(parseInt(secs, 10) || 1), 'pause');
      hideMoreMenu();
      return;
    }
    if (action === 'end_check_presence_to_continue') {
      sendStep('', '', 'end_check_presence_to_continue');
      hideMoreMenu();
      return;
    }
    if (action === 'print') {
      var msg = prompt('Enter log message:');
      if (msg != null) sendStep('', msg, 'print');
      hideMoreMenu();
      return;
    }
    if (action === 'compare_eq') {
      var a = prompt('Variable A name:');
      if (a == null) { hideMoreMenu(); return; }
      var b = prompt('Variable B name:');
      if (b == null) { hideMoreMenu(); return; }
      sendStep(a, b, 'compare_eq');
      hideMoreMenu();
      return;
    }
    if (action === 'check_file_downloaded') {
      var f = prompt('Filename pattern:');
      if (f == null) { hideMoreMenu(); return; }
      sendStep('', f, 'check_file_downloaded');
      hideMoreMenu();
      return;
    }
    enterPickMode(action);
  }

  function showMoreMenu() {
    if (mmHideTimer) { clearTimeout(mmHideTimer); mmHideTimer = null; }
    if (!moreMenuEl) return;
    moreMenuEl.style.display = 'grid';
    var menuH = moreMenuEl.offsetHeight || 400;
    var badgeRect = badgeEl ? badgeEl.getBoundingClientRect() : null;
    if (badgeRect && badgeRect.top < menuH) {
      moreMenuEl.style.bottom = 'auto';
      moreMenuEl.style.top = '100%';
      moreMenuEl.style.marginTop = '4px';
      moreMenuEl.style.marginBottom = '';
    } else {
      moreMenuEl.style.bottom = '100%';
      moreMenuEl.style.top = 'auto';
      moreMenuEl.style.marginBottom = '4px';
      moreMenuEl.style.marginTop = '';
    }
  }

  function hideMoreMenu() {
    if (!moreMenuEl) return;
    moreMenuEl.style.display = 'none';
    mmPersistent = false;
  }

  function scheduleHideMoreMenu() {
    if (mmPersistent) return;
    if (mmHideTimer) clearTimeout(mmHideTimer);
    mmHideTimer = setTimeout(function () {
      hideMoreMenu();
      mmHideTimer = null;
    }, 250);
  }

  /* =========================================================
     COMM  WITH  BACKGROUND
     ========================================================= */
  function sendMsg(msg, cb) {
    try {
      var p = chrome.runtime.sendMessage(msg, cb);
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (_) {}
  }

  /* 規則九：目標自身或任一祖先帶 ng-if / data-ng-if 時，該元素的動作需先確認存在 */
  function hasNgIf(el) {
    var cur = el;
    while (cur && cur.nodeType === 1) {
      if (cur.hasAttribute && (cur.hasAttribute('ng-if') || cur.hasAttribute('data-ng-if'))) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  /* 共用 push helper：locSteps / playSteps / UI / 背景三方同步 */
  function pushStep(step, el) {
    locSteps.push(step);
    playSteps.push({ action: step.action, el: el || null, xpath: step.xpath, value: step.value });
    updateStepBtn();
    sendMsg(
      { type: 'REC_ADD_STEP', step: step },
      function (resp) {
        if (resp) updateStepBtn();
      }
    );
  }

  function sendStep(xpath, value, action, el) {
    var step = { xpath: xpath, value: value, action: action, url: window.location.href };

    /* 規則九: click/type/dropdown/press 目標（或祖先）有 ng-if -> 前插 present 檢查，
       與上一筆同 xpath 的 present 不重複 */
    if (
      el &&
      (action === 'click' || action === 'type' || action === 'dropdown' || action === 'press') &&
      hasNgIf(el)
    ) {
      /* 去重：同一 xpath 已存在 present 就不重複插入（掃整個 locSteps，不限最後一筆） */
      var alreadyPresent = false;
      for (var b = locSteps.length - 1; b >= 0; b--) {
        var prev = locSteps[b];
        if (prev.action === 'present' && prev.xpath === xpath) { alreadyPresent = true; break; }
        if (prev.action === 'click' || prev.action === 'type' || prev.action === 'dropdown' || prev.action === 'press' || prev.action === 'open') break;
      }
      if (!alreadyPresent) {
        pushStep({ xpath: xpath, value: '', action: 'present', url: window.location.href }, el);
      }
    }

    pushStep(step, el);
  }

  function addPauseStep(sec) {
    var last = locSteps[locSteps.length - 1];
    if (last && last.action === 'pause') {
      var newVal = (parseInt(last.value, 10) || 0) + sec;
      last.value = String(newVal);
      var lastPlay = playSteps[playSteps.length - 1];
      if (lastPlay) lastPlay.value = String(newVal);
      updateStepBtn();
      sendMsg({ type: 'REC_UPDATE_STEP', index: locSteps.length - 1, step: last });
      return;
    }
    sendStep('', String(sec), 'pause');
  }

  function undoLastStep() {
    if (locSteps.length === 0) return;
    locSteps.pop();
    playSteps.pop();
    updateStepBtn();
    sendMsg(
      { type: 'REC_DELETE_LAST_STEP' },
      function () { updateStepBtn(); }
    );
  }

  function stopFromBadge() {
    if (badgeEl && badgeEl.classList.contains('mode-recording')) {
      stopRecording();
      sendMsg({ type: 'REC_STOP' });
      if (locSteps.length > 0) showResultPanel(locSteps, '');
    } else {
      sendMsg({ type: 'REC_RESUME' }, function () {
        startRecording(false);
      });
    }
  }

  /* =========================================================
     PLAYBACK  ENGINE
     ========================================================= */
  function startPlayback() {
    if (isPlaying || playSteps.length === 0) return;

    if (isRecording) {
      isRecording = false;
      exitPickMode();
      clearPendingPtr();
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('change', onChange, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('mouseover', onPickHover, true);
      document.removeEventListener('mouseout', onPickUnhover, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointermove', onPointerMoveCancel, true);
      window.removeEventListener('beforeunload', onBeforeUnload);
    }

    var steps = playSteps.slice();
    if (!steps[0] || steps[0].action !== 'open') {
      steps.unshift({ action: 'open', xpath: '', value: recordStartUrl || window.location.href, el: null });
    }

    var targetUrl = recordStartUrl || window.location.href;
    for (var si = 0; si < steps.length; si++) {
      if (steps[si].action === 'open') { targetUrl = steps[si].value; break; }
    }

    sendMsg({ type: 'REC_PLAY_NEW_TAB', steps: steps, url: targetUrl });
    showToast('\u25B6 Playing in new tab...');
    setTimeout(hideToast, 2000);
    isPlaying = true;
    setTimeout(function () { isPlaying = false; }, 3000);

    isRecording = true;
    setBadgeMode('recording');
    document.addEventListener('click', onClick, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('mouseover', onPickHover, true);
    document.addEventListener('mouseout', onPickUnhover, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointermove', onPointerMoveCancel, true);
    window.addEventListener('beforeunload', onBeforeUnload);
  }

  function executeLocalPlayback() {
    if (playSteps.length === 0) return;
    isPlaying = true;
    playAbort = false;
    var idx = 0;
    setBadgeMode('playing');
    document.title = 'Play steps:' + playSteps.length;
    showToast('\u25B6 [1/' + playSteps.length + '] Starting...');

    function next() {
      if (playAbort || idx >= playSteps.length) {
        endPlayback();
        return;
      }
      var ps = playSteps[idx];
      var line = (ps.xpath || '') + ', ' + (ps.value || '') + ', ' + ps.action;
      showToast('\u25B6 [' + (idx + 1) + '/' + playSteps.length + '] ' + line);
      executePlayStep(ps, idx, function (jumpTo) {
        idx = (typeof jumpTo === 'number') ? jumpTo : (idx + 1);
        waitWhilePaused(function () { setTimeout(next, 500); });
      });
    }
    next();
  }

  function stopPlayback() {
    playAbort = true;
    isPlaying = false;
    isPaused = false;
    clearHighlight();
    setBadgeMode('idle');
    hideToast();
  }

  function endPlayback() {
    isPlaying = false;
    isPaused = false;
    clearHighlight();
    if (!playAbort) {
      document.title = 'Playback complete';
      showToast('Play back complete');
    }
  }

  function executePlayStep(ps, idx, done) {
    if (ps.action === 'pause') {
      var ms = (parseInt(ps.value, 10) || 1) * 1000;
      setTimeout(done, ms);
      return;
    }
    if (ps.action === 'open' || ps.action === 'compare_eq' || ps.action === 'check_file_downloaded') {
      done();
      return;
    }
    if (ps.action === 'check_presence_to_continue') {
      if (!findPlayEl(ps)) {
        done(skipCheckBlock(idx));
      } else {
        done();
      }
      return;
    }
    if (ps.action === 'end_check_presence_to_continue') {
      done();
      return;
    }
    if (ps.action === 'print') {
      done();
      return;
    }
    if (ps.action === 'get_text' || ps.action === 'get_attribute_value' || ps.action === 'assert_attribute_value' || ps.action === 'assert_text' || ps.action === 'assert_class') {
      var found = findPlayEl(ps);
      clearHighlight();
      if (found) highlightEl(found);
      if (ps.action === 'assert_text') {
        var actual = found ? found.textContent.trim() : '';
        showToast((actual === ps.value ? '\u2705' : '\u26A0') + ' assert_text: "' + actual + '"');
      } else if (ps.action === 'assert_class') {
        var has = found ? found.classList.contains(ps.value) : false;
        showToast((has ? '\u2705' : '\u26A0') + ' assert_class: ' + ps.value);
      }
      done();
      return;
    }

    var el = findPlayEl(ps);
    if (!el) {
      showToast('\u26A0 Element not found: ' + truncatePath(ps.xpath));
      done();
      return;
    }
    /* 播放時 DOM 可能已變：xpath 若不唯一，警告「可能點到錯元素」 */
    var nowCount = ps.xpath ? xpathMatchCount(ps.xpath) : 1;
    if (nowCount > 1) {
      showToast('\u26A0 xpath 非唯一 (' + nowCount + ' 個元素): ' + truncatePath(ps.xpath));
    }
    clearHighlight();
    highlightEl(el);

    switch (ps.action) {
      case 'click':
        el.click();
        break;
      case 'type':
        setNativeValue(el, ps.value);
        break;
      case 'dropdown':
        setSelectValue(el, ps.value);
        break;
      case 'press':
        if (ps.value === 'CTRL+A') {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', ctrlKey: true, bubbles: true }));
        } else {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: normalizePressKey(ps.value), bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { key: normalizePressKey(ps.value), bubbles: true }));
        }
        break;
      case 'present':
        showToast((el ? '\u2705' : '\u26A0') + ' present');
        break;
      case 'not_present':
        showToast((!el ? '\u2705' : '\u26A0') + ' not_present');
        break;
      case 'visible':
        showToast((el.offsetParent !== null ? '\u2705' : '\u26A0') + ' visible');
        break;
      case 'not_visible':
        showToast((el.offsetParent === null ? '\u2705' : '\u26A0') + ' not_visible');
        break;
    }
    done();
  }

  function findPlayEl(ps) {
    if (ps.el && document.contains(ps.el)) return ps.el;
    if (!ps.xpath) return null;
    try {
      var xp = stripAttrSuffix(ps.xpath);
      var result = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return result.singleNodeValue;
    } catch (_) { return null; }
  }

  /* 對受控元件（React/Angular）設值：用原生 value setter 覆寫 prototype 上的 setter，
     再派發 input/change，確保框架的 onChange/ngModelChange 被觸發 */
  function setNativeValue(el, value) {
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
              : el.tagName === 'SELECT' ? HTMLSelectElement.prototype
              : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) {
      desc.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* dropdown 播放：值為錄製時的可見文字 label（可能含中/英文）。
     single：先依文字找 option 設定 selected，找不到再回退原生 value setter（相容舊錄的 value 值）；
     multiple：以 ';' 分隔，逐一比對文字或 value 勾選 */
  function setSelectValue(el, value) {
    var v = String(value == null ? '' : value);
    var opts = el.options;
    if (el.multiple) {
      var want = v.split(';');
      for (var i = 0; i < opts.length; i++) {
        var m = optionLabel(opts[i]);
        var mv = optionValue(opts[i]);
        opts[i].selected = want.indexOf(m) !== -1 || want.indexOf(mv) !== -1;
      }
    } else {
      var idx = -1;
      for (var i = 0; i < opts.length; i++) {
        if (optionLabel(opts[i]) === v) { idx = i; break; }
      }
      if (idx >= 0) {
        el.selectedIndex = idx;
      } else {
        var proto = HTMLSelectElement.prototype;
        var desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) {
          desc.set.call(el, v);
        } else {
          el.value = v;
        }
      }
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function skipCheckBlock(startIdx) {
    var depth = 1;
    for (var j = startIdx + 1; j < playSteps.length; j++) {
      if (playSteps[j].action === 'check_presence_to_continue') depth++;
      if (playSteps[j].action === 'end_check_presence_to_continue') {
        depth--;
        if (depth === 0) return j;
      }
    }
    return playSteps.length;
  }

  function truncatePath(s) {
    if (!s) return '';
    if (s.length > 30) return '...' + s.slice(-27);
    return s;
  }

  /* 錄製時 press 存 e.key.toUpperCase()（如 'TAB'、'ENTER'），播放時需還原成
     KeyboardEvent 的合法 key 值（'Tab'、'Enter'），否則 keydown handler 比對不到 */
  var PRESS_KEY_MAP = {
    'TAB': 'Tab', 'ENTER': 'Enter', 'ESCAPE': 'Escape', 'DELETE': 'Delete',
    'BACKSPACE': 'Backspace', 'ARROWDOWN': 'ArrowDown', 'ARROWUP': 'ArrowUp',
    'ARROWLEFT': 'ArrowLeft', 'ARROWRIGHT': 'ArrowRight', 'HOME': 'Home',
    'END': 'End', 'PAGEUP': 'PageUp', 'PAGEDOWN': 'PageDown',
    'SPACE': ' ', 'INSERT': 'Insert'
  };
  function normalizePressKey(v) {
    if (v && PRESS_KEY_MAP[v]) return PRESS_KEY_MAP[v];
    return v;
  }

  function clearHighlight() {
    var prev = document.querySelector('[data-mtarec-hl]');
    if (prev) {
      prev.style.outline = prev.getAttribute('data-mtarec-hl-orig') || '';
      prev.style.boxShadow = prev.getAttribute('data-mtarec-hl-shadow-orig') || '';
      prev.removeAttribute('data-mtarec-hl');
      prev.removeAttribute('data-mtarec-hl-orig');
      prev.removeAttribute('data-mtarec-hl-shadow-orig');
    }
  }

  function highlightEl(el) {
    if (!el) return;
    el.setAttribute('data-mtarec-hl-orig', el.style.outline || '');
    el.setAttribute('data-mtarec-hl-shadow-orig', el.style.boxShadow || '');
    el.style.outline = '3px solid #e53935';
    el.style.outlineOffset = '1px';
    el.style.boxShadow = '0 0 12px 3px rgba(229,57,53,0.6)';
    el.setAttribute('data-mtarec-hl', '1');
  }

  /* =========================================================
     TOAST  (bottom middle)
     ========================================================= */
  var TOAST_ID = '__mtarec_toast';

  function showToast(msg) {
    if (isPaused && isPlaying && !isRecording) {
      msg = '\u23F8 Paused - click to resume';
    }
    var el = document.getElementById(TOAST_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = TOAST_ID;
      el.style.cssText = [
        'all:initial; position:fixed; bottom:80px; left:50%; transform:translateX(-50%);',
        'z-index:2147483647; background:#1e1e1e; color:#eee;',
        'font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
        'padding:8px 18px; border-radius:20px;',
        'box-shadow:0 0 14px rgba(229,57,53,0.6);',
        'border:2px solid #e53935;',
        'pointer-events:auto; cursor:pointer; white-space:normal; max-width:min(720px, calc(100vw - 32px)); line-height:1.5;',
        'transition:opacity 0.2s;',
      ].join(' ');
      document.body.appendChild(el);
      el.addEventListener('click', function () {
        if (isPlaying && !isRecording) togglePause();
        else if (!isPlaying) hideToast();
      });
    }
    el.textContent = msg;
    el.style.opacity = '1';
  }

  function hideToast() {
    var el = document.getElementById(TOAST_ID);
    if (el) el.style.opacity = '0';
  }

  function togglePause() {
    isPaused = !isPaused;
    if (isPaused) {
      showToast('\u23F8 Paused - click to resume');
    } else {
      showToast('\u25B6 Resuming...');
      setTimeout(hideToast, 1000);
    }
  }

  function waitWhilePaused(cb) {
    if (!isPaused) { cb(); return; }
    setTimeout(function () { waitWhilePaused(cb); }, 200);
  }

  /* =========================================================
     IDLE  BADGE  (after recording stops, shows play button)
     ========================================================= */
  var stopGlowRAf = null;
  var stopGlowOff = 0;
  var stopGlowLast = 0;

  function stopBtnEl() {
    return badgeEl ? badgeEl.querySelector('.mtarec-btn-stop') : null;
  }

  function startStopGlow() {
    if (stopGlowRAf != null) return;
    var btn = stopBtnEl();
    if (!btn) return;
    var w = btn.offsetWidth || 84;
    btn.style.setProperty('--pattern-w1', Math.round(w * 0.7) + 'px');
    btn.style.setProperty('--pattern-w2', Math.round(w * 0.55) + 'px');
    stopGlowOff = 0;
    stopGlowLast = 0;
    stopGlowRAf = requestAnimationFrame(stopGlowTick);
  }

  function stopGlowTick(ts) {
    var btn = stopBtnEl();
    if (!btn || !badgeEl.classList.contains('mode-recording')) {
      stopGlowRAf = null;
      return;
    }
    if (!stopGlowLast) stopGlowLast = ts;
    var dt = Math.min((ts - stopGlowLast) / 1000, 0.1);
    stopGlowLast = ts;
    stopGlowOff += 90 * dt;
    var w1 = parseFloat(btn.style.getPropertyValue('--pattern-w1')) || 62;
    var w2 = parseFloat(btn.style.getPropertyValue('--pattern-w2')) || 48;
    var g1 = btn.querySelector('.ms-glow');
    var g2 = btn.querySelector('.ms-glow2');
    if (g1) g1.style.backgroundPositionX = (-(stopGlowOff % w1)).toFixed(2) + 'px';
    if (g2) g2.style.backgroundPositionX = (-(stopGlowOff * 1.35 % w2)).toFixed(2) + 'px';
    stopGlowRAf = requestAnimationFrame(stopGlowTick);
  }

  function stopStopGlow() {
    if (stopGlowRAf != null) {
      cancelAnimationFrame(stopGlowRAf);
      stopGlowRAf = null;
    }
  }

  function setBadgeMode(mode) {
    if (!badgeEl) return;
    badgeEl.classList.remove('mode-recording', 'mode-idle', 'mode-playing');
    badgeEl.classList.add('mode-' + mode);
    var playBtn = badgeEl.querySelector('.mtarec-btn-play');
    if (playBtn) playBtn.textContent = (mode === 'playing') ? '\u25A0' : '\u25B6';
    var stopTxt = badgeEl.querySelector('.mtarec-btn-stop .ms-txt');
    if (stopTxt) stopTxt.textContent = (mode === 'recording') ? 'recording' : 'stop';
    if (mode === 'recording') {
      startStopGlow();
    } else {
      stopStopGlow();
    }
  }

  /* =========================================================
     RESULT  PANEL  (in-page floating panel)
     ========================================================= */
  function csvQuote(val) {
    if (val == null) return '';
    var s = String(val);
    if (s.indexOf(',') !== -1 || s.indexOf('\n') !== -1 || s.indexOf('\r') !== -1 || s.indexOf('"') !== -1) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function stepsToCSV(testName, steps) {
    var parts = [csvQuote(testName)];
    for (var i = 0; i < steps.length; i++) {
      var step = steps[i];
      parts.push(csvQuote(step.xpath || ''), csvQuote(step.value || ''), step.action);
    }
    return parts.join(',');
  }

  function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function showResultPanel(steps, testName, title) {
    if (panelEl) panelEl.remove();

    var csv = stepsToCSV(testName || 'Untitled', steps);
    var id = '__mtarec_result';

    var css = document.createElement('style');
    css.id = id + '_css';
    css.textContent = [
      '#' + id + ' {',
      '  all:initial; position:fixed; bottom:60px; right:12px; z-index:2147483647;',
      '  background:#1e1e1e; color:#eee; border-radius:10px;',
      '  box-shadow:0 6px 24px rgba(0,0,0,0.5);',
      '  width:420px; max-height:70vh; overflow:hidden;',
      '  font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
      '  display:flex; flex-direction:column;',
      '  border:1px solid #333;',
      '}',
      '#' + id + ' * { all:revert; }',
      '#' + id + ' .hdr {',
      '  display:flex; align-items:center; gap:10px;',
      '  padding:10px 14px; background:#c8232c; flex-shrink:0;',
      '  cursor:grab; user-select:none;',
      '}',
      '#' + id + ' .hdr.dragging { cursor:grabbing; }',
      '#' + id + ' .hdr span.title { font-weight:600; font-size:13px; color:#fff; }',
      '#' + id + ' .hdr span.count { font-size:11px; color:rgba(255,255,255,0.7); margin-left:auto; }',
      '#' + id + ' .hdr button {',
      '  all:initial; font:16px/1 sans-serif; cursor:pointer; color:rgba(255,255,255,0.7);',
      '  padding:0 4px; border-radius:4px;',
      '}',
      '#' + id + ' .hdr button:hover { color:#fff; background:rgba(255,255,255,0.15); }',
      '#' + id + ' .list {',
      '  padding:6px 0; overflow-y:auto; flex:1;',
      '  background:#181818; max-height:320px;',
      '}',
      '#' + id + ' .list .row {',
      '  padding:3px 14px; font:11px/1.5 Consolas,"Courier New",monospace; color:#ccc;',
      '  border-bottom:1px solid #252525; white-space:pre; overflow:hidden; text-overflow:ellipsis;',
      '}',
      '#' + id + ' .list .row:last-child { border-bottom:none; }',
      '#' + id + ' .ftr {',
      '  display:flex; gap:6px; padding:8px 14px; border-top:1px solid #333; flex-shrink:0; background:#1e1e1e;',
      '}',
      '#' + id + ' .ftr button {',
      '  all:initial; font:12px/1 -apple-system,sans-serif; cursor:pointer;',
      '  padding:5px 12px; border-radius:6px; border:1px solid #555;',
      '  background:#2a2a2a; color:#eee; transition:background 0.15s;',
      '}',
      '#' + id + ' .ftr button:hover { background:#3a3a3a; }',
      '#' + id + ' .ftr .btn-copy { background:#1a6dc8; border-color:#1a6dc8; }',
      '#' + id + ' .ftr .btn-copy:hover { background:#1f7ee6; }',
      '#' + id + ' .ftr .btn-record { background:#2e7d32; border-color:#2e7d32; }',
      '#' + id + ' .ftr .btn-record:hover { background:#388e3c; }',
      '#' + id + ' .ftr .btn-close { margin-left:auto; background:transparent; border-color:transparent; color:#888; }',
      '#' + id + ' .ftr .btn-close:hover { color:#eee; }',
    ].join('\n');
    document.head.appendChild(css);

    var listHtml = [];
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i];
      var line = (i + 1) + '. ' + csvQuote(s.xpath || '') + ',' + csvQuote(s.value || '') + ',' + s.action;
      if (line.length > 70) line = line.slice(0, 67) + '...';
      listHtml.push('<div class="row">' + escHtml(line) + '</div>');
    }

    panelEl = document.createElement('div');
    panelEl.id = id;
    panelEl.innerHTML = [
      '<div class="hdr">',
        '<span class="title">' + (title || 'Recording Complete') + '</span>',
        '<span class="count">' + steps.length + ' step(s)</span>',
        '<button class="btn-x">\u00D7</button>',
      '</div>',
      '<div class="list">' + listHtml.join('') + '</div>',
      '<div class="ftr">',
        '<button class="btn-play">\u25B6 Play</button>',
        '<button class="btn-record">\u25C0 Continue Recording</button>',
        '<button class="btn-copy">Copy CSV</button>',
        '<button class="btn-save">Download</button>',
        '<button class="btn-close">Close</button>',
      '</div>'
    ].join('');
    document.body.appendChild(panelEl);

    panelEl.querySelector('.btn-x').addEventListener('click', function () { removePanel(); });
    panelEl.querySelector('.btn-close').addEventListener('click', function () { removePanel(); });

    var hdr = panelEl.querySelector('.hdr');
    hdr.addEventListener('mousedown', function (e) {
      if (e.target.tagName === 'BUTTON') return;
      e.preventDefault();
      var rect = panelEl.getBoundingClientRect();
      var offX = e.clientX - rect.left;
      var offY = e.clientY - rect.top;
      hdr.classList.add('dragging');
      function onMove(ev) {
        var x = Math.max(-panelEl.offsetWidth + 60, Math.min(ev.clientX - offX, window.innerWidth - 20));
        var y = Math.max(0, Math.min(ev.clientY - offY, window.innerHeight - 40));
        panelEl.style.left = x + 'px';
        panelEl.style.top = y + 'px';
        panelEl.style.right = 'auto';
        panelEl.style.bottom = 'auto';
      }
      function onUp() {
        hdr.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    panelEl.querySelector('.btn-play').addEventListener('click', function () {
      removePanel();
      if (!badgeEl) createBadge();
      startPlayback();
    });
    panelEl.querySelector('.btn-record').addEventListener('click', function () {
      removePanel();
      startRecording(false);
    });
    panelEl.querySelector('.btn-copy').addEventListener('click', function () {
      navigator.clipboard.writeText(csv).then(function () {
        var b = panelEl.querySelector('.btn-copy');
        b.textContent = 'Copied!';
        setTimeout(function () { b.textContent = 'Copy CSV'; }, 1500);
      }).catch(function () {
        var ta = panelEl.querySelector('textarea');
        if (ta) { ta.select(); document.execCommand('copy'); }
      });
    });
    panelEl.querySelector('.btn-save').addEventListener('click', function () {
      var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = (testName || 'recording') + '_' + Date.now() + '.csv';
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  function removePanel() {
    var c = document.getElementById('__mtarec_result_css');
    if (c) c.remove();
    if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
    panelEl = null;
  }

  /* =========================================================
     BADGE  UPDATE  HELPERS
     ========================================================= */
  function updateStepBtn() {
    var btn = badgeEl && badgeEl.querySelector('.mtarec-dropdown-btn');
    if (btn) {
      var cnt = btn.querySelector('.mtarec-count');
      if (cnt) cnt.textContent = locSteps.length;
    }
    var playBtn = badgeEl && badgeEl.querySelector('.mtarec-btn-play');
    if (playBtn) playBtn.classList.toggle('disabled', locSteps.length === 0);
    var drop = badgeEl && badgeEl.querySelector('.mtarec-dropdown');
    if (drop && drop.style.display === 'block') buildDropdownEl(drop);
  }

  function buildDropdownEl(drop) {
    if (!drop) return;
    var html = [];
    for (var i = 0; i < locSteps.length; i++) {
      var step = locSteps[i];
      var path = step.xpath || '';
      if (path.length > 27) path = '...' + path.slice(-27);
      var val = step.value || '';
      var act = step.action || '';
      html.push('<div class="dr" data-idx="' + i + '" title="' + escHtml((step.xpath || '') + ', ' + (step.value || '') + ', ' + step.action) + '">');
      html.push('<span class="dn">' + (i + 1) + '.</span>');
      html.push('<span class="dc">' + escHtml(path) + '<span class="dc-sep">, </span>' + escHtml(val) + '<span class="dc-sep">, </span>' + escHtml(act) + '</span>');
      html.push('<button class="del">\u00D7</button>');
      html.push('</div>');
    }
    drop.innerHTML = html.join('');

    var rows = drop.querySelectorAll('.dr');
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var delBtn = row.querySelector('.del');
      if (!delBtn) continue;
      delBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var idx = parseInt(this.parentNode.getAttribute('data-idx'), 10);
        deleteStep(idx);
      });
    }
  }

  function deleteStep(idx) {
    if (idx < 0 || idx >= locSteps.length) return;
    locSteps.splice(idx, 1);
    playSteps.splice(idx, 1);
    updateStepBtn();
    sendMsg(
      { type: 'REC_DELETE_STEP', index: idx },
      function () { updateStepBtn(); }
    );
  }

  function showDropdown() {
    if (!dropdownEl || locSteps.length === 0) return;
    buildDropdownEl(dropdownEl);
    dropdownEl.style.display = 'block';

    var badgeRect = badgeEl.getBoundingClientRect();
    var spaceBelow = window.innerHeight - badgeRect.bottom;
    var spaceAbove = badgeRect.top;
    var dropH = Math.min(300, locSteps.length * 26 + 20);
    dropdownEl.style.top = '';
    dropdownEl.style.bottom = '';
    dropdownEl.style.marginTop = '';
    dropdownEl.style.marginBottom = '';
    if (spaceBelow >= dropH) {
      dropdownEl.style.top = '100%';
      dropdownEl.style.marginTop = '4px';
    } else if (spaceAbove >= dropH) {
      dropdownEl.style.bottom = '100%';
      dropdownEl.style.marginBottom = '4px';
    } else {
      dropdownEl.style.top = '100%';
      dropdownEl.style.marginTop = '4px';
      dropdownEl.style.maxHeight = Math.max(60, spaceBelow - 8) + 'px';
    }
  }

  /* =========================================================
     REC  BADGE
     ========================================================= */
  var BADGE_ID = '__mtarec_badge';

  function createBadge() {
    if (badgeEl) return;

    var css = document.createElement('style');
    css.id = BADGE_ID + '_css';
    css.textContent = [
      '#' + BADGE_ID + ' {',
      '  all: initial; position:fixed;',
      '  bottom:24px; left:50%; transform:translateX(-50%);',
      '  z-index:2147483647;',
      '  background:#c8232c; color:#fff;',
      '  font:16px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
      '  padding:7px 10px; border-radius:26px;',
      '  box-shadow:0 3px 12px rgba(200,35,44,0.45);',
      '  display:flex; align-items:center; gap:5px;',
      '  transition:width 0.2s ease;',
      '  user-select:none; white-space:nowrap; cursor:default;',
      '}',
      '#' + BADGE_ID + ' * { all:revert; }',
      '#' + BADGE_ID + '.minimized { overflow:hidden; white-space:nowrap; direction:rtl; }',
      '#' + BADGE_ID + '.minimized > :not(.mtarec-dots) { display:none !important; }',
      '#' + BADGE_ID + '.mode-idle { background:#757575; box-shadow:0 3px 12px rgba(117,117,117,0.45); }',
      '#' + BADGE_ID + '.mode-playing { background:#1565c0; box-shadow:0 3px 12px rgba(21,101,192,0.45); }',
      '#' + BADGE_ID + ' .mtarec-btn-play.disabled { opacity:0.35; cursor:default; pointer-events:none; }',

      '#' + BADGE_ID + ' .mtarec-dots {',
      '  cursor:grab; padding:3px 4px;',
      '  display:grid; grid-template-columns:repeat(2,1fr); gap:2px;',
      '  align-items:center; justify-items:center;',
      '  min-width:28px; height:26px; box-sizing:border-box; flex-shrink:0;',
      '}',
      '#' + BADGE_ID + ' .mtarec-dots b {',
      '  display:block; width:3.5px; height:3.5px;',
      '  background:rgba(200,200,200,0.8); border-radius:50%;',
      '}',
      '#' + BADGE_ID + ' .mtarec-dots:active { cursor:grabbing; }',

      '#' + BADGE_ID + ' .mtarec-btn {',
      '  all:initial; font:14px/1 -apple-system,sans-serif;',
      '  padding:5px 8px; border-radius:10px;',
      '  border:1px solid rgba(255,255,255,0.25);',
      '  background:rgba(255,255,255,0.12); color:#fff; cursor:pointer;',
      '  display:inline-flex; align-items:center; justify-content:center;',
      '  min-width:28px; height:26px;',
      '  box-sizing:border-box;',
      '  transition:background 0.15s; white-space:nowrap;',
      '}',
      '#' + BADGE_ID + ' .mtarec-btn:hover { background:rgba(255,255,255,0.28); }',
      '#' + BADGE_ID + ' .mtarec-btn:active { transform:scale(0.93); }',
      '#' + BADGE_ID + ' .mtarec-btn-stop {',
      '  position:relative; overflow:hidden; font-weight:700; background:rgba(0,0,0,0.2);',
      '  width:96px;',
      '  /* 流光圖案寬度由 JS 依按鈕寬度動態設定 (--pattern-w1/w2) */',
      '  --pattern-w1:62px; --pattern-w2:48px;',
      '}',
      '#' + BADGE_ID + ' .mtarec-btn-stop:hover { background:rgba(0,0,0,0.35); }',
      '#' + BADGE_ID + ' .mtarec-btn-stop .ms-layer {',
      '  position:absolute; inset:0; border-radius:inherit; pointer-events:none; display:block;',
      '}',
      '#' + BADGE_ID + ' .mtarec-btn-stop .ms-glow {',
      '  z-index:1; background-repeat:repeat-x;',
      '  background-size:var(--pattern-w1) 100%;',
      '  background-image:linear-gradient(105deg,',
      '    transparent 0%, transparent 35%, rgba(255,255,255,0.08) 42%,',
      '    rgba(255,255,255,0.28) 50%, rgba(255,255,255,0.08) 58%,',
      '    transparent 65%, transparent 100%);',
      '}',
      '#' + BADGE_ID + ' .mtarec-btn-stop .ms-glow2 {',
      '  z-index:2; background-repeat:repeat-x;',
      '  background-size:var(--pattern-w2) 100%;',
      '  background-image:linear-gradient(105deg,',
      '    transparent 0%, transparent 40%, rgba(255,255,255,0.04) 46%,',
      '    rgba(255,255,255,0.14) 50%, rgba(255,255,255,0.04) 54%,',
      '    transparent 60%, transparent 100%);',
      '}',
      '#' + BADGE_ID + ' .mtarec-btn-stop .ms-txt {',
      '  position:relative; z-index:4; display:flex; align-items:center; justify-content:center;',
      '  width:100%; height:100%;',
      '}',
      '#' + BADGE_ID + ' .mtarec-btn-undo { font-size:16px; }',
      '#' + BADGE_ID + ' .mtarec-btn-more { font-weight:700; font-size:16px; }',
      '#' + BADGE_ID + ' .mtarec-btn-more.active { background:#2e7d32; border-color:#4caf50; }',

      '#' + BADGE_ID + ' .mtarec-more-menu {',
      '  display:none; position:absolute; left:50%; bottom:100%; margin-bottom:4px;',
      '  transform:translateX(-50%);',
      '  background:#2b2b2b !important; color:#ddd !important; border-radius:8px; padding:4px;',
      '  width:100%; min-width:0; box-sizing:border-box;',
      '  box-shadow:0 4px 16px rgba(0,0,0,0.5); z-index:2147483647;',
      '  font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
      '  grid-template-columns:repeat(2, minmax(0,1fr)); gap:2px;',
      '}',
      '#' + BADGE_ID + ' .mtarec-more-menu .mm-item {',
      '  padding:6px 10px; cursor:pointer; display:flex; align-items:center; gap:6px;',
      '  transition:background 0.1s; border-radius:4px;',
      '  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;',
      '}',
      '#' + BADGE_ID + ' .mtarec-more-menu .mm-item:hover { background:rgba(255,255,255,0.08); }',
      '#' + BADGE_ID + ' .mtarec-more-menu .mm-icon {',
      '  display:inline-flex !important; align-items:center !important; justify-content:center !important;',
      '  width:18px !important; height:18px !important; flex-shrink:0 !important;',
      '  font-size:14px !important; line-height:1 !important;',
      '}',
      '#' + BADGE_ID + ' .mtarec-more-menu .mm-icon svg, #' + BADGE_ID + ' .mtarec-more-menu .mm-icon svg * {',
      '  stroke:currentColor !important; fill:none !important; stroke-width:1.5 !important;',
      '  stroke-linecap:round !important; stroke-linejoin:round !important;',
      '}',
      '#' + BADGE_ID + ' .mtarec-sep { color:rgba(255,255,255,0.35); font-size:15px; margin:0 1px; user-select:none; }',

      '#' + BADGE_ID + ' .mtarec-dropdown-btn {',
      '  cursor:pointer; padding:3px 8px; border-radius:10px;',
      '  display:inline-flex; align-items:center; gap:4px;',
      '  height:26px; min-width:28px;',
      '  border:1px solid rgba(255,255,255,0.25);',
      '  background:rgba(255,255,255,0.12); color:#fff;',
      '  box-sizing:border-box; white-space:nowrap;',
      '  font-size:13px;',
      '  transition:background 0.15s;',
      '}',
      '#' + BADGE_ID + ' .mtarec-dropdown-btn:hover { background:rgba(255,255,255,0.28); }',
      '#' + BADGE_ID + ' .mtarec-dropdown-btn .arrow { font-size:8px; opacity:0.6; margin-left:2px; }',
      '#' + BADGE_ID + ' .mtarec-dropdown-btn .mtarec-count { font-weight:700; font-size:13px; min-width:10px; text-align:center; }',

      '#' + BADGE_ID + ' .mtarec-dropdown {',
      '  display:none; position:absolute; left:0;',
      '  background:#2b2b2b; color:#ddd; border-radius:6px; padding:4px 0;',
      '  width:100%; min-width:0; box-sizing:border-box; max-height:300px; overflow-y:auto;',
      '  box-shadow:0 4px 16px rgba(0,0,0,0.5); z-index:2147483647;',
      '  font:11px/1.5 Consolas,"Courier New",monospace;',
      '}',
      '#' + BADGE_ID + ' .mtarec-dropdown .dr {',
      '  display:flex; gap:6px; padding:3px 10px; align-items:baseline; position:relative;',
      '}',
      '#' + BADGE_ID + ' .mtarec-dropdown .dr:hover { background:rgba(255,255,255,0.06); }',
      '#' + BADGE_ID + ' .mtarec-dropdown .dn { color:#888; min-width:22px; text-align:right; flex-shrink:0; font-size:10px; }',
      '#' + BADGE_ID + ' .mtarec-dropdown .dc { color:#ccc; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; font-size:10px; }',
      '#' + BADGE_ID + ' .mtarec-dropdown .dc-sep { color:#666; }',
      '#' + BADGE_ID + ' .mtarec-dropdown .del {',
      '  all:initial; font:12px/1 sans-serif; cursor:pointer; color:#666;',
      '  padding:0 2px; opacity:0; transition:opacity 0.1s; flex-shrink:0;',
      '}',
      '#' + BADGE_ID + ' .mtarec-dropdown .dr:hover .del { opacity:1; }',
      '#' + BADGE_ID + ' .mtarec-dropdown .del:hover { color:#ff6b6b; }',
    ].join('\n');
    document.head.appendChild(css);

    badgeEl = document.createElement('div');
    badgeEl.id = BADGE_ID;

    var menuHtml = [];
    for (var mi = 0; mi < MORE_ITEMS.length; mi++) {
      var item = MORE_ITEMS[mi];
      menuHtml.push(
        '<div class="mm-item" data-action="' + item.action + '">' +
          '<span class="mm-icon">' + (item.emoji || '') + '</span>' +
          '<span>' + item.label + '</span>' +
        '</div>'
      );
    }

    badgeEl.innerHTML = [
      '<span class="mtarec-dots"><b></b><b></b><b></b><b></b><b></b><b></b></span>',
      '<button class="mtarec-btn mtarec-btn-stop">',
        '<span class="ms-layer ms-glow"></span>',
        '<span class="ms-layer ms-glow2"></span>',
        '<span class="ms-txt">recording</span>',
      '</button>',
      '<button class="mtarec-btn mtarec-btn-play">\u25B6</button>',
      '<span class="mtarec-sep">|</span>',
      '<span class="mtarec-dropdown-btn">',
        'steps: <span class="mtarec-count">0</span>',
        '<span class="arrow">&#x25BC;</span>',
      '</span>',
      '<button class="mtarec-btn mtarec-btn-undo">\u232B</button>',
      '<button class="mtarec-btn mtarec-btn-pause" data-sec="2">+2s</button>',
      '<button class="mtarec-btn mtarec-btn-more">\u22EF</button>',
      '<div class="mtarec-dropdown"></div>',
      '<div class="mtarec-more-menu">' + menuHtml.join('') + '</div>',
    ].join('');

    dropdownEl = badgeEl.querySelector('.mtarec-dropdown');
    moreMenuEl = badgeEl.querySelector('.mtarec-more-menu');

    document.body.appendChild(badgeEl);
    updateStepBtn();

    /* --- drag --- */
    var dots = badgeEl.querySelector('.mtarec-dots');
    dots.addEventListener('mousedown', onGripDown);

    /* --- stop --- */
    badgeEl.querySelector('.mtarec-btn-stop').addEventListener('click', function (e) {
      e.stopPropagation();
      stopFromBadge();
    });

    /* --- pause --- */
    badgeEl.querySelector('.mtarec-btn-pause').addEventListener('click', function (e) {
      e.stopPropagation();
      addPauseStep(parseInt(this.getAttribute('data-sec'), 10));
    });

    /* --- undo --- */
    badgeEl.querySelector('.mtarec-btn-undo').addEventListener('click', function (e) {
      e.stopPropagation();
      undoLastStep();
    });

    /* --- play --- */
    badgeEl.querySelector('.mtarec-btn-play').addEventListener('click', function (e) {
      e.stopPropagation();
      if (this.classList.contains('disabled')) return;
      if (isPlaying) { stopPlayback(); return; }
      startPlayback();
    });

    /* --- dropdown toggle --- */
    var dropBtn = badgeEl.querySelector('.mtarec-dropdown-btn');
    dropBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (dropdownEl.style.display === 'block') {
        dropdownEl.style.display = 'none';
      } else {
        showDropdown();
      }
    });
    function scheduleHideDropdown() {
      if (dropHideTimer) clearTimeout(dropHideTimer);
      dropHideTimer = setTimeout(function () {
        if (dropdownEl) dropdownEl.style.display = 'none';
        dropHideTimer = null;
      }, 200);
    }
    dropBtn.addEventListener('mouseenter', function () {
      if (dropHideTimer) { clearTimeout(dropHideTimer); dropHideTimer = null; }
      if (locSteps.length > 0) showDropdown();
    });
    dropBtn.addEventListener('mouseleave', function () {
      scheduleHideDropdown();
    });
    dropdownEl.addEventListener('mouseenter', function () {
      if (dropHideTimer) { clearTimeout(dropHideTimer); dropHideTimer = null; }
    });
    dropdownEl.addEventListener('mouseleave', function () {
      scheduleHideDropdown();
    });
    document.addEventListener('click', onOutsideDropdownClick);

    /* --- more menu --- */
    var moreBtn = badgeEl.querySelector('.mtarec-btn-more');
    moreBtn.addEventListener('mouseenter', function () {
      exitPickMode();
      showMoreMenu();
    });
    moreBtn.addEventListener('mouseleave', function () {
      if (!mmPersistent) scheduleHideMoreMenu();
    });
    moreBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (moreMenuEl.style.display === 'grid') {
        if (mmPersistent) {
          hideMoreMenu();
        } else {
          mmPersistent = true;
        }
      } else {
        exitPickMode();
        showMoreMenu();
        mmPersistent = true;
      }
    });
    moreMenuEl.addEventListener('mouseenter', function () {
      if (mmHideTimer) { clearTimeout(mmHideTimer); mmHideTimer = null; }
    });
    moreMenuEl.addEventListener('mouseleave', function () {
      if (!mmPersistent) scheduleHideMoreMenu();
    });

    /* --- more menu items --- */
    var items = moreMenuEl.querySelectorAll('.mm-item');
    for (var ii = 0; ii < items.length; ii++) {
      items[ii].addEventListener('click', function (e) {
        e.stopPropagation();
        handleMoreItem(this.getAttribute('data-action'));
      });
    }

    /* --- close more menu when clicking outside --- */
    document.addEventListener('click', onOutsideMoreMenuClick);

    /* --- saved position --- */
    chrome.storage.local.get('mtarec_pos', function (r) {
      if (!badgeEl) return;
      var p = r.mtarec_pos;
      if (p && p.left) {
        badgeEl.style.left = p.left;
        badgeEl.style.top = p.top;
        badgeEl.style.right = 'auto';
        badgeEl.style.bottom = 'auto';
        badgeEl.style.transform = 'none';
      }
    });
  }

  /* ----- drag handlers ----- */
  function onGripDown(e) {
    e.preventDefault();
    e.stopPropagation();
    dragStarted = false;
    var rect = badgeEl.getBoundingClientRect();
    isDragging = true;
    dragOffX = e.clientX - rect.left;
    dragOffY = e.clientY - rect.top;
    badgeEl.style.transition = 'none';
    badgeEl.style.transform = 'none';
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragUp);
  }

  function onDragMove(e) {
    if (!isDragging) return;
    dragStarted = true;
    var bw = badgeEl.offsetWidth;
    var bh = badgeEl.offsetHeight;
    var x = Math.max(0, Math.min(e.clientX - dragOffX, window.innerWidth - bw));
    var y = Math.max(0, Math.min(e.clientY - dragOffY, window.innerHeight - bh));
    badgeEl.style.left   = x + 'px';
    badgeEl.style.top    = y + 'px';
    badgeEl.style.right  = 'auto';
    badgeEl.style.bottom = 'auto';
  }

  function onDragUp() {
    if (!isDragging) return;
    isDragging = false;
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragUp);
    if (!badgeEl) return;
    if (!dragStarted) {
      isMinimized = !isMinimized;
      if (isMinimized) {
        if (dropdownEl) dropdownEl.style.display = 'none';
        var rect = badgeEl.getBoundingClientRect();
        var rightEdge = rect.left + rect.width;
        var dotsEl = badgeEl.querySelector('.mtarec-dots');
        var dotsW = (dotsEl ? dotsEl.offsetWidth : 36) + 14;
        badgeEl.style.left = rect.left + 'px';
        badgeEl.style.right = 'auto';
        badgeEl.style.transform = 'none';
        badgeEl.style.width = rect.width + 'px';
        badgeEl.classList.add('minimized');
        badgeEl.offsetHeight;
        badgeEl.style.width = dotsW + 'px';
        setTimeout(function () {
          if (badgeEl) { badgeEl.style.width = ''; badgeEl.style.transition = ''; }
        }, 250);
      } else {
        badgeEl.classList.remove('minimized');
        badgeEl.style.width = '';
        badgeEl.style.transition = '';
      }
      return;
    }
    chrome.storage.local.set({
      mtarec_pos: { left: badgeEl.style.left, top: badgeEl.style.top }
    });
    badgeEl.style.transition = '';
  }

  function onOutsideDropdownClick(e) {
    if (badgeEl && !badgeEl.contains(e.target)) {
      if (dropdownEl) dropdownEl.style.display = 'none';
    }
  }

  function onOutsideMoreMenuClick(e) {
    if (badgeEl && !badgeEl.contains(e.target)) {
      hideMoreMenu();
    }
  }

  function removeBadge() {
    var c = document.getElementById(BADGE_ID + '_css');
    if (c) c.remove();
    if (badgeEl && badgeEl.parentNode) badgeEl.parentNode.removeChild(badgeEl);
    badgeEl = null;
    dropdownEl = null;
    moreMenuEl = null;
  }

  /* =========================================================
     RECORDING  CONTROL
     ========================================================= */
  function startRecording(clearSteps) {
    if (isRecording) return;
    isRecording = true;
    if (clearSteps !== false) {
      locSteps = [];
      playSteps = [];
      recordStartUrl = window.location.href;
    }
    removePanel();
    if (!badgeEl) createBadge();
    setBadgeMode('recording');
    updateStepBtn();
    document.addEventListener('click', onClick, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('mouseover', onPickHover, true);
    document.addEventListener('mouseout', onPickUnhover, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointermove', onPointerMoveCancel, true);
    window.addEventListener('beforeunload', onBeforeUnload);
  }

  function stopRecording() {
    if (!isRecording) return;
    isRecording = false;
    exitPickMode();
    clearPendingPtr();
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('change', onChange, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('mouseover', onPickHover, true);
    document.removeEventListener('mouseout', onPickUnhover, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('pointermove', onPointerMoveCancel, true);
    window.removeEventListener('beforeunload', onBeforeUnload);
    setBadgeMode('idle');
  }

  function onBeforeUnload(e) {
    e.preventDefault();
    e.returnValue = 'Recording in progress. Leave page?';
  }

  /* =========================================================
     MESSAGES  FROM  POPUP
     ========================================================= */
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    switch (msg.type) {
      case 'REC_START_RECORDING':
        startRecording();
        sendResponse({ success: true });
        break;
      case 'REC_STOP_RECORDING':
        stopRecording();
        sendResponse({ success: true });
        break;
      case 'REC_PLAY':
        if (!isPlaying && playSteps.length > 0) {
          if (!badgeEl) createBadge();
          startPlayback();
        }
        sendResponse({ success: true });
        break;
      case 'REC_STOP_PLAY':
        stopPlayback();
        sendResponse({ success: true });
        break;
      default:
        sendResponse({ error: 'unknown' });
    }
  });

})();
