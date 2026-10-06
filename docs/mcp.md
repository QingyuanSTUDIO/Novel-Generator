# MCP：从外部 AI 客户端操作叙事工坊

叙事工坊提供本机 MCP 服务，让外部 AI 客户端读取作品资料、检索上下文、调用软件内的 Agent，或自行生成修改计划并提交给桌面端。MCP、桌面 Agent 和 CLI 共用任务队列、结构校验、字段锁、修改记录及统一 `.qy` 保存流程。

MCP 默认关闭。它依赖正在运行的桌面编辑器，不会独立打开作品集，也不会在软件退出后继续写作。MCP 不提供批准修改的工具；作者在桌面控制台审核并确认计划。

## 1. 启用与连接

1. 通过 `start.bat` 或 `npm run desktop:dev` 启动桌面端。
2. 打开或保存 `.qy` 作品集，选中准备操作的作品。
3. 进入右上角 **设置 → MCP 连接**，勾选“启用 MCP 连接”。
4. 保留默认端口 `43127`，或填写 `1024～65535` 范围内的可用整数端口。
5. 点击“保存并应用”，确认服务显示“运行中”。
6. 在“客户端连接”选择所需客户端类型并复制配置，合并到客户端现有 MCP 配置中。

默认地址：

```text
http://127.0.0.1:43127/mcp
```

界面上的地址来自已经保存的配置；只修改端口输入框而没有“保存并应用”，不会改变运行中的服务。复制前先确认配置已经应用。服务启动失败不会阻止小说编辑器打开，错误会显示在 MCP 连接页面中。

### 主界面连接状态

标题栏“已保存”左侧显示 **MCP 未连接 / MCP 已连接**。未连接红灯、已连接绿灯；文字使用外观设置的字体色，状态灯使用危险色 / 成功色，白天和夜间调色板分别生效。

服务“运行中”表示可接受连接，不等于已有客户端。只有认证通过、经 SDK 成功处理的有效 MCP 活动才点亮绿灯；无效令牌、Origin、JSON、协议和工具参数不会建立连接状态，单纯服务探测也不计入。

本机 HTTP 使用活动租约，不表示永久保持的网络会话：

- 有效请求续期 90 秒；没有后续请求或心跳时，到期自动推送“未连接”；
- stdio 适配器各有独立随机客户端 ID，每 20 秒发送心跳；
- stdio 退出或输入 EOF 时通过认证 DELETE 撤销自身连接，不影响其他客户端；
- 直接 HTTP 不提供客户端 ID 时计为一个活动组；客户端没有心跳时按最近请求判断；
- 停用、服务重启、切换端口或轮换令牌会清空连接状态。

鼠标停在状态文字上可查看活动组数量与判断规则。已连接只表示客户端活动，不表示任务已经执行、修改已批准或作品已保存。

### stdio 与 HTTP

设置提供两种连接方式：

| 方式 | 如何认证 | 适用入口 |
| --- | --- | --- |
| stdio | 客户端启动 `scripts/qy-mcp.mjs`；适配器自动读取本机 MCP 配置并认证桌面 HTTP 服务 | Codex、Claude Code、DSH、Zcode 及支持 stdio 的客户端 |
| Streamable HTTP | 客户端连接本机 `/mcp`，每个请求携带 `Authorization: Bearer …` | 支持 HTTP MCP 与自定义请求头的客户端 |

stdio 适配器只转发协议，不重复实现业务工具，不直接读写 `.qy`，也不额外启动一个小说生成 Agent。它运行时在每次工具或资源操作前重新读取已保存的端口和令牌；修改端口或重新生成令牌后，下一次操作会使用新配置。桌面服务关闭时操作会返回错误。

安装的 SDK v2 现代协议不支持 `ping`，适配器的内部 HTTP 跳使用 SDK 的 legacy 协商发送标准心跳；对外 stdio 仍支持现代和 legacy 协议，13 个业务工具保持一致。

复制的 stdio 配置会优先使用本机系统 Node 的绝对路径，同时带上适配脚本及 `--settings` 的绝对路径。如果系统 Node 无法定位，配置会回退为 `node`，需要客户端进程能从自己的 PATH 找到 Node。安装依赖与运行适配器需要 Node.js 20 或更高版本。

### 各客户端配置

以下展示软件当前生成的结构。路径仅作示例，日常使用应复制设置页生成的配置，并保留客户端其他已有服务。

**Codex**：合并到自己的 `config.toml`，使用 TOML 的 `mcp_servers`。

```toml
[mcp_servers.qy_novel]
command = "C:\\Program Files\\nodejs\\node.exe"
args = ["E:\\Github\\Novel-Generator\\scripts\\qy-mcp.mjs", "--settings", "C:\\Users\\你的用户名\\AppData\\Roaming\\novel-generator\\mcp-settings.json"]
```

**Claude Code**：合并到项目 `.mcp.json` 的 `mcpServers`。

```json
{
  "mcpServers": {
    "qy_novel": {
      "type": "stdio",
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "E:\\Github\\Novel-Generator\\scripts\\qy-mcp.mjs",
        "--settings",
        "C:\\Users\\你的用户名\\AppData\\Roaming\\novel-generator\\mcp-settings.json"
      ]
    }
  }
}
```

**DSH（DeepSeek Harness）**：作为 Cordis overlay 导入，使用官方 `@deepseek-ai/dsh-mcp-client` 的 `stdio` 传输。它不是 `mcpServers` JSON。

```yaml
- insert:
    - id: qy-novel-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: qy_novel
        transport: stdio
        command: "C:\\Program Files\\nodejs\\node.exe"
        args:
          - "E:\\Github\\Novel-Generator\\scripts\\qy-mcp.mjs"
          - "--settings"
          - "C:\\Users\\你的用户名\\AppData\\Roaming\\novel-generator\\mcp-settings.json"
```

**Zcode**：合并到 `~/.zcode/cli/config.json` 的 `mcp.servers`。

```json
{
  "mcp": {
    "servers": {
      "qy_novel": {
        "command": "C:\\Program Files\\nodejs\\node.exe",
        "args": [
          "E:\\Github\\Novel-Generator\\scripts\\qy-mcp.mjs",
          "--settings",
          "C:\\Users\\你的用户名\\AppData\\Roaming\\novel-generator\\mcp-settings.json"
        ]
      }
    }
  }
}
```

**HTTP 通用配置**：软件复制出的文本不会内嵌真实令牌。需要单独点击“复制认证令牌”，把 `<QY_MCP_TOKEN>` 替换为取得的值。此 JSON 是一种客户端配置形状，不代表所有 HTTP 客户端都使用相同的配置文件。

```json
{
  "mcpServers": {
    "qy_novel": {
      "type": "http",
      "url": "http://127.0.0.1:43127/mcp",
      "headers": {
        "Authorization": "Bearer <QY_MCP_TOKEN>"
      }
    }
  }
}
```

软件不会为外部客户端安装、登录、授权或自动修改配置文件。保存配置后，按对应客户端的方式重新加载 MCP 服务。客户端自身的工具授权仍由该客户端管理。

客户端参考：

- [Codex MCP](https://developers.openai.com/codex/learn/mcp)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [DSH MCP 客户端](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.zh.md)
- [Zcode MCP 服务](https://zcode.z.ai/cn/docs/mcp-services)

## 2. 工具与资源

共提供 13 个工具。工具查询返回 JSON 内容；队列工具返回任务快照，不会等待模型完成。

| 工具 | 参数要点 | 能力 |
| --- | --- | --- |
| `qy_status` | 无 | 获取就绪状态、作品集 / 作品 / 章节 ID、保存路径与任务服务状态 |
| `qy_read_resources` | 可选 `projectId`、`collection` | 读取指定作品的创作资料 |
| `qy_get_schema` | 可选 `collection` | 读取 Agent 操作协议、标准卡字段、创建强化提示词及自定义模块结构 |
| `qy_search_context` | `query`；可选 `projectId` | 关键词与常驻资料智能检索；目标作品须在桌面端打开 |
| `qy_list_providers` | 无 | 读取可选 API 预设 ID、名称、模型和启用状态等安全摘要 |
| `qy_run_agent` | 写入目标、`prompt` | 调用软件内 Agent，将创作要求加入队列 |
| `qy_submit_plan` | 写入目标、`responseJSON` | 提交外部生成的 AgentResponse JSON 计划 |
| `qy_list_jobs` | 无 | 列出持久化任务、状态、步骤与结果 |
| `qy_get_job` | `jobId` | 查询单个任务的进度、结果或待确认计划 |
| `qy_pause_job` | `jobId` | 暂停指定任务 |
| `qy_resume_job` | `jobId` | 继续暂停或失败任务，恢复已有计划或保存断点 |
| `qy_cancel_job` | `jobId` | 终止任务；不自动撤销已经应用的修改 |
| `qy_save_portfolio` | `portfolioId`、`projectId`；可选 `requestId` | 通过统一保存队列写入整份 `.qy` 作品集 |

`qy_read_resources.collection` 可为 `volumes`、`chapters`、`world`、`characters`、`items`、`skills`、`outline`、`style`、`resourceGroups`、`contextBlocks`、`contextGroups`、`worldEngine`、`customModules`、`memes`。省略分类时读取作品资料视图，软件配置和角色图片仍被过滤。

`qy_get_schema.collection` 可以传 `agent`、标准资料类型，或自定义模块的结构 ID / 类型名。省略时返回通用协议、标准资料字段、创建提示词和自定义结构列表。修改计划必须遵守这里返回的实际协议，不能把自定义字段写进普通世界书卡的结构。

写入目标参数：

- `portfolioId`、`projectId` 必填，从 `qy_status` 的真实返回值获取。
- `qy_run_agent`、`qy_submit_plan` 可另传 `chapterId`、`conversationId`、`providerId`、`mode`、`requestId`。
- `mode` 为 `writing` 或 `inspiration`，省略默认 `writing`。
- `providerId` 从 `qy_list_providers` 取得；省略使用软件内默认配置。
- `requestId` 用于幂等重试：目标、对话和内容相同会返回原任务；相同 ID 用于其他内容或目标会报冲突。

MCP 写入没有 `useCurrent` 参数。提交前读一次状态，再显式提供 ID。执行、审批和恢复都校验目标；任务不会随着桌面切换自动改投另一作品。写入目标必须已经打开并有 `.qy` 保存路径。

还提供 3 个只读 MCP 资源：

| URI | 内容 |
| --- | --- |
| `qy://status` | 当前作品集、作品和桌面任务状态 |
| `qy://schemas` | Agent 协议、资料字段与创建提示词 |
| `qy://providers` | API 预设安全摘要 |

API Key、MCP 令牌、认证字段、软件模型列表与角色图片不会作为作品资料输出；providers 查询也只提供安全投影。

## 3. 两种创作流程

### 调用软件内 Agent

先调用 `qy_status`，确认 `ready`、`savedFile` 及目标 ID，再按需调用 `qy_search_context`、`qy_get_schema` 和 `qy_list_providers`。随后调用 `qy_run_agent`，例如：

```json
{
  "portfolioId": "从 qy_status 获取的作品集 ID",
  "projectId": "从 qy_status 获取的作品 ID",
  "prompt": "创建三位配角，按角色卡结构补全性格、动机和动态状态。",
  "mode": "writing",
  "requestId": "create-three-supporting-characters-001"
}
```

工具立即返回任务 `id`。使用 `qy_get_job` 查询进度，或进入桌面 **AI 功能 → 创作控制台** 查看步骤和修改计划。写作模式读取启用的文风规则，灵感模式可放宽文风约束。

### 外部客户端自行规划

外部客户端可以自己使用模型规划，不必再调用软件内 Agent：

1. 读取 `qy_status` 固定目标。
2. 用 `qy_read_resources` / `qy_search_context` 取得需要的资料，读取 `qy_get_schema`。
3. 按软件 Agent 协议生成返回对象。
4. 把完整返回对象序列化为 JSON **字符串**，作为 `responseJSON` 调用 `qy_submit_plan`。
5. 查询任务并等待作者在桌面控制台确认。

例如，外部客户端提交创建世界书的参数可以这样构造：

```javascript
const plan = {
  message: '补充雾港的基础设定。',
  operations: [{
    action: 'create_resource',
    resourceType: 'world',
    title: '雾港',
    summary: '以灯塔辨认航道的港口。',
    includeAllFields: true,
    fields: {
      '触发策略': '关键词',
      '触发键': '雾港，灯塔',
      '内容': '雾港常有浓雾，船只依照岸边灯塔的信号辨认航道。',
      '适用范围': '雾港相关场景',
      '状态': '生效',
    },
  }],
}
const argumentsForSubmitPlan = {
  portfolioId: status.portfolioId,
  projectId: status.projectId,
  responseJSON: JSON.stringify(plan),
  requestId: 'external-world-plan-001',
}
```

这里展示的是 MCP 参数构造，`status` 来自 `qy_status`。`responseJSON` 不是 `.qy` 文件，也不是直接传入的对象。更新现有条目使用 `update_resource`，只提交需要修改的字段，并遵守实际 schema 与锁状态。

普通 JSON 计划的解析、预览和应用不需要再次调用模型；联网搜索等操作仍可能使用软件配置的 API。MCP 不允许写入 API 设置或绕过本地操作协议。

## 4. 审批、任务与保存

任务先进入 `queued`，执行时为 `running`。生成有效修改计划后进入 `awaiting_approval`；计划显示在桌面控制台，后续生成暂停，等待作者处理。

MCP 没有 `qy_approve_job`，外部客户端不能通过 MCP 直接批准自己的计划。作者在桌面控制台点击批准后，业务层重新检查作品目标、条目与字段锁、操作结构和内容指纹。CLI 保留自己的 `jobs approve` 命令，见[控制台与 CLI](cli-console.md)；这不等于 MCP 暴露了批准工具。

应用修改后先持久化 `applied` 和内容指纹检查点，再调用统一作品集保存队列。保存失败保留检查点；继续任务只校验并补保存，不重复创建或修改。指纹不符时停止恢复。

提交成功不代表修改已经应用，`awaiting_approval` 也不代表 `.qy` 已保存。查询任务结果或在桌面控制台查看“等待确认 / 正在保存 / 已完成 / 失败”状态。终止任务不会撤销已应用修改；撤销使用桌面修改记录。

任务及步骤事件保存在 `console-jobs.json`，与 `.qy` 和 profile 分开，最多 200 个任务、每任务最近 200 个事件。MCP 和 CLI 操作同一队列。退出暂停任务并关闭 MCP 监听；重启不会自动重跑任务，需要显式继续。保存断点和原计划的完整规则见[任务持久化与恢复](cli-console.md#任务持久化与恢复)。

## 5. 设置持久化与鉴权

MCP 的启用状态、端口及令牌单独保存到 Electron `userData/mcp-settings.json`。普通 Windows 配置位于：

```text
%APPDATA%\novel-generator\mcp-settings.json
```

自定义用户数据目录以桌面生成的 `--settings` 路径为准。适配器还支持 `QY_MCP_SETTINGS` 环境变量；显式 `--settings` 优先。此文件不进入 `.qy`，也不进入本机 profile 的作品或软件设置序列化；新建、打开、切换作品不改变 MCP 配置。

首次初始化生成令牌，但默认不启用监听。令牌跨重启保持稳定；只有“重置认证令牌”才主动轮换。已保存启用状态在下次启动时重新应用。关闭开关并保存后关闭监听，但保留令牌与端口。

普通连接配置不包含真实令牌；仅“复制认证令牌”这一单独动作把令牌放到剪贴板。重新生成令牌后，直接 HTTP 客户端需要更新请求头；stdio 适配器会读取新的设置。关闭后再开启服务不需要重新生成令牌。

服务只绑定 `127.0.0.1`。所有请求（包括初始化、GET 和工具调用）都验证 Bearer；Host 限制为本机地址及实际端口，拒绝带 Origin 的浏览器调用，不开放 CORS。JSON 请求上限为 2 MiB，日志和错误不会回显认证令牌。

MCP 设置文件和剪贴板中的令牌属于本机控制凭据，不应放进 Git 或作品集分享。浏览器直接打开 `/mcp` 不会显示编辑界面，也不会建立一个经过认证的客户端连接。

## 6. 常见问题

| 情况 | 处理 |
| --- | --- |
| 显示“已关闭” | 勾选启用并“保存并应用”；只修改草稿不会启动服务 |
| 服务运行中，标题栏仍是红灯 | 尚无认证成功的客户端活动；连接外部客户端并发起有效请求 |
| HTTP 操作后空闲一段时间又变红 | 90 秒租约到期；发起新请求会续期，stdio 适配器自动发送心跳 |
| 端口占用 / 连接异常 | 修改为可用端口后应用，或重试；启动失败保留原配置 |
| HTTP 返回 401 | 单独复制令牌，替换 `<QY_MCP_TOKEN>`，确认请求头是 `Bearer …` |
| HTTP 返回 403 | 检查是否来自浏览器 Origin、错误 Host 或非实际本机端口 |
| stdio 无法读取配置 | 使用设置生成的绝对 `--settings` 路径，保持桌面端运行并启用 MCP |
| stdio 找不到 Node / 脚本 | 检查 `command` 与 `args`，移动仓库后重新复制配置 |
| 已提交却未新增条目 | 查询 `qy_get_job`；若为 `awaiting_approval`，在桌面控制台确认 |
| 写入目标不符 | 打开原作品，重新读状态；任务不会追随切换到的新作品 |
| 请求过大 | 按任务拆分资料或计划；不要把整份作品集当作工具参数 |
| 超时后不确定是否提交成功 | 用同一 `requestId` 重试或查询任务列表，避免重复创建 |
| 软件重启后任务没继续 | 属于显式恢复设计；查看原计划并按需继续任务 |

## 7. 实现与验证范围

当前使用官方 MCP TypeScript SDK v2；HTTP 入口兼容当前协议和 2025 版 stateless 请求，stdio 入口使用官方 `serveStdio`。配置格式由 `electron/mcp-connection-config.mjs` 生成。

核心文件：

- `electron/mcp-server.mjs`：本机 HTTP 入口、工具与资源、安全投影。
- `electron/mcp-settings.mjs`：独立配置持久化、启停、端口和令牌管理。
- `electron/mcp-connections.mjs`：认证活动租约、客户端断开与到期推送。
- `electron/mcp-ipc.mjs`：仅允许当前桌面主 frame 管理连接配置。
- `electron/mcp-connection-config.mjs`：各客户端连接模板及独立令牌导出。
- `scripts/qy-mcp.mjs`：stdio 到桌面 HTTP 服务的协议适配。
- `src/components/McpSettings.vue`、`src/mcp/`：竖栏设置页、连接状态与主题样式。
- `src/components/McpConnectionIndicator.vue`：标题栏状态灯、主题变量与 IPC 更新竞态保护。

专项自动验证覆盖真实本机 HTTP、官方 SDK 客户端、真实 stdio 子进程、工具及资源发现、显式目标与幂等冲突、令牌轮换和端口变化、停用服务、鉴权与 Host / Origin、2 MiB 限制、凭据过滤、端口释放和持久化任务审批边界。队列执行使用假执行器，未调用真实模型 API 或用户作品。

构建和完整自动回归通过，最新数字见[路线验收记录](product-roadmap.md#11-验证矩阵)，最新日志为本机 `.tmp/qy-recovery-full-tests.log`。连接状态专项另覆盖多个客户端、心跳、EOF 撤销、空闲到期、失效请求、服务停用和实际编译的 Vue 状态组件。

桌面集成另使用独立用户数据目录和合成作品集，实际完成：

- 在“设置 → MCP 连接”表单中启用服务；
- 通过本机 HTTP 与真实 stdio 适配读取状态和资料，发现全部 13 个工具；
- 外部提交计划后，在桌面控制台显示预览并由作者确认；
- 确认后的修改保存到 `.qy`，任务的已应用检查点也完成持久化；
- 尝试覆盖锁定字段被业务层拒绝，原内容保持不变。

本机 `.tmp/mcp-desktop-result.json` 记录 `success: true`，并确认设置、HTTP、stdio、桌面审批、文件保存、检查点和锁拦截均成功。该集成没有使用用户作品或调用真实模型 API；`.tmp` 是本机验收产物，不属于发行文件。

本轮 `.tmp/qy-recovery-desktop-result.json` 另记录 `success: true`，确认标题栏在仅启用时红灯、有效请求后绿灯、断开和停用后红灯；计算后的字体和状态灯颜色匹配自定义夜间调色板。该隔离桌面验收同时覆盖作品集备份恢复与文件冲突，原生文件选择和目录打开使用 fixture 路径替代。

协议和桌面集成验收仍不是逐个外部产品的安装登录验收。当前未完成 Codex、Claude Code、DSH、Zcode 实客户端逐一安装、登录和交互验证；连接模板与协议兼容性不能表述为这些客户端的完整验收。
