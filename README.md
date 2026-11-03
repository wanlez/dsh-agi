# dsh-agi

A floating-ball agent for DeepSeek Harness: voice input, persona cards, a knowledge library, and screenshot learning.

This is a fork of [dsh-orb](https://github.com/mini-yifan/dsh-orb-cordis) (MIT, by mini-yifan), renamed to `dsh-agi` and maintained independently.

## Install

Ordinary users install the release tarball; there is no npm package yet.

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "https://github.com/wanlez/dsh-agi/releases/latest/download/dsh-agi-0.5.3.tgz"
```

Then add `"dsh-agi"` to `dsh.profile.bundles` in `%USERPROFILE%\.dsh\profiles\desktop\package.json` and restart DeepSeek Harness.

The release tarball contains code only. The Electron runtime and the speech models download on first use.

## How to use

- **Voice**: click the ball's avatar to start listening, speak, and click it again to stop. A one-second pause also ends the utterance automatically. Speak and send go through the same path.
- **Images**: paste a screenshot (Ctrl+V) into the panel's composer, up to nine per message, and send it with your text.
- **Persona cards**: Settings → Floating ball → Persona cards. Create or pick a card; the agent then answers in that character every turn.
- **Knowledge library**: Settings → Floating ball → Knowledge library. Pick a folder; a screenshot plus one sentence is saved as `<process>/<process>.md` with numbered images under `screenshots/`.
- **Wake word**: the code supports a wake word, but its model is not auto-downloaded by default. Use the click-to-talk flow above.

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
