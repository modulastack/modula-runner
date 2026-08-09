# @modulastack/runner-protocol

The versioned wire protocol between the [Modula Runner](https://github.com/modulastack/modula-runner)
and the Modula Stack control plane. The runner is open source and the control plane is not;
this package is public so that the seam between them stays honest — the server consumes the
same published schema the runner does.

- **[`SCHEMA.md`](SCHEMA.md)** — the frame reference: transport rules, versioning policy
  (the control plane supports N and N−1), channel model, reconnect continuity, and the
  end-to-end-encryption capability the frames are designed for.
- **`src/`** — the executable form: TypeScript types, the frame codec with structural
  validation, and version negotiation.

```ts
import { PROTOCOL_VERSION, decodeFrame, encodeFrame, negotiate } from '@modulastack/runner-protocol'
```

The seam this protocol serves — what executes on the user's machine versus what stays
hosted — is defined in the runner repository's
[`docs/runner-seam.md`](https://github.com/modulastack/modula-runner/blob/main/docs/runner-seam.md).

Apache-2.0.
