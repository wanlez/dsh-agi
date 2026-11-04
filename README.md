# dsh-agi

A floating-ball agent for DeepSeek Harness: voice input, persona cards, a knowledge library, and screenshot learning.

This is a fork of [dsh-orb](https://github.com/mini-yifan/dsh-orb-cordis) (MIT, by mini-yifan), renamed to `dsh-agi` and maintained independently.

## Install

Ordinary users install the release tarball; there is no npm package yet.

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "https://github.com/wanlez/dsh-agi/releases/download/plugin-v0.5.6/dsh-agi-0.5.6.tgz"
```

Then add `"dsh-agi"` to `dsh.profile.bundles` in `%USERPROFILE%\.dsh\profiles\desktop\package.json` and restart DeepSeek Harness.

The release tarball contains the code; npm dependencies are fetched by pnpm during install (see the koffi note below), and the Electron runtime and speech models download on first use.

### Install error: pnpm blocks koffi's build script

DSH ships pnpm 11.x with `strictDepBuilds` enabled. Dependencies that declare an `install`/`postinstall` script are refused, so `dsh plugin add` exits with **code 1** when it reaches koffi. The package files are already extracted and koffi's win32-x64 prebuilt binary loads fine.

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
- **Knowledge library**: Settings → Floating ball → Knowledge library. Pick a folder; a screenshot plus one sentence is saved as `<process>/<process>.md` with numbered images under `screenshots/`.
- **Wake word**: with the ball collapsed, say 你好大肥鱼 (or your configured phrase). The panel opens and pins itself, and the ball answers 我在呢 locally. The wake phrase, reply, threshold, decision granularity and the 1.5 s cooldown are all editable. The 9 MB wake model downloads from this repository on first use. Say 大肥鱼 to interject while the agent works, or 退下吧 to stop and unpin.

## Models

All model files are served from this repository's releases, so the project no longer depends on the upstream author or on npm.

| Model | Size | Link | Auto-downloaded |
|---|---:|---|---|
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
