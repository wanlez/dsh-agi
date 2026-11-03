# dsh-agi（中文）

DeepSeek Harness 的悬浮球插件：语音输入、人设卡、经验库、截图学习。

本项目基于 [dsh-orb](https://github.com/mini-yifan/dsh-orb-cordis)（MIT，作者 mini-yifan）修改，改名为 `dsh-agi` 并独立维护。

## 安装

普通用户直接装 Release 里的安装包（目前还没有 npm 包）：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "https://github.com/wanlez/dsh-agi/releases/latest/download/dsh-agi-0.5.3.tgz"
```

然后在 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 的 `dsh.profile.bundles` 里加入 `"dsh-agi"`，重启 DeepSeek Harness。

Release 包只有代码；Electron 运行时和语音模型在首次使用时下载。

## 怎么用

- **语音**：点球上的头像开始说话，再点一次结束；停顿约 1 秒也会自动结束。说出来的内容走和打字发送同一条路径。
- **发图片**：在面板输入框按 `Ctrl+V` 粘贴截图，一条消息最多 9 张，和文字一起发。
- **人设卡**：设置 → 悬浮球 → 人设卡。新建或选中一张卡后，球每轮都按这张卡的设定回复。
- **经验库**：设置 → 悬浮球 → 经验库。选一个文件夹；截图 + 一句说明会保存成 `<流程名>/<流程名>.md`，截图按序号放在 `screenshots/`。
- **唤醒词**：代码支持唤醒词，但默认不自动下载唤醒模型，日常请用上面的“点击说话”流程。

## 模型

所有模型都放在本仓库的 Release 里，不再依赖原作者或 npm。

| 模型 | 大小 | 地址 | 是否自动下载 |
|---|---:|---|---|
| 唤醒模型 `dsh-agi-kws` | 9 MB | [models-v1](https://github.com/wanlez/dsh-agi/releases/download/models-v1/dsh-agi-kws-2026.10.0.tgz) | 是，首次使用时 |
| 本地播报 `tts` | 188 MB | [models-v1](https://github.com/wanlez/dsh-agi/releases/download/models-v1/dsh-agi-tts-2026.10.0.tgz) | 是；先走 Hugging Face 镜像，全失败才用这个整包兜底 |
| 语音识别 `SenseVoice` | 162 MB | [models-v1](https://github.com/wanlez/dsh-agi/releases/download/models-v1/dsh-agi-asr-sensevoice-2026.10.0.tgz) | 否；ASR 由 DeepSeek Harness 自己管理，需要这份副本可手动下载 |

## 从源码构建

```powershell
git clone https://github.com/wanlez/dsh-agi.git
cd dsh-agi
pnpm install
pnpm build    # 产物在 packages/bundle
pnpm test
```

## 许可

MIT。上游版权归 mini-yifan，修改部分归 dsh-agi contributors。见 `LICENSE` 与 `NOTICE.md`。
