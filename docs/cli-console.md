# 桌面任务控制台与 CLI

CLI 连接正在运行的桌面软件。它不会直接修改 `.qy`：模型执行、预览确认、字段锁、修改记录和保存都通过桌面端的同一业务入口完成。

支持 MCP 的外部 AI 客户端还可以通过 **设置 → MCP 连接** 接入同一任务服务，详见[MCP 连接与工具](mcp.md)。CLI 使用每次启动随机的连接文件；MCP 默认关闭，使用独立持久化的固定端口和稳定令牌。MCP 不提供批准工具，计划在桌面控制台确认；CLI 的 `jobs approve` 命令保持自己的明确操作入口。

## 软件中的控制台

左侧 **AI 功能 → 创作控制台** 提供独立页面，包含终端、创作任务和运行日志三个页签。章节写作页点击正文上方的“控制台”按钮，可以展开底部面板并拖动调整高度，方便边写边查看当前任务。

任务视图显示任务状态、绑定作品、模型返回、待确认计划和步骤事件；可以批准、暂停、继续或终止任务。桌面 Agent 和 CLI 使用同一计划校验、字段锁、确认、撤销记录及 `.qy` 保存流程。这里的日志是软件记录的任务步骤，不是全部 Electron 启动日志或 stderr。

终端视图运行真实的本机 PowerShell、cmd 或 Codex 会话，支持输入命令和查看输出。Codex 入口要求本机已经安装对应命令；登录、授权和外部命令行为由该工具处理。终端输出与任务步骤日志分别展示，终端不会被伪装成 Agent 回复。

收起面板只改变显示。退出软件会暂停任务、完成已应用修改的保存处理并关闭终端，不会继续在后台推演；重启显示已保存任务记录，需要作者显式继续。终端会话不跨重启延续。

## 使用

先启动桌面软件，打开或保存 `.qy` 作品集并选中目标作品，再运行：

```powershell
node scripts/qy-cli.mjs status --json
node scripts/qy-cli.mjs inspect --collection characters --json
node scripts/qy-cli.mjs context --query "叶青失踪的师父" --json
node scripts/qy-cli.mjs schema --collection world --json
node scripts/qy-cli.mjs providers --json
```

从 `status` 返回值中读取当前作品集、作品 ID。可以显式指定两个 ID，不会默默跟随软件切换后的作品：

```powershell
node scripts/qy-cli.mjs agent run --portfolio PORTFOLIO_ID --project PROJECT_ID --prompt "创建三位配角，补全人物信息" --mode writing --request-id create-supporting-characters --json
node scripts/qy-cli.mjs jobs list --json
node scripts/qy-cli.mjs jobs status JOB_ID --json
node scripts/qy-cli.mjs jobs approve JOB_ID --json
node scripts/qy-cli.mjs save --portfolio PORTFOLIO_ID --project PROJECT_ID --json
```

`--api` 指定 API 预设，`--chapter` 指定章节；省略 API 使用软件默认配置。`--mode inspiration` 使用灵感模式。提交后立即返回任务 ID，模型仍在后台执行，应查询任务状态或在软件控制台查看进度。

也可以用 `--current` 绑定当前作品：

```powershell
node scripts/qy-cli.mjs agent run --current --prompt "整理本卷的人物动机" --chapter CHAPTER_ID --json
node scripts/qy-cli.mjs plan submit --current --file response.json --json
node scripts/qy-cli.mjs save --current --json
```

`--current` 只用于提交 Agent、计划和保存任务。CLI 先读取一次桌面状态，确认读取完成、已有 `.qy` 保存路径以及完整作品集/作品 ID，再将这些 ID 固定写入本次任务。之后切换作品不会改变此任务目标；执行时与当前选择不符会明确失败。`--current` 不能和显式 `--portfolio` 或 `--project` 混用；`--chapter` 仍需明确指定所需章节。

外部工具也能提交符合软件 Agent 协议的返回 JSON，先预览、再批准：

```powershell
node scripts/qy-cli.mjs plan submit --file response.json --portfolio PORTFOLIO_ID --project PROJECT_ID --json
```

`response.json` 必须是 Agent 返回对象，包含 `message`、`operations` 等正式协议字段。它不是 `.qy` 作品集，也不是模型 API 密钥或软件设置。

例如，外部 Agent 可以提交完整的世界书条目：

```json
{
  "message": "补充雾港的基础设定。",
  "operations": [
    {
      "action": "create_resource",
      "resourceType": "world",
      "title": "雾港",
      "summary": "以灯塔辨认航道的港口。",
      "includeAllFields": true,
      "fields": {
        "触发策略": "关键词",
        "触发键": "雾港，灯塔",
        "内容": "雾港常有浓雾，船只依照岸边灯塔的信号辨认航道。",
        "适用范围": "雾港相关场景",
        "状态": "生效"
      }
    }
  ]
}
```

创建其他标准卡前使用 `schema` 读取完整字段和强化提示词，更新已有卡片使用 `update_resource` 并只传需要修改的字段。自定义结构使用自定义模块协议。普通 JSON 修改计划的确认不调用模型；只有联网搜索等操作需要可用的 API 预设。

任务支持 `jobs pause`、`jobs resume`、`jobs cancel`。暂停不删除原计划；终止不会自动撤销已经应用的内容，撤销请使用软件修改记录。请求超时并不证明提交失败：使用原 `--request-id` 重试或查看 `jobs list`，避免重复提交。

当前 CLI 提供状态检查、资料与结构读取、上下文检索、Agent 请求、计划提交、任务管理和保存入口。它依赖正在运行的桌面编辑器，不是覆盖全部编辑操作、可脱离窗口运行的 headless CLI。直接编辑 `.qy` 不属于 CLI 的写入方式。

## 连接与安全边界

Electron 每次启动生成一个随机端口和独立 bearer token，只监听 `127.0.0.1`。连接文件位于用户数据目录 `console-endpoint.json`：

```json
{
  "version": 1,
  "port": 12345,
  "token": "本次启动的随机连接凭据",
  "pid": 1234
}
```

CLI 默认读取 `%APPDATA%/novel-generator/console-endpoint.json`。可以通过 `QY_CLI_ENDPOINT` 环境变量或 `--endpoint` 指定其他连接文件。CLI 固定访问本机地址，不接受连接文件提供的外部主机。

连接文件属于本机控制凭据，不要分享。服务验证 bearer、拒绝浏览器 Origin、不提供 CORS，并限制请求 JSON 为 2 MiB。`providers` 检查只提供预设信息，API 密钥不会输出。`--json` 在 stdout 输出结果；错误在 stderr 输出结构化 `{ "error": { "code", "message" } }`，退出码为 1。

本机连接、读取和提交请求默认超时 20 秒，可用 `--timeout 10000` 调整。这不是模型生成时间上限；任务提交返回后继续通过状态查询跟踪。

## 任务持久化与恢复

任务存于用户数据目录的 `console-jobs.json`，与 `.qy` 作品内容和 profile 设置分开。每次任务状态、事件和保存断点更新都串行写入独立临时文件，fsync 后原子替换；确认提交前记录已经落盘。最多保存 200 个任务、每任务最近 200 个事件。超过上限先移除可裁剪的已结束历史；暂停任务、待确认任务和已应用但保存失败的检查点不会为腾出空间被删除。没有可裁剪记录时明确拒绝新提交。

任务默认串行执行。生成修改计划后进入 `awaiting_approval`，后续模型生成暂停，等待用户处理。批准是另一次执行，必须重新校验原作品目标、字段锁和内容指纹。

从桌面 Agent 或控制台提交的创作任务还会绑定当时的 Agent 对话。排队期间切换对话后，任务会要求先打开原对话再继续，避免把请求和回复写进另一段聊天。恢复已应用修改的保存断点时，只要求原作品集与作品匹配，不要求保持原章节或对话。

应用修改后，执行器先保存 `{ applied: true, afterFingerprint, changes }` 断点，再进入作品集统一保存队列。保存失败保留断点。继续该任务时只校验并保存已经应用的内容，绝不能重新运行创建或修改操作；指纹不匹配时明确失败，由用户重新生成或处理。

重启将原 `queued`、`running`、`saving` 任务转为 `paused`，不会自动调用模型。已有待确认计划保持可供审核；显式继续暂停的计划也会恢复原预览，避免再次生成。任务记录损坏时停止启动此服务并保留原文件，避免静默覆盖。

取消关窗或重新加载后软件仍打开时，显式提交新任务会恢复调度；之前暂停的任务继续保持暂停，不会被新任务顺带重启。

## 业务接入

`createConsoleService({ storagePath, endpointPath, execute, inspect, logger })` 不依赖 Electron，可用假执行器测试。

- `execute({ action: "run" | "approve" | "cancel", job })` 调用桌面工作区业务。返回 `status: "awaiting_approval" | "completed" | "failed"`，以及 `message`、`plan`、`changes`、`error`、`applied`、`afterFingerprint` 等结果。
- `inspect({ kind: "status" | "workspace" | "context" | "providers" | "schema", projectId?, collection?, query? })` 读取工作区。
- `report(jobId, { title, detail?, state })` 保存进度事件；`state` 为 `queued`、`running`、`done` 或 `error`。
- `checkpoint(jobId, { applied: true, afterFingerprint, changes, plan? })` 必须在原子修改后、作品保存前 await。
- `subscribe(listener)` 在成功持久化后通知完整任务快照，返回取消订阅函数。
- `suspend()` 停止后续调度、暂停现有任务并发送取消；`waitForIdle()` 等待原执行和取消请求全部结束，再由桌面端执行最后保存。`close()`/`dispose()` 清理 HTTP 服务与自己的连接文件。

HTTP 检查使用 `GET /v1/inspect?kind=status`，返回 `{ data }`；任务列表使用 `GET /v1/jobs`，返回 `{ jobs }`；创建使用 `POST /v1/jobs`；单任务为 `GET /v1/jobs/:id`；控制为 `POST /v1/jobs/:id/approve|pause|resume|cancel`，返回 `{ job }`。任务控制立即返回持久化快照，不等待模型完成。进度和保存断点只由可信的桌面内部调用，HTTP 不开放任意 checkpoint 写入。

`electron/mcp-server.mjs` 将上述 service 方法投影为 MCP 工具与只读资源，`scripts/qy-mcp.mjs` 提供 stdio 到该服务的官方协议适配。它们不复制任务执行或文件写入逻辑；配置与令牌保存在独立 `mcp-settings.json`，不使用 CLI 的随机 `console-endpoint.json`。

## 本轮验证

生产构建及完整自动回归通过，最新数字见[路线验收记录](product-roadmap.md#11-验证矩阵)，包含真实 Windows ConPTY 的输入、窗口尺寸变化、Ctrl+C、关闭清理和视图未挂载时持续输出。

使用独立用户数据目录和合成作品集，实际完成了 CLI 提交计划 → 桌面显示预览 → 点击确认 → 完整道具及分组写入 `.qy` → 修改记录写入本机 profile。另一次锁定条目更新被业务层拒绝，文件和编辑器中的原内容均保持不变。桌面检查覆盖整页任务、步骤日志、写作页底部面板和昼夜主题；未调用真实模型 API，未使用用户作品作为测试数据。

MCP 的独立桌面集成也已完成连接表单启用、HTTP / stdio 实际读取、13 个工具发现、外部计划桌面确认、检查点和 `.qy` 保存及锁定字段拒绝覆盖。结果记录于本机 `.tmp/mcp-desktop-result.json`，`success: true`；这使用协议客户端，不代表 Codex、Claude Code、DSH、Zcode 已逐一完成实客户端安装登录验收。完整说明见[MCP 验证范围](mcp.md#7-实现与验证范围)。
