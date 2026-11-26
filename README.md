<p align="center"><img src="icons/icon-128.png" width="96" alt="Web Agent Bridge logo"></p>

# Web Agent Bridge — Chrome extension

Let ChatGPT, Claude, Gemini and other browser AI chats read and edit the code in your editor (VS Code, Antigravity, Cursor, Windsurf).

This is the **browser half**. You also need the **editor half**: search **Web Agent Bridge** (publisher *devpro-tools*) in the Extensions view of Antigravity / Cursor / Windsurf, or download it for VS Code from [Open VSX](https://open-vsx.org/extension/devpro-tools/web-agent-bridge).

## ⬇️ Download

**[Download the Chrome extension (ZIP)](https://github.com/devpro2028/web-agent-bridge-chrome/archive/refs/heads/main.zip)**

## Install (1 minute)

1. Unzip the download. Keep the folder somewhere permanent (for example `Documents/web-agent-bridge-chrome`) — Chrome loads the extension from it.
2. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
3. Turn on **Developer mode** (top-right switch).
4. Click **Load unpacked** and select the unzipped folder (the one that contains `manifest.json`).
5. Pin it: puzzle-piece icon in the toolbar → pin **Web Agent Bridge**.

Chrome may show a "Developer mode extensions" notice at startup — click **Keep**. This is normal for extensions not installed from the Chrome Web Store.

## Connect to your editor

1. In the editor, click **Web Agent** in the status bar → **Copy pairing token**
   (or Command Palette → *Web Agent Bridge: Copy Pairing Token*).
2. Click the Chrome extension icon → paste the token → **Save & connect**.
3. The dot turns **green**.

## Use

1. Open a chat site: ChatGPT, Claude, Gemini, AI Studio, DeepSeek, Perplexity, Grok, Copilot, Mistral, Poe, Qwen, Kimi, z.ai, HuggingChat, OpenRouter, LMArena, Meta AI, …
2. In the editor: Command Palette → **Web Agent Bridge: Start Session in Browser Chat** → type your task.
3. The AI reads and edits your files; edits open in the editor and can be undone with `Cmd/Ctrl+Z`.

Every new chat must start with **Start Session** (or extension popup → **Insert & send**), otherwise the AI does not know the bridge exists.

Other chat sites: open the site → extension icon → **Enable on this site**.

## Update

Download the ZIP again, replace the files in your folder, then click **↻ reload** on the extension card in `chrome://extensions`. Your token and settings are kept.

## Settings

Extension popup → **Response gap & timing**:

| Setting | Default | Meaning |
|---|---|---|
| Response gap | 2000 ms | How long the AI reply must stay unchanged before it counts as finished. Raise it for slow or "thinking" models. |
| Send delay min / max | 700 / 1800 ms | Random wait before results are sent back. |
| Max auto turns | 25 | After this many automatic rounds, results are pasted but not sent. |

Presets: **Fast / Normal / Slow**.

## Privacy

The extension talks only to your own computer (`127.0.0.1`) and the chat site you are using. Nothing is sent anywhere else. Connections need the pairing token from your editor.
