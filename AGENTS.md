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
| `lib/log.mjs` | 诊断落点：`$DSH_HOME/state/dsh-sandboxie-redirect/`，可用 `DSH_SBIE_LOG_DIR` 覆盖。**绝不写进包目录**——bundle 装在 profile 的 `node_modules`（可能直接来自 pnpm store）里。 |
| `lib/naming.mjs` / `boxes.mjs` / `sbie.mjs` / `koffi.mjs` / `core.mjs` / `redirect.mjs` | 命名、沙盒操作、Sandboxie FFI、核心包加载、重定向拼装。 |
| `cordis.patch.yml` | 本包的 **bundle 层**（`dsh.bundle.patch`）：禁用 stock sandbox 行、把 `copy-on-write` 合并进 `permission` 行的预设目录、插入本包。行按**包名**引用，不含绝对路径。 |
| `bin/dsh-sbie-run.mjs` | 启动器（纯 Node 进程，持有 Sandboxie FFI 与 `--manage`）。 |
| `tools/install.mjs` / `verify-box-binding.mjs` / `inspect-copies.mjs` | **手工通道**（把工作区拷进 `~/.dsh/plugins`）的安装/校验/清单工具，面向维护者；公开用户走 `dsh plugin add`。 |
| `test/*` | 单元 / 投影 / 补丁结构 / 验收 / soak。 |

## 接入方式与平台事实

- **一个声明了 `dsh.client` 的包只能有恰好一个活动 loader 行。** `@deepseek-ai/dsh-client-modules` 的 `reconcilePackage()` 对同一包名多于一个 source 直接抛错，导致启动失败（"resolves from multiple active Loader sources"）。因此 note / host / tool 都不各自成行，而是由 provider 一处挂载。
- **patch 词汇**：非 `insert` 补丁里 `name` 是**守卫**不是重指向——`applyEntryPatches` 只保留 `id` 与其余字段，`name` 与目标不符就整条跳过。所以不能用"改名"换 provider，只能"禁用原行 + 新增 insert 行"。
- **为什么是"预设"而不是第四个模式字面量**：三个模式字面量硬编码在四个核心包里——`dsh-sandbox-policy`（`SANDBOX_MODES` 与 `sandboxMode` 投影 schema）、`dsh-permission-presets`（preset 的 `sandbox` 校验与目录）、`dsh-client-ui-permission-presets`（只对三个已知值给内置图标/文案）、`dsh-sandbox`（`WIDER_MODES`/`writableRoots`）。其中 `SANDBOX_MODES` 在模块求值时被按值读入，`writableRoots` 又被文件围栏直接 import，所以"加第四个枚举值"必须改 asar 或替换多个插件行。改用预设身份区分，这些全都不用动。代价：拒绝文案仍写 "workspace-write"（对文件工具而言确实如此），属文案一致、非行为不一致。
- **客户端半边不是 ES module**：`window.__ModuleLoader__.load({ id, factory: (require) => … })`，用 CJS 风格 `require("react")`；`id` 必须等于包名。发现方式为 `package.json` 的 `dsh.client`（`platform: "web"` + `inject`）与 `exports["./client"]`。
- **客户端改动与插件代码改动**：profile 是 **live** 的——改 `cordis.patch.yml` 后宿主会在数秒内重新合成并加载（实测：写入补丁 2 秒后 `provider.log` 出现 `provider constructed`，`sandbox` 行转为 `inactive`，浏览器半边的 slot 占用者也在同一次重载后出现）。但 `lib/*.mjs` **代码**改动不会被重新求值，仍需重启客户端。副作用：`tools/install.mjs` 的 `rm`+`cp` 序列在 live 宿主下不是原子的，宿主可能在复制途中加载到半个包。
- **核心包只能经 `core.mjs` 的 `importCore(specifier)` 加载**（`createRequire` 锚定 `app.asar/dsh/node_modules` 再 `import(fileURL)`）；路径挂载插件里的裸 specifier 不解析。

## 分发包形态（bundle）

- 包声明 `dsh.bundle.patch: "./cordis.patch.yml"`，`files` **必须包含**该文件；`exports["."]` **必须**指向 `lib/provider.mjs`——bundle 行按包名插入，行名解析到的就是包的入口（历史上 `main` 指向 `lib/host.mjs`，那样 bundle 行会挂到错误的半边，沙箱 provider 根本不生效）。
- 用户安装：`dsh plugin --profile <name> add @lone-wolf-akela/dsh-sandboxie-redirect`（也支持 `./目录`、`pnpm pack` 出的 tarball、`github:user/repo`）。`dsh plugin` 把包追加进 profile 的 `dsh.profile.bundles`，**不需要**手改 profile 文件。包名带 scope，所以 `publishConfig.access: "public"` 是必需的——带 scope 的包默认 private。
- **包名出现在三个必须一致的地方**：`package.json` 的 `name`、`cordis.patch.yml` 插入行的 `name`、`lib/client.js` 里 `window.__ModuleLoader__.load({ id })` 的 id。改名前先看 `test/unit.mjs` 的对应断言。
- 开发回路：`dsh plugin --profile dev add ./` 会把当前 checkout link 进 profile；改 `lib/*.mjs` 后重启客户端即可，不必反复手工拷贝。
- **手工通道**（`~/.dsh/plugins/…` + 绝对路径行）仍被 `test/validate-patch.mjs` 支持（它从 path 行反推包目录，所以两种形态都能校验），但不再是公开安装路径；旧的 `cordis.patch.yml.new` 模板已删除。
- 层顺序：bundle 层（按 `dsh.profile.bundles` 顺序）→ profile 自己的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch`。越靠后越优先；patch **整行替换** `config`，不深合并——所以任何要"改一行里的一部分"的补丁都必须把整行交出来，本包因此用 `!!js` 交出算好的整份预设目录（见下条）。
- **`permission.config.presets` 是算出来的，不是字面量**：`!!js` 表达式读 `ctx.loader.entries()` 里已合成的 `permission` 行再合并。整行替换语义下，字面量会把上游或其它 bundle 新增的预设静默删掉。表达式读不到就回退到字面量的 stock 三个——失败方向永远是"旧行为"，绝不会是"预设目录少了自带预设"。`test/validate-patch.mjs` 会**真的执行**这段表达式（stub ctx），并断言"另一层新增的预设被保留、`copy-on-write` 紧随 workspace-write、其余条目未被改动"。
- **`peerDependencies` 按宿主内置版本写**：本机实测宿主为 `@deepseek-ai/dsh-* 0.2.0-rc.2`、`@deepseek-ai/cordis 4.0.4`（而 npm 上 profile 装到的是 `0.1.1-rc.2`）。官方建议把这些包同时写进 `devDependencies`，这里**故意不写**：宿主版本没发布在 npm 上，装不进开发树；而且本插件的测试刻意不依赖 harness 包（host 半边靠改写 import 加载），所以 devDependencies 只有 `js-yaml`。预发布 semver 的元组极敏感——宿主换到 `0.2.1-rc.x` 这类新元组时 `^0.2.0-rc.2` 不再匹配，用户会看到 incompatible 警告与 `dsh plugin allow-version` 豁免提示，所以每次跟随 DSH 版本都要重新实测闸门判定。

## 硬规则（违反会静默失败或造成破坏）

1. **不要 `session.append()` 新事件类型。** 持久化读路径只接受"本 harness 认识"或"信封带 `ignorable: true`"的事件，而 `Session.append()` 无法设置该标记——后果是相关会话重启后打不开。从已有事件（`header.cwd`）推导状态。
2. **投影注册必须走 `ctx.inject(["sessionProjections"], scope => scope.sessionProjections.register(…))`。** 在 provider 构造函数里直接 `ctx.sessionProjections.register` 可能落到尚未就绪的实例上，该实例永远不会被驱动：不建 cell、`apply` 与 `wire.view` 都不被调用，标题栏沙箱名称静默不显示（连快照也没有，因为快照只遍历已有 cell）。
3. **模块顶层只 import Node 内置模块。** 原生模块（koffi）在 Electron 宿主里加载失败会让整行在求值阶段就静默失败，连日志都写不出。原生工作交给纯 Node 子进程（启动器）。
4. **`defineTool` 的 `output.schema` 是 value schema DSL**：`required` 只能出现在 `properties` 映射的直接子节点上；根、`items`、`oneOf` 分支都不允许。`parameters` 是 parameter DSL，`required: true` 写在属性上。离线校验在 `tool-schema.mjs`，`test/validate-patch.mjs` 带反向对照。
5. **安装 / 校验插件文件必须在沙盒外。** 写时复制下，工作区外的写入会被重定向进副本、盒内读是合并视图，于是"报成功 + 读回确认"都可能发生在副本上，真实磁盘一字未变。`tools/install.mjs` 检测 `DSH_SBIE_BOX` 即拒绝，并在盒外逐文件比对 sha256。
6. **诊断写文件，不写 stderr。** 宿主 stderr 事后不可读。provider / host / tool 各写 `*.log` 到 `$DSH_HOME/state/dsh-sandboxie-redirect/`（`DSH_SBIE_LOG_DIR` 可覆盖；`host.log` 有 512 KB 上限，只记状态迁移与 view 变化）。**不要写进包目录**：bundle 装在 profile 的 `node_modules`，还可能是 pnpm store 的内容寻址副本，往那里追加文件既污染安装树也可能直接失败。日志里不要写死常量（版本号曾写死字符串，误导排查）。
7. **跑启动器必须用真正的 node，找不到就响亮失败。** `process.execPath` 在 Electron 宿主里是 Electron 二进制，拿它跑启动器会把原生 koffi 工作塞回 Electron 进程。`lib/redirect.mjs` 的 `resolveNodePath()` 候选顺序：`DSH_SBIE_NODE` → `<resources>/runtime/primary-runtime/dependencies/node/bin/node.exe`（安装目录由用户决定，`process.resourcesPath` 是唯一可靠入口）→ `$DSH_HOME/dsh-runtimes/*/dependencies/node/bin/node.exe`（本版本**按需**创建，新机器上首次可能不存在），并且只在**非 Electron** 宿主才接受 `process.execPath`。全都找不到时返回 `null`，`confine()` 抛 `SANDBOX_UNAVAILABLE` —— 曾经的"回退到 `process.execPath`"是把失败推到盒内，事后无法归因。

## 已知问题与规避

- **升权说明的文本不归本插件所有，也不该去改**：`sandbox_permissions` 的参数描述来自 `@deepseek-ai/dsh-sandbox` 的 `sandboxPermissionsDescription(subject)`，被 `dsh-tool-pwsh` / `dsh-tool-bash` / `dsh-tool-fs` 在**注册工具时**烘进参数 schema，而 `dsh-tools` 对编译结果做了 `deepFreeze()`（`lib/index.js` 的 `binding(deepFreeze(schema))`），并且它是 **registry 全局**的——同一段文本服务所有预设，这正是上游"schema 是全局的，有效模式才是每次调用的事实"的设计。因此按会话纠正它只有一条路：我们自己拥有的 `sandbox:copy-on-write` systemPrompt 文本（`redirectPolicyNote`）。那段文本必须**显式纠正**"先被拒、再重试"的措辞，并说明本模式下区外写入**根本不会被拒**、不会出现 `[sandbox: file access denied under … mode]`、也就没有"被拒的命令"可重试（`test/unit.mjs` 有三条断言钉住这一点）。正解在上游：需要"按模式提供升权文案"的扩展点。
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
node test\run-tests.mjs                       # 验收
node test\soak.mjs 30                          # 稳定性/延迟
node test\unit.mjs                             # 单元
node test\host-projection.mjs
node test\validate-patch.mjs                   # 默认校验本仓库的 cordis.patch.yml（bundle 层）
node test\validate-patch.mjs <某个 patch.yml>   # 也可校验 profile 补丁 / 手工通道
```

`validate-patch.mjs` 需要 js-yaml（harness 自己用的解析器），按顺序在 `node_modules`（devDependency）、`asar-yaml/`（本地从 `app.asar` 提取的副本）、`$DSH_HOME/profiles/node_modules` 里找，或用 `DSH_YAML` 指定。它同时支持两种行形态：bundle 层的**包名**行，以及手工通道的**绝对路径**行（后者会从行反推包目录，因此校验的是实际挂载的那份代码）。

验收与 soak 必须在沙盒外、普通用户令牌（Medium IL）下运行；在 DSH 的 Low IL 沙盒里跑无意义。测试会把 `DSH_SBIE_LOG_DIR` 指到临时目录，避免污染真实用户的 `$DSH_HOME/state`。

## 环境变量、沙盒根与迁移

- `DSH_SBIE_ROOT`：沙盒根（**父目录**）覆盖。`FileRootPath` 会被自动跟随：宿主半边读 ini（`fileRootPathFor` → 盒级优先、其次 `[GlobalSettings]`），启动器 / `--manage` 走 `SbieIni query`（进程内按盒 memo），两者都交给 `resolveBoxRoot()`。要点：**`FileRootPath` 指的是该盒自己的目录**（模板含 `%SANDBOX%`），而 `boxRoot(box, parent)` 接的是父目录——两者不可混用。模板若不含 `%SANDBOX%`、含未知占位符、或展开后不是绝对路径，一律返回 `null` 退回默认布局：**错误路径的代价必须是"漏清理"，绝不能是"删错目录"**（`--manage` 的删除是 `rm -rf` 那个目录）。
- 其它覆盖：`DSH_SBIE_NODE`（真 node）、`DSH_SBIE_LOG_DIR`（日志目录）、`DSH_SBIE_INI`（ini 路径）、`DSH_SBIE_KOFFI` / `DSH_SBIE_KOFFI_ROOT`（koffi 定位）。
- **迁移陷阱（会直接导致启动失败）**：从手工通道切到 bundle 通道时，profile 的 `cordis.patch.yml` 里那三条行（绝对路径 `insert` + `sandbox` + `permission`）**必须先删掉**。同一个声明了 `dsh.client` 的包有两个活动 loader 行，client-modules 会拒绝合成并让整个 boot 失败（"resolves from multiple active Loader sources"）。
- **CLI 不能碰桌面应用独占的 profile**：`dsh --profile desktop …` 会被拒绝（"profile desktop is managed exclusively by the Electron application"），那是 `plugin_manager`（应用内）的地盘；其它 profile 走 CLI。
- `tools/install.mjs` 的拷贝清单已从 `package.json` 的 `files` 派生，不再手工维护、不会与发布内容漂移。

## 发布清单

1. `package.json` 版本号 + `CHANGELOG.md`（写清日期）。
2. `npm test` 全绿；`npm run pack:check` 只应看到 `lib bin cordis.patch.yml README(×2) CHANGELOG LICENSE package.json`——tests / tools / probe / AGENTS / `CONTRIBUTING` / `SECURITY` 都不进包。
3. 提交并推送，打**签名标签** `git tag -s vX.Y.Z`（本机 `commit.gpgsign=true`，历史是签名的）。
4. `npm publish`：包名带 scope，`publishConfig.access=public` 已在包里；开了 2FA 会要一次性验证码。
5. **pnpm 11 的 `minimumReleaseAge` 会拦住发布不足 24 小时的新版本**：实测 `dsh plugin add` 会自动往 profile 的 `pnpm-workspace.yaml` 写一条 `minimumReleaseAgeExclude` 才放行；用户直接 `pnpm add` 需自行放行。
6. `peerDependencies` 跟着宿主版本走：宿主换到新元组（如 `0.2.1-rc.x`）时 `^0.2.0-rc.2` 不再匹配，用户会看到 incompatible 警告并需要 `dsh plugin allow-version` 开豁免——**每次跟随 DSH 版本都要用临时 profile 重测闸门**。
7. 发布后核对三件事：`npm view <pkg> version dist-tags.latest`；**用一个临时 profile 走 `dsh plugin add <pkg>@<version>`**（按包名解析，而不是 link/tarball）；以及 `npm view <pkg>@<version> gitHead` 是否等于推送的 commit——它证明发布产物与仓库同源。
8. **新包的 packument 有边缘传播滞后**：刚发布的一两分钟内 `npm view <pkg>` / `dsh plugin add <pkg>` 可能 404，而版本端点、`dist-tags` 与 tarball 已经 200。等一两分钟重试即可，别急着判定发布失败。
