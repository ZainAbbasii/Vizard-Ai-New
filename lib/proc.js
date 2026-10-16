const { spawn } = require('child_process');

// Runs a program without a shell (arguments are never interpreted by a shell).
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : null;

    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      if (stdout.length > 2_000_000) stdout = stdout.slice(-500_000);
      if (opts.onStdout) opts.onStdout(s);
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (stderr.length > 200_000) stderr = stderr.slice(-50_000);
      if (opts.onStderr) opts.onStderr(s);
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

module.exports = { run };
