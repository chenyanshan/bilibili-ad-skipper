# B站广告跳过：维护与 GitHub 发布约定

本项目为无运行依赖的 Chrome Manifest V3 扩展。运行源代码在 `extension/`；Chrome 加载这个目录。用户文档必须适合没有开发经验的人阅读。

## 产品约定

- 插件及界面名称为 **B站广告跳过** / **广告跳过**，不要恢复旧名称中的“字幕 AI”。
- AI 识别仅使用 **JEV**，不得恢复 LLM 选项或调用路径。
- JEV 默认地址 `https://api.typesafe.ai`，模型 `jev-latest`，Key 默认空白。
- JEV Key 必须默认空白、只存用户本地，不能提交进源码、截图、文档、压缩包、Actions 日志或 Release。
- 更新时保留用户已有服务配置，不覆盖其 Key、URL、模型；旧 LLM 选择统一按 JEV，旧 LLM Key 不得复用，下次保存设置删除旧字段。
- 费用仅根据已知官方模型的实际输入 Token 估算，注明价格来源与日期；不将本机用量称作余额或账单。
- `research/private-*.json` 为本机完整字幕和实验记录，不得提交。公开研究结论只用短摘录和来源链接。
- README 用相对路径引用 `docs/images/` 图片；用户给的历史截图保留真实性，用说明标明旧界面，不伪造截图。

## 工具和本地验证

需要 Node.js 22+ 和 Python 3。无 npm 依赖，**不需要 `npm install` / `npm ci`**，不要添加无意义锁文件或让工作流依赖不存在的锁文件。

```bash
npm run check
npm test
npm run build
```

- `check` 验证 JS 语法、默认配置、必需文件和版本一致性。
- `build` 只打包 `extension/`，ZIP 根目录必须直接包含 `manifest.json`。不可把整个仓库、外层目录、私有研究或用户配置打进去。
- 输出：`dist/bilibili-ad-skipper-vX.Y.Z.zip`、稳定文件名 `dist/bilibili-ad-skipper.zip`、`dist/SHA256SUMS.txt`。
- 构建产物已 gitignore，不提交 ZIP；公开安装包通过 GitHub Release 发布。

## 版本：只有一个标准更新方式

`package.json` 和 `extension/manifest.json` 版本必须相同，采用 Chrome 可接受的三段数字，不带 `v`。设置页版本从 manifest 动态读取，文档不要硬编码“最新版本”。

```bash
npm run version:set -- 0.3.1
```

上面版本仅示例，实际必须使用比最近 Release 高的未发布版本。**不要单独运行 `npm version`，它不会同步 Chrome manifest。** 不要只修改其中一个版本文件。不要复用、删除重建或强推已经发布的 tag。

## GitHub 标准更新/发布步骤

1. 在工作分支完成修改、必要回归和文档/截图更新。准备 `docs/releases/vX.Y.Z.md`，用用户能理解的语言说明功能变化、默认行为、升级方法和验证结果；不能只给代码比较链接。
2. 用 `version:set` 同步版本。运行 `npm run check`、`npm test`、`npm run build -- --tag vX.Y.Z`；确认输出内 manifest 版本和 tag 一致。
3. 提交代码，推送工作分支并走 PR；合入 `main`。若用户明确要求直接推送自己的仓库，可直接更新 `main`，仍不得跳过检查。
4. 确认目标发布提交已在 `origin/main`，工作区没有遗漏未提交内容。
5. 在**该发布提交**创建新 annotated tag，再推送；不要对旧提交随意打版本标签。

```bash
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin main
git push origin vX.Y.Z
```

6. 等待 **Release extension** 成功，打开 Releases 确认正文包含对应版本的更新说明，检查三个附件、下载 ZIP 校验 SHA256、检查内部 manifest 版本。只有源码已 push、但没有 Release 附件时，不得向用户宣称“新包已发布”。
7. `README.md` 安装入口固定用 `/releases/latest`，不要改成一次性的本地路径或过期版本下载地址。

## 两个工作流的区别

- `.github/workflows/ci.yml`：main 推送、PR、手动触发；检查、测试、打包并上传 Actions Artifact（保留 14 天）。仅推 main **不会创建 Release**。
- `.github/workflows/release.yml`：新 `v*` tag 推送，或手动指定一个**已存在**的 tag；检查 tag 格式、源码在 main 历史中、两处版本一致；使用对应的 `docs/releases/vX.Y.Z.md` 作为正文并上传 Release 附件。main 上更新发布说明或此工作流时，独立任务仅同步当前 package 版本已存在的 Release 正文；尚未发布则等待 tag 发布，不创建空 Release。
- Release 必须使用 `contents: write` 和 GitHub 自动提供的 `GITHUB_TOKEN` / `github.token`；不依赖维护者个人 PAT、JEV Key 或 LLM Key。
- tag 名通过环境变量传给 shell，不把未经验证的用户输入直接拼进 shell。
- 构建规则集中在 `scripts/package.py`，本地与 CI 使用同一个入口。变更打包布局时必须同时检查 README、两个 workflow 和这里的说明。

## 发布失败处理

- **版本/tag 不一致**：若尚未发布，修复版本并生成新的正确 tag；已公开 tag 不强行移动。最稳妥是增加修复版本。
- **main 检查成功但没 Release**：检查是否已推送版本 tag；branch push 不触发发布。
- **网络/临时上传失败**：可以重跑失败工作流，或在 Actions 的 Release extension 手动填写原 tag。发布步骤支持为同一 tag 补传附件，`--clobber` 仅用于同一不可变源码的重跑，不用于偷换已发布代码。
- **workflow 自身有缺陷**：修复 main 后用新版本、新 tag 发布；旧 tag 的 workflow 仍是旧版本，单纯重跑不会获得新修复。
- **发布说明遗漏或需要更正**：更新当前版本的 `docs/releases/vX.Y.Z.md` 并推送 main，由说明同步任务更新已发布正文；不移动旧 tag，也不替换安装包。后续新版本仍需在打 tag 前将对应说明放入发布提交。
- **权限失败**：检查仓库允许 Actions、workflow 的 `contents: write`。通过 HTTPS 推送 `.github/workflows/` 时，classic PAT 除 `repo` 外还需要 `workflow` scope；可使用仓库维护者已授权的 SSH 凭据推送，不要误删工作流以绕过发布准备。不要打印凭据排查。


## 更新检测与原地升级（v0.7.0 起）

- 当前分发为 unpacked 扩展。每天查询固定 GitHub 仓库的正式 Release，只提示不静默安装；失败保留旧观察并显示失败，不当作“已是最新版”。检查不发送 Key、字幕、视频或浏览器登录凭据。
- 原地升级仅设置页显式点击，使用浏览器目录授权；随机探针必须能从当前 chrome-extension URL 读回，不能仅凭同名 manifest 就覆盖另一份目录。
- 固定仓库附件、SHA256、ZIP 路径/大小/CRC、名称/版本/权限/必需入口均须验证；新增权限/Chrome 最低版本要求变化转下载升级。不得放宽成任意地址下载并执行。
- 源文件写入前持久备份；逐文件写后读回，manifest 最后写，错误尝试回退；同扩展多设置页用 Web Locks 串行化。配置与用量在 Chrome 存储，不能覆盖/清空。目录句柄及备份存在独立 IndexedDB。
- 原生目录选择和授权不能静默绕过。无 API、拒绝、目录失效、浏览器崩溃等走明确的下载恢复；不能宣称跨文件更新具备断电原子性。
- 验证记录必须区分真实本机文件夹授权、浏览器 OPFS 文件 API 测试、模拟版本/附件及真实重新加载。当前原生目录选择仅测取消；未完成从人工授权到整包覆盖的端到端验收，见 docs/UPDATES.md。
