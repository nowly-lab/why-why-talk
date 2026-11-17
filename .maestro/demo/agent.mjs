#!/usr/bin/env node
// Plays Claude in the demo: a tiny local endpoint the flow calls (POST /call?tool=<name>&args=<json>) that calls the
// why-why MCP server (dist/cli.js mcp, over stdio) as Claude would. Uses the same WHY_WHY_HOME as the talk.
//   WHY_WHY_HOME=<dir> node .maestro/demo/agent.mjs     (listens on 127.0.0.1:8797)
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const mcp = new Client({ name: 'claude-code', version: 'demo' });
await mcp.connect(new StdioClientTransport({ command: 'node', args: ['dist/cli.js', 'mcp'], env: { ...process.env } }));
createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (req.method !== 'POST' || u.pathname !== '/call' || req.headers.origin) { res.writeHead(404).end(); return; }
  try {
    const r = await mcp.callTool({ name: u.searchParams.get('tool'), arguments: JSON.parse(u.searchParams.get('args') || '{}') });
    res.writeHead(r.isError ? 500 : 200, { 'content-type': 'application/json' }).end(r.content[0].text);
  } catch (e) {
    res.writeHead(500).end(String(e.message));
  }
}).listen(8797, '127.0.0.1', () => console.log('agent ready on 127.0.0.1:8797'));
