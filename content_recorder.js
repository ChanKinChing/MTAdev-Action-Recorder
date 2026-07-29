(function () {
  if (window.__mtarec_active) return;
  window.__mtarec_active = true;

  /* =========================================================
     STATE
     ========================================================= */
  let isRecording = false;
  let badgeEl = null;
  let dropdownEl = null;
  let panelEl = null;
  let isDragging = false;
  let dragOffX = 0, dragOffY = 0;
  let locSteps = [];

  let checkElementMode = false;
  let highlightedEl = null;
  let isMinimized = false;
  let dragStarted = false;

  /* =========================================================
     XPATH  GENERATOR
     ========================================================= */
  function esc(val) {
    return val.replace(/"/g, '\\"');
  }

  function generateXPath(el) {
    if (!el || el === document || el === document.body) return '//body';
    const tag = (el.tagName || '').toLowerCase();
    if (!tag) return '';

    if (el.hasAttribute('name')) {
      const n = el.getAttribute('name');
      if (n && n.trim()) {
        return '//*[@name="' + esc(n.trim()) + '"]';
      }
    }
    if (el.id) {
      return '//*[@id="' + esc(el.id) + '"]';
    }
    if (el.hasAttribute('data-testid')) {
      const d = el.getAttribute('data-testid');
      if (d && d.trim()) {
        return '//*[@data-testid="' + esc(d.trim()) + '"]';
      }
    }
    if (el.hasAttribute('aria-label')) {
      const a = el.getAttribute('aria-label');
      if (a && a.trim()) {
        return '//*[@aria-label="' + esc(a.trim()) + '"]';
      }
    }
    if (el.className && typeof el.className === 'string') {
      const classes = el.className.trim().split(/\s+/).filter(c => c && !c.startsWith('ng-'));
      for (const c of classes) {
        try {
          if (document.querySelectorAll('.' + CSS.escape(c)).length === 1) {
            return '//*[contains(@class,"' + esc(c) + '")]';
          }
        } catch (_) {}
      }
    }
    return buildFullXPath(el);
  }

  function buildFullXPath(el) {
    if (!el || el === document.body) return '/html/body';
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document) {
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
    return '/' + parts.join('/');
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

    if (checkElementMode) {
      e.preventDefault();
      e.stopPropagation();
      sendStep(generateXPath(el), '', 'present');
      exitCheckMode();
      return;
    }

    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (['checkbox', 'radio'].includes(t)) {
        sendStep(generateXPath(el), '', 'click');
      }
      return;
    }
    sendStep(generateXPath(el), '', 'click');
  }

  function onChange(e) {
    if (!isRecording) return;
    const el = e.target;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'select') {
      const val = el.options[el.selectedIndex] ? el.options[el.selectedIndex].value : '';
      sendStep(generateXPath(el), val, 'dropdown');
    } else if (isTextInput(el)) {
      if (el.value) {
        sendStep(generateXPath(el), el.value, 'type');
      }
    }
  }

  function onKeyDown(e) {
    if (!isRecording) return;
    const controlKeys = ['Tab', 'Enter', 'Escape', 'Delete'];
    if (!controlKeys.includes(e.key)) return;
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return;
    if (badgeEl && badgeEl.contains(el)) return;
    sendStep(generateXPath(el), e.key.toUpperCase(), 'press');
  }

  function onCheckHover(e) {
    if (!checkElementMode) return;
    var el = e.target;
    if (badgeEl && badgeEl.contains(el)) return;
    if (el === highlightedEl) return;
    clearCheckHighlight();
    el.style.outline = '2px solid #ff1744';
    el.style.outlineOffset = '-2px';
    highlightedEl = el;
  }

  function onCheckUnhover(e) {
    if (!checkElementMode) return;
    var el = e.target;
    if (el === highlightedEl) {
      el.style.outline = '';
      highlightedEl = null;
    }
  }

  function exitCheckMode() {
    checkElementMode = false;
    clearCheckHighlight();
    var cb = badgeEl && badgeEl.querySelector('.mtarec-btn-check');
    if (cb) cb.classList.remove('active');
  }

  function clearCheckHighlight() {
    if (highlightedEl) {
      highlightedEl.style.outline = '';
      highlightedEl = null;
    }
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

  function sendStep(xpath, value, action) {
    var step = { xpath: xpath, value: value, action: action, url: window.location.href };
    locSteps.push(step);
    updateStepBtn();
    sendMsg(
      { type: 'REC_ADD_STEP', step: step },
      function (resp) {
        if (resp) updateStepBtn();
      }
    );
  }

  function undoLastStep() {
    if (locSteps.length === 0) return;
    locSteps.pop();
    updateStepBtn();
    sendMsg(
      { type: 'REC_DELETE_LAST_STEP' },
      function () { updateStepBtn(); }
    );
  }

  function stopFromBadge() {
    stopRecording();
    sendMsg({ type: 'REC_STOP' }, function (resp) {
      if (resp && resp.success && resp.steps) {
        showResultPanel(resp.steps, resp.testName);
      }
    });
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
    var parts = [csvQuote(testName), ''];
    for (var i = 0; i < steps.length; i++) {
      var step = steps[i];
      parts.push(csvQuote(step.xpath || ''), csvQuote(step.value || ''), step.action);
    }
    return parts.join(',');
  }

  function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function showResultPanel(steps, testName) {
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
        '<span class="title">Recording Complete</span>',
        '<span class="count">' + steps.length + ' step(s)</span>',
        '<button class="btn-x">\u00D7</button>',
      '</div>',
      '<div class="list">' + listHtml.join('') + '</div>',
      '<div class="ftr">',
        '<button class="btn-copy">Copy CSV</button>',
        '<button class="btn-save">Download</button>',
        '<button class="btn-close">Close</button>',
      '</div>'
    ].join('');
    document.body.appendChild(panelEl);

    panelEl.querySelector('.btn-x').addEventListener('click', function () { removePanel(); });
    panelEl.querySelector('.btn-close').addEventListener('click', function () { removePanel(); });
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
    var drop = badgeEl && badgeEl.querySelector('.mtarec-dropdown');
    if (drop && drop.style.display === 'block') buildDropdownEl(drop);
  }

  function buildDropdownEl(drop) {
    if (!drop) return;
    var html = [];
    for (var i = 0; i < locSteps.length; i++) {
      var displayVal = locSteps[i].value || '';
      if (locSteps[i].xpath && locSteps[i].xpath.length > displayVal.length) displayVal = locSteps[i].xpath;
      if (displayVal.length > 55) displayVal = displayVal.slice(0, 52) + '...';
      html.push('<div class="dr" data-idx="' + i + '">');
      html.push('<span class="dn">' + (i + 1) + '.</span>');
      html.push('<span class="da">' + escHtml(locSteps[i].action) + '</span>');
      html.push('<span class="dv">' + escHtml(displayVal) + '</span>');
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
    var dropH = Math.min(260, locSteps.length * 26 + 20);
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
      '  user-select:none; white-space:nowrap; cursor:default;',
      '}',
      '#' + BADGE_ID + ' * { all:revert; }',
      '#' + BADGE_ID + '.minimized > :not(.mtarec-dots) { display:none !important; }',

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
      '#' + BADGE_ID + ' .mtarec-btn-check { font-weight:700; }',
      '#' + BADGE_ID + ' .mtarec-btn-check.active { background:#2e7d32; border-color:#4caf50; }',

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
      '#' + BADGE_ID + ' .mtarec-dropdown .da { color:#7cb7ff; min-width:64px; flex-shrink:0; }',
      '#' + BADGE_ID + ' .mtarec-dropdown .dv { color:#bbb; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }',
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

    badgeEl.innerHTML = [
      '<span class="mtarec-dots"><b></b><b></b><b></b><b></b><b></b><b></b></span>',
      '<button class="mtarec-btn mtarec-btn-stop">\u25A0</button>',
      '<button class="mtarec-btn mtarec-btn-pause" data-sec="2">+2s</button>',
      '<button class="mtarec-btn mtarec-btn-pause" data-sec="5">+5s</button>',
      '<button class="mtarec-btn mtarec-btn-check">\u2713</button>',
      '<button class="mtarec-btn mtarec-btn-undo">\u232B</button>',
      '<span class="mtarec-dropdown-btn">',
        'steps: <span class="mtarec-count">0</span>',
        '<span class="arrow">&#x25BC;</span>',
      '</span>',
      '<div class="mtarec-dropdown"></div>'
    ].join('');

    dropdownEl = badgeEl.querySelector('.mtarec-dropdown');

    document.body.appendChild(badgeEl);

    /* --- drag --- */
    var dots = badgeEl.querySelector('.mtarec-dots');
    dots.addEventListener('mousedown', onGripDown);

    /* --- stop --- */
    badgeEl.querySelector('.mtarec-btn-stop').addEventListener('click', function (e) {
      e.stopPropagation();
      stopFromBadge();
    });

    /* --- pause --- */
    var pauseBtns = badgeEl.querySelectorAll('.mtarec-btn-pause');
    for (var i = 0; i < pauseBtns.length; i++) {
      pauseBtns[i].addEventListener('click', function (e) {
        e.stopPropagation();
        sendStep('', this.getAttribute('data-sec'), 'pause');
      });
    }

    /* --- check element --- */
    var checkBtn = badgeEl.querySelector('.mtarec-btn-check');
    checkBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (checkElementMode) {
        exitCheckMode();
      } else {
        checkElementMode = true;
        this.classList.add('active');
      }
    });

    /* --- undo --- */
    badgeEl.querySelector('.mtarec-btn-undo').addEventListener('click', function (e) {
      e.stopPropagation();
      undoLastStep();
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

    /* --- close dropdown when clicking outside --- */
    document.addEventListener('click', function (e) {
      if (badgeEl && !badgeEl.contains(e.target)) {
        if (dropdownEl) { dropdownEl.style.display = 'none'; }
      }
    });

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
        badgeEl.classList.add('minimized');
      } else {
        badgeEl.classList.remove('minimized');
      }
      return;
    }
    chrome.storage.local.set({
      mtarec_pos: { left: badgeEl.style.left, top: badgeEl.style.top }
    });
  }

  function removeBadge() {
    var c = document.getElementById(BADGE_ID + '_css');
    if (c) c.remove();
    if (badgeEl && badgeEl.parentNode) badgeEl.parentNode.removeChild(badgeEl);
    badgeEl = null;
    dropdownEl = null;
    locSteps = [];
  }

  /* =========================================================
     RECORDING  CONTROL
     ========================================================= */
  function startRecording() {
    if (isRecording) return;
    isRecording = true;
    locSteps = [];
    removePanel();
    createBadge();
    document.addEventListener('click', onClick, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('mouseover', onCheckHover, true);
    document.addEventListener('mouseout', onCheckUnhover, true);
    window.addEventListener('beforeunload', onBeforeUnload);
  }

  function stopRecording() {
    if (!isRecording) return;
    isRecording = false;
    exitCheckMode();
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('change', onChange, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('mouseover', onCheckHover, true);
    document.removeEventListener('mouseout', onCheckUnhover, true);
    window.removeEventListener('beforeunload', onBeforeUnload);
    removeBadge();
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
      default:
        sendResponse({ error: 'unknown' });
    }
    return true;
  });

})();
