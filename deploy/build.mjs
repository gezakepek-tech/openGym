/* Installs the API's production dependencies for single-process (PaaS) deploys.

   Why a script instead of "cd api && npm ci" in package.json: a parent npm exports its own
   configuration as npm_config_* environment variables, and a user- or host-level setting such as
   allow-scripts then makes the nested install fail with EALLOWSCRIPTS. Running the install with
   those variables removed keeps the result identical on every machine and npm version. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = path.join(root, 'api');

const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.toLowerCase().startsWith('npm_config_')) delete env[key];
}

const npmArgs = ['ci', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund'];
// npm_execpath is the path of the npm CLI that started this script — reusing it avoids any
// PATH and shell-resolution problems, and needs no shell on Windows.
const npmCli = process.env.npm_execpath;
const cmd = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
const args = npmCli ? [npmCli, ...npmArgs] : npmArgs;

console.log(`[build] api dependencies: ${cmd} ${args.join(' ')} (in ${apiDir})`);
const child = spawn(cmd, args, {
  cwd: apiDir,
  stdio: 'inherit',
  env,
  shell: !npmCli && process.platform === 'win32',
});
child.on('error', (e) => {
  console.error('[build] could not start npm:', e.message);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[build] npm ci was killed by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
