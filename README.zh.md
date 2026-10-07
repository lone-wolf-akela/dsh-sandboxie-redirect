# dsh-sandboxie-redirect

> **English**: [README.md](README.md)

给 [DSH](https://github.com/deepseek-ai/deepseek-harness) 增加第四种权限预设 **「写时复制」** 的 bundle：shell 命令跑在本工作区专属的 Sandboxie 沙盒里，工作区内的写入照常落到真实磁盘；工作区外的写入、修改、删除不会失败，但只落进该沙盒的副本。原有三个预设（只读 / 仅工作区 / 完全权限）行为不变。

```
┌─ 你的 DSH 会话 ───────────────────┐
│  文件策略：写时复制                │
│                                   │
│  shell 命令 ──▶ Sandboxie 沙盒 ───┼──▶ 工作区内写入   → 真实磁盘
│  （在沙盒内）   （每工作区一个）    ┼──▶ 其它位置写入   → 沙盒副本
│                                   │    其它位置删除   → 副本里只留删除标记
│  读/写/编辑 ──▶ 宿主进程（盒外）    ┼──▶ 规则不变：工作区内可写，区外拒绝
└───────────────────────────────────┘
```

- 仅 Windows，且需要先装 [Sandboxie-Plus](https://sandboxie-plus.com/)（其服务须在运行）。
- 接入方式是权限**预设**，不修改 DSH 应用本体。
- 用途是防误写、可撤销、保持系统目录干净。**不用于防御恶意程序**——Sandboxie 不提供该保证，而插件与承载它的应用拥有同等权限。

## 术语

| 词 | 含义 |
|---|---|
| 真实磁盘 | 系统里实际存放文件的地方（例如 `C:\Users\…`）。 |
| 沙盒 / 盒 | Sandboxie 创建的隔离环境；本插件为每个工作区创建一个。 |
| 副本 | 沙盒对"工作区外文件改动"的私有存储（位于沙盒根下），与真实文件分开。 |
| 盒内 / 盒外 | 写时复制下，shell 命令在盒内运行；DSH 应用本体与它的文件工具（读/写/编辑）在盒外。 |
| 合并视图 | 盒内命令读文件时，沙盒把副本内容叠加到真实文件上呈现。 |
| SandMan | Sandboxie-Plus 自带的图形管理界面，可查看、恢复、删除沙盒。 |

## 安装

**前置条件**：[Sandboxie-Plus](https://sandboxie-plus.com/)（[源码](https://github.com/sandboxie-plus/Sandboxie)）。安装后它的服务须在运行；本插件的所有沙盒都由 Sandboxie 创建与管理。

本包是 DSH 的 **bundle**（自带配置层），装进去就自动挂载，**不需要手改 profile 文件**。

```powershell
# 装进某个 profile（不存在会创建），并自动加入该 profile 的 bundle 列表
dsh plugin --profile <profile> add @lone-wolf-akela/dsh-sandboxie-redirect

# 先不启动，核对配置层，再启动
dsh --profile <profile> --dump-config      # 应看到一行 "# == @lone-wolf-akela/dsh-sandboxie-redirect"
dsh --profile <profile>
```

也支持本地目录 / 离线 tarball：

```powershell
dsh plugin --profile <profile> add C:\path\to\dsh-sandboxie-redirect   # 本地 checkout（link 方式）
dsh plugin --profile <profile> add .\lone-wolf-akela-dsh-sandboxie-redirect-0.3.0.tgz
```

> **哪个 profile 用哪条路？** 正在运行的桌面应用独占的 profile（`desktop`）会被 CLI 拒绝操作（`profile "desktop" is managed exclusively by the Electron application`）。这种 profile 请在**应用内**装：**设置 → 插件 → 添加 bundle**，填上面的包名。其它 profile 用 CLI 即可。

装完重启客户端，在权限下拉里选择 **❐ Copy-on-write 写时复制**。沙盒名称会在第一条 shell 命令之后出现在标题栏。

### 从"手工挂载"迁移

早期版本是"把目录拷到 `~/.dsh/plugins/dsh-sandboxie-redirect` + 在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里加行"。切到 bundle 通道前**必须先删掉那些行**：同一个 `dsh.client` 包有两个活动 loader 行会让启动直接失败（"resolves from multiple active Loader sources"）。要删的是：`name` 为绝对路径、以 `lib\provider.mjs` 结尾的那一行，以及本插件加的 `sandbox`、`permission` 两行。仓库里的 `tools/install.mjs` 仍然保留给手工通道使用，且必须在沙盒外运行。

## 功能

### 写时复制预设

| 位置 | 行为 |
|---|---|
| 工作区**内**的写入、修改、删除 | 直接作用于真实磁盘 |
| 工作区**外**的写入、修改 | 命令报成功，但改动只落在该工作区的副本里；真实磁盘不受影响 |
| 工作区**外**的删除 | 真实文件保留；副本中只记录删除标记 |

DSH 的文件工具（读/写/编辑）在盒外运行，仍按「仅工作区」判定：工作区内可写、区外拒绝。想读"沙盒视角"的文件，用 shell 命令读（见下文「读侧分歧」）。

该预设下，会话的策略文本会追加一段说明，告知模型本模式的行为与注意事项，不必让模型自己推断。

### 标题栏的沙箱名称

写时复制模式下，标题栏显示当前沙盒名称（如 `dsh_able_willow`，悬停可见副本根路径）。它只在两个条件同时满足时出现：该会话的预设是写时复制，且该工作区确已创建沙盒。因此第一条命令后才出现，切换预设或清理沙盒后消失。

### 权限下拉图标

「写时复制」在下拉与底部按钮中带有图标（复制双矩形），随主题配色。预设名以 `❐` 开头也是同一个原因：出厂下拉的图标来自一张封闭的 id→图标表，自定义预设没有图标，而名字是唯一一定渲染的表面。

### sandbox_clear 工具

会话内可用 `sandbox_clear` 查看或清除本工作区的副本：`mode: "inspect"` 仅查看（文件数、占用），`mode: "clear"` 删除副本与配置。任何权限模式下都可用，且只能操作 Sandboxie 认定属于**本工作区**的沙盒。

## 用户注意事项

- **`sandbox_permissions` 的参数描述不是为本预设写的。** 那段文字由 DSH 统一生成、所有预设共用，读起来像"被拒之后的补救"——而写时复制下区外写入**不会被拒**（它会成功落进副本），所以既不会出现拒绝标记，也没有"被拒的命令"可重试。会话的策略文本会明确说明这一点：升权是"这一次调用直接作用于真实磁盘"的主动手段，不是失败的后续动作。
- **读侧分歧（重要）**：同一个路径，不同工具看到的内容可能不同。
  - shell 命令在盒内运行，读到的是合并视图：如果之前有命令在工作区外写过该文件，命令看到的是副本里的版本。
  - DSH 的文件工具在盒外运行，读到的一直是真实磁盘上的版本。
  - 因此：验证"命令在工作区外写了什么"用 shell 命令读；验证"真实磁盘有没有被改动"用 DSH 的文件工具（或资源管理器）读。
- **副本位置**：普通路径在 `<沙盒根>\drive\<盘符>\<路径>`；用户目录下的路径在 `<沙盒根>\user\current\<相对路径>`。Sandboxie 自己配置的沙盒目录会被自动跟随（`FileRootPath`，盒级或 `[GlobalSettings]`，含 `%USER%`/`%SANDBOX%` 展开）；需要时可用 `DSH_SBIE_ROOT` 覆盖（见[环境变量](#环境变量)）。
- **磁盘占用**：副本不自动回收，会持续累积。
- **`C:\Windows\Temp`**：修改其中**已存在**的文件可能被拒（Sandboxie 原生行为，非本插件所致）；新建与删除不受影响。
- **并发**：同一工作区的并发命令共用一个沙盒，互相可见。
- **升权**：写时复制下，若某命令需要更大权限而发起升权，该次调用会整体在盒外运行；下一条命令回到盒内。升权不是"把某个文件变真"的手段。
- **写回**：副本改动默认不回灌真实磁盘。需要恢复时在 SandMan 中查看并恢复；`sandbox_clear` 只做删除，不做写回。
- **卸载** bundle 只会移除预设与配置行，**沙盒与副本仍留在磁盘上**。想收回空间就先清理（`sandbox_clear`，或 `--manage clean`）。

## 手动管理沙盒

```powershell
node bin\dsh-sbie-run.mjs --manage list                    # 列出受管沙盒
node bin\dsh-sbie-run.mjs --manage clean "<工作区>"         # 清理某工作区的沙盒
node bin\dsh-sbie-run.mjs --manage delete-box <沙盒名>      # 删除指定沙盒
```

`--manage` 必须在盒外运行（普通终端，或 `danger-full-access` 会话）：盒内进程看不到沙盒列表。同样的操作也可以在 SandMan 里做。

## 环境变量

全部可选，都是"逃生阀"而非配置面。

| 变量 | 作用 |
|---|---|
| `DSH_SBIE_NODE` | 跑启动器的 `node.exe`。插件会自动去找（桌面应用自带的运行时，其次 `$DSH_HOME/dsh-runtimes`），找不到时用它指定。 |
| `DSH_SBIE_ROOT` | 覆盖沙盒根。通常不需要：Sandboxie 配置的 `FileRootPath` 会被自动跟随。默认 `%SystemDrive%\Sandbox\%USERNAME%`。 |
| `DSH_SBIE_LOG_DIR` | 诊断日志目录。默认 `$DSH_HOME/state/dsh-sandboxie-redirect`。 |
| `DSH_SBIE_INI` | 要读取的 Sandboxie 配置文件。默认 `%SystemDrive%\Windows\Sandboxie.ini`。 |
| `DSH_SBIE_KOFFI` / `DSH_SBIE_KOFFI_ROOT` | 启动器要用的 `koffi.node`（或含它的目录），当找不到应用自带的那份时使用。 |
| `DSH_SBIE_BOX` / `DSH_SANDBOX_ROOT` | **由插件在命令内注入**；"我在哪个盒里"以它们为准，永远不要用工作区路径去推导盒名。 |

诊断文件：上述日志目录下的 `provider.log`、`host.log`、`tool.log`。`host.log` 上限 512 KB，只记状态迁移。

## 实现要点（简述）

- bundle 层禁用原 `sandbox` 行（`@deepseek-ai/dsh-sandbox-local`）并插入本包的 provider，它继承原 provider：只把「写时复制」这一预设分流，其余模式一律委托原 ACL 路径。用 `runnerCommand` 做不到这件事——那会作用于所有模式。
- 同一层把 `copy-on-write` **合并**进 `permission` 的预设目录，保留之前各层贡献的条目。
- shell 命令经 `bin/dsh-sbie-run.mjs`——一个持有 Sandboxie FFI 的纯 Node 子进程。Sandboxie 由服务创建进程并丢弃标准句柄，因此 stdio 走回环 TCP + 长度前缀帧回传。
- 盒名由工作区路径确定性派生成词对（`dsh_<形容词>_<名词>`），不需要状态文件；冲突时按候选序列顺延，且只有当 Sandboxie 配置表明该工作区确实拥有某盒时才采用它。
- 只有"加载 harness 包失败"是致命错误，此时注册的 provider 会**失败关闭**：拒绝执行命令，而不是不加限制地执行。

## 开发

架构与踩过的坑见 [AGENTS.md](AGENTS.md)。常用命令：

```powershell
node test\unit.mjs               # 纯逻辑
node test\host-projection.mjs    # 标题栏投影（不依赖 harness 包）
node test\validate-patch.mjs     # 本 bundle 的层：结构 + 真的执行预设合并表达式
node test\run-tests.mjs          # 验收：真沙盒、真重定向（须在盒外、Medium IL）
```

## 许可

MIT —— 见 [LICENSE](LICENSE)。
