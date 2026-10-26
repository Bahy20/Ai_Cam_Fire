// Use the project's Wrangler and keep its diagnostic logs in this workspace.
import {spawnSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wrangler = path.join(project, 'worker', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const logs = path.join(project, '.hermes', 'wrangler-logs');

mkdirSync(logs, {recursive:true});
const result = spawnSync(process.execPath, [wrangler, ...process.argv.slice(2)], {
  cwd:process.cwd(),
  env:{...process.env, WRANGLER_LOG_PATH:logs},
  stdio:'inherit',
  windowsHide:true,
});
if (result.error) {
  console.error(`Unable to start project Wrangler: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
