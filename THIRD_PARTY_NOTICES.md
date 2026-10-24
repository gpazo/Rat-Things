# Third-party code

## OpenAI Codex

The macOS app bundles the native Codex package version pinned in
`runtime/codex/source.json`, including its companion executables and resources.
Its Apache 2.0 license and upstream NOTICE are retained in
`runtime/codex/licenses/`. The native app includes them in
`Contents/Resources/Runtime.bundle/Contents/Resources/notices/`.
Rat Things builds modified host and Linux worker runtimes from the revision
and ordered patches listed by `runtime/codex/source.json`.
The signed runtime's component inventory records each target's build inputs.

## Cua

`src/domain/local-runtime.ts` adapts the engine classification in
`libs/cua/crates/cua-vmm/src/container/engine.rs` from
[trycua/cua](https://github.com/trycua/cua/tree/864fd4e525fe14d55fda25502c69132505a0e85d).
The port is TypeScript, and Rat Things restricts execution to supported local engines.
Cua is not a runtime dependency. Rat Things retains its API, CLI, authentication,
execution protocol, and AWS deployment.

MIT License

Copyright (c) 2025 Cua AI, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
