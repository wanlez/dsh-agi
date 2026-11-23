# dsh-agi

[中文](README.zh-CN.md)

A floating-ball agent for DeepSeek Harness. Talk to it, paste screenshots into it, and let it operate your desktop — then let it remember how your workflows actually work, and get better at them on every run.

This is a fork of [dsh-orb](https://github.com/mini-yifan/dsh-orb-cordis) (MIT, by mini-yifan), renamed to `dsh-agi` and maintained independently.

## Why it is different

| | |
|---|---|
| **Voice, not typing** | Click the avatar, speak, click again. Wake phrase (`你好大肥鱼`) opens the panel, a second phrase (`退下吧`) stops the task, and `大肥鱼` interjects while it works. Wake word, ASR and TTS all run locally. |
| **Personas with memory** | Persona cards change who answers each turn. Paired with the experience library, the same ball can behave like a different specialist per project. |
| **An experience library, not notes** | Workflows are stored as a **node library plus independent paths**. Human text stays the base, the agent appends what it learned from real runs, and human screenshots remain the accuracy standard. |
| **Edited from the chat box** | A one-sentence request like "帮我创建一个节点，内容是 xxx" is enough: seven library tools search, create, check and confirm — with confirmation gates the code enforces, not just prompts. |
| **Hardened desktop control** | Six independent safety mechanisms check that every click landed, that the frame is fresh, that the target is really the control it aimed at. |
| **Safe mode** | Any real key or pointer event stops the task instantly; only input the ball injects itself is ignored. Stopping never ends the conversation. |
| **Its own conversation** | The ball runs an isolated `computer-use` conversation by default, so it can drive the desktop and use the experience library while the main window keeps its own session; a setting switches it to follow the conversation the main window touched last. |

## The experience library

Markdown notes go stale and get skipped. `dsh-agi` keeps a library you can actually maintain, and it is designed so the agent's own experience improves it without overwriting yours.

### Nodes: one package per step

- **Title + human description** — the operator's own words. This is the base the agent reads first.
- **AI supplement (`ai_notes`)** — written only by the agent after it actually ran the step: pitfalls, better prompts, what the next run should watch for. The human text is never rewritten.
- **Screenshots with a source** — human screenshots are the **core accuracy standard**; AI screenshots are guidance for the next run. Both live in the same node package, labelled `human` / `ai`.
- **Edit in place** — the editor shows the human block and the AI block side by side, so you can see what it learned and keep your own wording authoritative.

### Paths: a node graph you can actually read

- A path owns a **directed graph of node instances and edges**, not a flat list. Two arrows into one node is a merge; two arrows out is a branch.
- The same node may appear more than once. **A repeat is not a cycle**: whether the flow loops depends on the edges, and every insert runs real cycle detection (Kahn's algorithm) on the instance graph.
- The canvas draws circles with arrows, and each position carries a display number (1..N) that is recomputed on every render — two instances of the same node stay distinguishable, and numbers never jump or leave gaps.
- The insert dialog offers three sources: positions already in this path, search results, and favorites. Picking an existing position adds **one edge to that exact position** — no duplicate node. Picking a library node adds one new position plus an edge; the library node itself is never copied.
- Nodes and paths can be copied (`_复制版_<timestamp>` naming) and exported into an empty folder as JSON plus screenshots plus a manifest, then imported back unchanged.
- Editing a node improves **every** path that references it — one fix, everywhere.

### Checks that run before anything executes

A path is checked statically, on demand and on save:

- every referenced node still exists and is not soft-deleted;
- every edge points at a node that belongs to this path;
- the graph is **acyclic** — checked by real cycle detection, not by "did this node repeat";
- the recorded start and end belong to the path;
- required fields (title, description, captions) are filled.

Nothing here touches the desktop — checking is pure data. A broken path can never silently reach the machine.

### Chat-driven edits with double constraints

The input box can drive the library through seven tools:

| Tool | What it does |
|---|---|
| `knowledge_graph_search` | Finds existing nodes and paths before anything is created — the operator decides whether to reuse one or create something new. |
| `knowledge_graph_get_node` | Reads a node, including its AI supplement and which screenshots are human vs AI. |
| `knowledge_graph_create_node` | Creates a node; refuses a duplicate title unless the operator explicitly confirms creating a new one, and can store screenshots attached in the same message. |
| `knowledge_graph_create_path` | Saves a flow **only after explicit confirmation**: `steps` plus optional `edges` (`[from, to]` 0-based instance index pairs; omit for a straight line). The same node may repeat at different positions; only a real edge back is a cycle, and cycles or missing nodes are rejected. Checks the saved path afterwards. |
| `knowledge_graph_check_path` | Runs the static check and reports every finding. |
| `knowledge_graph_update_node` | Fixes a human title or description — wording stays the operator's. |
| `knowledge_graph_learn_node` | After a real run, updates **only** the AI part: `ai_notes` (capped at 600 characters, 3 bullets) and AI screenshots. Skips when nothing new was learned. |

The safety order is enforced twice: the code refuses an unconfirmed write, and a per-step prompt states the procedure — search first, confirm every step with the operator, then check and report. Creating a path also starts with the explicit warning *"路径创建较复杂，请务必打开经验库核对每个细节"*, so the operator is expected in the loop, not surprised by it.

## Hardened computer use

Desktop automation fails in boring ways: a click lands while a modal owns the window, a screenshot shows the frame from before the change, a coordinate is off because the window moved or the second monitor has another DPI. The Windows layer borrows six engineering ideas from [Windows-MCP](https://github.com/CursorTouch/Windows-MCP) and turns each failure into something the model can see:

| Failure | What `dsh-agi` does |
|---|---|
| **A click into a blocked window** | **Action receipts.** Before a click the native layer reports a disabled foreground with an owned dialog; the call returns a structured modal warning with real options (`press-esc` / `focus-modal` / `ask-user`) instead of clicking blindly. |
| **"Did that click do anything?"** | **Post-action verification.** Right after the action the same target is sampled again and four facts are recorded: focus retention, foreground stability, whether the target became disabled, and whether the window moved far enough to invalidate the point. |
| **An old frame** | **Frame freshness + rescue capture.** `DwmFlush` runs before every capture, so the bitmap is a composed frame. A failed or all-black BitBlt switches to `PrintWindow(PW_RENDERFULLCONTENT)`; a degenerate rescue frame still returns the original bitmap plus a trace, never an exception that loses the capture. |
| **Aim that looks right but is not** | **Hover probe.** The preview stage captures the same small rectangle before and after the pointer moves onto the target and reports whether the control actually reacted — pixel differencing with a tolerance, so anti-aliasing and subpixel jitter cannot fake it. |
| **Wrong screen, wrong DPI** | **Display inventory.** Every monitor is enumerated with physical and logical rectangles at per-monitor-v2 DPI awareness. One conversion maps a normalized point → window rect → containing monitor → physical pixel, and the inventory is printed into the observation envelope. |
| **"Could not read" shown as "nothing there"** | **Three-state observation + text hygiene.** Every field is `provided`, `empty`, or `unsampled` (permission, timeout, unsupported), so a failed read can never masquerade as an empty UI. All model-facing text is sanitized: private-use areas removed, zero-width characters dropped, lone surrogates repaired, line breaks escaped, truncation marked explicitly. |

The observation frame (the glowing border drawn while the agent is in control) is excluded from every screenshot via `WDA_EXCLUDEFROMCAPTURE`, so it can never pollute what the model sees.

## Version notes

Each release keeps its own section, newest first, so the delta between two versions is always readable.

### 0.7.0

The web layer, the experience library and the desktop channels stop being three separate things: one capability ladder decides which channel runs each step, and the web channel now runs whole flows in code instead of asking the model to look at the page.

**Web control (off by default, 20 tools)**
- Settings → Floating ball → Web control. Tools appear only while the switch is on; turning it off removes them from the model at once, without a restart.
- Read as structure, act by name: `web_find` normalizes names (width, case, whitespace) and only a unique hit acts; `web_click` / `web_type` / `web_select` / `web_hover` / `web_upload` take a name, not a coordinate, and refuse to guess when a name matches twice.
- Coverage that intranet back offices need: every iframe (cross-origin included), recursive open shadow roots, popups followed automatically, tabs listed and switched (`web_pages` / `web_switch`), wheel scrolling for virtualized lists (`web_scroll`), file uploads without the system picker, and a crashed browser relaunched once.
- Verification is part of the channel: `web_wait` waits for a URL fragment, page text or a selector, and `web_text` reads what the page actually says, so "clicked and assumed success" is not possible.
- Flow executor, no model in the loop: `web_flow_save` stores a flow (`click` / `type` / `select` / `hover` / `press` / `wait` / `open` / `back` / `upload` / `scroll`), `web_run_flow` runs it step by step — unique hit, `expect` check, stop on failure — and defaults to `dryRun` so the operator sees what would be clicked first. A saved flow costs zero model calls to replay.
- Three browser sources, each behaving as its name says: bundled Chromium launches Chromium, system Chrome launches Chrome, attach only connects to a CDP port. When the chosen mode lacks its prerequisite the panel says so and the web steps fall back to keyboard and mouse instead of failing the task.
- Chrome takeover, operator-authorized: the plugin can ask Chrome to close, restart it on the operator's own profile with a loopback debug port, and attach — logins and extensions come back because nothing is copied or moved. A window that will not close is reported, never force-killed.
- Remote desktop, VM and remote-control tools are evidence, never a reason to switch the channel off: the browser always runs on this machine, so the channel keeps working and falls back to the keyhole only when a page is genuinely unreadable.

**Experience library you can edit by talking**
- `knowledge_graph_list` / `get_path` / `update_path` / `delete` / `relations` / `link` complete the tool set: list what exists, read a whole flow, rename or reorder it in place, see which paths use a node, and get a local deep link (`http://127.0.0.1:<port>/#/node|path/<id>`) that opens the editor on that exact item.
- Deletion is guarded: a node still used by a path is refused, with the paths named; a path never deletes its nodes.
- Fixed a silent data loss: `updatePath` advanced the index but never wrote `paths/<id>.json`, so renames and reorders looked saved and were lost on reload. A regression test now reads the path back through a fresh service.
- Read-only UIA aid: `uia_snapshot` lists the frontmost window's control names, types and rectangles with an in-window center the pointer tools accept. It never invokes a control, never reads or writes a value, and reports a thin tree (Qt, Flutter, old Win32) as unusable.

**One policy instead of three**
- The capability ladder lives in the preset (`cordis.patch.yml`): API/CLI → files and processes → web → launching an app → UIA targeting → screenshot and input. The per-turn injection no longer repeats a competing "default to mouse and keyboard" rule.
- The ball session starts isolated on a fresh install and after an upgrade, so its conversation is its own; only a choice made in settings sticks.

## Install

**Recommended: Settings → Plugins**, and install `dsh-agi` there. The plugin manager writes both the dependency and `dsh.profile.bundles`, so a restart is all that is left.

Command-line install (two steps, both required):

```powershell
& "<DSH install folder>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add dsh-agi@0.6.19
```

`dsh plugin` only forwards its arguments to pnpm and does **not** add the bundle to `dsh.profile.bundles`, so run the bundled enabler once:

```powershell
& "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-agi\install.cmd"
```

It writes the loader entry, checks the native module and asks for a restart. Then quit DeepSeek Harness completely and open it again.

If npm is unreachable, download the newest `.tgz` from [Releases](https://github.com/wanlez/dsh-agi/releases), install it with `dsh plugin add "<absolute path to the tgz>"`, and run the same `install.cmd`.

The package ships its code and runtime dependencies (speech, native modules), so an install never touches another registry; the Electron runtime and speech models still download on first use.

### Older releases (0.6.18 and earlier): install exits with code 1

Those packages depended on `koffi`, whose binary is built by its `install` script; pnpm's build-script policy refuses that (`ERR_PNPM_IGNORED_BUILDS`, exit 1) even though the package installed fine. From 0.6.19 the plugin depends on the prebuilt platform package (`@koromix/koffi-win32-x64`) instead: no install script, exit code 0, and no `allowBuilds` configuration needed.

### Uninstall

The package also contains `uninstall.cmd`: it removes the package and its loader entries plus the speech models and runtime caches, and keeps the experience library, the ball workspace and the conversation archive.

## How to use

- **Voice**: click the ball's avatar to start listening, speak, and click it again to stop. A one-second pause also ends the utterance automatically. Speak and send go through the same path.
- **Images**: paste a screenshot (Ctrl+V) into the panel's composer, up to nine per message, and send it with your text.
- **Persona cards**: Settings → Floating ball → Persona cards. Create or pick a card; the agent then answers in that character every turn.
- **Experience library**: Settings → Floating ball → Knowledge library, or the ball's right-click menu → 进入经验库. Search nodes to view and edit them, search paths to see the whole flow; insert, reorder and check steps inside the path view. Or just ask in the chat box — "创建节点：xxx", "创建路径 A→B→C" — and confirm the steps it lists back.
- **Wake word**: with the ball collapsed, say 你好大肥鱼 (or your configured phrase). The panel opens and pins itself, and the ball answers 我在呢 locally. The wake phrase, reply, threshold, decision granularity and the 1.5 s cooldown are all editable. The 9 MB wake model downloads from this repository on first use. Say 大肥鱼 to interject while the agent works, or 退下吧 to stop and unpin.

## Safe mode and the activity pill

- **Three-colour state**: a pill inside the ball panel shows what the ball is doing. A blue dot means "thinking", a green dot means "acting" (it turns green about 0.35 s before a click or keystroke lands, so you have time to notice), and a red dot means "not working" for five seconds after a task ends or is stopped. The pill hides while nothing is running.
- **Safe mode**: Settings → Floating ball → Safe mode. While it is on, any key you press or any mouse move or click stops the current task immediately, exactly like the stop button. Input the ball injects itself carries the Windows injected flag and never triggers it.
- **Stopping is not ending the chat**: the session and its context stay; keep typing or speaking and the ball carries on from where it was.

## Updates

Settings → Floating ball → Check for updates. The check asks npm first (npmmirror, then npmjs) with GitHub Releases as the fallback; the upgrade prefers `dsh-agi@version` from npm and uses the release tarball when npm is unreachable. Automatic checks are on by default, once a day.

## Models

All model files are served from this repository's releases, so the project no longer depends on the upstream author or on npm.

| Model | Size | Link | Auto-downloaded |
|---|---|---:|---|
| Wake word (`dsh-agi-kws`) | 9 MB | [models-v1](https://github.com/wanlez/dsh-agi/releases/download/models-v1/dsh-agi-kws-2026.10.0.tgz) | yes, on first use |
| Local TTS (`tts`) | 188 MB | [models-v1](https://github.com/wanlez/dsh-agi/releases/download/models-v1/dsh-agi-tts-2026.10.0.tgz) | yes; Hugging Face mirrors first, this tarball as the last resort |
| ASR (`SenseVoice`) | 162 MB | [models-v1](https://github.com/wanlez/dsh-agi/releases/download/models-v1/dsh-agi-asr-sensevoice-2026.10.0.tgz) | no; DeepSeek Harness manages its own ASR. Download manually if you need this exact copy. |
| Bundled Chromium (`159.0.8154.6`) | 207 MB | [web-chromium-159.0.8154.6](https://github.com/wanlez/dsh-agi/releases/download/web-chromium-159.0.8154.6/chromium-win64-159.0.8154.6.zip) | no; download from Settings → Web control when you choose the bundled browser |

## Build from source

```powershell
git clone https://github.com/wanlez/dsh-agi.git
cd dsh-agi
pnpm install
pnpm build    # output in packages/bundle
pnpm test
```

## License

MIT. Upstream copyright belongs to mini-yifan; the modifications belong to dsh-agi contributors. See `LICENSE` and `NOTICE.md`.
