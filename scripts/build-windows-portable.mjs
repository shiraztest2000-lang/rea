#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
const nodeVersion = (await readFile(join(root, ".nvmrc"), "utf8"))
  .trim()
  .replace(/^v/u, "");
const platform = "win-x64";
const folderName = `REA-${packageJson.version}-windows-x64`;
const outputDirectory = join(root, ".artifacts", "windows-portable");
const outputArchive = join(outputDirectory, `${folderName}.zip`);
const npmCli = process.env.npm_execpath;
const temporaryRoot = join(root, ".cache");
await mkdir(temporaryRoot, { recursive: true });
await mkdir(outputDirectory, { recursive: true });
const workspace = await mkdtemp(join(temporaryRoot, "rea-windows-portable-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function downloadVerifiedNodeArchive() {
  const filename = `node-v${nodeVersion}-win-x64.zip`;
  const base = `https://nodejs.org/dist/v${nodeVersion}/`;
  const [checksumResponse, archiveResponse] = await Promise.all([
    fetch(`${base}SHASUMS256.txt`, { signal: AbortSignal.timeout(60_000) }),
    fetch(`${base}${filename}`, { signal: AbortSignal.timeout(180_000) }),
  ]);
  if (!checksumResponse.ok || !archiveResponse.ok) {
    const details = [
      `checksums=${checksumResponse.status},`,
      `archive=${archiveResponse.status}`,
    ].join(" ");
    throw new Error(`Official Node.js download failed: ${details}`);
  }
  const checksums = await checksumResponse.text();
  const expected = checksums
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
    .find(([, name]) => name === filename)?.[0];
  if (!expected || !/^[a-f0-9]{64}$/u.test(expected))
    throw new Error(`Official Node.js checksum list omitted ${filename}`);
  const bytes = Buffer.from(await archiveResponse.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== expected)
    throw new Error(
      `Node.js archive SHA-256 mismatch: expected ${expected}, ` +
        `got ${actual}`,
    );
  const archive = join(workspace, filename);
  await writeFile(archive, bytes);
  return { archive, filename, sha256: actual };
}

try {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error(
      "The portable Windows bundle must be built on a Windows x64 " +
        "runner.",
    );
  if (!/^\d+\.\d+\.\d+$/u.test(nodeVersion))
    throw new Error(`Invalid pinned Node.js version in .nvmrc: ${nodeVersion}`);
  if (!npmCli) {
    throw new Error(
      "npm_execpath is required; run this builder from an npm-enabled " +
        "Windows environment.",
    );
  }

  const packedDirectory = join(workspace, "packed");
  const bundleParent = join(workspace, "bundle");
  const bundleRoot = join(bundleParent, folderName);
  const appDirectory = join(bundleRoot, "app");
  const runtimeDirectory = join(bundleRoot, "runtime");
  await Promise.all([
    mkdir(packedDirectory, { recursive: true }),
    mkdir(appDirectory, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
  ]);

  run(process.execPath, [npmCli, "run", "prepack"]);
  run(process.execPath, [npmCli, "run", "verify:windows-native:artifact"]);
  const packed = JSON.parse(
    run(process.execPath, [
      npmCli,
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      packedDirectory,
    ]),
  );
  const packageFile = packed[0]?.filename;
  if (typeof packageFile !== "string")
    throw new Error("npm pack did not produce a package archive.");
  const packageArchive = join(packedDirectory, packageFile);
  await access(packageArchive);
  const packageSha256 = sha256(await readFile(packageArchive));

  run(process.execPath, [
    npmCli,
    "install",
    "--prefix",
    appDirectory,
    "--no-save",
    "--no-package-lock",
    "--no-audit",
    "--no-fund",
    "--omit=dev",
    packageArchive,
  ]);
  const installedPackage = join(appDirectory, "node_modules", packageJson.name);
  await access(join(installedPackage, "scripts", "rea.mjs"));
  await access(join(installedPackage, "dist", "mcp", "main.js"));
  await access(
    join(
      installedPackage,
      "native",
      "windows",
      "build",
      "rea-windows-x64.node",
    ),
  );
  await access(
    join(installedPackage, "native", "windows", "build", "manifest.json"),
  );

  const node = await downloadVerifiedNodeArchive();
  const extractedRuntime = join(workspace, "node-runtime");
  await mkdir(extractedRuntime);
  run("tar.exe", ["-xf", node.archive, "-C", extractedRuntime]);
  const officialRuntime = join(
    extractedRuntime,
    `node-v${nodeVersion}-win-x64`,
  );
  await copyFile(
    join(officialRuntime, "node.exe"),
    join(runtimeDirectory, "node.exe"),
  );
  for (const name of ["LICENSE", "README.md"]) {
    try {
      await copyFile(join(officialRuntime, name), join(runtimeDirectory, name));
    } catch (cause) {
      if (cause?.code !== "ENOENT") throw cause;
    }
  }

  const nodeExecutableSha256 = sha256(
    await readFile(join(runtimeDirectory, "node.exe")),
  );
  const manifest = {
    schemaVersion: 1,
    product: "REA",
    version: packageJson.version,
    platform,
    architecture: "x64",
    nodeVersion,
    nodeArchive: node.filename,
    nodeArchiveSha256: node.sha256,
    nodeExecutableSha256,
    npmPackage: packageJson.name,
    npmPackageSha256: packageSha256,
    author: "ShirazTipsy",
    repository: "https://github.com/shiraztest2000-lang/rea",
    generatedAt: new Date().toISOString(),
  };
  await writeFile(
    join(bundleRoot, "portable-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const entrypoint = `app\\node_modules\\${packageJson.name}\\scripts\\rea.mjs`;
  const launcher = (command) => {
    const runtimePath = "%REA_PORTABLE_ROOT%runtime\\node.exe";
    const entryPath = `%REA_PORTABLE_ROOT%${entrypoint}`;
    const commandArguments = command.length === 0 ? "%*" : `${command}%*`;
    return [
      "@echo off",
      "setlocal",
      'set "REA_PORTABLE_ROOT=%~dp0"',
      `"${runtimePath}" "${entryPath}" ${commandArguments}`,
      "exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n");
  };
  await writeFile(join(bundleRoot, "rea.cmd"), launcher(""), "utf8");
  await writeFile(join(bundleRoot, "rea-mcp.cmd"), launcher("mcp "), "utf8");
  await writeFile(
    join(bundleRoot, "README_FA.txt"),
    [
      "REA — نسخه پرتابل ویندوز",
      "",
      "اجرا:",
      "  روی rea.cmd دوبار کلیک نکنید؛ ترمینال را در این پوشه باز کنید.",
      "  دستورها:",
      "    .\\rea.cmd --help",
      "    .\\rea.cmd --version",
      "    .\\rea.cmd mcp doctor --json",
      "    .\\rea.cmd setup",
      "    .\\rea-mcp.cmd",
      "",
      "این بسته Node.js موردنیاز را همراه خود دارد و برای اجرای CLI/MCP به " +
        "نصب سراسری Node.js نیاز ندارد.",
      "در ویندوزهایی که کتابخانه‌های لازم را ندارند، Microsoft Visual C++ " +
        "Redistributable 2015–2022 نسخه x64 نیز لازم است.",
      "برای اتصال به ابزارهای تحلیلی مانند Ghidra یا IDA، نصب و پیکربندی " +
        "جداگانه آن ابزارها همچنان لازم است.",
      "پیش از اجرای rea.cmd setup پوشه را در مسیر نهایی قرار دهید؛ پس از " +
        "جابه‌جایی، تنظیمات هر Agent را دوباره اجرا کنید.",
      "برای به‌روزرسانی، ZIP نسخه جدید را دریافت و پوشه را جایگزین کنید؛ " +
        "فرمان rea update مخصوص نصب‌های package manager است.",
      "",
      "سازنده بسته: ShirazTipsy",
      "مخزن: https://github.com/shiraztest2000-lang/rea",
      "مجوز: MIT؛ مجوزهای وابستگی‌ها در بسته برنامه موجود است.",
      "",
    ].join("\r\n"),
    "utf8",
  );
  await writeFile(
    join(bundleRoot, "README_EN.txt"),
    [
      "REA — Portable Windows x64",
      "",
      "Run from Command Prompt or PowerShell in this directory:",
      "  .\\rea.cmd --help",
      "  .\\rea.cmd --version",
      "  .\\rea.cmd mcp doctor --json",
      "  .\\rea.cmd setup",
      "  .\\rea-mcp.cmd",
      "",
      "The required Node.js runtime is bundled. A system-wide Node.js " +
        "installation is not required.",
      "Microsoft Visual C++ Redistributable 2015–2022 x64 may be required " +
        "if its runtime libraries are absent.",
      "Analysis providers such as Ghidra and IDA remain separate " +
        "prerequisites and must be installed/configured when needed.",
      "Extract to the final location before running setup; rerun setup for " +
        "each agent after moving the folder.",
      "To update, download the new portable ZIP and replace this folder; " +
        "rea update targets package-manager installations.",
      "",
      "Packaged by: ShirazTipsy",
      "Source: https://github.com/shiraztest2000-lang/rea",
      "License: MIT; dependency notices ship with the application package.",
      "",
    ].join("\r\n"),
    "utf8",
  );

  await rm(outputArchive, { force: true });
  await rm(`${outputArchive}.sha256`, { force: true });
  run("tar.exe", [
    "-a",
    "-c",
    "-f",
    outputArchive,
    "-C",
    bundleParent,
    folderName,
  ]);
  const archiveBytes = await readFile(outputArchive);
  const archiveSha256 = sha256(archiveBytes);
  await writeFile(
    `${outputArchive}.sha256`,
    `${archiveSha256}  ${folderName}.zip\n`,
    "utf8",
  );
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      archive: outputArchive,
      archiveBytes: archiveBytes.length,
      archiveSha256,
      packageSha256,
      nodeVersion,
      nodeArchiveSha256: node.sha256,
      nodeExecutableSha256,
      folderName,
      author: "ShirazTipsy",
    }, null, 2)}\n`,
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}
