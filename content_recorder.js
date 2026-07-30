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
  let isMinimized = false;
  let dragStarted = false;
  let pickModeAction = null;
  let highlightedEl = null;
  let mmPersistent = false;
  let mmHideTimer = null;

  /* =========================================================
     XPATH  GENERATOR
     ========================================================= */
  function esc(val) {
    return val.replace(/"/g, '\\"');
  }

  function generateXPath(el) {
    if (!el || el === document || el === document.documentElement) return '/html';
    const tag = (el.tagName || '').toLowerCase();
    if (!tag) return '';

    if (el.id) {
      return '//*[@id="' + esc(el.id) + '"]';
    }
    if (el.hasAttribute('name')) {
      const n = el.getAttribute('name');
      if (n && n.trim() && document.querySelectorAll('[name="' + CSS.escape(n.trim()) + '"]').length === 1) {
        return '//*[@name="' + esc(n.trim()) + '"]';
      }
    }
    if (el.hasAttribute('data-testid')) {
      const d = el.getAttribute('data-testid');
      if (d && d.trim() && document.querySelectorAll('[data-testid="' + CSS.escape(d.trim()) + '"]').length === 1) {
        return '//*[@data-testid="' + esc(d.trim()) + '"]';
      }
    }
    if (el.hasAttribute('aria-label')) {
      const a = el.getAttribute('aria-label');
      if (a && a.trim() && document.querySelectorAll('[aria-label="' + CSS.escape(a.trim()) + '"]').length === 1) {
        return '//*[@aria-label="' + esc(a.trim()) + '"]';
      }
    }
    if (el.className && typeof el.className === 'string') {
      const classes = el.className.trim().split(/\s+/).filter(c => c && !c.startsWith('ng-'));
      for (const c of classes) {
        try {
          if (document.querySelectorAll('.' + CSS.escape(c)).length === 1) {
            return '//*[contains(concat(" ",normalize-space(@class)," ")," ' + esc(c) + ' ")]';
          }
        } catch (_) {}
      }
    }
    return buildFullXPath(el);
  }

  function buildFullXPath(el) {
    if (!el || el === document.documentElement || el === document) return '/html';
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && cur !== document) {
      let tag = (cur.tagName || '').toLowerCase();
      if (!tag) break;
      if (cur.id) {
        parts.unshift('//*[@id="' + esc(cur.id) + '"]');
        return parts.join('/');
      }
      const parent = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(s => (s.tagName || '').toLowerCase() === tag);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(cur) + 1;
          tag += '[' + idx + ']';
        }
      }
      parts.unshift(tag);
      cur = parent;
    }
    return '/html/' + parts.join('/');
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

  function onClick(e) {
    if (!isRecording) return;
    const el = e.target;
    if (badgeEl && badgeEl.contains(el)) return;

    if (pickModeAction) {
      e.preventDefault();
      e.stopPropagation();
      var xpath = generateXPath(el);
      var val = '';
      switch (pickModeAction) {
        case 'check_presence_to_continue':
          val = 'present';
          break;
        case 'assert_text':
          val = prompt('Expected text:');
          if (val == null) { exitPickMode(); return; }
          break;
        case 'assert_attribute_value':
          var attrName = prompt('Attribute name:');
          if (attrName == null) { exitPickMode(); return; }
          var expVal = prompt('Expected value:');
          if (expVal == null) { exitPickMode(); return; }
          xpath = xpath + '/@' + attrName;
          val = expVal;
          break;
        case 'assert_class':
          val = prompt('Expected class:');
          if (val == null) { exitPickMode(); return; }
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
        case 'check':
          val = prompt('Check or uncheck?', 'check');
          if (val == null) { exitPickMode(); return; }
          sendStep(xpath, val, 'click', el);
          exitPickMode();
          return;
      }
      sendStep(xpath, val, pickModeAction, el);
      exitPickMode();
      return;
    }

    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (['checkbox', 'radio'].includes(t)) {
        sendStep(generateXPath(el), '', 'click', el);
      }
      return;
    }
    sendStep(generateXPath(el), '', 'click', el);
  }

  function onChange(e) {
    if (!isRecording) return;
    const el = e.target;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'select') {
      var val = '';
      if (el.multiple) {
        val = Array.from(el.selectedOptions).map(function (o) { return o.value; }).join(';');
      } else {
        val = el.selectedIndex >= 0 ? el.options[el.selectedIndex].value : '';
      }
      sendStep(generateXPath(el), val, 'dropdown', el);
    } else if (isTextInput(el)) {
      if (el.value) {
        sendStep(generateXPath(el), el.value, 'type', el);
      }
    }
  }

  function onKeyDown(e) {
    if (!isRecording) return;
    const controlKeys = ['Tab', 'Enter', 'Escape', 'Delete'];
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
    if (el === highlightedEl) return;
    clearPickHighlight();
    el.style.outline = '2px solid #ff1744';
    el.style.outlineOffset = '-2px';
    highlightedEl = el;
  }

  function onPickUnhover(e) {
    if (!pickModeAction) return;
    var el = e.target;
    if (el === highlightedEl) {
      el.style.outline = '';
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
      highlightedEl = null;
    }
  }

  /* =========================================================
     MORE  MENU
     ========================================================= */
  var MORE_ITEMS = [
    { action: 'present',         label: '\u2713 Present' },
    { action: 'not_present',     label: '\u2717 Not Present' },
    { action: 'visible',         label: '\u25C9 Visible' },
    { action: 'not_visible',     label: '\u25CC Not Visible' },
    { action: 'assert_text',     label: '\u2713 Assert Text...' },
    { action: 'assert_attribute_value', label: '\u2713 Assert Attr Value...' },
    { action: 'assert_class',    label: '\u2713 Assert Class...' },
    { action: 'compare_eq',      label: '\u2713 Compare Eq...' },
    { action: 'get_text',        label: '\uD83D\uDCCB Get Text...' },
    { action: 'get_attribute_value', label: '\uD83D\uDCCB Get Attr Value...' },
    { action: 'check',           label: '\u2611 Check...' },
    { action: 'check_file_download', label: '\u2B07 File Download...' },
    { action: 'check_presence_to_continue', label: '\u25B7 Check Presence...' },
    { action: 'end_check_presence_to_continue', label: '\u25A1 End Check Presence' },
    { action: 'open',            label: '\uD83C\uDF10 Open Current URL' },
    { action: 'print',           label: '\uD83D\uDDA8 Print' },
  ];

  function handleMoreItem(action) {
    if (action === 'open') {
      sendStep('', window.location.href, 'open');
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
    if (action === 'check_file_download') {
      var f = prompt('Filename pattern:');
      if (f == null) { hideMoreMenu(); return; }
      sendStep('', f, 'check_file_download');
      hideMoreMenu();
      return;
    }
    enterPickMode(action);
  }

  function showMoreMenu() {
    if (mmHideTimer) { clearTimeout(mmHideTimer); mmHideTimer = null; }
    if (!moreMenuEl) return;
    moreMenuEl.style.display = 'block';
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

  function sendStep(xpath, value, action, el) {
    var step = { xpath: xpath, value: value, action: action, url: window.location.href };
    locSteps.push(step);
    playSteps.push({ action: action, el: el || null, xpath: xpath, value: value });
    updateStepBtn();
    sendMsg(
      { type: 'REC_ADD_STEP', step: step },
      function (resp) {
        if (resp) updateStepBtn();
      }
    );
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
    stopRecording();
    sendMsg({ type: 'REC_STOP' });
    if (locSteps.length > 0) showResultPanel(locSteps, '');
  }

  /* =========================================================
     PLAYBACK  ENGINE
     ========================================================= */
  function startPlayback() {
    if (isPlaying || playSteps.length === 0) return;

    if (isRecording) {
      isRecording = false;
      exitPickMode();
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('change', onChange, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('mouseover', onPickHover, true);
      document.removeEventListener('mouseout', onPickUnhover, true);
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

    isRecording = true;
    setBadgeMode('recording');
    document.addEventListener('click', onClick, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('mouseover', onPickHover, true);
    document.addEventListener('mouseout', onPickUnhover, true);
    window.addEventListener('beforeunload', onBeforeUnload);
  }

  function executeLocalPlayback() {
    if (playSteps.length === 0) return;
    isPlaying = true;
    playAbort = false;
    var idx = 0;
    setBadgeMode('playing');
    showToast('\u25B6 [1/' + playSteps.length + '] Starting...');

    function next() {
      if (playAbort || idx >= playSteps.length) {
        endPlayback();
        return;
      }
      var ps = playSteps[idx];
      var label = ps.action + (ps.xpath ? ' ' + truncatePath(ps.xpath) : '');
      if (label.length > 45) label = label.slice(0, 42) + '...';
      showToast('\u25B6 [' + (idx + 1) + '/' + playSteps.length + '] ' + label);
      executePlayStep(ps, idx, function () {
        idx++;
        setTimeout(next, 500);
      });
    }
    next();
  }

  function stopPlayback() {
    playAbort = true;
    isPlaying = false;
    clearHighlight();
    setBadgeMode('idle');
    hideToast();
  }

  function endPlayback() {
    isPlaying = false;
    clearHighlight();
    if (!playAbort) {
      showToast('\u25C0 Resuming recording...');
      setTimeout(hideToast, 1000);
    }
  }

  function executePlayStep(ps, idx, done) {
    if (ps.action === 'pause') {
      var ms = (parseInt(ps.value, 10) || 1) * 1000;
      setTimeout(done, ms);
      return;
    }
    if (ps.action === 'open' || ps.action === 'compare_eq' || ps.action === 'check_file_download') {
      done();
      return;
    }
    if (ps.action === 'check_presence_to_continue') {
      if (!findPlayEl(ps)) {
        idx = skipCheckBlock(idx);
      }
      done();
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
    clearHighlight();
    highlightEl(el);

    switch (ps.action) {
      case 'click':
      case 'check':
        el.click();
        break;
      case 'type':
        el.value = ps.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        break;
      case 'dropdown':
        el.value = ps.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        break;
      case 'press':
        el.dispatchEvent(new KeyboardEvent('keydown', { key: ps.value, bubbles: true }));
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
      var parts = ps.xpath.split('/@');
      var xp = parts[0];
      var result = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return result.singleNodeValue;
    } catch (_) { return null; }
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

  function clearHighlight() {
    var prev = document.querySelector('[data-mtarec-hl]');
    if (prev) {
      prev.style.outline = prev.getAttribute('data-mtarec-hl-orig') || '';
      prev.removeAttribute('data-mtarec-hl');
      prev.removeAttribute('data-mtarec-hl-orig');
    }
  }

  function highlightEl(el) {
    if (!el) return;
    el.setAttribute('data-mtarec-hl-orig', el.style.outline || '');
    el.style.outline = '3px solid #e53935';
    el.style.outlineOffset = '1px';
    el.setAttribute('data-mtarec-hl', '1');
  }

  /* =========================================================
     TOAST  (bottom middle)
     ========================================================= */
  var TOAST_ID = '__mtarec_toast';

  function showToast(msg) {
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
        'pointer-events:none; white-space:nowrap;',
        'transition:opacity 0.2s;',
      ].join(' ');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
  }

  function hideToast() {
    var el = document.getElementById(TOAST_ID);
    if (el) el.style.opacity = '0';
  }

  /* =========================================================
     IDLE  BADGE  (after recording stops, shows play button)
     ========================================================= */
  function setBadgeMode(mode) {
    if (!badgeEl) return;
    badgeEl.classList.remove('mode-recording', 'mode-idle', 'mode-playing');
    badgeEl.classList.add('mode-' + mode);
    var playBtn = badgeEl.querySelector('.mtarec-btn-play');
    if (playBtn) playBtn.textContent = (mode === 'playing') ? '\u25A0' : '\u25B6';
  }

  /* =========================================================
     RESULT  PANEL  (in-page floating panel)
     ========================================================= */
  function csvQuote(val) {
    if (val == null) return '';
    var s = String(val);
    if (s.indexOf(',') !== -1 || s.indexOf('\n') !== -1) {
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
      '}',
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
    panelEl.querySelector('.btn-play').addEventListener('click', function () {
      removePanel();
      if (!badgeEl) createBadge();
      startPlayback();
    });
    panelEl.querySelector('.btn-record').addEventListener('click', function () {
      removePanel();
      startRecording();
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
      '#' + BADGE_ID + '.mode-idle { background:#2e7d32; box-shadow:0 3px 12px rgba(46,125,50,0.45); }',
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
      '#' + BADGE_ID + ' .mtarec-btn-stop { font-weight:700; background:rgba(0,0,0,0.2); }',
      '#' + BADGE_ID + ' .mtarec-btn-stop:hover { background:rgba(0,0,0,0.35); }',
      '#' + BADGE_ID + ' .mtarec-btn-undo { font-size:16px; }',
      '#' + BADGE_ID + ' .mtarec-btn-more { font-weight:700; font-size:16px; }',
      '#' + BADGE_ID + ' .mtarec-btn-more.active { background:#2e7d32; border-color:#4caf50; }',

      '#' + BADGE_ID + ' .mtarec-more-menu {',
      '  display:none; position:absolute; left:50%; bottom:100%; margin-bottom:4px;',
      '  transform:translateX(-50%);',
      '  background:#2b2b2b; color:#ddd; border-radius:8px; padding:4px 0;',
      '  min-width:220px;',
      '  box-shadow:0 4px 16px rgba(0,0,0,0.5); z-index:2147483647;',
      '  font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
      '}',
      '#' + BADGE_ID + ' .mtarec-more-menu .mm-item {',
      '  padding:6px 14px; cursor:pointer; display:flex; align-items:center; gap:6px;',
      '  transition:background 0.1s;',
      '}',
      '#' + BADGE_ID + ' .mtarec-more-menu .mm-item:hover { background:rgba(255,255,255,0.08); }',

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
      '  min-width:380px; max-height:300px; overflow-y:auto;',
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
      menuHtml.push('<div class="mm-item" data-action="' + MORE_ITEMS[mi].action + '">' + MORE_ITEMS[mi].label + '</div>');
    }

    badgeEl.innerHTML = [
      '<span class="mtarec-dots"><b></b><b></b><b></b><b></b><b></b><b></b></span>',
      '<button class="mtarec-btn mtarec-btn-stop">\u25A0</button>',
      '<button class="mtarec-btn mtarec-btn-pause" data-sec="2">+2s</button>',
      '<button class="mtarec-btn mtarec-btn-undo">\u232B</button>',
      '<button class="mtarec-btn mtarec-btn-play">\u25B6</button>',
      '<span class="mtarec-dropdown-btn">',
        'steps: <span class="mtarec-count">0</span>',
        '<span class="arrow">&#x25BC;</span>',
      '</span>',
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
      if (moreMenuEl.style.display === 'block') {
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
  function startRecording() {
    if (isRecording) return;
    isRecording = true;
    locSteps = [];
    playSteps = [];
    recordStartUrl = window.location.href;
    removePanel();
    if (!badgeEl) createBadge();
    setBadgeMode('recording');
    updateStepBtn();
    document.addEventListener('click', onClick, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('mouseover', onPickHover, true);
    document.addEventListener('mouseout', onPickUnhover, true);
    window.addEventListener('beforeunload', onBeforeUnload);
  }

  function stopRecording() {
    if (!isRecording) return;
    isRecording = false;
    exitPickMode();
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('change', onChange, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('mouseover', onPickHover, true);
    document.removeEventListener('mouseout', onPickUnhover, true);
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
      case 'REC_START_PLAYBACK':
        playSteps = msg.steps.map(function (s) {
          return { action: s.action, el: null, xpath: s.xpath, value: s.value };
        });
        locSteps = playSteps.slice();
        if (!badgeEl) createBadge();
        setTimeout(executeLocalPlayback, 500);
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
