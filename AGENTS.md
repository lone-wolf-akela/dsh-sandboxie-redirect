# AGENTS.md — dsh-sandboxie-redirect 开发说明

面向维护本插件的人或 agent。用户向的行为与安装说明见 `README.zh.md`。本文记录架构、硬约束和已证实的经验教训，避免重复踩坑。

## 仓库结构

| 路径 | 职责 |
|---|---|
| `lib/provider.mjs` | 唯一 loader 入口。继承 `@deepseek-ai/dsh-sandbox-local`，只有 `copy-on-write` 预设走重定向，其余委托父类；构造函数里 `wireCompanions()` 挂载 note / host / tool。 |
| `lib/host.mjs` | 注册 session 投影 `sandboxBox`（视图 `{box, root}`）。从 `header.cwd` 推导，只在 Sandboxie 配置里确认本工作区确实拥有某沙盒后才报告。 |
| `lib/client.js` | 浏览器半边：标题栏沙箱名称；下拉与底部按钮的预设图标。 |
| `lib/note.mjs` | 模型侧说明（`systemPrompt` 上下文），仅写时复制模式出现。文本在 `lib/redirect.mjs` 的 `redirectPolicyNote()`。 |
| `lib/tool.mjs` + `lib/tool-schema.mjs` | `sandbox_clear` 工具与其输出 schema（含离线 DSL 校验 `valueSchemaViolations()`）。 |
| `lib/naming.mjs` / `boxes.mjs` / `sbie.mjs` / `koffi.mjs` / `core.mjs` / `redirect.mjs` | 命名、沙盒操作、Sandboxie FFI、核心包加载、重定向拼装。 |
| `bin/dsh-sbie-run.mjs` | 启动器（纯 Node 进程，持有 Sandboxie FFI 与 `--manage`）。 |
| `tools/install.mjs` / `verify-box-binding.mjs` / `inspect-copies.mjs` | 安装、绑定回归验证、副本清单。 |
| `test/*` | 单元 / 投影 / 补丁结构 / 验收 / soak。 |

## 接入方式与平台事实

- **一个声明了 `dsh.client` 的包只能有恰好一个活动 loader 行。** `@deepseek-ai/dsh-client-modules` 的 `reconcilePackage()` 对同一包名多于一个 source 直接抛错，导致启动失败（"resolves from multiple active Loader sources"）。因此 note / host / tool 都不各自成行，而是由 provider 一处挂载。
- **patch 词汇**：非 `insert` 补丁里 `name` 是**守卫**不是重指向——`applyEntryPatches` 只保留 `id` 与其余字段，`name` 与目标不符就整条跳过。所以不能用"改名"换 provider，只能"禁用原行 + 新增 insert 行"。
- **为什么是"预设"而不是第四个模式字面量**：三个模式字面量硬编码在四个核心包里——`dsh-sandbox-policy`（`SANDBOX_MODES` 与 `sandboxMode` 投影 schema）、`dsh-permission-presets`（preset 的 `sandbox` 校验与目录）、`dsh-client-ui-permission-presets`（只对三个已知值给内置图标/文案）、`dsh-sandbox`（`WIDER_MODES`/`writableRoots`）。其中 `SANDBOX_MODES` 在模块求值时被按值读入，`writableRoots` 又被文件围栏直接 import，所以"加第四个枚举值"必须改 asar 或替换多个插件行。改用预设身份区分，这些全都不用动。代价：拒绝文案仍写 "workspace-write"（对文件工具而言确实如此），属文案一致、非行为不一致。
- **客户端半边不是 ES module**：`window.__ModuleLoader__.load({ id, factory: (require) => … })`，用 CJS 风格 `require("react")`；`id` 必须等于包名。发现方式为 `package.json` 的 `dsh.client`（`platform: "web"` + `inject`）与 `exports["./client"]`。
- **客户端改动与插件代码改动都只能靠重启客户端生效**：DSH 是 Electron 应用，没有"刷新页面"语义。
- **核心包只能经 `core.mjs` 的 `importCore(specifier)` 加载**（`createRequire` 锚定 `app.asar/dsh/node_modules` 再 `import(fileURL)`）；路径挂载插件里的裸 specifier 不解析。

## 硬规则（违反会静默失败或造成破坏）

1. **不要 `session.append()` 新事件类型。** 持久化读路径只接受"本 harness 认识"或"信封带 `ignorable: true`"的事件，而 `Session.append()` 无法设置该标记——后果是相关会话重启后打不开。从已有事件（`header.cwd`）推导状态。
2. **投影注册必须走 `ctx.inject(["sessionProjections"], scope => scope.sessionProjections.register(…))`。** 在 provider 构造函数里直接 `ctx.sessionProjections.register` 可能落到尚未就绪的实例上，该实例永远不会被驱动：不建 cell、`apply` 与 `wire.view` 都不被调用，标题栏沙箱名称静默不显示（连快照也没有，因为快照只遍历已有 cell）。
3. **模块顶层只 import Node 内置模块。** 原生模块（koffi）在 Electron 宿主里加载失败会让整行在求值阶段就静默失败，连日志都写不出。原生工作交给纯 Node 子进程（启动器）。
4. **`defineTool` 的 `output.schema` 是 value schema DSL**：`required` 只能出现在 `properties` 映射的直接子节点上；根、`items`、`oneOf` 分支都不允许。`parameters` 是 parameter DSL，`required: true` 写在属性上。离线校验在 `tool-schema.mjs`，`test/validate-patch.mjs` 带反向对照。
5. **安装 / 校验插件文件必须在沙盒外。** 写时复制下，工作区外的写入会被重定向进副本、盒内读是合并视图，于是"报成功 + 读回确认"都可能发生在副本上，真实磁盘一字未变。`tools/install.mjs` 检测 `DSH_SBIE_BOX` 即拒绝，并在盒外逐文件比对 sha256。
6. **诊断写文件，不写 stderr。** 宿主 stderr 事后不可读。provider / host / tool 各自写 `*.log`（`host.log` 有 512 KB 上限，只记状态迁移与 view 变化）。日志里不要写死常量（版本号曾写死字符串，误导排查）。

## 已知问题与规避

- **遗留 `sandbox/box` 事件**：只容忍、不采信。它记录的是历史，不是"沙盒现在存在"的证据；投影从不据此报出名称。
- **投影 state 会被 checkpoint**：改投影语义需升 `stateVersion` 作废旧缓存行。
- **图标 shim 的约束**（`lib/client.js`）：
  - 标记打在**标签 span** 上（按钮子结构随选中态变化，勾选 `<svg>` 会让结构判据失效）；
  - 标记必须**可撤销**（切模式时 React 复用 span 但不会删除未设置的属性，否则两个图标并存）；
  - 只改属性、不向 React 树插节点；用 ARIA（`[role="menu"]`、`button[aria-label*=…]`）而非哈希类名定位；
  - "产品已画图标"只看**前一兄弟节点**是否含 `<svg>`（底部按钮尾部永远有 chevron，也是 span 装 svg）。
- **沙盒内不要遍历 `C:\Sandbox\`**（掉进重定向层递归卡死）；`--manage` 与嵌套启动器在沙盒内不可用（Sandboxie 不把沙盒列表暴露给沙盒内进程）。

## Sandboxie 技术要点

- **可编程入口**：`SbieDll_RunSandboxed`（stdcall，6 参数，`@24`）。`Start.exe` 是 GUI 子系统程序，拿不到 stdio 与退出码。
- **stdio 不通**：进程由 `SbieSvc` 创建，`STARTUPINFOW` 里的标准句柄被忽略；需自建回传。命名管道不通（沙盒内进程连不上），**回环 TCP 可用**——本插件用回环 TCP + 长度前缀帧。
- **命名**：`dsh_<形容词>_<名词>`，由工作区绝对路径（小写）经 64 位 FNV-1a 映射到 90×90 词表；冲突时按确定性候选序列顺延（`boxNameCandidates`），并据沙盒配置里的 `OpenFilePath` 判断归属。约束：盒名仅 `[A-Za-z0-9_]`、宽字符 ≤ 34。启动器也支持 `--mode read-only` 下的 `dshr_` 前缀，但 DSH 的只读预设走原生 ACL runner、不使用沙盒，`dshr_` 盒只会出现在手动以 `--mode read-only` 调用启动器时；历史遗留的 `Dsh_<8 位十六进制>` 盒仍被识别，可被 `--manage` 列出与清理。
- **副本布局**：普通路径 `<沙盒根>\drive\<盘符>\<路径>`；用户目录下 `<沙盒根>\user\current\<相对路径>`。
- **SBIE 消息**：`SBIE2308 [41/C0000024]`、`SBIE2336 [44/C0000022]`、`SBIE2335→SBIE2337 [55/1067]` 表示沙盒初始化失败，启动器做引擎级重试（3 次，超时 7s/10s/15s，间隔 300/600ms）。`SBIE2205 ConsoleInit` 是无害日志噪音。

## 测试

```powershell
node test\run-tests.mjs      # 验收
node test\soak.mjs 30        # 稳定性/延迟
node test\unit.mjs           # 单元
node test\host-projection.mjs
node test\validate-patch.mjs cordis.patch.yml.new
```

验收与 soak 必须在沙盒外、普通用户令牌（Medium IL）下运行；在 DSH 的 Low IL 沙盒里跑无意义。
