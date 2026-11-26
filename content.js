/* Web Agent Bridge — content script.
 * Runs in Chrome's isolated world: no globals, attributes or events are exposed to the page.
 * Watches the assistant's replies for @@webagent tool blocks, runs them in the editor
 * through the background worker, and types the results back into the chat.
 */
(() => {
    if (globalThis.__wabLoaded) return;
    globalThis.__wabLoaded = true;
    // If a previous instance was torn down by a context invalidation, clear the guard so a fresh inject can load.
    if (globalThis.__wabDead) { globalThis.__wabLoaded = false; return; }

  const D = globalThis.WAB_DEFAULTS || {};
  const MARKER = '@@webagent';
  const MARKER_RE = /(^|\n)[ \t]*@@webagent\b/;
  const CONTENT_TOOLS = new Set(['write_file', 'write', 'create', 'create_file', 'replace', 'edit', 'edit_file', 'patch', 'replace_in_file', 'str_replace']);

  // ---------------------------------------------------------------------------
  // Site adapters. Every selector list falls back to GENERIC, so unknown or
  // changed sites keep working through heuristics.
  // ---------------------------------------------------------------------------
  const ADAPTERS = [
    {
      id: 'chatgpt', hosts: ['chatgpt.com', 'chat.openai.com'],
      input: ['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]'],
      send: ['button[data-testid="send-button"]', '#composer-submit-button'],
      stop: ['button[data-testid="stop-button"]'],
      assistant: ['[data-message-author-role="assistant"]']
    },
    {
      id: 'claude', hosts: ['claude.ai'],
      input: ['div.ProseMirror[contenteditable="true"]', '[data-testid="chat-input"]'],
      send: ['button[aria-label="Send message"]', 'button[aria-label="Send Message"]', 'button[aria-label*="Send" i]'],
      stop: ['button[aria-label="Stop response"]', 'button[aria-label*="Stop" i]'],
      streaming: ['[data-is-streaming="true"]'],
      assistant: ['.font-claude-response', '[data-is-streaming]', '.font-claude-message']
    },
    {
      id: 'gemini', hosts: ['gemini.google.com'],
      input: ['rich-textarea .ql-editor', 'div.ql-editor[contenteditable="true"]'],
      send: ['button.send-button', 'button[aria-label*="Send" i]'],
      stop: ['button.send-button.stop', 'button[aria-label*="Stop" i]'],
      assistant: ['model-response message-content', 'model-response']
    },
    {
      id: 'aistudio', hosts: ['aistudio.google.com'],
      input: ['ms-prompt-input-wrapper textarea', 'ms-autosize-textarea textarea', 'textarea'],
      send: ['run-button button', 'button[aria-label*="Run" i]'],
      stop: ['run-button button.stoppable', 'button[aria-label*="Stop" i]'],
      assistant: ['ms-chat-turn [data-turn-role="Model"]', '.chat-turn-container.model', 'ms-chat-turn .model-prompt-container']
    },
    {
      id: 'deepseek', hosts: ['chat.deepseek.com'],
      input: ['textarea#chat-input', 'textarea'],
      send: ['div[role="button"].ds-button--primary', 'button[type="submit"]'],
      stop: ['div[role="button"] svg[class*="stop" i]'],
      assistant: ['.ds-markdown']
    },
    {
      id: 'perplexity', hosts: ['perplexity.ai'],
      input: ['#ask-input', 'textarea[placeholder]', 'div[contenteditable="true"]'],
      send: ['button[aria-label="Submit"]', 'button[data-testid="submit-button"]'],
      stop: ['button[aria-label*="Stop" i]'],
      assistant: ['.prose']
    },
    {
      id: 'grok', hosts: ['grok.com', 'x.com'],
      input: ['div.tiptap[contenteditable="true"]', 'textarea', 'div[contenteditable="true"]'],
      send: ['button[type="submit"]', 'button[aria-label*="Submit" i]', 'button[aria-label*="Send" i]'],
      stop: ['button[aria-label*="Stop" i]'],
      assistant: ['.message-bubble .response-content-markdown', '[class*="message-bubble"]']
    },
    {
      id: 'copilot', hosts: ['copilot.microsoft.com'],
      input: ['textarea#userInput', 'textarea'],
      send: ['button[aria-label*="Submit" i]', 'button[title*="Submit" i]'],
      stop: ['button[aria-label*="Stop" i]', 'button[aria-label*="Interrupt" i]'],
      assistant: ['[data-content="ai-message"]']
    },
    {
      id: 'mistral', hosts: ['chat.mistral.ai'],
      input: ['div.ProseMirror[contenteditable="true"]', 'textarea'],
      send: ['button[type="submit"]', 'button[aria-label*="Send" i]'],
      stop: ['button[aria-label*="Stop" i]'],
      assistant: ['[data-message-author-role="assistant"]', '.prose']
    },
    {
      id: 'poe', hosts: ['poe.com'],
      input: ['textarea[class*="GrowingTextArea"]', 'textarea'],
      send: ['button[data-button-send="true"]', 'button[class*="SendButton"]'],
      stop: ['button[class*="StopButton"]', 'button[aria-label*="Stop" i]'],
      assistant: ['[class*="Message_leftSideMessageBubble"]', '[class*="botMessageBubble"]']
    },
    {
      id: 'qwen', hosts: ['chat.qwen.ai'],
      input: ['textarea#chat-input', 'textarea'],
      send: ['button#send-message-button', 'button[type="submit"]'],
      stop: ['button[aria-label*="Stop" i]'],
      assistant: ['.response-message-content', '.chat-response-message']
    }
  ];

  const GENERIC = {
    id: 'generic', hosts: [],
    input: ['textarea:not([readonly])', 'div.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"]', '[contenteditable="plaintext-only"]', 'input[type="text"]'],
    send: ['button[type="submit"]', 'button[aria-label*="Send" i]', 'button[aria-label*="Submit" i]', 'button[data-testid*="send" i]', 'button[title*="Send" i]'],
    stop: ['button[aria-label*="Stop" i]', 'button[data-testid*="stop" i]', 'button[title*="Stop" i]'],
    streaming: [],
    assistant: []
  };

  const host = location.hostname;
  const SITE = ADAPTERS.find((a) => a.hosts.some((h) => host === h || host.endsWith('.' + h))) || GENERIC;
  const sel = (key) => [...(SITE[key] || []), ...(SITE === GENERIC ? [] : GENERIC[key] || [])];

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let cfg = { ...D };
  const st = {
    connected: false,
    workspace: null,
    armed: false,          // only replies that arrive after a send are acted on
    busy: false,
    processed: new Set(),
    lastSig: '',
    stableSince: 0,
    autoTurns: 0,
    sentNorm: [],          // normalized text we inserted (ignore tool blocks echoed from it)
    url: location.href,
    pending: [],           // detected but not yet run (manual mode)
    aborted: false,
    status: '',
    selfAction: false
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => Math.round(a + Math.random() * Math.max(0, b - a));
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    if (panel.host && panel.host.contains(el)) return false;
    const r = el.getClientRects();
    if (!r.length) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function queryAll(list, root = document) {
    const out = [];
    for (const s of list) {
      try { root.querySelectorAll(s).forEach((e) => out.push(e)); } catch (_) { /* bad selector on this browser */ }
    }
    return out;
  }

  function sortDoc(els) {
    return [...new Set(els)].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  }

  // ---------------------------------------------------------------------------
  // Page reading
  // ---------------------------------------------------------------------------
  function assistantMessages() {
    const list = SITE.assistant || [];
    if (!list.length) return null;
    for (const s of list) {
      let els;
      try { els = [...document.querySelectorAll(s)]; } catch (_) { continue; }
      if (els.length) {
        els = els.filter((e) => !els.some((o) => o !== e && o.contains(e))); // outermost only
        return sortDoc(els);
      }
    }
    return [];
  }

  function isGenerating() {
    if (queryAll(SITE.streaming || []).length) return true;
    return queryAll(sel('stop')).some(visible);
  }

  function blockText(pre) {
    const code = pre.querySelector('code') || pre.querySelector('.cm-content') || pre;
    let t = code.innerText;
    if (!t || !t.trim()) t = code.textContent || '';
    return t.replace(/\u00a0/g, ' ');
  }

  function parseHeader(line) {
    const m = line.trim().match(/^@@webagent[:\s]+([A-Za-z_][\w-]*)\s*(.*)$/);
    if (!m) return null;
    const tool = m[1].toLowerCase().replace(/-/g, '_');
    const args = {};
    const re = /([A-Za-z_][\w-]*)=("((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/g;
    let a;
    while ((a = re.exec(m[2]))) {
      let v = a[3] !== undefined ? a[3].replace(/\\(["\\])/g, '$1') : a[4] !== undefined ? a[4] : a[5];
      args[a[1]] = v;
    }
    return { tool, args };
  }

  /** Split one block's text into tool calls. */
  function parseCalls(text) {
    const m = MARKER_RE.exec(text);
    if (!m) return [];
    const body = text.slice(m.index + m[1].length).replace(/^[ \t]+/, '');
    const lines = body.split('\n');
    const calls = [];
    let i = 0;
    while (i < lines.length) {
      const head = parseHeader(lines[i]);
      if (!head) { i++; continue; }
      if (CONTENT_TOOLS.has(head.tool)) {
        let content = lines.slice(i + 1);
        const endIdx = content.findIndex((l) => l.trim() === '@@end');
        if (endIdx >= 0) content = content.slice(0, endIdx);
        calls.push({ ...head, content: content.join('\n'), raw: lines.slice(i).join('\n') });
        break; // rest of the block belongs to this call
      }
      calls.push({ ...head, content: '', raw: lines[i] });
      i++;
    }
    return calls;
  }

  /** All tool calls on the page with stable keys. Only the last reply is eligible for running. */
  function collectCalls() {
    const msgs = assistantMessages();
    const scopes = msgs === null ? [document.querySelector('main') || document.body] : msgs;
    const last = msgs === null ? scopes[0] : msgs[msgs.length - 1];
    const seen = new Map();
    const calls = [];
    for (const scope of scopes) {
      if (!scope) continue;
      const pres = scope.querySelectorAll('pre');
      let found = false;
      pres.forEach((pre) => {
        const text = blockText(pre);
        if (!text.includes(MARKER)) return;
        parseCalls(text).forEach((c) => {
          found = true;
          const h = hash(c.tool + '\u0000' + JSON.stringify(c.args) + '\u0000' + c.content);
          const n = (seen.get(h) || 0) + 1;
          seen.set(h, n);
          calls.push({ ...c, key: `${h}#${n}`, inLast: scope === last });
        });
      });
      // Plain-text fallback (agent forgot the code fence): content-less tools only.
      if (!found && scope === last) {
        const txt = (scope.innerText || '').split('\n');
        txt.forEach((line) => {
          if (!line.trim().startsWith(MARKER)) return;
          const head = parseHeader(line);
          if (!head || CONTENT_TOOLS.has(head.tool)) return;
          const h = hash('p' + line.trim());
          const n = (seen.get(h) || 0) + 1;
          seen.set(h, n);
          calls.push({ ...head, content: '', raw: line, key: `${h}#${n}`, inLast: true });
        });
      }
    }
    return calls;
  }

  function signature() {
    const msgs = assistantMessages();
    if (msgs === null) {
      const root = document.querySelector('main') || document.body;
      return `g:${root.textContent.length}:${root.querySelectorAll('pre').length}`;
    }
    const last = msgs[msgs.length - 1];
    return `${msgs.length}:${last ? last.textContent.length : 0}`;
  }

  function isEcho(c) {
    const r = norm(c.raw);
    return r.length > 0 && st.sentNorm.some((s) => s.includes(r));
  }

  // ---------------------------------------------------------------------------
  // Composer
  // ---------------------------------------------------------------------------
  function findComposer() {
    const active = document.activeElement;
    const cands = queryAll(sel('input')).filter(visible).filter((e) => !e.disabled && e.getAttribute('aria-disabled') !== 'true');
    if (!cands.length) return null;
    if (active && cands.includes(active)) return active;
    // Prefer the lowest, widest box on screen (chat composers sit at the bottom).
    return cands
      .map((e) => ({ e, r: e.getBoundingClientRect() }))
      .sort((a, b) => b.r.bottom - a.r.bottom || b.r.width - a.r.width)[0].e;
  }

  function readComposer(el) {
    return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? el.value : el.innerText;
  }

  async function setComposerText(el, text) {
    el.focus();
    await sleep(30);
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    // contenteditable (ProseMirror / Quill / Lexical / TipTap)
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    // Editors that handle paste themselves cancel the event (some turn long text into an attachment).
    const handled = !el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await sleep(120);
    const probe = norm(text).slice(0, 40);
    if (!handled && !norm(readComposer(el)).includes(probe)) {
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
      try { document.execCommand('insertText', false, text); } catch (_) { /* deprecated: may be a no-op */ }
      await sleep(80);
      // execCommand is deprecated and silently does nothing on some React-controlled
      // inputs / closed shadow roots. Verify the text actually landed before submitting.
      if (!norm(readComposer(el)).includes(probe)) {
        throw new Error('Could not type into the chat box (execCommand was ignored by this site). Copy the results manually or update the site adapter.');
      }
    }
  }

  function sendButton() {
    const btns = queryAll(sel('send')).filter(visible);
    return btns.reverse().find((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true') || null;
  }

  async function submit(el) {
    for (let i = 0; i < 25; i++) {
      const b = sendButton();
      if (b) { b.click(); return; }
      await sleep(120);
    }
    // Fallback: Enter key.
    el.focus();
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  function rememberSent(text) {
    st.sentNorm.push(norm(text));
    if (st.sentNorm.length > 30) st.sentNorm.shift();
  }

  async function sendToChat(text, doSubmit) {
    const el = findComposer();
    if (!el) throw new Error('Chat input box not found on this page.');
    rememberSent(text);
    st.selfAction = true;
    try {
      await setComposerText(el, text);
      if (doSubmit) {
        await sleep(rand(200, 450));
        await submit(el);
        st.armed = true;
        st.lastSig = '';
        st.stableSince = 0;
      }
    } finally {
      setTimeout(() => { st.selfAction = false; }, 300);
    }
  }

  // ---------------------------------------------------------------------------
  // Running tools
  // ---------------------------------------------------------------------------
  function fence(text) {
    const runs = String(text).match(/`{3,}/g);
    return '`'.repeat(runs ? Math.max(...runs.map((r) => r.length)) + 1 : 3);
  }

  function describe(c) {
    const args = Object.entries(c.args).map(([k, v]) => `${k}="${v}"`).join(' ');
    return `${c.tool}${args ? ' ' + args : ''}`;
  }

  function formatResults(results) {
    const parts = [`[Web Agent Bridge] Results from the editor${st.workspace ? ` (workspace: ${st.workspace})` : ''}:`];
    results.forEach(({ c, r }, i) => {
      const out = r && r.output != null ? String(r.output) : 'No response.';
      const f = fence(out);
      parts.push(`### ${i + 1}. ${describe(c)} : ${r && r.ok ? 'OK' : 'ERROR'}\n${f}\n${out}\n${f}`);
    });
    parts.push('Continue with more @@webagent tool blocks if needed, or reply with a short summary when the task is done.');
    return parts.join('\n\n');
  }

  async function runCalls(calls) {
    if (!calls.length || st.busy) return;
    st.busy = true;
    st.aborted = false;
    st.pending = [];
    const results = [];
    try {
      for (let i = 0; i < calls.length; i++) {
        if (st.aborted) break;
        const c = calls[i];
        setStatus(`Running ${i + 1}/${calls.length}: ${c.tool}${c.args.path ? ' ' + c.args.path : ''}`);
        let r;
        try {
          r = await chrome.runtime.sendMessage({ type: 'tool', tool: c.tool, args: c.args, content: c.content, site: SITE.id });
        } catch (e) {
          if (isContextInvalid(e)) { die(e && e.message); return; }
          r = { ok: false, output: 'Extension was reloaded — refresh this page.' };
        }
        results.push({ c, r });
        if (cfg.betweenToolsMs) await sleep(cfg.betweenToolsMs);
      }
      if (st.aborted) { setStatus('Stopped'); return; }
      const text = formatResults(results);
      const canAuto = cfg.autoSubmit && st.autoTurns < cfg.maxAutoTurns;
      if (canAuto) {
        const wait = rand(cfg.minSendDelayMs, cfg.maxSendDelayMs);
        setStatus(`Sending results in ${(wait / 1000).toFixed(1)} s`);
        await sleep(wait);
        if (st.aborted) { setStatus('Stopped'); return; }
        // Don't type over something the user started writing.
        const el = findComposer();
        if (el && norm(readComposer(el)).length > 0) {
          setStatus('Chat box not empty — results not sent');
          return;
        }
        await sendToChat(text, true);
        st.autoTurns++;
        setStatus(`Sent ${results.length} result(s)`);
      } else {
        await sendToChat(text, false);
        st.armed = false;
        setStatus(cfg.autoSubmit ? `Auto-turn limit (${cfg.maxAutoTurns}) reached — press Enter to continue` : 'Results pasted — press Enter to send');
      }
    } catch (e) {
      setStatus(`Error: ${e.message || e}`);
    } finally {
      st.busy = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Main loop (response-gap detection)
  // ---------------------------------------------------------------------------
  function tick() {
    if (location.href !== st.url) {
      st.url = location.href;
      st.armed = false;
      st.autoTurns = 0;
      st.pending = [];
    }
    if (st.busy || !cfg.enabled) return;

    const generating = isGenerating();
    if (generating) {
      st.armed = true;
      st.stableSince = 0;
    }

    let calls;
    try { calls = collectCalls(); } catch (_) { return; }

    if (!st.armed) {
      // Baseline: everything already on the page (old chats, reloads) is never run.
      calls.forEach((c) => st.processed.add(c.key));
      renderPanel();
      return;
    }

    const sig = signature();
    if (sig !== st.lastSig) {
      st.lastSig = sig;
      st.stableSince = Date.now();
      if (generating || st.status.startsWith('Waiting')) setStatus('Waiting for reply to finish');
      return;
    }
    if (generating || !st.stableSince || Date.now() - st.stableSince < cfg.responseGapMs) return;

    const fresh = calls.filter((c) => !st.processed.has(c.key) && c.inLast && !isEcho(c));
    calls.forEach((c) => { if (!c.inLast || isEcho(c)) st.processed.add(c.key); });
    if (!fresh.length) {
      if (st.status.startsWith('Waiting')) setStatus('Idle');
      return;
    }
    fresh.forEach((c) => st.processed.add(c.key));

    if (cfg.autoRun) {
      runCalls(fresh);
    } else {
      st.pending = st.pending.concat(fresh);
      setStatus(`${st.pending.length} tool call(s) ready`);
    }
  }

  // User actions arm the watcher and reset the auto-turn counter.
  function userSent() {
    if (st.selfAction) return;
    st.armed = true;
    st.autoTurns = 0;
    st.lastSig = '';
  }
  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted || e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    const t = e.target;
    if (t && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) userSent();
  }, true);
  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const b = e.target && e.target.closest && e.target.closest('button,[role="button"]');
    if (!b) return;
    if (sel('send').some((s) => { try { return b.matches(s); } catch (_) { return false; } })) userSent();
  }, true);

  // ---------------------------------------------------------------------------
  // Status panel (closed shadow root, optional)
  // ---------------------------------------------------------------------------
  const panel = { host: null, root: null, els: {} };

  function buildPanel() {
    if (panel.host) return;
    const h = document.createElement('div');
    h.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:14px;bottom:86px;';
    const root = h.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .p{font:12px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e8eaed;background:rgba(32,33,36,.92);
           border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:5px 8px;display:flex;align-items:center;gap:6px;
           box-shadow:0 2px 10px rgba(0,0,0,.3);max-width:340px;user-select:none}
        .d{width:8px;height:8px;border-radius:50%;background:#9aa0a6;flex:none}
        .d.on{background:#34a853}.d.off{background:#ea4335}
        .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px;cursor:default}
        button{all:unset;cursor:pointer;padding:2px 7px;border-radius:10px;background:rgba(255,255,255,.1);font-size:11px}
        button:hover{background:rgba(255,255,255,.2)} .hide{display:none}
        .x{background:none;opacity:.6;padding:0 3px}
      </style>
      <div class="p">
        <span class="d"></span><span class="t">Web Agent</span>
        <button class="run hide"></button>
        <button class="stop hide">Stop</button>
        <button class="auto"></button>
        <button class="x" title="Hide (re-enable in the extension popup)">✕</button>
      </div>`;
    panel.root = root;
    panel.els = {
      dot: root.querySelector('.d'), text: root.querySelector('.t'), run: root.querySelector('.run'),
      stop: root.querySelector('.stop'), auto: root.querySelector('.auto'), x: root.querySelector('.x')
    };
    panel.els.run.onclick = () => { const p = st.pending; st.pending = []; runCalls(p); };
    panel.els.stop.onclick = () => { st.aborted = true; st.armed = false; setStatus('Stopped'); };
    panel.els.auto.onclick = () => safeStorageSet({ autoRun: !cfg.autoRun, autoSubmit: !cfg.autoRun });
    panel.els.x.onclick = () => safeStorageSet({ showPanel: false });
    document.documentElement.appendChild(h);
    panel.host = h;
  }

  // ---------------------------------------------------------------------------
  // Context-loss guard. After the extension is reloaded/updated/disabled,
  // every chrome.* call from this (now orphaned) content script throws
  // "Extension context invalidated". Detect it once and stop cleanly instead
  // of letting uncaught errors pile up in the page console.
  // ---------------------------------------------------------------------------
  let alive = true;
  function isContextInvalid(err) {
    const s = String((err && err.message) || err || '');
    return s.includes('Extension context invalidated') ||
           s.includes('message port closed') ||
           s.includes('Receiving end does not exist');
  }
  function die(reason) {
    if (!alive) return;
    alive = false;
    st.aborted = true;
    try { removePanel(); } catch (_) { /* ignore */ }
    console.info(`[Web Agent Bridge] stopping: ${reason || 'extension context lost'}. Reload the page to reconnect.`);
  }
  // Safe wrapper: resolves to {ok:false} instead of throwing when the context is gone.
  async function safeChrome(fn) {
    if (!alive) return { ok: false, error: 'context invalidated' };
    try {
      return await fn();
    } catch (e) {
      if (isContextInvalid(e)) die(e && e.message);
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
  function safeStorageSet(obj) {
    return safeChrome(() => chrome.storage.local.set(obj));
  }

  function removePanel() {
    if (panel.host) panel.host.remove();
    panel.host = null;
    panel.root = null;
  }

  function renderPanel() {
    if (!cfg.showPanel) return removePanel();
    if (!panel.host || !panel.host.isConnected) { panel.host = null; buildPanel(); }
    const e = panel.els;
    e.dot.className = 'd ' + (st.connected ? 'on' : 'off');
    const label = !cfg.enabled ? 'Paused' : st.connected ? (st.status || `Connected${st.workspace ? ' · ' + st.workspace : ''}`) : 'Editor not connected';
    e.text.textContent = label;
    e.text.title = label;
    e.run.textContent = `Run ${st.pending.length}`;
    e.run.classList.toggle('hide', !st.pending.length || st.busy);
    e.stop.classList.toggle('hide', !st.busy && !(st.armed && cfg.autoRun && st.status.startsWith('Waiting')));
    e.auto.textContent = cfg.autoRun ? 'Auto ✓' : 'Auto ✕';
  }

  function setStatus(s) {
    st.status = s;
    renderPanel();
  }

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------
  function applyStatus(s) {
    if (!s) return;
    st.connected = s.state === 'connected';
    if (s.workspace) st.workspace = s.workspace;
    renderPanel();
  }

  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!alive) return false;
      if (msg.type === 'status') {
        applyStatus(msg);
        return false;
      }
      if (msg.type === 'send_to_chat') {
        sendToChat(msg.text, msg.autoSubmit)
          .then(() => { if (msg.autoSubmit) st.autoTurns = 0; sendResponse({ ok: true }); })
          .catch((e) => {
            if (isContextInvalid(e)) die(e && e.message);
            sendResponse({ ok: false, error: e.message });
          });
        return true;
      }
      if (msg.type === 'insert_prompt') {
        safeChrome(() => chrome.runtime.sendMessage({ type: 'get_prompt' })).then(async (r) => {
          if (!r || !r.ok) return sendResponse({ ok: false, error: (r && r.error) || 'No prompt available' });
          try {
            await sendToChat(r.prompt, !!msg.submit);
            sendResponse({ ok: true });
          } catch (e) {
            if (isContextInvalid(e)) die(e && e.message);
            sendResponse({ ok: false, error: e.message });
          }
        });
        return true;
      }
      if (msg.type === 'ping') {
        sendResponse({ ok: true, site: SITE.id });
        return false;
      }
      return false;
    });
  } catch (e) {
    // Listener could not be registered because the context is already gone.
    if (isContextInvalid(e)) die(e && e.message);
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (!alive || area !== 'local') return;
      for (const k of Object.keys(changes)) if (k in D) cfg[k] = changes[k].newValue;
      if (changes.pollMs) restartLoop();
      renderPanel();
    });
  } catch (e) {
    if (isContextInvalid(e)) die(e && e.message);
  }

  function register() {
    safeChrome(() => chrome.runtime.sendMessage({ type: 'register', site: SITE.id, focused: document.hasFocus() }))
      .then((s) => { if (s && s.ok !== false) applyStatus(s); });
  }
  window.addEventListener('focus', () => { safeChrome(() => chrome.runtime.sendMessage({ type: 'focus' })); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) register(); });

  let loop = null;
  function restartLoop() {
    clearInterval(loop);
    loop = setInterval(() => { if (alive) tick(); }, Math.max(150, Number(cfg.pollMs) || 400));
  }

  safeChrome(() => chrome.storage.local.get(D)).then((c) => {
    if (!alive || !c || c.ok === false) return;
    cfg = { ...D, ...c };
    register();
    tick(); // baseline existing replies immediately
    restartLoop();
    renderPanel();
  });
})();
