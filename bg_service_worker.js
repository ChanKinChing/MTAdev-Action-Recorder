const state = {
  isRecording: false,
  tabId: null,
  steps: [],
  testName: ''
};

chrome.storage.session.get('mtarec_state', function (r) {
  if (r.mtarec_state) {
    Object.assign(state, r.mtarec_state);
    if (state.isRecording) {
      state.isRecording = false;
      state.steps = [];
      state.testName = '';
      chrome.storage.session.remove('mtarec_state');
    }
  }
});

function saveState() {
  chrome.storage.session.set({ mtarec_state: state });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    case 'REC_START':
      if (state.isRecording) {
        sendResponse({ success: false, error: 'already recording' });
        return;
      }
      state.isRecording = true;
      state.tabId = msg.tabId || (sender.tab ? sender.tab.id : null);
      state.steps = [];
      state.testName = msg.testName || 'Untitled';
      saveState();
      sendResponse({ success: true, count: 0 });
      break;

    case 'REC_STOP':
      state.isRecording = false;
      const steps = [...state.steps];
      saveState();
      sendResponse({ success: true, steps, testName: state.testName });
      break;

    case 'REC_ADD_STEP':
      if (!state.isRecording) {
        sendResponse({ count: state.steps.length });
        return;
      }
      state.steps.push(msg.step);
      saveState();
      sendResponse({ count: state.steps.length });
      break;

    case 'REC_DELETE_LAST_STEP':
      if (state.steps.length > 0) state.steps.pop();
      saveState();
      sendResponse({ count: state.steps.length });
      break;

    case 'REC_DELETE_STEP':
      if (msg.index >= 0 && msg.index < state.steps.length) state.steps.splice(msg.index, 1);
      saveState();
      sendResponse({ count: state.steps.length });
      break;

    case 'REC_UPDATE_STEP':
      if (msg.index >= 0 && msg.index < state.steps.length && msg.step) {
        state.steps[msg.index] = msg.step;
        saveState();
      }
      sendResponse({ success: true });
      break;

    case 'REC_GET_STATE':
      sendResponse({
        isRecording: state.isRecording,
        stepCount: state.steps.length,
        testName: state.testName,
        steps: state.isRecording ? [] : [...state.steps]
      });
      break;

    case 'REC_CLEAR':
      state.isRecording = false;
      state.steps = [];
      state.testName = '';
      saveState();
      sendResponse({ success: true });
      break;

    case 'REC_PLAY_NEW_TAB':
      (async () => {
        try {
          const { steps, url } = msg;
          const tab = await chrome.tabs.create({ url, active: true });
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content_recorder.js']
          });
          chrome.tabs.sendMessage(tab.id, { type: 'REC_START_PLAYBACK', steps });
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;

    default:
      sendResponse({ error: 'unknown type' });
  }
  return true;
});
