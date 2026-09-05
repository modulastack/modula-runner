# Vendored native file-lock binaries

This private workspace vendors two reviewed native members from the npm artifact below. Installation and runtime never download, compile, or search for another binary.

## Upstream artifact

- Package: `fs-ext-extra-prebuilt@2.2.13`
- npm integrity: `sha512-mVSm+UDKvftEMHljOThNW3NtI8/gX7f1z9U1WGRbBf6JXQTFbS8Wv+qPVpZhYH6zCj1rXV/XnhQMek3tEn41Pg==`
- Repository: <https://github.com/adamziel/fs-ext-prebuilt>
- Published git commit: `792ba4cf6f887011afd03757716ca099824a23d0`
- License: MIT; the upstream license text is preserved in `UPSTREAM-LICENSE.txt`.

## Extracted members

| Upstream member | Vendored member | Runtime | SHA-256 |
|---|---|---|---|
| `binaries/fs-ext-linux-x64-node-22.0.0.node` | same | Linux x64, Node 22 | `a58e01d64248b487d9c7dafba751d69b7924d16f0e31cedcce9d3226fdfdb514` |
| `binaries/fs-ext-linux-arm64-node-22.0.0.node` | same | Linux arm64, Node 22 | `80c10393d3698397e35d30f0edca8d05f938c9f5f8be1a747d0bd56cedce6d06` |

The release toolchain is pinned more narrowly to Node `22.22.3`. The loader verifies the selected member's hash before loading it. Other upstream platforms, architectures, Node versions, and Electron builds are intentionally excluded. Darwin arm64 uses the separate `@modulastack/darwin-file-lock` workspace.
