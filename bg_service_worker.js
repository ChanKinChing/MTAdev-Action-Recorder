const state = {
  isRecording: false,
  tabId: null,
  steps: [],
  testName: ''
};

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
      sendResponse({ success: true, count: 0 });
      break;

    case 'REC_STOP':
      state.isRecording = false;
      const steps = [...state.steps];
      sendResponse({ success: true, steps, testName: state.testName });
      break;

    case 'REC_ADD_STEP':
      if (!state.isRecording) {
        sendResponse({ count: state.steps.length });
        return;
      }
      state.steps.push(msg.step);
      sendResponse({ count: state.steps.length });
      break;

    case 'REC_DELETE_LAST_STEP':
      if (state.steps.length > 0) state.steps.pop();
      sendResponse({ count: state.steps.length });
      break;

    case 'REC_DELETE_STEP':
      if (msg.index >= 0 && msg.index < state.steps.length) state.steps.splice(msg.index, 1);
      sendResponse({ count: state.steps.length });
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
      sendResponse({ success: true });
      break;

    default:
      sendResponse({ error: 'unknown type' });
  }
  return true;
});
