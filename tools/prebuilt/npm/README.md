# 离线 npm 本体（`npm-<ver>.tgz`）

`build-runtime.mjs` 的 `loadBundledNpm()` 把这里的 tarball 解到 runtime 的
`lib/node_modules/npm/`，`bin/npm` / `bin/npx` 与 `corepack npm …` 全部改走本地
`npm-cli.js`。目的是让设备上**第一次** `npm install` 完全不联网。

## 为什么必须有这份

`bin/npm` 以前是 corepack shim。corepack 首次运行要按 `packageManager` 字段把
指定的 npm 整包下载到 `~/.cache/node/corepack`，手机侧这条路径既不 EOF 也不超时，
用户看到的就是 `npm install` 永久卡住（与 v0.9.69 修掉的 pnpm 症状同型）。

## 为什么提交 tarball 而不是构建期下载

构建机能不能上网不该成为出包前置条件；与 `tools/prebuilt/native-ml/*.whl` 同一
取舍。tarball 2.9 MiB，解包后约 1900 个文件。

## 版本选择

随包 Node（Termux `nodejs-lts`，当前 24.x）能跑的版本即可；必须满足 npm 自己的
`engines.node`。当前钉 **npm 11.21.3**（`^20.17.0 || >=22.9.0`）。

## 刷新步骤

```bash
# 任意有网机器、任意 node ≥ 22
cd .cache && npm pack npm@11 --pack-destination .
mv npm-11.*.tgz tools/prebuilt/npm/npm-<ver>.tgz
# 改 build-runtime.mjs 的 BUNDLED_NPM_TARBALL
node tools/test-runtime-capability-contracts.mjs
```

`npm pack` 的产物自带全部 `bundleDependencies`（已核对 1500+ 个
`package/node_modules/**`）。`--ignore-scripts` 可加可不加，npm 包的 prepare
只会构建文档。
