# dsh-agi

[中文](README.zh-CN.md)

A floating-ball agent for DeepSeek Harness. Talk to it, paste screenshots into it, and let it operate your desktop — then let it remember how your workflows actually work.

This is a fork of [dsh-orb](https://github.com/mini-yifan/dsh-orb-cordis) (MIT, by mini-yifan), renamed to `dsh-agi` and maintained independently.

## Why it is different

| | |
|---|---|
| **Voice, not typing** | Click the avatar, speak, click again. Wake phrase (`你好大肥鱼`) opens the panel, a second phrase (`退下吧`) stops the task, and `大肥鱼` interjects while it works. Wake word, ASR and TTS all run locally. |
| **Personas with memory** | Persona cards change who answers each turn. Paired with the knowledge graph, the same ball can behave like a different specialist per project. |
| **A knowledge graph, not notes** | Your screen workflows are stored as executable paths: nodes, hard prerequisites, screenshots as the accuracy reference. The agent looks up the graph before touching an unfamiliar app instead of improvising. |
| **Hardened desktop control** | Six independent safety mechanisms (below) check that every click landed, that the frame is fresh, that the target is really the control it aimed at. |
| **Safe mode** | Any real key or pointer event stops the task instantly; only input the ball injects itself is ignored. Stopping never ends the conversation. |

## Knowledge graph: workflows that survive

Markdown notes go stale and get skipped. `dsh-agi` stores a workflow as a graph instead:

- **Paths** — one prepared procedure per task, with `start_title`, `end_title`, and a `runnable` flag.
- **Nodes** — one step each, with a description and reference screenshots. Nodes are peers; any node can start a flow.
- **Hard prerequisites** — every in-edge is an AND: a node may not run until *all* predecessors are met or explicitly skipped by you.
- **Lookup before acting** — the agent reads `ACTIVE_GRAPH`, matches your request semantically against path names and summaries, asks you to pick one of the best three, then runs `node_sequence` in order.
- **Fail loud, never silent** — when a predecessor is missing it reports exactly `「<next step>」 requires the output of「<previous step>」, currently missing` and offers: run the prerequisite / mark it skipped / edit the edge. It does not improvise and does not skip.
- **A real editor** — create, edit, connect, search, copy, soft-delete and restore nodes in the built-in editor; the operations log records who created, changed, connected or deleted what, in plain Chinese.

Everything lives in a folder you own (`$DSH_HOME\dsh-agi\`), not in a cloud account.

## Hardened computer use

Desktop automation fails in boring ways: a click lands while a modal owns the window, a screenshot shows the frame from before the change, a coordinate is off because the window moved or the second monitor has another DPI. The Windows layer borrows six engineering ideas from [Windows-MCP](https://github.com/CursorTouch/Windows-MCP) and turns each failure into something the model can see:

| Failure | What `dsh-agi` does |
|---|---|
| **A click into a blocked window** | **Action receipts.** Before a click the native layer reports a disabled foreground with an owned dialog; the call returns a structured modal warning with real options (`press-esc` / `focus-modal` / `ask-user`) instead of clicking blindly. |
| **"Did that click do anything?"** | **Post-action verification.** Right after the action the same target is sampled again and four facts are recorded: focus retention, foreground stability, whether the target became disabled, and whether the window moved far enough to invalidate the point. |
| **An old frame** | **Frame freshness + rescue capture.** `DwmFlush` runs before every capture, so the bitmap is a composed frame. A failed or all-black BitBlt switches to `PrintWindow(PW_RENDERFULLCONTENT)`; a degenerate rescue frame still returns the original bitmap plus a trace, never an exception that loses the capture. |
| **Aim that looks right but is not** | **Hover probe.** The preview stage captures the same small rectangle before and after the pointer moves onto the target and reports whether the control actually reacted — pixel differencing with a tolerance, so anti-aliasing and subpixel jitter cannot fake it. |
| **Wrong screen, wrong DPI** | **Display inventory.** Every monitor is enumerated with physical and logical rectangles at per-monitor-v2 DPI awareness. One conversion maps a normalized point → window rect → containing monitor → physical pixel, and the inventory is printed into the observation envelope. |
| **"Could not read" shown as "nothing there"** | **Three-state observation + text hygiene.** Every field is `provided`, `empty`, or `unsampled` (permission, timeout, unsupported), so a failed read can never masquerade as an empty UI. All model-facing text is sanitized: private-use areas removed, lone surrogates repaired, line breaks escaped, truncation marked explicitly. |

These are covered by dedicated suites: 373 host tests and 68 knowledge-graph tests, plus computer-use specs for action receipts, capture strategy, hover, display inventory, text sanitize and window hardening.

## Recent changes — 0.6.1

- **Knowledge graph editor**: favorites, plain-Chinese operations log, soft delete with restore, search-driven relation building (from a node's `+` or the toolbar, independent of the canvas), a 1/3-width detail drawer, and `io.input`/`io.output` removed.
- **Hardened computer use**: the six mechanisms above, plus modal guard, window hardening and diagnostics.
- **Diagnostics**: display inventory is published process-wide so the settings page and troubleshooting route can read it (a preset may not provide Cordis services).
- **Activity pill**: blue "thinking", green "acting" (turns green about 0.35 s before a click or keystroke) and red "not working" for five seconds after a task ends.
- **Safe mode**: a switch in settings; while on, a yellow chip stays beside the activity pill and any real input stops the task. Injected input is ignored, and stopping does not end the conversation.
- **Automatic updates**: the settings page checks npm (npmmirror first) with GitHub as the fallback.

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
- **Knowledge graph**: Settings → Floating ball → Knowledge library. Save a path while you work, or dictate an experience and let the agent file it as nodes with screenshots. Before operating an unfamiliar app the agent looks up the graph and follows the path.
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
