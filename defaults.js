// Shared defaults for background, content script and popup.
self.WAB_DEFAULTS = {
  port: 3765,
  token: '',

  // Behaviour
  enabled: true,          // master switch for tool execution in chat tabs
  autoRun: true,          // run @@webagent tool blocks as soon as the reply is finished
  autoSubmit: true,       // send tool results back to the chat automatically
  showPanel: true,        // small status pill on chat pages (closed shadow DOM)
  focusChatTab: true,     // bring the chat tab forward when the editor sends something

  // Response gap / timing
  responseGapMs: 2000,    // reply must stay unchanged this long (and not be streaming) before it counts as finished
  minSendDelayMs: 700,    // random wait before sending results back (lower bound)
  maxSendDelayMs: 1800,   // random wait before sending results back (upper bound)
  betweenToolsMs: 150,    // pause between consecutive tool calls
  pollMs: 400,            // how often the page is checked
  maxAutoTurns: 25,       // stop auto-replying after this many consecutive automatic turns
  toolTimeoutMs: 600000   // how long to wait for the editor (covers manual Apply/Reject)
};
