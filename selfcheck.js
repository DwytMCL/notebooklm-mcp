// Starts the server, lists tools, opens NotebookLM and prints the start of the snapshot.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert';
const c = new Client({ name: 'selfcheck', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: [new URL('./server.js', import.meta.url).pathname], env: process.env }));
const { tools } = await c.listTools();
assert(tools.some(t => t.name === 'nlm_snapshot'));
console.log(tools.map(t => t.name).join(', '));
const r = await c.callTool({ name: 'nlm_open', arguments: {} });
console.log(r.content[0].text.slice(0, 600));
await c.close();
