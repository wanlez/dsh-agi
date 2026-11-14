# 决策：截图后端保持 BitBlt + PrintWindow，DXGI 暂缓（2026-11-15）

## 结论
不做 DXGI Desktop Duplication 原生模块。截图主链路维持：

1. `DwmFlush()` 等一帧；
2. `BitBlt` 抓当前桌面；
3. 抽样全黑 / 全同色 / 调用失败时，降级 `PrintWindow(PW_RENDERFULLCONTENT)`。

## 为什么暂缓
- 现有 koffi FFI 没有 COM/D3D 绑定，手搓 vtable 桥接脆弱：槽位错位即崩溃、堆破坏或静默泄漏，且难定位。
- 设备生命周期复杂：GPU 重置、驱动更新、热插拔、休眠唤醒都要重建 ID3D11Device / IDXGIOutputDuplication。
- 分支成本高：多适配器、混合显卡、旋转、HDR 色彩空间各一套。
- 故障难复现：只在特定 GPU/驱动/远程会话出现，测试环境覆盖不到。
- 粗估 3–5 人日，算上多 GPU/热插拔/HDR/旋转为 5–8 人日，且属顺利情况。

## 已知能力缺口（接受）
- 受保护内容（DRM 视频）
- 独占全屏 / 部分全屏视频
- RDP 会话
- 10-bit / HDR 输出
以上场景截不到时直接报错，不做兜底。

## 参考：Windows-MCP 的做法
`Windows-MCP/src/windows_mcp/desktop/screenshot.py:119` 用第三方 Python 库 `dxcam` 实现 DXGI 后端，
并按 dxcam → mss → PIL 降级。它自己不打 COM 桥，但也踩了「零超时轮询拿到上一帧」的坑
（`tests/test_dxcam_fresh_frame.py`）。

我们的技术栈是 Node/Electron，`dxcam` 是 CPython 原生扩展，不能直接 import：
- 起 Python sidecar：可行，但要打包 Python 运行时、处理签名与杀软误报、管理子进程崩溃，安装包显著变大；
- 自写 N-API 原生插件：等于把 dxcam 干的事重做一遍，工作量回到上面的估算。

所以「移植」在本栈不成立，只能「照抄思路自己实现」。

## 什么情况下重启这个决策
真实流程被黑屏窗口卡住，且 `BitBlt` 与 `PrintWindow` 都失败时。

届时优先级：
1. 先做「可选 Python sidecar」——独立进程、失败即退出、不经主链路；
2. 若 sidecar 仍不够稳，再考虑 N-API 原生模块。

## 备注
本仓库本轮全部改动统一在本地同一份代码上迭代，未经确认不提交、不推送、不发 npm。
