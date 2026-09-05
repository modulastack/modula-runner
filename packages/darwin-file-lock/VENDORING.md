# Vendored Darwin Native Binary

This private workspace vendors the reviewed Modula runner-home descriptor backend for macOS arm64.
Installation and runtime never download, compile, or search for another binary.

| File | Platform | SHA-256 |
| --- | --- | --- |
| `binaries/fs-ext-darwin-arm64-node-22.0.0.node` | Darwin arm64, Node 22 | `3f020304746900a51d130162bfc46fa5277cb1fc27d6137a7dcfc2aec8f83b0b` |

The source is `packages/runner/native/darwin_runner_home.c`. The release build verifies a fresh
source build against this committed addon before packing.
