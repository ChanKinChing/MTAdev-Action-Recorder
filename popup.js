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
  var parts = [csvQuote(testName)];
  for (var i = 0; i < steps.length; i++) {
    var step = steps[i];
    if (step.action === 'open') {
      parts.push(csvQuote(step.value), '', 'open');
    } else {
      parts.push(csvQuote(step.xpath || ''), csvQuote(step.value || ''), step.action);
    }
  }
  return parts.join(',');
}

function parseCSVLine(text) {
  var fields = [];
  var cur = '';
  var inQuotes = false;
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { fields.push(cur); cur = ''; }
      else cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

function parseCSV(text) {
  var parts = parseCSVLine(String(text).replace(/\r?\n/g, ''));
  var testName = parts[0] || 'Untitled';
  var steps = [];
  for (var i = 1; i + 2 < parts.length; i += 3) {
    steps.push({
      xpath: parts[i] || '',
      value: parts[i + 1] || '',
      action: parts[i + 2] || ''
    });
  }
  return { testName: testName, steps: steps };
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

    var resp = await chrome.runtime.sendMessage({
      type: 'REC_START',
      tabId: currentTabId,
      testName: testName
    });

    if (!resp.success) {
      setStatus('Error: ' + (resp.error || 'unknown'), 'ready');
      return;
    }

    await chrome.tabs.sendMessage(currentTabId, { type: 'REC_START_RECORDING' }).catch(function () {});

    setRecordingUI(true);
    window.close();
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

$('btnPlay').addEventListener('click', async function () {
  try {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0] && tabs[0].id) {
      await chrome.tabs.sendMessage(tabs[0].id, { type: 'REC_PLAY' }).catch(function () {});
    }
    window.close();
  } catch (_) {}
});

$('btnNew').addEventListener('click', async function () {
  await chrome.runtime.sendMessage({ type: 'REC_CLEAR' });
  resetUI();
  $('testName').value = 'Untitled';
});

$('btnScript').addEventListener('click', function () {
  $('scriptFile').click();
});

$('scriptFile').addEventListener('change', async function (e) {
  var file = e.target.files && e.target.files[0];
  $('scriptFile').value = '';
  if (!file) return;
  try {
    var text = await file.text();
    var parsed = parseCSV(text);
    if (!parsed.steps.length) {
      setStatus('No steps found in CSV', 'ready');
      return;
    }
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    var activeUrl = (tabs[0] && tabs[0].url) || '';

    var targetUrl = '';
    for (var i = 0; i < parsed.steps.length; i++) {
      if (parsed.steps[i].action === 'open') { targetUrl = parsed.steps[i].value; break; }
    }
    if (!targetUrl) targetUrl = activeUrl;
    if (!targetUrl) {
      setStatus('No open step / active URL', 'ready');
      return;
    }

    var resp = await chrome.runtime.sendMessage({
      type: 'REC_PLAY_NEW_TAB',
      steps: parsed.steps,
      url: targetUrl
    });
    if (resp && resp.success) {
      setStatus('Playing script...', 'ready');
    } else {
      setStatus('Play failed: ' + ((resp && resp.error) || 'unknown'), 'ready');
    }
    window.close();
  } catch (err) {
    setStatus('Error: ' + err.message, 'ready');
  }
});

document.addEventListener('DOMContentLoaded', checkState);
