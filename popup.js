/* =========================================================
   MTAdev Action Recorder - Popup
   ========================================================= */

let currentTabId = null;

/* =========================================================
   CSV  GENERATOR
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
    if (step.action === 'open') {
      parts.push(csvQuote(step.value), 'open');
    } else {
      parts.push(csvQuote(step.xpath || ''), csvQuote(step.value || ''), step.action);
    }
  }
  return parts.join(',');
}

/* =========================================================
   UI  HELPERS
   ========================================================= */
function $(id) { return document.getElementById(id); }

function showElement(el) { el.style.display = ''; }
function hideElement(el) { el.style.display = 'none'; }

function setStatus(text, mode) {
  $('statusText').textContent = text;
  $('statusDot').className = 'status-dot' + (mode ? ' ' + mode : '');
}

function setRecordingUI(isRec) {
  var btn = $('btnRecord');
  var icon = $('btnIcon');
  var label = $('btnLabel');

  if (isRec) {
    btn.classList.add('recording');
    icon.textContent = '\u25A0';
    label.textContent = 'Stop Recording';
    setStatus('Recording...', 'recording');
    hideElement($('previewSection'));
    hideElement($('actionsSection'));
  } else {
    btn.classList.remove('recording');
    icon.textContent = '\u25B6';
    label.textContent = 'Start Recording';
  }
}

function showResult(steps, testName) {
  hideElement($('btnRecord'));
  hideElement($('previewSection'));
  hideElement($('actionsSection'));
  setStatus('Complete - ' + steps.length + ' step(s)', 'ready');

  var csv = stepsToCSV(testName, steps);
  $('csvPreview').value = csv;
  $('finalStepCount').textContent = steps.length + ' step(s)';
  showElement($('previewSection'));
  showElement($('actionsSection'));
}

function resetUI() {
  showElement($('btnRecord'));
  hideElement($('previewSection'));
  hideElement($('actionsSection'));
  $('csvPreview').value = '';
  setRecordingUI(false);
  setStatus('Ready', 'ready');
}

/* =========================================================
   MAIN  ACTIONS
   ========================================================= */
async function startRecording() {
  try {
    var testName = $('testName').value.trim() || 'Untitled';
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabId = tabs[0].id;

    if (!tabs[0].url || tabs[0].url.startsWith('chrome://') || tabs[0].url.startsWith('about:')) {
      setStatus('Cannot record on this page', 'ready');
      return;
    }

    await chrome.scripting.executeScript({
      target: { tabId: currentTabId },
      files: ['content_recorder.js']
    });

    await chrome.runtime.sendMessage({
      type: 'REC_START',
      tabId: currentTabId,
      url: tabs[0].url,
      testName: testName
    });

    await chrome.tabs.sendMessage(currentTabId, { type: 'REC_START_RECORDING' });

    setRecordingUI(true);
  } catch (err) {
    setStatus('Error: ' + err.message, 'ready');
  }
}

async function stopRecording() {
  try {
    if (currentTabId) {
      await chrome.tabs.sendMessage(currentTabId, { type: 'REC_STOP_RECORDING' }).catch(function () {});
    }

    var resp = await chrome.runtime.sendMessage({ type: 'REC_STOP' });

    if (resp.success && resp.steps && resp.steps.length) {
      showResult(resp.steps, resp.testName || 'Untitled');
    } else {
      setStatus('No steps recorded', 'ready');
      resetUI();
    }
  } catch (err) {
    setStatus('Error: ' + err.message, 'ready');
  }
}

async function checkState() {
  try {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabId = tabs[0].id;

    var resp = await chrome.runtime.sendMessage({ type: 'REC_GET_STATE' });

    if (resp.isRecording) {
      setRecordingUI(true);
      $('testName').value = resp.testName || 'Untitled';
    } else if (resp.stepCount > 0) {
      showResult(resp.steps, resp.testName || 'Untitled');
    } else {
      resetUI();
    }
  } catch (_) {
    resetUI();
  }
}

/* =========================================================
   CLIPBOARD  &  DOWNLOAD
   ========================================================= */
function copyCSV() {
  var csv = $('csvPreview').value;
  if (!csv) return;
  navigator.clipboard.writeText(csv).then(function () {
    var btn = $('btnCopy');
    btn.textContent = 'Copied!';
    setTimeout(function () { btn.textContent = 'Copy CSV'; }, 1500);
  }).catch(function () {
    $('csvPreview').select();
    document.execCommand('copy');
  });
}

function downloadCSV() {
  var csv = $('csvPreview').value;
  if (!csv) return;
  var testName = $('testName').value.trim() || 'Untitled';
  var safeName = testName.replace(/[^a-zA-Z0-9_-]/g, '_');
  var ts = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
  var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  var url = URL.createObjectURL(blob);

  chrome.downloads.download({
    url: url,
    filename: safeName + '_' + ts + '.csv',
    saveAs: true
  });
}

/* =========================================================
   EVENT  BINDING
   ========================================================= */
$('btnRecord').addEventListener('click', async function () {
  var isRec = this.classList.contains('recording');
  if (isRec) {
    await stopRecording();
  } else {
    await startRecording();
  }
});

$('btnCopy').addEventListener('click', copyCSV);
$('btnSave').addEventListener('click', downloadCSV);

$('btnNew').addEventListener('click', async function () {
  await chrome.runtime.sendMessage({ type: 'REC_CLEAR' });
  resetUI();
  $('testName').value = 'Untitled';
});

/* =========================================================
   RESIZE  HANDLER
   ========================================================= */
(function initResize() {
  var app = $('app');
  var handle = $('resizeHandle');
  if (!app || !handle) return;
  var MIN_W = 380, MIN_H = 320;

  chrome.storage.local.get('mtarec_popup_size', function (r) {
    var s = r.mtarec_popup_size;
    if (s) {
      document.body.style.width = Math.max(MIN_W, s.w) + 'px';
      document.body.style.height = Math.max(MIN_H, s.h) + 'px';
    }
  });

  handle.addEventListener('mousedown', function (e) {
    e.preventDefault();
    e.stopPropagation();
    var startX = e.clientX, startY = e.clientY;
    var startW = document.body.offsetWidth;
    var startH = document.body.offsetHeight;

    function onMove(ev) {
      var w = Math.max(MIN_W, startW + (ev.clientX - startX));
      var h = Math.max(MIN_H, startH + (ev.clientY - startY));
      document.body.style.width = w + 'px';
      document.body.style.height = h + 'px';
    }

    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      chrome.storage.local.set({
        mtarec_popup_size: { w: document.body.offsetWidth, h: document.body.offsetHeight }
      });
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
})();

document.addEventListener('DOMContentLoaded', checkState);
