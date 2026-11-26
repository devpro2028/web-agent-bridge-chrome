/* Web Agent Bridge — service worker.
 * Holds the WebSocket to the editor and routes messages between chat tabs and the editor.
 */
importScripts('defaults.js');

const VERSION = chrome.runtime.getManifest().version;
const D = self.WAB_DEFAULTS;

let ws = null;
let state = 'disconnected'; // disconnected | connecting | connected | no-token
let lastError = '';
let welcome = null;
let pingTimer = null;
let seq = 0;
let activeTabId = null;
const pending = new Map(); // id -> {resolve, timer}
const tabs = new Set(); // tab ids with a live content script

async function getCfg() {
  return chrome.storage.local.get(D);
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  const c = await getCfg();
  if (!c.token) {
    state = 'no-token';
    lastError = 'Paste the pairing token from the editor (command: "Web Agent Bridge: Copy Pairing Token").';
    broadcastStatus();
    return;
  }
  state = 'connecting';
  let sock;
  try {
    sock = new WebSocket(`ws://127.0.0.1:${Number(c.port) || D.port}/bridge?token=${encodeURIComponent(c.token)}`);
  } catch (e) {
    state = 'disconnected';
    lastError = String(e.message || e);
    return;
  }
  ws = sock;
  sock.onopen = () => {
    if (ws !== sock) return;
    state = 'connected';
    lastError = '';
    wsSend({ type: 'hello', client: 'chrome', version: VERSION });
    clearInterval(pingTimer);
    // Regular traffic also keeps the MV3 service worker alive (Chrome 116+).
    pingTimer = setInterval(() => wsSend({ type: 'ping' }), 20000);
    broadcastStatus();
  };
  sock.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    onEditorMessage(msg);
  };
  sock.onerror = () => {
    lastError = `Cannot reach the editor on port ${c.port}. Is the editor extension running, and is the token correct?`;
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    state = 'disconnected';
    clearInterval(pingTimer);
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, output: 'Bridge to the editor disconnected.' });
      pending.delete(id);
    }
    broadcastStatus();
  };
}

function disconnect() {
  if (ws) {
    const s = ws;
    ws = null;
    try { s.close(); } catch (_) { /* ignore */ }
  }
  state = 'disconnected';
  clearInterval(pingTimer);
  broadcastStatus();
}

async function waitConnected(ms = 5000) {
  await connect();
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (state === 'connected') return true;
    if (state === 'no-token') return false;
    if (!ws) await connect();
    await new Promise((r) => setTimeout(r, 150));
  }
  return state === 'connected';
}

async function pickTab() {
  if (activeTabId != null) {
    try {
      await chrome.tabs.get(activeTabId);
      return activeTabId;
    } catch (_) {
      activeTabId = null;
    }
  }
  for (const id of tabs) {
    try {
      await chrome.tabs.get(id);
      return id;
    } catch (_) {
      tabs.delete(id);
    }
  }
  return null;
}

async function onEditorMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      welcome = msg;
      chrome.storage.local.set({ lastWorkspace: msg.workspace, protocolPrompt: msg.protocolPrompt });
      broadcastStatus();
      break;
    case 'prompt':
      if (msg.protocolPrompt) chrome.storage.local.set({ protocolPrompt: msg.protocolPrompt });
      resolvePending(msg);
      break;
    case 'tool_result':
      resolvePending(msg);
      break;
    case 'send_to_chat': {
      const tabId = await pickTab();
      if (tabId == null) {
        wsSend({ type: 'ack', id: msg.id, ok: false, error: 'No chat tab is open in the browser.' });
        return;
      }
      const c = await getCfg();
      if (c.focusChatTab) {
        try {
          const t = await chrome.tabs.update(tabId, { active: true });
          await chrome.windows.update(t.windowId, { focused: true });
        } catch (_) { /* ignore */ }
      }
      try {
        const r = await chrome.tabs.sendMessage(tabId, { type: 'send_to_chat', text: msg.text, autoSubmit: msg.autoSubmit });
        wsSend({ type: 'ack', id: msg.id, ok: !!(r && r.ok), error: r && r.error });
      } catch (e) {
        wsSend({ type: 'ack', id: msg.id, ok: false, error: 'Chat tab did not answer — reload the chat page.' });
      }
      break;
    }
    default:
      break;
  }
}

function resolvePending(msg) {
  const p = pending.get(msg.id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(msg.id);
  p.resolve(msg);
}

function request(payload, timeoutMs) {
  return new Promise((resolve) => {
    const id = `${Date.now()}-${++seq}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, output: `Timed out after ${Math.round(timeoutMs / 1000)} s waiting for the editor.` });
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    if (!wsSend({ ...payload, id })) {
      clearTimeout(timer);
      pending.delete(id);
      resolve({ ok: false, output: 'Not connected to the editor.' });
    }
  });
}

function statusPayload() {
  return {
    type: 'status',
    state,
    lastError,
    workspace: welcome ? welcome.workspace : null,
    activeTabId
  };
}

function broadcastStatus() {
  const s = statusPayload();
  for (const id of tabs) chrome.tabs.sendMessage(id, s).catch(() => tabs.delete(id));
  chrome.runtime.sendMessage({ ...s, type: 'popup_status' }).catch(() => {});
  chrome.action.setBadgeText({ text: state === 'connected' ? '' : '!' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#b3261e' }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'register':
        if (sender.tab) {
          tabs.add(sender.tab.id);
          if (msg.focused || activeTabId == null) activeTabId = sender.tab.id;
        }
        connect();
        return statusPayload();
      case 'focus':
        if (sender.tab) activeTabId = sender.tab.id;
        return { ok: true };
      case 'tool': {
        const c = await getCfg();
        if (!(await waitConnected())) return { ok: false, output: lastError || 'Not connected to the editor.' };
        return request({ type: 'tool', tool: msg.tool, args: msg.args, content: msg.content, site: msg.site }, Number(c.toolTimeoutMs) || D.toolTimeoutMs);
      }
      case 'get_prompt': {
        if (await waitConnected(3000)) {
          const r = await request({ type: 'get_prompt' }, 5000);
          if (r.protocolPrompt) return { ok: true, prompt: r.protocolPrompt };
        }
        const { protocolPrompt } = await chrome.storage.local.get('protocolPrompt');
        return protocolPrompt ? { ok: true, prompt: protocolPrompt, cached: true } : { ok: false, error: 'Connect to the editor first.' };
      }
      case 'get_status':
        await connect();
        return statusPayload();
      case 'reconnect':
        disconnect();
        await waitConnected(4000);
        return statusPayload();
      case 'disconnect':
        disconnect();
        return statusPayload();
      case 'set_active':
        activeTabId = msg.tabId;
        tabs.add(msg.tabId);
        return statusPayload();
      case 'inject':
        await chrome.scripting.executeScript({ target: { tabId: msg.tabId }, files: ['defaults.js', 'content.js'] });
        activeTabId = msg.tabId;
        tabs.add(msg.tabId);
        return { ok: true };
      default:
        return { ok: false, error: 'unknown message' };
    }
  })().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true;
});

chrome.tabs.onRemoved.addListener((id) => {
  tabs.delete(id);
  if (activeTabId === id) activeTabId = null;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.port || changes.token) {
    disconnect();
    connect();
  }
});

function ensureAlarm() {
  chrome.alarms.create('wab-keepalive', { periodInMinutes: 0.5 });
}
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'wab-keepalive' && state !== 'connected') connect();
});
chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); connect(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); connect(); });
ensureAlarm();
connect();
