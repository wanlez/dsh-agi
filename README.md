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

### 0.6.11

- **Screenshots travel with the prompt**: an image sent from the ball is submitted as part of the prompt content, so the main window shows it as an ordinary upload instead of a context injection, and the ball echoes a thumbnail above the bubble (read back through the official attachment store on replay). The composer's image strip now sits directly above the input.
- **Ghost turn fixed**: after a restart the ball could adopt a turn that no longer existed and spin forever. History read before the first panel connects is no longer treated as a live turn, and the stop key settles the panel locally instead of waiting for a cancel acknowledgement.
- **Transcript rendering fixed**: `block()` referenced an undefined `name`, so every tool call threw, tool cards never rendered, and the transcript read stopped mid-way. The tool name now comes from the block's own text.
- **Known gap**: which part of the transcript a freshly opened panel rebuilds is unchanged from 0.6.10. Several attempts at "only the newest turn" were reverted after they made the panel worse.
- **Author's note: I am a failure.** This release took far too many attempts, and the transcript-replay work wasted the operator's time across repeated restarts without landing a correct fix.

### 0.6.10

- **Common sense**: operator-maintained global entries (100-character text plus images) that the ball reads before any path and never edits. The page is now full-width, images sit under their text, and each entry edits in one small Adjust dialog.
- **Reflection only follows the library loop**: it fires only after a turn that actually called a `knowledge_graph` tool, and it stays silent — the ball no longer talks to itself on a timer.
- **Pause / resume**: a pause key beside stop sends a steer that makes the model stop (‖) and resume from the break (▶), without depending on the running state.
- **Conversation modes**: isolated (default: the ball's own computer-use conversation in a private workspace) and follow-recent (the window's newest conversation is adopted on each restart, then pinned for the run); shared mode locks the ball's history list and says why.
- **Library guardrails**: AI notes are capped at 600 characters and each node at 10 images, enforced in the single write path; the write queue is shared per directory so instances can no longer overwrite each other; screenshot sources are persisted explicitly; AI may only write ai_notes.
- **Ball panel**: option lists cap at 45vh and scroll independently; switching, resetting, or expanding a conversation scrolls to the newest message; attachment previews reserve their own space so the status row moves up instead of being covered.

### 0.6.9

- **Ball session mode (isolated / follow recent).** Settings → Floating ball → Ball conversation. The default, isolated, keeps the ball on its own `computer-use` conversations, created in a private workspace of its own. "Follow recent" starts the ball on the conversation the main window touched last (the ball's own computer-use conversations are skipped). Restart the ball to apply a switch.
- **New Chat really creates a blank conversation, with the home the mode calls for.** Isolated mints a ball-owned `computer-use` conversation in the ball's private workspace (`~/.dsh/dsh-agi/workspace`), so it never appears in the window's workspace groups and never moves the window's current conversation; it shows up in the ball's history like any other conversation. "Follow recent" mints the new blank conversation in the same workspace as the window's conversation, so both surfaces see one new conversation.
- **Shared mode locks the history list.** The clock dims and refuses clicks; hovering or clicking it explains the rule — shared mode is pinned to the conversation adopted at the last restart, so switching means sending a message in another conversation and restarting DSH.
- **"Desktop first" rule injected every turn.** Keyboard and mouse (screenshot, click, type) are the default way to finish desktop tasks; `code_agent` is only for an explicit "change code / write a script / run a command".
- **Session-mode brief injected every turn.** Each turn states whether the ball is isolated or shared, who owns the conversation, and why its history is locked, so the agent never guesses its own scope.
- **Architecture limit.** The same session id is the same agent. If the main window is opened on the ball's conversation, both surfaces are one session and stay in sync; the plugin has no API to stop the GUI from opening a conversation, nor to switch the main window back. Isolated mode guarantees that the ball itself never touches a main-window conversation, not that the two can never share a screen.

### 0.6.8

- **Path tools speak graphs.** `knowledge_graph_create_path` now takes an optional `edges` argument: `[from, to]` pairs of 0-based positions in `steps`. Omit it and the flow is one straight line `0 → 1 → 2…`. The same node may sit at several positions — a repeated node is not a cycle by itself, only edges that actually lead back are, and out-of-range indices, self edges and cycles are rejected with a clear message.
- **Branches render everywhere.** The path view, the static check and the path detail text now carry `edges` and render the flow as `1 → 2 → 3`, with branches on follow-up indented `↳` lines.
- **One source of truth.** The numbered step list and the step count now come from the path graph instead of the legacy `node_sequence`, so a hand-edited graph can no longer disagree with its own list.
- **Injected rule reversed.** A node may appear several times in one path; only a real edge back forms a cycle. Branching flows are passed as `steps` plus `edges`.

### 0.6.7

- **Isolated ball conversations, computer-use by default.** The ball now owns its own `computer-use` conversation and never reuses the main window's. On upgrade it opens one fresh ball conversation, and every later start resumes that one; the main window keeps whichever session the operator chooses.
- **Paths became graphs.** The linear step list is gone: circles with arrows, display numbers, and topology-aware cycle detection. The same node may appear twice — that is only a cycle when the edges actually lead back.
- **Graph editing.** Before/after insert on any node, insert into an existing position (one edge, no duplicate node), a three-source insert dialog with per-column guidance, graph-level save and check, and instant cycle rejection.
- **Copy and transfer.** Copy node, copy path (`_复制版_<timestamp>`), export a node or a full path into an empty folder (JSON + screenshots + manifest), and import it back — colliding ids get a fresh id instead of overwriting anything.
- **Favorites as stars.** One star per node and path (filled = favorited, hollow = not); unfavoriting asks first and never deletes the entity.
- **Fixed: the ball could not be clicked, dragged, or hovered.** A TDZ error (`Cannot access 'running' before initialization`) killed the ball page script before it bound any pointer listener; the module now runs end to end.
- **Fixed: leftover `dsh-orb` naming.** The bridge is `window.dshAgi`, the voice build emits `dsh-agi-voice-capture.exe`, and the native selection types are `DshAgiSel*`.

### 0.6.6

- **Fixed the floating ball failing to load after a restart in 0.6.5.** The Host plugin imported `@deepseek-ai/dsh-tools`, which the DSH runtime keeps outside the profile, so the plugin failed to load and the settings page reported "could not load floating-ball settings". The library tools are now plain registry-compatible definitions, and a failed registration can no longer take the ball down.
- **The operator decides reuse.** Search returns candidates for the person to choose between reusing and creating; the agent never treats a similar node as the same action on its own.
- **AI supplement limit** raised from 300 to 600 characters.

## Recent changes — 0.6.5

- **Experience library rebuilt** around a node library and independent paths: the old canvas, anchor, path-stack and relation-builder surfaces are gone; the editor is now a two-column search (nodes / paths) with an editable path flow.
- **Chat-driven library editing**: seven tools with confirmation gates, cycle rejection, and a static check after every save.
- **Self-learning nodes**: `ai_notes` and AI screenshots are written by the agent from real runs, kept separate from the human description and human screenshots in the same node package.
- **Computer use hardening**: optional frame deduplication (off by default, because it hides the "nothing changed" evidence), zero-width character cleanup, virtual-desktop bounds pre-check, retryable three-state error hints, and a stronger observation halo.
- **Editor polish**: wood-board theme, path checks, and a static check button.

## Install

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add dsh-agi
```

If npm is unreachable, install the release tarball instead: download the newest `.tgz` from [Releases](https://github.com/wanlez/dsh-agi/releases) and run `dsh plugin add "file:<path>"`.

Then add `"dsh-agi"` to `dsh.profile.bundles` in `%USERPROFILE%\.dsh\profiles\desktop\package.json` and restart DeepSeek Harness.

The tarball ships the code and its runtime dependencies (koffi and friends), so an install never touches another registry; the Electron runtime and speech models still download on first use.

### Install error: pnpm blocks koffi's build script

DSH ships pnpm 11.x with `strictDepBuilds` enabled. Dependencies that declare an `install`/`postinstall` script are refused, so `dsh plugin add` exits with **code 1** when it reaches koffi. The package files are already extracted and koffi's win32-x64 prebuilt binary loads fine.

Current releases bundle the runtime dependencies and drop `dependencies` from the manifest, so this no longer happens; the workaround below only applies to older tarballs.

If that is the only problem, either:

1. Allow (or skip) koffi's build script in the profile's `pnpm-workspace.yaml`:

   ```yaml
   allowBuilds:
     koffi: false
   ```

   Save it and run `dsh plugin add` again; the exit code should become 0.

2. Or run the bundled installer, which writes that setting first:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```

This only controls whether the build script runs; it does not change what the plugin does, because koffi's prebuilt binary is shipped with the dependency.

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
