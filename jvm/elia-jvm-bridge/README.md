# elia-jvm-bridge (Java)

A resident JVM service for Elia. Speaks the same newline-delimited JSON-RPC as
`eliad` over stdin/stdout; `eliad` spawns and supervises it (`crates/eliad/src/jvm.rs`)
and forwards `jvm.*` requests. It starts lazily — only on the first `jvm.*`
call, and only when a JDK and this jar are both present.

## Methods

| Method | Params | Result |
| --- | --- | --- |
| `jvm.info` | – | `{ version, protocol, java_version, java_home }` |
| `jvm.check` | `{ source, path?, classpath?: string[] }` | `{ ok, errors: [{ line, column, message, severity }] }` |

`jvm.check` compiles `source` with the JDK's in-process compiler
(`javax.tools`, `-proc:none -implicit:none`, output discarded) and returns its
diagnostics. Warm, it answers in a few hundred milliseconds — so Elia catches a
broken Java edit without a cold Gradle build. Without a `classpath` the check is
syntax + local semantics; unresolved imports show up as errors.

## Why hand-rolled JSON

The JDK ships no JSON API and this bridge speaks one small protocol, so
`Json.java` is a ~200-line recursive-descent parser + writer rather than a
Jackson dependency.

## Build

No Gradle yet — `just build-jvm`, or:

```
cd jvm/elia-jvm-bridge
javac -d build/classes $(find src -name '*.java')
jar --create --file build/elia-jvm-bridge.jar \
  --main-class com.elia.jvmbridge.Bridge -C build/classes .
```

`src/daemon/client.ts` finds the jar (`jvm/elia-jvm-bridge/build/` in dev, the
`@elia/native` package once published) and passes its path to `eliad` via
`ELIA_JVM_BRIDGE_JAR`. Needs JDK 21+ (`java` on `PATH` or `JAVA_HOME`).

Later: a Gradle build, the Gradle tooling API for real project build-graphs, and
JUnit test discovery + shard planning (WS8).
