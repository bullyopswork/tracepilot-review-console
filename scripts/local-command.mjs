import { spawn } from "node:child_process";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("Usage: node scripts/local-command.mjs <command> [args...]");
  process.exit(2);
}

const child = spawn(command, args, {
  env: { ...process.env, TRACEPILOT_LOCAL_DB: "true" },
  stdio: "inherit",
  shell: process.platform === "win32"
});

child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
