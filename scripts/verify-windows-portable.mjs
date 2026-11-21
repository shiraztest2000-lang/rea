#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { verifyCompleteToolCatalog } from "./lib/verify-package-core.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
const archive = resolve(
  process.argv[2] ??
    join(
      root,
      ".artifacts",
      "windows-portable",
      `REA-${packageJson.version}-windows-x64.zip`,
    ),
);
const expectedRoot = `REA-${packageJson.version}-windows-x64`;
const workspaceRoot = join(root, ".cache");
await mkdir(workspaceRoot, { recursive: true });
const workspaceParent = join(workspaceRoot, "portable space test");
await mkdir(workspaceParent, { recursive: true });
const workspace = await mkdtemp(
  join(workspaceParent, "rea-windows-portable-verify-"),
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const message = [
      `${command} failed (${String(result.status)}):`,
      result.stdout,
      result.stderr,
    ].join("\n");
    throw new Error(message);
  }
  return result.stdout;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
let client;
let transport;
try {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("Portable bundle verification must run on Windows x64.");
  const archiveBytes = await readFile(archive);
  const sidecar = (await readFile(`${archive}.sha256`, "utf8")).trim();
  const expectedHash = sidecar.split(/\s+/u)[0];
  assert.match(expectedHash, /^[a-f0-9]{64}$/u);
  assert.equal(
    sha256(archiveBytes),
    expectedHash,
    "ZIP SHA-256 sidecar mismatch",
  );

  const listing = run("tar.exe", ["-tf", archive])
    .split(/\\r?\\n/u)
    .filter(Boolean);
  assert.ok(listing.length > 0, "portable ZIP is empty");
  for (const entry of listing) {
    const normalized = entry.replaceAll("\\", "/");
    assert.ok(
      !normalized.startsWith("/") && !/^[A-Za-z]:/u.test(normalized),
      `absolute ZIP path: ${entry}`,
    );
    assert.ok(
      !normalized.split("/").includes(".."),
      `ZIP path traversal: ${entry}`,
    );
    assert.ok(
      normalized === expectedRoot ||
        normalized.startsWith(`${expectedRoot}/`),
      `unexpected ZIP root: ${entry}`,
    );
  }

  run("tar.exe", ["-xf", archive, "-C", workspace]);
  const bundleRoot = join(workspace, expectedRoot);
  const manifest = JSON.parse(
    await readFile(join(bundleRoot, "portable-manifest.json"), "utf8"),
  );
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.platform, "win-x64");
  assert.equal(manifest.architecture, "x64");
  assert.equal(manifest.author, "ShirazTipsy");
  assert.equal(
    manifest.repository,
    "https://github.com/shiraztest2000-lang/rea",
  );
  assert.match(manifest.nodeArchiveSha256, /^[a-f0-9]{64}$/u);
  assert.match(manifest.nodeExecutableSha256, /^[a-f0-9]{64}$/u);
  assert.match(manifest.npmPackageSha256, /^[a-f0-9]{64}$/u);

  const node = join(bundleRoot, "runtime", "node.exe");
  const app = join(bundleRoot, "app", "node_modules", packageJson.name);
  const entry = join(app, "scripts", "rea.mjs");
  for (const path of [
    node,
    entry,
    join(app, "dist", "mcp", "main.js"),
    join(app, "native", "windows", "build", "manifest.json"),
    join(app, "native", "windows", "build", "rea-windows-x64.node"),
    join(bundleRoot, "rea.cmd"),
    join(bundleRoot, "rea-mcp.cmd"),
    join(bundleRoot, "README_FA.txt"),
    join(bundleRoot, "README_EN.txt"),
  ])
    await access(path);
  assert.ok(
    (await stat(node)).size > 1_000_000,
    "bundled node.exe is unexpectedly small",
  );
  assert.equal(
    sha256(await readFile(node)),
    manifest.nodeExecutableSha256,
    "bundled node.exe digest mismatch",
  );

  const nodeVersion = run(node, ["--version"]).trim();
  assert.equal(nodeVersion, `v${manifest.nodeVersion}`);
  const version = run(node, [entry, "--version"]).trim();
  assert.equal(version, packageJson.version);
  const help = run(node, [entry, "--help"]);
  assert.match(help, /inspect/u);
  assert.match(help, /providers/u);

  const launcher = join(bundleRoot, "rea.cmd");
  const launcherOutput = run(process.env.ComSpec ?? "cmd.exe", [
    "/d",
    "/c",
    `"${launcher}" --version`,
  ], { cwd: workspace }).trim();
  assert.equal(
    launcherOutput,
    packageJson.version,
    "portable CMD launcher failed",
  );

  const doctor = JSON.parse(run(node, [entry, "mcp", "doctor", "--json"]));
  assert.equal(doctor.healthy, true, "portable MCP doctor is unhealthy");
  assert.equal(
    doctor.inventory?.tools?.observed,
    doctor.inventory?.tools?.expected,
    "portable MCP tool inventory is incomplete",
  );

  transport = new StdioClientTransport({
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/c", `"${join(bundleRoot, "rea-mcp.cmd")}"`],
    cwd: workspace,
    env: { ...process.env },
    stderr: "pipe",
  });
  client = new Client({ name: "rea-portable-verifier", version: "1.0.0" });
  await client.connect(transport);
  const toolCatalog = await verifyCompleteToolCatalog(client);
  const prompts = await client.listPrompts();
  assert.ok(
    Array.isArray(prompts.prompts),
    "portable MCP prompt catalog is invalid",
  );

  await client.close();
  client = undefined;
  await transport.close();
  transport = undefined;

  process.stdout.write(`${JSON.stringify({
    ok: true,
    archive,
    archiveSha256: expectedHash,
    version: packageJson.version,
    nodeVersion,
    cli: true,
    cmdLauncher: true,
    mcpDoctor: true,
    mcpTools: toolCatalog.length,
    mcpPrompts: prompts.prompts.length,
    author: manifest.author,
  }, null, 2)}\n`);
} finally {
  try { await client?.close(); } finally {
    try { await transport?.close(); } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}
