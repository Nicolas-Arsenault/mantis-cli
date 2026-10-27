import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mantis.js');

// Preload that reports any forced process.exit() call on stderr.
const EXIT_PROBE = `data:text/javascript,${encodeURIComponent(
  "const exit = process.exit; process.exit = (code) => { process.stderr.write('FORCED_EXIT\\n'); exit(code); };",
)}`;

// Server that rejects every MCP request the way /mcp_integrated/ does for a bad key.
async function rejectingServer() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or expired MCP bearer token' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function runCli(args, home) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', EXIT_PROBE, CLI, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

// On Windows, process.exit() while the MCP SDK is still closing the failed
// transport trips a libuv assertion (KellisLab/mantis-cli#5), so MCP-backed
// commands must set process.exitCode and let Node exit on its own.
for (const args of [['tools'], ['use', 'get_space_context']]) {
  test(`mantis ${args.join(' ')} exits 1 without process.exit() when MCP auth fails`, async (t) => {
    const server = await rejectingServer();
    t.after(() => server.close());
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mantis-cli-test-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    fs.mkdirSync(path.join(home, '.mantis'));
    fs.writeFileSync(path.join(home, '.mantis', 'config.json'), JSON.stringify({
      apiKey: 'synthetic-test-credential',
      apiBaseUrl: `http://127.0.0.1:${server.address().port}`,
      spaceId: 'space',
      spaceStateId: 'thread',
    }));

    const { code, stderr } = await runCli(args, home);
    assert.equal(code, 1);
    assert.match(stderr, /Invalid or expired MCP bearer token/);
    assert.doesNotMatch(stderr, /FORCED_EXIT/);
  });
}
