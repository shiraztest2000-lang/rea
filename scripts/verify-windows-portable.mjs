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
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parse as parseJsonc } from "jsonc-parser";
import { supportedClients } from "../dist/application/SupportedClients.js";
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
    .split(/\r?\n/u)
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
  assert.equal(manifest.npmPackage, packageJson.name);
  assert.match(manifest.nodeVersion, /^\d+\.\d+\.\d+$/u);
  assert.equal(
    manifest.nodeArchive,
    `node-v${manifest.nodeVersion}-win-x64.zip`,
  );
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
  const runLauncher = (args, options = {}) =>
    run(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/c", [`"${launcher}"`, ...args].join(" ")],
      { cwd: workspace, ...options },
    );
  const launcherOutput = runLauncher(["--version"]).trim();
  assert.equal(
    launcherOutput,
    packageJson.version,
    "portable CMD launcher failed",
  );

  const home = join(workspace, "portable agent home");
  const setupEnvironment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    CLAUDE_CONFIG_DIR: home,
    CODEX_HOME: join(home, ".codex"),
    XDG_CONFIG_HOME: join(home, ".config"),
    OPENCODE_CONFIG: join(home, ".config", "opencode", "opencode.jsonc"),
    COPILOT_HOME: join(home, ".copilot"),
    GROK_HOME: join(home, ".grok"),
    SAND_DATA_ROOT: join(home, ".grokbot"),
    OMP_PROFILE: undefined,
    PI_CODING_AGENT_DIR: undefined,
    PI_CONFIG_DIR: undefined,
    PI_PROFILE: undefined,
  };
  await mkdir(join(home, ".config", "opencode"), { recursive: true });
  await writeFile(
    setupEnvironment.OPENCODE_CONFIG,
    '{\n  // preserve user settings\n  "theme": "dark",\n}\n',
  );
  const setupArgs = [
    "setup",
    "--yes",
    "--client",
    "opencode",
    "--client",
    "vscode",
    "--client",
    "copilot_cli",
    "--skill=false",
    "--json",
  ];
  const setup = JSON.parse(
    runLauncher(setupArgs, { env: setupEnvironment }),
  );
  assert.equal(setup.status, "ready");
  assert.equal(setup.appliedActions.length, 3);
  const expectedCommand = [node, entry, "mcp"];
  const clients = supportedClients(home, process.platform, setupEnvironment);
  for (const id of ["opencode", "vscode", "copilot_cli"]) {
    const clientLocation = clients.find(({ name }) => name === id);
    assert.ok(clientLocation, `Missing portable setup client ${id}`);
    const text = await readFile(clientLocation.configPath, "utf8");
    const config = parseJsonc(text);
    const registration =
      id === "opencode"
        ? config.mcp?.rea
        : id === "vscode"
          ? config.servers?.rea
          : config.mcpServers?.rea;
    const actualCommand =
      id === "opencode"
        ? registration?.command
        : [registration?.command, ...(registration?.args ?? [])];
    assert.deepEqual(
      actualCommand,
      expectedCommand,
      `Portable ${id} registration does not use the bundled runtime`,
    );
    if (id === "opencode")
      assert.ok(text.includes("// preserve user settings"));
  }
  const repeated = JSON.parse(
    runLauncher(setupArgs, { env: setupEnvironment }),
  );
  assert.equal(repeated.status, "ready");
  assert.equal(repeated.plannedActions.length, 0);
  assert.equal(repeated.appliedActions.length, 0);
  const uninstalled = JSON.parse(
    runLauncher(["uninstall", "--json"], { env: setupEnvironment }),
  );
  for (const id of ["opencode", "vscode", "copilot_cli"])
    assert.equal(
      uninstalled.items?.find(({ name }) => name === id)?.status,
      "removed",
      `Portable uninstall did not remove ${id}`,
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
