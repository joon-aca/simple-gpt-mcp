// Print MCP host configuration for this checkout. Credentials stay placeholders: paste your key into the host config.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = resolve(fileURLToPath(import.meta.url), '../../dist/index.js');
// process.execPath is the real Node binary, unlike version-manager shims that hosts may not find.
// Homebrew's Cellar path changes on every upgrade; its opt/ symlink is the stable equivalent.
const brewOpt = process.execPath.replace(
  /\/Cellar\/([^/]+)\/[^/]+\//,
  '/opt/$1/',
);
const node = existsSync(brewOpt) ? brewOpt : process.execPath;
const model = process.env.OPENAI_MODEL?.trim() || 'your-model-id';
const server = {
  command: node,
  args: [entry],
  env: { OPENAI_API_KEY: 'your-api-key', OPENAI_MODEL: model },
};

console.log('MCP host JSON (Claude Desktop, Cursor, ...):\n');
console.log(
  JSON.stringify({ mcpServers: { 'simple-gpt-mcp': server } }, null, 2),
);
console.log('\nClaude Code:\n');
console.log(
  `  claude mcp add simple-gpt-mcp --env OPENAI_API_KEY=your-api-key --env OPENAI_MODEL=${model} -- ${JSON.stringify(node)} ${JSON.stringify(entry)}`,
);
