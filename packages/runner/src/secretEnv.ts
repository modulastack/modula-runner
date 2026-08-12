// A set of environment variables whose values are secret, shaped so that ordinary
// serialization cannot reveal them.
//
// The rule this exists to enforce is FR-11's: an API key is injected env-only and never
// through a process argument. That rule is easy to state and easy to violate by accident —
// a launch plan logged for diagnostics, an error message interpolating the spec that
// failed, a structured log line taking the whole object. Each of those is a credential in a
// file somebody keeps.
//
// So the property is made true by construction rather than by remembering: the value
// serializes to a marker under JSON.stringify, string interpolation, and util.inspect, and
// the plaintext leaves only through `use`, which hands it to a callback for the length of
// one call. Variable NAMES stay visible, because a diagnostic that says which variables
// were injected is useful and discloses nothing.

export const SECRET_PLACEHOLDER = '[secret]'

const INSPECT = Symbol.for('nodejs.util.inspect.custom')
// The shape an execve environment can actually carry, which is narrower than a JS key: an
// `=` or a NUL in a name has no representation, and a name that reaches a shell must also
// be a shell identifier because the injection path assigns it.
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

// Values live outside the instance, so an object holding one has no own property to spread,
// clone or print. The custom inspect hook covers the reader who asks politely; this covers
// the code that does not ask at all.
const values = new WeakMap<SecretEnv, ReadonlyMap<string, string>>()
const EMPTY: ReadonlyMap<string, string> = new Map()

function sealed(entries: ReadonlyMap<string, string>) {
  const env = new SecretEnv()
  values.set(env, entries)
  return env
}

function valuesOf(env: SecretEnv) {
  return values.get(env) ?? EMPTY
}

export class SecretEnv {
  static empty(): SecretEnv {
    return sealed(EMPTY)
  }

  static of(entries: Readonly<Record<string, string>>): SecretEnv {
    const sealedEntries = new Map<string, string>()
    for (const [name, value] of Object.entries(entries)) {
      if (!VARIABLE_NAME.test(name)) throw new Error(`not a usable environment variable name: ${name}`)
      // Reported by name, never by value: a rejection message is a log line.
      if (typeof value !== 'string' || value.includes('\0')) throw new Error(`the value for ${name} is not something an environment can carry`)
      sealedEntries.set(name, value)
    }
    return sealed(sealedEntries)
  }

  // The variables this will set, in sorted order. Safe to log, and the only way to reason
  // about an injection without unwrapping it.
  get names(): readonly string[] {
    return [...valuesOf(this).keys()].sort()
  }

  get size(): number {
    return valuesOf(this).size
  }

  // Merge for the case where a launch draws secrets from more than one place. Rejects a
  // variable defined twice rather than picking a winner: two sources disagreeing about one
  // credential is a configuration error, and silently preferring one hides it.
  merge(other: SecretEnv): SecretEnv {
    const merged = new Map(valuesOf(this))
    for (const [name, value] of valuesOf(other)) {
      if (merged.has(name)) throw new Error(`two sources define the secret variable ${name}`)
      merged.set(name, value)
    }
    return sealed(merged)
  }

  // The single door. The entries object passed in is valid only for the duration of the
  // call and must not be retained by the callback.
  use<T>(consume: (entries: Readonly<Record<string, string>>) => T): T {
    return consume(Object.fromEntries(valuesOf(this)))
  }

  toJSON(): string {
    return SECRET_PLACEHOLDER
  }

  toString(): string {
    return SECRET_PLACEHOLDER
  }

  [INSPECT](): string {
    return SECRET_PLACEHOLDER
  }
}
