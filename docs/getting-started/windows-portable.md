# Windows portable CLI and MCP package

The portable build is a relocatable Windows x64 ZIP containing the exact REA npm
runtime package, its production dependencies, the matching Windows x64 native
addon, and an official Node.js runtime. It does not require a system-wide
Node.js installation or a global npm install.

## Build requirements

- Windows x64 runner
- Node.js version pinned by `.nvmrc` and npm
- A matching `native/windows/build/manifest.json` and
  `rea-windows-x64.node` from the CI `windows-native-controls` artifact.
  The native artifact builder itself runs on Linux with MinGW-w64; the portable
  package and its runtime tests run on Windows x64. Download the CI artifact
  and extract its manifest and addon into `native/windows/build/`; do not use
  an artifact built for another REA version.
- Network access to the official Node.js distribution and npm package sources
- Microsoft Visual C++ Redistributable 2015–2022 x64 on target systems where
  the required runtime libraries are not already installed

## Build and verify

Run from the repository root:

```powershell
npm ci
npm run verify:windows-native:artifact
npm run build:windows-portable
npm run verify:windows-portable
```

The portable builder runs the package's full `prepack` checks before creating
the npm archive, verifies the supplied Windows native artifact, and installs
the production package into an isolated bundle directory.

The output is written to
`.artifacts/windows-portable/REA-<version>-windows-x64.zip`, with a SHA-256
sidecar. The builder verifies the official Node.js archive checksum before
extracting the runtime. The verifier checks the ZIP path boundary and digest,
extracts into a temporary directory, runs the embedded runtime and CLI, checks
the MCP doctor inventory, invokes the command launcher, and performs a real
stdio MCP handshake.

## Use

Extract the ZIP anywhere and run from its root:

```powershell
.\rea.cmd --help
.\rea.cmd --version
.\rea.cmd mcp doctor --json
.\rea.cmd setup
.\\rea-mcp.cmd
```

The bundle is relocatable. Extract it to its final location before running
`rea.cmd setup`; agent configuration stores the absolute runtime path. If you
move the bundle later, rerun setup for each affected agent. REA stores agent
configuration in the normal per-user locations; the portable folder itself is
not used as a profile store.
Analysis providers such as Ghidra and IDA remain separate prerequisites.

The portable bundle is not the final standalone EXE or installer. Those are
separate release targets and are intentionally deferred until the CLI/MCP and
portable distributions pass their full qualification suites.

Packaged by **ShirazTipsy**.
