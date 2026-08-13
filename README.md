# research-bridge

`research-bridge` 是一个本地 MCP 服务。它让 ChatGPT 或其他 MCP 客户端能够检查 Git 仓库、启动 Codex 任务、观察事件流、追加纠正指令、检查代码差异与预期产物，以及取消任务。

本仓库目前实现的是 **M1：可观察的双向通信**。现阶段刻意不包含自动语义审查或研究计划审批门禁。

## M1 工具

| 工具 | 用途 |
| --- | --- |
| `bridge_health` | 验证配置和 Git 连接状态 |
| `repo_snapshot` | 读取分支、提交、未提交状态和顶层目录项 |
| `repo_read` | 读取仓库内文本文件的有限行范围 |
| `repo_search` | 在仓库文本文件中执行有结果数量限制的搜索 |
| `codex_start_task` | 启动后台 Codex 任务 |
| `codex_send_followup` | 在同一个 Codex 线程中排队追加纠正指令 |
| `codex_status` | 读取持久化的任务状态和最终回复 |
| `codex_events` | 使用序列游标读取有序事件 |
| `codex_diff` | 读取整个仓库的代码差异和任务基线 |
| `codex_artifacts` | 检查预期产物和发生变化的路径 |
| `codex_record_audit_event` | 写入 ChatGPT 评审、测试证据、语义复核或最终裁决 |
| `codex_audit` | 读取机器审计事件及其研究工作区文件路径 |
| `codex_abort` | 取消排队中或运行中的任务轮次 |

## 环境要求

- Node.js 18 或更高版本
- `PATH` 中可以使用 Git
- 已安装并完成认证的本地 Codex
- pnpm（推荐）或 npm

## 安装与验证

```powershell
pnpm install
pnpm run build
pnpm test
```

编译后的 STDIO 服务入口为 `dist/index.js`。服务只向 stdout 写入协议消息，运行日志则写入 stderr。

## 配置

在 MCP 服务进程中设置以下环境变量：

| 环境变量 | 是否必需 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `RESEARCH_BRIDGE_REPO_ROOT` | 建议设置 | 进程工作目录 | Codex 操作的 Git 仓库绝对路径 |
| `RESEARCH_BRIDGE_DATA_DIR` | 否 | `~/.research-bridge` | 持久化任务记录和 JSONL 事件日志的目录 |
| `RESEARCH_BRIDGE_CODEX_PATH` | 否 | SDK 内置的 Codex 运行时 | 显式指定 Codex 可执行文件 |
| `RESEARCH_BRIDGE_MAX_READ_LINES` | 否 | `500` | 单次文件读取返回的最大行数 |
| `RESEARCH_BRIDGE_MAX_SEARCH_RESULTS` | 否 | `100` | 搜索返回的最大匹配数 |
| `RESEARCH_BRIDGE_MAX_DIFF_CHARS` | 否 | `200000` | 代码差异返回的最大字符数 |
| `RESEARCH_BRIDGE_WORKER_POLL_MS` | 否 | `250` | 常驻 worker 检查新任务的间隔 |
| `RESEARCH_BRIDGE_WORKER_LEASE_MS` | 否 | `15000` | worker 心跳失效后才允许 recovery 的时间 |

本地直接开发时可以这样启动：

```powershell
$env:RESEARCH_BRIDGE_REPO_ROOT = 'C:\absolute\path\to\research-repo'
$env:RESEARCH_BRIDGE_DATA_DIR = 'C:\absolute\path\to\bridge-data'
node .\dist\index.js
```

## 连接 ChatGPT 桌面应用

1. 构建本项目。
2. 打开 **设置 → MCP servers → Add server**。
3. 选择 **STDIO**。
4. 将命令设置为 Node.js 可执行文件的绝对路径。
5. 将 `dist/index.js` 的绝对路径添加为命令参数。
6. 在服务环境变量中添加 `RESEARCH_BRIDGE_REPO_ROOT`，并建议同时添加 `RESEARCH_BRIDGE_DATA_DIR`。
7. 保存并重启 MCP 服务。使用 `/mcp` 确认工具已经可见。

建议先调用 `bridge_health`，再调用 `repo_snapshot`。典型的任务流程如下：

1. 调用 `codex_start_task` 并保存返回的 `id`。
2. 使用 `nextAfterSeq` 游标轮询 `codex_events`，同时检查 `codex_status`。
3. 当实现需要纠正时，调用 `codex_send_followup`。
4. 接受结果之前，检查 `codex_diff` 和 `codex_artifacts`；`codex_diff` 会自动留下 diff inspection 证据。
5. 使用 `codex_record_audit_event` 记录 ChatGPT review、test evidence、semantic review 和 final verdict；确定不再纠正后写入 `bridge.task_closed`。

## 重要语义与安全边界

- Follow-up **不会**中断正在运行的 Codex 轮次。指令会被持久化排队，并在当前轮次结束后立即在同一个 Codex 线程中运行。
- 任务默认使用 `workspace-write`、审批策略 `never`，并关闭网络访问。Codex 沙箱仍然是主要的写入边界。
- `codex_diff` 返回整个仓库的差异。M1 会记录任务开始时的分支、提交和未提交状态，帮助审查者区分原有改动；但是 M1 不会创建 worktree，也不会把每一行改动归因到某一个任务。
- 产物路径必须位于目标仓库内。文件读取和搜索结果均有上限；搜索会跳过符号链接以及常见的生成目录。
- 事件日志采用只追加的 JSONL 格式。只有 task worker 的心跳租约确认失效后，未完成任务才会变为 `interrupted`；如果此前已经捕获 Codex 线程 ID，则可以通过 follow-up 恢复任务。
- 审计日志不写入 `research-bridge` 的数据目录。它始终写入目标研究工作区（`RESEARCH_BRIDGE_REPO_ROOT`）下的 `.agents/audit/bridge/<task-id>/`。每条机器记录都包含序号、时间、任务、actor、事件类型、原始内容、当时的 commit、dirty state 和关联路径。
- `codex_diff`、`codex_artifacts` 和审计记录中的 dirty state 会排除 `.agents/audit/bridge/` 本身，避免审计写入污染被审查的实现差异；普通 `repo_snapshot` 仍返回完整工作区状态。
- MCP stdio 会话与 Codex task worker 分离。`codex_start_task` 返回后，常驻 worker 会继续执行；新的 MCP 会话会依据 worker 心跳识别仍在运行的任务，不会仅因 MCP 进程退出就标记为 `interrupted`。
- worker host lease 同时检查 owner PID 和 heartbeat：已死亡的 owner 会被立即接管；过期 heartbeat 即使遇到 PID 复用也会被回收；只有 PID 存活且 heartbeat 新鲜的 lease 才阻止第二个 worker 启动。
- M1 只提供本地 STDIO 服务，不开放 HTTP 监听，也不实现远程认证。

## 连接 ChatGPT 网页端（仅个人使用）

本项目会读写本机仓库并启动本机 Codex，不建议直接将 HTTP 端口暴露到公网。推荐使用 OpenAI **Secure MCP Tunnel**：ChatGPT 网页端能调用 MCP，但电脑无需开放入站端口，访问权限由 tunnel 关联的 Platform 组织和 ChatGPT 工作区限定。

### 1. 创建私有 tunnel

1. 打开 [OpenAI Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels)，创建一个 tunnel。
2. 只关联你自己的 personal Platform organization 和你要使用的 ChatGPT workspace，不要关联其他组织或工作区。
3. 创建一个供 `tunnel-client` 使用的 runtime API key，并为你自己保留 Tunnels Read + Use 权限。
4. 从 tunnel settings 页面下载最新的 `tunnel-client`，将可执行文件放入 `PATH`。

API key 和 tunnel id 都不应写入仓库或提交到 Git。

### 2. 配置本机端

先构建项目，再在当前 PowerShell 会话中设置密钥和 tunnel id：

```powershell
pnpm install
pnpm run build

$env:CONTROL_PLANE_API_KEY = 'sk-...'
$env:RESEARCH_BRIDGE_TUNNEL_ID = 'tunnel_...'
$env:RESEARCH_BRIDGE_REPO_ROOT = 'C:\absolute\path\to\research-repo'
$env:RESEARCH_BRIDGE_DATA_DIR = 'C:\absolute\path\to\bridge-data'

pnpm run tunnel:init
pnpm run tunnel:doctor
pnpm run tunnel:start
```

如果本地终端没有 `pnpm`，可以直接使用 Windows 启动器（会自动读取项目根目录中的 `.env`）：

```powershell
.\scripts\tunnel.cmd init
.\scripts\tunnel.cmd doctor
.\scripts\tunnel.cmd run
```

`init` 只需执行一次。如果前面已经初始化成功，日常使用只需运行 `.\scripts\tunnel.cmd run`。

`tunnel:init` 只需要执行一次。以后只需在设置了 `CONTROL_PLANE_API_KEY` 和 bridge 环境变量的会话中运行 `pnpm run tunnel:start`。保持该进程运行，ChatGPT 才能访问本机 MCP。

如果不设置 `RESEARCH_BRIDGE_REPO_ROOT` 和 `RESEARCH_BRIDGE_DATA_DIR`，脚本会默认使用本项目根目录和其中的 `.research-bridge` 目录。

### 3. 在 ChatGPT 网页端添加

1. 确保你的 ChatGPT 账号/工作区具有 developer mode 权限，并在 ChatGPT 设置中启用它。
2. 打开 ChatGPT 的 Plugins/App 管理页，创建 developer-mode app。
3. Connection 选择 **Tunnel**，选择刚创建的 tunnel（或粘贴 tunnel id）。
4. 扫描工具后，先调用 `bridge_health`，再调用 `repo_snapshot` 验证连接。

这个方案用你的 OpenAI 组织/工作区身份限制 tunnel 的可见性，适合个人开发和使用，不用于公开发布 plugin。如果未来要给其他用户使用，则应改为稳定的 HTTPS Streamable HTTP 端点，并实现符合 MCP 授权规范的 OAuth 2.1，不要使用共享静态 API key 代替用户认证。

## 持久化数据结构

```text
<data-dir>/
  tasks/
    <task-id>/
      record.json
      events.jsonl

<research-workspace>/
  .agents/
    audit/
      bridge/
        <task-id>/
          events.jsonl
          audit.md
```

`<data-dir>` 中的 `record.json` 和 `events.jsonl` 是 bridge 自身的任务状态与内部事件流。研究工作区中的 `events.jsonl` 是稳定、机器可读的审计记录，`audit.md` 会在每次审计事件追加后原子重建，供人类和 Codex 直接阅读。
