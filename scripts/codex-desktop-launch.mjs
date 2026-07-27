#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = resolve(root, "dist/index.js");
const srcEntry = resolve(root, "src/index.ts");

const useDist = existsSync(distEntry);
const command = useDist ? process.execPath : "npx";
const args = useDist ? [distEntry] : ["tsx", srcEntry];

const child = spawn(command, args, {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (err) => {
  console.error("[tondemon-ai] failed to launch:", err);
  process.exit(1);
});
