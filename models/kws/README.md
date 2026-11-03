# dsh-agi-kws

Wake-word model files for the [dsh-agi](https://www.npmjs.com/package/dsh-agi) floating ball.
Data only: this package has no entry point and nothing to `import`.

这是悬浮球的唤醒词模型数据包，只给 `dsh-agi` 插件用，不需要手动安装。

## 里面是什么

`sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20` 里 spotter 真正会打开的那 8 个文件，
放在 `kws/` 下（来源、裁剪说明和许可证见 [NOTICE.md](NOTICE.md)）：

```
kws/tokens.txt
kws/en.phone
kws/encoder-epoch-13-avg-2-chunk-{8,16}-left-64.int8.onnx
kws/decoder-epoch-13-avg-2-chunk-{8,16}-left-64.onnx
kws/joiner-epoch-13-avg-2-chunk-{8,16}-left-64.int8.onnx
```

chunk-8 和 chunk-16 两套都带着，因为设置里的「判定粒度」可以在两者之间切。

## 插件怎么用它

`dsh-agi` 的「下载语音唤醒模型」按钮按这个顺序拉压缩包：

1. `https://registry.npmmirror.com/dsh-agi-kws/-/dsh-agi-kws-<version>.tgz`
2. `https://registry.npmjs.org/dsh-agi-kws/-/dsh-agi-kws-<version>.tgz`
3. GitHub 上的原始 release（最后的兜底）

版本号写死在插件的 `packages/voice/src/manifest.ts` 里，同时钉着这个 tarball 的 sha256。
校验不过就换下一个源，三个都不成才报错——所以镜像里出现一个坏包不会污染本机。

## 版本怎么走

版本号跟模型走，不跟插件版本走：

- `2026.10.0` — 首次打包，模型仍是上游 `2025-12-20` 那一版
- 上游换了模型 → 新版本号，例如 `2027.1.0`；插件改一个常量再发版

已发布的版本不改。要重新打包就必须升版本号，npm 也会拒绝覆盖。

## 重新打包

```sh
node models/kws/scripts/pack.mjs --from ~/.dsh/dsh-agi/voice/kws
```

不传 `--from` 时读默认位置 `~/.dsh/dsh-agi/voice/kws`。脚本会校验 8 个文件都在，
打出 `dsh-agi-kws-<version>.tgz` 并打印 sha256 和字节数。

然后：

1. 把 sha256 和字节数填进 `packages/voice/src/manifest.ts` 的 `WAKE_MODEL_SHA256` / `WAKE_MODEL_BYTES`
2. `npm publish ./dsh-agi-kws-<version>.tgz`

**发布的就是这个 tarball 本身**，不要 `npm pack` 重新打一遍：重新打包会换掉 mtime，
sha256 变了，插件就再也校验不过。

## 许可

模型是 Apache License 2.0（见 [LICENSE](LICENSE)），本包只做字节级的子集再分发，
未做任何修改。这个仓库自身的代码是 MIT。
