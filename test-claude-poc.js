/**
 * POC: Test Claude Code CLI with stream-json protocol.
 * Run: node test-claude-poc.js
 *
 * Tests multiple approaches to find what actually works on Windows.
 */

const { spawn, execSync } = require('child_process');

// Find claude binary
function findClaude() {
  try {
    const cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
    const result = execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim();
    return result.split(/\r?\n/)[0]?.trim();
  } catch {
    return null;
  }
}

const binary = findClaude();
if (!binary) {
  console.error('Claude CLI not found in PATH');
  process.exit(1);
}
console.log(`Found claude at: ${binary}`);

// Get version
try {
  const ver = execSync(`"${binary}" --version`, { encoding: 'utf-8', timeout: 5000 }).trim();
  console.log(`Version: ${ver}`);
} catch (e) {
  console.log(`Version check failed: ${e.message}`);
}

// ============================================================
// Test 1: Bidirectional stream-json (current approach)
// ============================================================
async function testStreamJson() {
  console.log('\n=== Test 1: Bidirectional stream-json ===');

  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_SSE_PORT;

  const args = [
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
  ];

  console.log(`Spawning: ${binary} ${args.join(' ')}`);
  console.log(`shell: ${process.platform === 'win32'}`);

  const child = spawn(binary, args, {
    cwd: process.cwd(),
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });

  const userMessage = {
    type: 'user',
    session_id: '',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'Say hello world. Just reply with "Hello World!" and nothing else.' }],
    },
  };

  const jsonStr = JSON.stringify(userMessage);
  console.log(`Sending via stdin: ${jsonStr}`);
  child.stdin.write(jsonStr + '\n');

  let stdoutBuf = '';
  let stderrBuf = '';
  let eventCount = 0;

  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      eventCount++;
      try {
        const event = JSON.parse(trimmed);
        console.log(`[EVENT ${eventCount}] type=${event.type}`, JSON.stringify(event).substring(0, 200));

        // Close stdin when we get result
        if (event.type === 'result') {
          console.log('\n--- RESULT received, closing stdin ---');
          console.log(`Result text: ${typeof event.result === 'string' ? event.result : JSON.stringify(event.result)}`);
          if (child.stdin && !child.stdin.destroyed) {
            child.stdin.end();
          }
        }
      } catch {
        console.log(`[RAW ${eventCount}] ${trimmed.substring(0, 200)}`);
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
  });

  return new Promise((resolve) => {
    child.on('close', (code) => {
      // Flush remaining
      if (stdoutBuf.trim()) {
        console.log(`[FINAL] ${stdoutBuf.trim().substring(0, 200)}`);
      }
      if (stderrBuf.trim()) {
        console.log(`[STDERR] ${stderrBuf.trim().substring(0, 500)}`);
      }
      console.log(`Process exited with code ${code}, total events: ${eventCount}`);
      resolve(code);
    });

    child.on('error', (err) => {
      console.error(`Spawn error: ${err.message}`);
      resolve(1);
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      console.log('Timeout! Killing process...');
      child.kill('SIGTERM');
    }, 30000);
  });
}

// ============================================================
// Test 2: Simple --print mode with -p flag (baseline)
// ============================================================
async function testPrintMode() {
  console.log('\n=== Test 2: --print with -p flag ===');

  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_SSE_PORT;

  const args = [
    '--print',
    '-p', 'Say hello world. Just reply with Hello World and nothing else.',
    '--output-format', 'text',
  ];

  console.log(`Spawning: ${binary} ${args.join(' ')}`);

  const child = spawn(binary, args, {
    cwd: process.cwd(),
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });

  let stdoutBuf = '';
  let stderrBuf = '';

  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
  });

  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
  });

  return new Promise((resolve) => {
    child.on('close', (code) => {
      console.log(`[STDOUT] ${stdoutBuf.trim().substring(0, 500)}`);
      if (stderrBuf.trim()) {
        console.log(`[STDERR] ${stderrBuf.trim().substring(0, 500)}`);
      }
      console.log(`Process exited with code ${code}`);
      resolve(code);
    });

    child.on('error', (err) => {
      console.error(`Spawn error: ${err.message}`);
      resolve(1);
    });

    setTimeout(() => {
      console.log('Timeout! Killing process...');
      child.kill('SIGTERM');
    }, 30000);
  });
}

// ============================================================
// Test 3: stream-json without shell:true (may fail on Windows .cmd)
// ============================================================
async function testNoShell() {
  console.log('\n=== Test 3: stream-json WITHOUT shell:true ===');

  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_SSE_PORT;

  const args = [
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
  ];

  console.log(`Spawning (no shell): ${binary} ${args.join(' ')}`);

  try {
    const child = spawn(binary, args, {
      cwd: process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,  // explicitly no shell
    });

    const userMessage = {
      type: 'user',
      session_id: '',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Say hello world. Just reply with Hello World and nothing else.' }],
      },
    };

    child.stdin.write(JSON.stringify(userMessage) + '\n');

    let stdoutBuf = '';
    let stderrBuf = '';
    let eventCount = 0;

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        eventCount++;
        try {
          const event = JSON.parse(trimmed);
          console.log(`[EVENT ${eventCount}] type=${event.type}`, JSON.stringify(event).substring(0, 200));
          if (event.type === 'result') {
            console.log(`Result: ${typeof event.result === 'string' ? event.result : JSON.stringify(event.result)}`);
            if (child.stdin && !child.stdin.destroyed) child.stdin.end();
          }
        } catch {
          console.log(`[RAW ${eventCount}] ${trimmed.substring(0, 200)}`);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
    });

    return new Promise((resolve) => {
      child.on('close', (code) => {
        if (stdoutBuf.trim()) console.log(`[FINAL] ${stdoutBuf.trim().substring(0, 200)}`);
        if (stderrBuf.trim()) console.log(`[STDERR] ${stderrBuf.trim().substring(0, 500)}`);
        console.log(`Process exited with code ${code}, total events: ${eventCount}`);
        resolve(code);
      });

      child.on('error', (err) => {
        console.error(`Spawn error (expected on Windows .cmd): ${err.message}`);
        resolve(1);
      });

      setTimeout(() => {
        console.log('Timeout! Killing process...');
        child.kill('SIGTERM');
      }, 30000);
    });
  } catch (e) {
    console.log(`Failed to spawn (expected on Windows): ${e.message}`);
    return 1;
  }
}

// Run tests
(async () => {
  await testStreamJson();
  await testPrintMode();
  await testNoShell();
  console.log('\n=== All tests complete ===');
})();
