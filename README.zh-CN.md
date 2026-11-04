# dsh-agi（中文）

[English](README.md) | **中文**

DeepSeek Harness 的悬浮球插件：语音输入、人设卡、经验库、截图学习。

本项目基于 [dsh-orb](https://github.com/mini-yifan/dsh-orb-cordis)（MIT，作者 mini-yifan）修改，改名为 `dsh-agi` 并独立维护。

## 安装

普通用户直接装 Release 里的安装包（目前还没有 npm 包）：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "https://github.com/wanlez/dsh-agi/releases/download/plugin-v0.5.7/dsh-agi-0.5.7.tgz"
```

然后在 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 的 `dsh.profile.bundles` 里加入 `"dsh-agi"`，重启 DeepSeek Harness。

从 0.5.6 起，Release 包内含代码和运行时依赖（koffi 等），安装不再访问 npm registry；Electron 运行时和语音模型仍在首次使用时下载。

### 安装报错：koffi 的构建脚本被 pnpm 拦截（0.5.3 及更早的包）

DSH 自带的 pnpm（11.x）默认开启 `strictDepBuilds`，安装带有 `install`/`postinstall` 的依赖时会拒绝执行构建脚本。旧版 Release 包（0.5.3 及更早）在 manifest 里声明了 koffi，会命中这一条，`dsh plugin add` 以**退出码 1** 结束，但文件其实已经解压好，koffi 自带的 win32-x64 预编译也能正常加载。

**0.5.6 起已把运行时依赖打进包内并去掉 `dependencies`，不会再触发这个提示**；下面的处理只对旧包有效。

如果确认只是这个原因，任选一种处理：

1. 在 profile 目录的 `pnpm-workspace.yaml` 里允许（或跳过）koffi 的构建：

   ```yaml
   allowBuilds:
     koffi: false
   ```

   保存后重新执行 `dsh plugin add`，退出码应为 0。

2. 或者直接用仓库里的安装脚本，它会先写好上面的配置再安装：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```

注意：这一步只影响构建脚本是否执行，不改变插件功能；koffi 的预编译二进制随依赖一起提供。

## 怎么用

- **语音**：点球上的头像开始说话，再点一次结束；停顿约 1 秒也会自动结束。说出来的内容走和打字发送同一条路径。
- **发图片**：在面板输入框按 `Ctrl+V` 粘贴截图，一条消息最多 9 张，和文字一起发。
- **人设卡**：设置 → 悬浮球 → 人设卡。新建或选中一张卡后，球每轮都按这张卡的设定回复。
- **经验库**：设置 → 悬浮球 → 经验库。选一个文件夹；截图 + 一句说明会保存成 `<流程名>/<流程名>.md`，截图按序号放在 `screenshots/`。
- **唤醒词**：球收起时喊「你好大肥鱼」（可改），面板展开并固定，本机回一句「我在呢」。唤醒词、回复语、灵敏度、判定粒度和 1.5 秒冷却都能改。唤醒模型约 9 MB，首次使用时从本仓库下载。Agent 干活时说「大肥鱼」可以插话，说「退下吧」立刻停止并取消固定。

## 安全模式与状态提示

- **三色状态**：悬浮球面板里有一条状态提示。任务思考时蓝点「大肥鱼正在思考」，动手操作时绿点「大肥鱼正在操作」（真正点击/打字前约 0.35 秒变绿，留出反应时间），任务结束或被停止后红点「大肥鱼不在工作」，5 秒后自动隐藏；没有任务活动时不显示。
- **安全模式**：设置 → 悬浮球 → 安全模式。开启后，你敲键盘、移动鼠标、点击鼠标都会**立刻停止当前任务**（等同按停止按钮），大肥鱼自己注入的点击和打字不会误触发。
- **停止不等于结束会话**：安全模式停下后，会话和上下文都保留，你可以继续打字或语音，像往常一样接着指挥。

## 更新

设置 → 悬浮球 → 检查更新。0.5.6 起从 **GitHub Releases** 查询最新版本（npm 源暂未启用），安装也使用 Release 里的 tgz 地址。自动检查默认开启，每天一次。

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

## 发布（维护者）

Release 包用自定义打包脚本生成：它会把运行时依赖塞进包内、去掉 manifest 里的 `dependencies`，安装时不需要访问 registry，也就不会再触发 pnpm 的构建脚本拦截。

```powershell
pnpm --filter dsh-agi pack -- --version 0.5.4
```

注意：0.5.3 的包是早期用普通 `npm pack` 打的，manifest 里仍声明了依赖，所以会遇到上面的 koffi 提示；用这条命令重新打包即可消除。

## 许可

MIT。上游版权归 mini-yifan，修改部分归 dsh-agi contributors。见 `LICENSE` 与 `NOTICE.md`。
