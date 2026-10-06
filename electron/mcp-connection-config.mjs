const CLIENT_KINDS = new Set(['generic', 'stdio', 'codex', 'claude', 'dsh', 'zcode', 'token'])

/**
 * Export connection instructions on demand. Normal configuration snippets do
 * not embed the bearer token: stdio reads the desktop's private settings file.
 */
export function mcpConnectionConfig({ kind, credentials, scriptPath, settingsPath, nodeCommand = 'node' }) {
  if (!CLIENT_KINDS.has(kind)) throw new Error('不支持的 MCP 客户端配置。')
  if (kind === 'token') {
    if (!credentials.token) throw new Error('MCP 令牌尚未初始化，请先在设置中重新生成。')
    return { text: credentials.token }
  }
  const args = [scriptPath, '--settings', settingsPath]
  const stdio = { command: nodeCommand, args }
  if (kind === 'generic') {
    return {
      text: JSON.stringify({
        mcpServers: {
          qy_novel: {
            type: 'http',
            url: credentials.url,
            headers: { Authorization: 'Bearer <QY_MCP_TOKEN>' },
          },
        },
      }, null, 2),
    }
  }
  if (kind === 'codex') {
    // JSON basic strings are valid TOML basic strings, including Windows paths.
    return {
      text: [
        '[mcp_servers.qy_novel]',
        `command = ${JSON.stringify(nodeCommand)}`,
        `args = ${JSON.stringify(args)}`,
      ].join('\n'),
    }
  }
  if (kind === 'dsh') {
    // DeepSeek Harness consumes Cordis overlays, not a mcpServers JSON object.
    return {
      text: [
        '- insert:',
        '    - id: qy-novel-mcp',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        '        serverName: qy_novel',
        '        transport: stdio',
        `        command: ${JSON.stringify(nodeCommand)}`,
        '        args:',
        ...args.map((arg) => `          - ${JSON.stringify(arg)}`),
      ].join('\n'),
    }
  }
  if (kind === 'zcode') {
    return { text: JSON.stringify({ mcp: { servers: { qy_novel: stdio } } }, null, 2) }
  }
  // Claude Code .mcp.json and the general JSON editor both accept this shape.
  return { text: JSON.stringify({ mcpServers: { qy_novel: { type: 'stdio', ...stdio } } }, null, 2) }
}
