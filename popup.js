const D = self.WAB_DEFAULTS;
const $ = (id) => document.getElementById(id);
const NUMBERS = ['responseGapMs', 'minSendDelayMs', 'maxSendDelayMs', 'betweenToolsMs', 'pollMs', 'maxAutoTurns', 'toolTimeoutMs'];
const CHECKS = ['enabled', 'autoRun', 'autoSubmit', 'showPanel', 'focusChatTab'];
const PRESETS = {
  presetFast: { responseGapMs: 1000, minSendDelayMs: 200, maxSendDelayMs: 600, betweenToolsMs: 50, pollMs: 250 },
  presetNormal: { responseGapMs: 2000, minSendDelayMs: 700, maxSendDelayMs: 1800, betweenToolsMs: 150, pollMs: 400 },
  presetSlow: { responseGapMs: 4000, minSendDelayMs: 2000, maxSendDelayMs: 5000, betweenToolsMs: 400, pollMs: 700 }
};

let tab = null;

function say(text) {
  $('msg').textContent = text || '';
}

function showStatus(s) {
  if (!s) return;
  const dot = $('dot');
  dot.className = 'dot ' + (s.state === 'connected' ? 'on' : s.state === 'connecting' ? 'wait' : 'off');
  $('status').textContent =
    s.state === 'connected' ? `Connected${s.workspace ? ' · ' + s.workspace : ''}`
      : s.state === 'connecting' ? 'Connecting…'
        : s.lastError || 'Not connected';
  if (tab) {
    const active = s.activeTabId === tab.id;
    $('tabinfo').textContent = `${new URL(tab.url || 'about:blank').hostname || 'this tab'}${active ? ' — agent tab ✓' : ''}`;
  }
}

async function load() {
  const c = await chrome.storage.local.get(D);
  $('port').value = c.port;
  $('token').value = c.token;
  NUMBERS.forEach((k) => { $(k).value = c[k]; });
  CHECKS.forEach((k) => { $(k).checked = !!c[k]; });
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  showStatus(await chrome.runtime.sendMessage({ type: 'get_status' }));
}

function num(id, min) {
  const v = Number($(id).value);
  return Number.isFinite(v) ? Math.max(min, v) : D[id];
}

async function saveTiming() {
  const patch = {};
  NUMBERS.forEach((k) => { patch[k] = num(k, k === 'maxAutoTurns' ? 1 : 0); });
  if (patch.maxSendDelayMs < patch.minSendDelayMs) patch.maxSendDelayMs = patch.minSendDelayMs;
  await chrome.storage.local.set(patch);
  say('Saved.');
}

$('connect').onclick = async () => {
  await chrome.storage.local.set({ port: num('port', 1), token: $('token').value.trim() });
  say('Connecting…');
  const s = await chrome.runtime.sendMessage({ type: 'reconnect' });
  showStatus(s);
  say(s.state === 'connected' ? 'Connected.' : '');
};

$('disconnect').onclick = async () => showStatus(await chrome.runtime.sendMessage({ type: 'disconnect' }));

NUMBERS.forEach((k) => $(k).addEventListener('change', saveTiming));
CHECKS.forEach((k) => $(k).addEventListener('change', () => chrome.storage.local.set({ [k]: $(k).checked })));

Object.entries(PRESETS).forEach(([id, values]) => {
  $(id).onclick = async () => {
    await chrome.storage.local.set(values);
    Object.entries(values).forEach(([k, v]) => { $(k).value = v; });
    say(`${id.replace('preset', '')} timing applied.`);
  };
});

async function contentAlive() {
  if (!tab || tab.id == null) return false;
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'ping' });
    return !!(r && r.ok);
  } catch (_) {
    return false;
  }
}

$('useTab').onclick = async () => {
  if (!(await contentAlive())) return say('Bridge is not active on this page. Click "Enable on this site" first.');
  showStatus(await chrome.runtime.sendMessage({ type: 'set_active', tabId: tab.id }));
  say('This tab will receive text from the editor.');
};

$('inject').onclick = async () => {
  if (await contentAlive()) {
    await chrome.runtime.sendMessage({ type: 'set_active', tabId: tab.id });
    return say('Already active on this page.');
  }
  const r = await chrome.runtime.sendMessage({ type: 'inject', tabId: tab.id });
  say(r && r.ok ? 'Enabled on this tab (until reload). Uses generic detection.' : `Could not enable: ${r && r.error}`);
  showStatus(await chrome.runtime.sendMessage({ type: 'get_status' }));
};

async function insertPrompt(submit) {
  if (!(await contentAlive())) return say('Bridge is not active on this page. Click "Enable on this site" first.');
  const r = await chrome.tabs.sendMessage(tab.id, { type: 'insert_prompt', submit });
  say(r && r.ok ? (submit ? 'Protocol prompt sent.' : 'Protocol prompt inserted.') : `Failed: ${r && r.error}`);
}
$('prompt').onclick = () => insertPrompt(false);
$('promptSend').onclick = () => insertPrompt(true);

chrome.runtime.onMessage.addListener((m) => {
  if (m.type === 'popup_status') showStatus(m);
});

load();
