# THIRD PARTY NOTICES - Sudo Studio AI extension

Sudo Studio integrates the OpenCode server (MISSION P3) as a local child
process. This file records its license and the licenses of its exact
dependency closure.

## 1. OpenCode v1.19.0 - MIT License

- Source: https://github.com/sst/opencode (redirects to github.com/anomalyco/opencode)
- Release: https://github.com/anomalyco/opencode/releases/tag/v1.19.0 (2026-10-11)
- License: MIT (LICENSE file at tag v1.19.0, reproduced below)

```
MIT License

Copyright (c) 2025 opencode

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
```

## 2. Dependency licenses (exact closure, v1.19.0)

Method (license-checker equivalent): OpenCode installs with bun, so npm's
`license-checker` cannot resolve its tree. Instead, `preuves-p3/p3-licenses.py`
parses the exact resolved versions from `bun.lock` at tag v1.19.0 (workspace
`packages/opencode`, runtime closure: dependencies + optionalDependencies +
peerDependencies; devDependencies excluded as not shipped), applying the
lockfile `overrides` and `catalog`, then reads each `name@version` license
field from the npm registry. 4 packages lack the metadata field but carry an
MIT LICENSE file in their repo (verified, see overrides in the audit JSON).
35 optional peer dependencies have no lockfile entry (never installed).
Full machine-readable output: `preuves-p3/licenses-v1.19.0.json` (810 nodes).

Summary (audit date 2026-10-12):

-   532  MIT
-   106  Apache-2.0
-    75  ISC
-    35  n/a(not-installed-optional-peer)
-    19  BSD-3-Clause
-    13  MIT(opencode)
-     9  BSD-2-Clause
-     6  BlueOak-1.0.0
-     2  apache-2.0
-     1  MIT OR Apache-2.0
-     1  MIT(repo-openauthjs/openauth)
-     1  CC-BY-4.0
-     1  (MPL-2.0 OR Apache-2.0)
-     1  (AFL-2.1 OR BSD-3-Clause)
-     1  MIT(repo-poe-platform/poe-code)
-     1  Unlicense
-     1  MIT(repo-changchang/seq-queue)
-     1  CC-BY-3.0
-     1  CC0-1.0
-     1  0BSD
-     1  (MIT OR CC0-1.0)
-     1  MIT(repo-mjwwit/node-XMLHttpRequest)

Result: 0 copyleft (no GPL/AGPL/LGPL), 0 unknown, 0 unresolved.

### 2.1 Non-MIT permissive licenses (present in closure)

- Apache-2.0, ISC, BSD-2-Clause, BSD-3-Clause, BlueOak-1.0.0, Unlicense,
  CC0-1.0, 0BSD, and the dual expressions MIT OR Apache-2.0,
  (MPL-2.0 OR Apache-2.0), (AFL-2.1 OR BSD-3-Clause), (MIT OR CC0-1.0).
- CC-BY-3.0 / CC-BY-4.0: attribution satisfied by this notice (data/doc assets).

### 2.2 Full list (name@version :: license)

```
@actions/core@1.11.1 :: MIT
@actions/exec@1.1.1 :: MIT
@actions/github@6.0.1 :: MIT
@actions/http-client@2.2.3 :: MIT
@actions/io@1.1.3 :: MIT
@agentclientprotocol/sdk@0.21.0 :: Apache-2.0
@ai-sdk/alibaba@1.0.17 :: Apache-2.0
@ai-sdk/amazon-bedrock@4.0.166 :: Apache-2.0
@ai-sdk/anthropic@3.0.111 :: Apache-2.0
@ai-sdk/azure@3.0.93 :: Apache-2.0
@ai-sdk/cerebras@2.0.60 :: Apache-2.0
@ai-sdk/cohere@3.0.54 :: Apache-2.0
@ai-sdk/deepgram@2.0.51 :: Apache-2.0
@ai-sdk/deepinfra@2.0.41 :: Apache-2.0
@ai-sdk/deepseek@2.0.50 :: Apache-2.0
@ai-sdk/elevenlabs@2.0.51 :: Apache-2.0
@ai-sdk/fireworks@2.0.76 :: Apache-2.0
@ai-sdk/gateway@3.0.104 :: Apache-2.0
@ai-sdk/google@3.0.108 :: Apache-2.0
@ai-sdk/google-vertex@4.0.181 :: Apache-2.0
@ai-sdk/groq@3.0.59 :: Apache-2.0
@ai-sdk/mistral@3.0.51 :: Apache-2.0
@ai-sdk/openai@3.0.105 :: Apache-2.0
@ai-sdk/openai-compatible@2.0.81 :: Apache-2.0
@ai-sdk/perplexity@3.0.53 :: Apache-2.0
@ai-sdk/provider@3.0.8 :: Apache-2.0
@ai-sdk/provider-utils@4.0.23 :: Apache-2.0
@ai-sdk/togetherai@2.0.68 :: Apache-2.0
@ai-sdk/vercel@2.0.39 :: Apache-2.0
@ai-sdk/xai@3.0.139 :: Apache-2.0
@anthropic-ai/sdk@0.71.2 :: MIT
@anycable/core@0.9.2 :: MIT
@aws-crypto/crc32@5.2.0 :: Apache-2.0
@aws-crypto/sha256-browser@5.2.0 :: Apache-2.0
@aws-crypto/sha256-js@5.2.0 :: Apache-2.0
@aws-crypto/supports-web-crypto@5.2.0 :: Apache-2.0
@aws-crypto/util@5.2.0 :: Apache-2.0
@aws-sdk/client-cognito-identity@3.1057.0 :: Apache-2.0
@aws-sdk/client-rds-data@>=3 (not installed) :: n/a(not-installed-optional-peer)
@aws-sdk/core@3.974.15 :: Apache-2.0
@aws-sdk/credential-provider-cognito-identity@3.972.38 :: Apache-2.0
@aws-sdk/credential-provider-env@3.972.41 :: Apache-2.0
@aws-sdk/credential-provider-http@3.972.43 :: Apache-2.0
@aws-sdk/credential-provider-ini@3.972.46 :: Apache-2.0
@aws-sdk/credential-provider-login@3.972.45 :: Apache-2.0
@aws-sdk/credential-provider-node@3.972.47 :: Apache-2.0
@aws-sdk/credential-provider-process@3.972.41 :: Apache-2.0
@aws-sdk/credential-provider-sso@3.972.45 :: Apache-2.0
@aws-sdk/credential-provider-web-identity@3.972.45 :: Apache-2.0
@aws-sdk/credential-providers@3.1057.0 :: Apache-2.0
@aws-sdk/nested-clients@3.997.13 :: Apache-2.0
@aws-sdk/signature-v4-multi-region@3.996.30 :: Apache-2.0
@aws-sdk/token-providers@3.1056.0 :: Apache-2.0
@aws-sdk/types@3.973.9 :: Apache-2.0
@aws-sdk/util-locate-window@3.965.5 :: Apache-2.0
@aws-sdk/xml-builder@3.972.26 :: Apache-2.0
@aws/lambda-invoke-store@0.2.4 :: Apache-2.0
@babel/code-frame@7.29.7 :: MIT
@babel/compat-data@7.29.7 :: MIT
@babel/core@7.28.4 :: MIT
@babel/generator@7.29.7 :: MIT
@babel/helper-annotate-as-pure@7.29.7 :: MIT
@babel/helper-compilation-targets@7.29.7 :: MIT
@babel/helper-create-class-features-plugin@7.29.7 :: MIT
@babel/helper-globals@7.29.7 :: MIT
@babel/helper-member-expression-to-functions@7.29.7 :: MIT
@babel/helper-module-imports@7.29.7 :: MIT
@babel/helper-module-transforms@7.29.7 :: MIT
@babel/helper-optimise-call-expression@7.29.7 :: MIT
@babel/helper-plugin-utils@7.29.7 :: MIT
@babel/helper-replace-supers@7.29.7 :: MIT
@babel/helper-skip-transparent-expression-wrappers@7.29.7 :: MIT
@babel/helper-string-parser@7.29.7 :: MIT
@babel/helper-validator-identifier@7.29.7 :: MIT
@babel/helper-validator-option@7.29.7 :: MIT
@babel/helpers@7.29.7 :: MIT
@babel/parser@7.29.7 :: MIT
@babel/plugin-syntax-jsx@7.29.7 :: MIT
@babel/plugin-syntax-typescript@7.29.7 :: MIT
@babel/plugin-transform-modules-commonjs@7.29.7 :: MIT
@babel/plugin-transform-typescript@7.29.7 :: MIT
@babel/preset-typescript@7.27.1 :: MIT
@babel/runtime@7.29.7 :: MIT
@babel/template@7.29.7 :: MIT
@babel/traverse@7.29.7 :: MIT
@babel/types@7.29.7 :: MIT
@cfworker/json-schema@^4.1.1 (not installed) :: n/a(not-installed-optional-peer)
@clack/core@1.0.0-alpha.1 :: MIT
@clack/prompts@1.0.0-alpha.1 :: MIT
@cloudflare/workers-types@4.20251008.0 :: MIT OR Apache-2.0
@corvu/utils@0.4.2 :: MIT
@effect/opentelemetry@4.0.0-beta.83 :: MIT
@effect/platform-node@4.0.0-beta.83 :: MIT
@effect/platform-node-shared@4.0.0-beta.83 :: MIT
@effect/sql-pg@>=4.0.0-beta.58 || >=4.0.0 (not installed) :: n/a(not-installed-optional-peer)
@effect/sql-sqlite-bun@4.0.0-beta.83 :: MIT
@electric-sql/pglite@>=0.2.0 (not installed) :: n/a(not-installed-optional-peer)
@emotion/is-prop-valid@0.8.8 :: MIT
@emotion/memoize@0.7.4 :: MIT
@fastify/ajv-compiler@4.0.5 :: MIT
@fastify/error@4.2.0 :: MIT
@fastify/fast-json-stringify-compiler@5.0.3 :: MIT
@fastify/forwarded@3.0.1 :: MIT
@fastify/merge-json-schemas@0.2.1 :: MIT
@fastify/proxy-addr@5.1.0 :: MIT
@fastify/rate-limit@10.3.0 :: MIT
@ff-labs/fff-bin-darwin-arm64@0.9.4 :: MIT
@ff-labs/fff-bin-darwin-x64@0.9.4 :: MIT
@ff-labs/fff-bin-linux-arm64-gnu@0.9.4 :: MIT
@ff-labs/fff-bin-linux-arm64-musl@0.9.4 :: MIT
@ff-labs/fff-bin-linux-x64-gnu@0.9.4 :: MIT
@ff-labs/fff-bin-linux-x64-musl@0.9.4 :: MIT
@ff-labs/fff-bin-win32-arm64@0.9.4 :: MIT
@ff-labs/fff-bin-win32-x64@0.9.4 :: MIT
@ff-labs/fff-bun@0.9.4 :: MIT
@floating-ui/core@1.7.5 :: MIT
@floating-ui/dom@1.7.6 :: MIT
@floating-ui/utils@0.2.11 :: MIT
@gar/promise-retry@1.0.3 :: MIT
@gitlab/opencode-gitlab-auth@1.3.3 :: MIT
@graphql-typed-document-node/core@3.2.0 :: MIT
@hono/node-server@1.19.14 :: MIT
@internationalized/date@3.12.2 :: Apache-2.0
@internationalized/number@3.6.7 :: Apache-2.0
@ioredis/commands@1.10.0 :: MIT
@isaacs/fs-minipass@4.0.1 :: ISC
@isaacs/string-locale-compare@1.1.0 :: ISC
@jridgewell/gen-mapping@0.3.13 :: MIT
@jridgewell/remapping@2.3.5 :: MIT
@jridgewell/resolve-uri@3.1.2 :: MIT
@jridgewell/sourcemap-codec@1.5.5 :: MIT
@jridgewell/trace-mapping@0.3.31 :: MIT
@kobalte/core@0.13.11 :: MIT
@kobalte/utils@0.9.1 :: MIT
@leichtgewicht/ip-codec@2.0.5 :: MIT
@libsql/client@>=0.10.0 (not installed) :: n/a(not-installed-optional-peer)
@libsql/client-wasm@>=0.10.0 (not installed) :: n/a(not-installed-optional-peer)
@lukeed/ms@2.0.2 :: MIT
@lydell/node-pty@1.2.0-beta.12 :: MIT
@lydell/node-pty-darwin-arm64@1.2.0-beta.12 :: MIT
@lydell/node-pty-darwin-x64@1.2.0-beta.12 :: MIT
@lydell/node-pty-linux-arm64@1.2.0-beta.12 :: MIT
@lydell/node-pty-linux-x64@1.2.0-beta.12 :: MIT
@lydell/node-pty-win32-arm64@1.2.0-beta.12 :: MIT
@lydell/node-pty-win32-x64@1.2.0-beta.12 :: MIT
@mixmark-io/domino@2.2.0 :: BSD-2-Clause
@modelcontextprotocol/sdk@1.29.0 :: MIT
@msgpackr-extract/msgpackr-extract-darwin-arm64@3.0.4 :: MIT
@msgpackr-extract/msgpackr-extract-darwin-x64@3.0.4 :: MIT
@msgpackr-extract/msgpackr-extract-linux-arm@3.0.4 :: MIT
@msgpackr-extract/msgpackr-extract-linux-arm64@3.0.4 :: MIT
@msgpackr-extract/msgpackr-extract-linux-x64@3.0.4 :: MIT
@msgpackr-extract/msgpackr-extract-win32-x64@3.0.4 :: MIT
@neondatabase/serverless@>=0.10.0 (not installed) :: n/a(not-installed-optional-peer)
@nodable/entities@2.1.1 :: MIT
@npmcli/agent@4.0.2 :: ISC
@npmcli/arborist@9.4.0 :: ISC
@npmcli/config@10.8.1 :: ISC
@npmcli/fs@5.0.0 :: ISC
@npmcli/git@7.0.2 :: ISC
@npmcli/installed-package-contents@4.0.0 :: ISC
@npmcli/map-workspaces@5.0.3 :: ISC
@npmcli/metavuln-calculator@9.0.3 :: ISC
@npmcli/name-from-folder@4.0.0 :: ISC
@npmcli/node-gyp@5.0.0 :: ISC
@npmcli/package-json@7.0.5 :: ISC
@npmcli/promise-spawn@9.0.1 :: ISC
@npmcli/query@5.0.0 :: ISC
@npmcli/redact@4.0.0 :: ISC
@npmcli/run-script@10.0.4 :: ISC
@octokit/auth-token@6.0.0 :: MIT
@octokit/core@7.0.6 :: MIT
@octokit/endpoint@11.0.3 :: MIT
@octokit/graphql@9.0.3 :: MIT
@octokit/openapi-types@27.0.0 :: MIT
@octokit/plugin-paginate-rest@13.2.1 :: MIT
@octokit/plugin-request-log@6.0.0 :: MIT
@octokit/plugin-rest-endpoint-methods@16.1.1 :: MIT
@octokit/request@10.0.10 :: MIT
@octokit/request-error@7.1.0 :: MIT
@octokit/rest@22.0.0 :: MIT
@octokit/types@16.0.0 :: MIT
@op-engineering/op-sqlite@>=2 (not installed) :: n/a(not-installed-optional-peer)
@openauthjs/openauth@0.0.0-20250322224806 :: MIT(repo-openauthjs/openauth)
@opencode-ai/codemode@workspace:1.19.0 :: MIT(opencode)
@opencode-ai/core@workspace:1.19.0 :: MIT(opencode)
@opencode-ai/effect-drizzle-sqlite@workspace:1.19.0 :: MIT(opencode)
@opencode-ai/effect-sqlite-node@workspace:1.19.0 :: MIT(opencode)
@opencode-ai/llm@workspace:1.19.0 :: MIT(opencode)
@opencode-ai/plugin@workspace:packages/plugin :: MIT(opencode)
@opencode-ai/protocol@workspace:? :: MIT(opencode)
@opencode-ai/schema@workspace:? :: MIT(opencode)
@opencode-ai/script@workspace:? :: MIT(opencode)
@opencode-ai/sdk@workspace:1.19.0 :: MIT(opencode)
@opencode-ai/server@workspace:1.19.0 :: MIT(opencode)
@opencode-ai/tui@workspace:1.19.0 :: MIT(opencode)
@opencode-ai/ui@workspace:1.19.0 :: MIT(opencode)
@openrouter/ai-sdk-provider@2.10.0 :: Apache-2.0
@opentelemetry/api@1.9.0 :: Apache-2.0
@opentelemetry/api-logs@0.214.0 :: Apache-2.0
@opentelemetry/context-async-hooks@2.6.1 :: Apache-2.0
@opentelemetry/core@2.6.1 :: Apache-2.0
@opentelemetry/exporter-trace-otlp-http@0.214.0 :: Apache-2.0
@opentelemetry/otlp-exporter-base@0.214.0 :: Apache-2.0
@opentelemetry/otlp-transformer@0.214.0 :: Apache-2.0
@opentelemetry/resources@2.6.1 :: Apache-2.0
@opentelemetry/sdk-logs@0.214.0 :: Apache-2.0
@opentelemetry/sdk-metrics@2.6.1 :: Apache-2.0
@opentelemetry/sdk-trace-base@2.6.1 :: Apache-2.0
@opentelemetry/sdk-trace-node@2.6.1 :: Apache-2.0
@opentelemetry/sdk-trace-web@^2.0.0 (not installed) :: n/a(not-installed-optional-peer)
@opentelemetry/semantic-conventions@1.41.1 :: Apache-2.0
@opentui/core@0.4.5 :: MIT
@opentui/core-darwin-arm64@0.4.5 :: MIT
@opentui/core-darwin-x64@0.4.5 :: MIT
@opentui/core-linux-arm64@0.4.5 :: MIT
@opentui/core-linux-arm64-musl@0.4.5 :: MIT
@opentui/core-linux-x64@0.4.5 :: MIT
@opentui/core-linux-x64-musl@0.4.5 :: MIT
@opentui/core-win32-arm64@0.4.5 :: MIT
@opentui/core-win32-x64@0.4.5 :: MIT
@opentui/keymap@0.4.5 :: MIT
@opentui/react@^0.3.4 (not installed) :: n/a(not-installed-optional-peer)
@opentui/solid@0.4.5 :: MIT
@oslojs/asn1@1.0.0 :: MIT
@oslojs/binary@1.0.0 :: MIT
@oslojs/crypto@1.0.1 :: MIT
@oslojs/encoding@0.4.1 :: MIT
@oslojs/jwt@0.2.0 :: MIT
@parcel/watcher@2.5.1 :: MIT
@parcel/watcher-android-arm64@2.5.1 :: MIT
@parcel/watcher-darwin-arm64@2.5.1 :: MIT
@parcel/watcher-darwin-x64@2.5.1 :: MIT
@parcel/watcher-freebsd-x64@2.5.1 :: MIT
@parcel/watcher-linux-arm-glibc@2.5.1 :: MIT
@parcel/watcher-linux-arm-musl@2.5.1 :: MIT
@parcel/watcher-linux-arm64-glibc@2.5.1 :: MIT
@parcel/watcher-linux-arm64-musl@2.5.1 :: MIT
@parcel/watcher-linux-x64-glibc@2.5.1 :: MIT
@parcel/watcher-linux-x64-musl@2.5.1 :: MIT
@parcel/watcher-win32-arm64@2.5.1 :: MIT
@parcel/watcher-win32-ia32@2.5.1 :: MIT
@parcel/watcher-win32-x64@2.5.1 :: MIT
@pierre/diffs@1.2.10 :: apache-2.0
@pierre/theme@1.0.3 :: MIT
@pierre/theming@0.0.1 :: apache-2.0
@pinojs/redact@0.4.0 :: MIT
@planetscale/database@1.19.0 :: Apache-2.0
@protobufjs/aspromise@1.1.2 :: BSD-3-Clause
@protobufjs/base64@1.1.2 :: BSD-3-Clause
@protobufjs/codegen@2.0.5 :: BSD-3-Clause
@protobufjs/eventemitter@1.1.1 :: BSD-3-Clause
@protobufjs/fetch@1.1.1 :: BSD-3-Clause
@protobufjs/float@1.0.2 :: BSD-3-Clause
@protobufjs/inquire@1.1.2 :: BSD-3-Clause
@protobufjs/path@1.1.2 :: BSD-3-Clause
@protobufjs/pool@1.1.0 :: BSD-3-Clause
@protobufjs/utf8@1.1.1 :: BSD-3-Clause
@shikijs/core@4.2.0 :: MIT
@shikijs/engine-javascript@4.2.0 :: MIT
@shikijs/engine-oniguruma@4.2.0 :: MIT
@shikijs/langs@4.2.0 :: MIT
@shikijs/primitive@4.2.0 :: MIT
@shikijs/stream@4.2.0 :: MIT
@shikijs/themes@4.2.0 :: MIT
@shikijs/transformers@3.20.0 :: MIT
@shikijs/types@4.2.0 :: MIT
@shikijs/vscode-textmate@10.0.2 :: MIT
@sigstore/bundle@4.0.0 :: Apache-2.0
@sigstore/core@3.2.1 :: Apache-2.0
@sigstore/protobuf-specs@0.5.1 :: Apache-2.0
@sigstore/sign@4.1.1 :: Apache-2.0
@sigstore/tuf@4.0.2 :: Apache-2.0
@sigstore/verify@3.1.1 :: Apache-2.0
@silvia-odwyer/photon-node@0.3.4 :: Apache-2.0
@sinclair/typebox@>=0.34.8 (not installed) :: n/a(not-installed-optional-peer)
@smithy/core@3.24.5 :: Apache-2.0
@smithy/credential-provider-imds@4.3.6 :: Apache-2.0
@smithy/eventstream-codec@4.2.14 :: Apache-2.0
@smithy/fetch-http-handler@5.4.5 :: Apache-2.0
@smithy/node-http-handler@4.7.5 :: Apache-2.0
@smithy/signature-v4@5.4.5 :: Apache-2.0
@smithy/types@4.14.2 :: Apache-2.0
@smithy/util-buffer-from@4.3.5 :: Apache-2.0
@smithy/util-hex-encoding@4.3.5 :: Apache-2.0
@smithy/util-utf8@4.2.2 :: Apache-2.0
@socket.io/component-emitter@3.1.2 :: MIT
@solid-primitives/bounds@0.1.3 :: MIT
@solid-primitives/event-bus@1.1.2 :: MIT
@solid-primitives/event-listener@2.4.5 :: MIT
@solid-primitives/keyed@1.5.3 :: MIT
@solid-primitives/map@0.4.13 :: MIT
@solid-primitives/media@2.3.3 :: MIT
@solid-primitives/props@3.2.3 :: MIT
@solid-primitives/refs@1.1.3 :: MIT
@solid-primitives/resize-observer@2.1.3 :: MIT
@solid-primitives/rootless@1.5.3 :: MIT
@solid-primitives/scheduled@1.5.2 :: MIT
@solid-primitives/static-store@0.1.3 :: MIT
@solid-primitives/trigger@1.2.3 :: MIT
@solid-primitives/utils@6.4.0 :: MIT
@solidjs/meta@0.29.4 :: MIT
@sqlitecloud/drivers@>=1.0.653 (not installed) :: n/a(not-installed-optional-peer)
@standard-schema/spec@1.1.0 :: MIT
@swc/helpers@0.5.23 :: Apache-2.0
@tidbcloud/serverless@* (not installed) :: n/a(not-installed-optional-peer)
@tufjs/canonical-json@2.0.0 :: MIT
@tufjs/models@4.1.0 :: MIT
@tursodatabase/database@>=0.2.1 (not installed) :: n/a(not-installed-optional-peer)
@tursodatabase/database-common@>=0.2.1 (not installed) :: n/a(not-installed-optional-peer)
@tursodatabase/database-wasm@>=0.2.1 (not installed) :: n/a(not-installed-optional-peer)
@types/better-sqlite3@* (not installed) :: n/a(not-installed-optional-peer)
@types/emscripten@^1.40.0 (not installed) :: n/a(not-installed-optional-peer)
@types/hast@3.0.4 :: MIT
@types/mdast@4.0.4 :: MIT
@types/mssql@^9.1.4 (not installed) :: n/a(not-installed-optional-peer)
@types/node@24.12.2 :: MIT
@types/pg@* (not installed) :: n/a(not-installed-optional-peer)
@types/sql.js@* (not installed) :: n/a(not-installed-optional-peer)
@types/trusted-types@2.0.7 :: MIT
@types/unist@3.0.3 :: MIT
@types/ws@8.18.1 :: MIT
@ungap/structured-clone@1.3.1 :: ISC
@upstash/redis@1.38.0 :: MIT
@vercel/oidc@3.2.0 :: Apache-2.0
@vercel/postgres@>=0.8.0 (not installed) :: n/a(not-installed-optional-peer)
@xata.io/client@* (not installed) :: n/a(not-installed-optional-peer)
@zip.js/zip.js@2.7.62 :: BSD-3-Clause
abbrev@4.0.0 :: ISC
abstract-logging@2.0.1 :: MIT
accepts@2.0.0 :: MIT
acorn@8.15.0 :: MIT
agent-base@7.1.4 :: MIT
ai@6.0.168 :: Apache-2.0
ai-gateway-provider@3.2.0 :: MIT
ajv@8.20.0 :: MIT
ajv-formats@3.0.1 :: MIT
ansi-regex@6.2.2 :: MIT
ansi-styles@6.2.3 :: MIT
arctic@2.3.4 :: MIT
argparse@1.0.10 :: MIT
arktype@>=2.0.0 (not installed) :: n/a(not-installed-optional-peer)
atomic-sleep@1.0.0 :: MIT
avvio@9.2.0 :: MIT
aws-ssl-profiles@1.1.2 :: MIT
aws4fetch@1.0.20 :: MIT
babel-plugin-jsx-dom-expressions@0.40.7 :: MIT
babel-plugin-module-resolver@5.0.2 :: MIT
babel-preset-solid@1.9.12 :: MIT
balanced-match@1.0.2 :: MIT
base64-js@1.5.1 :: MIT
baseline-browser-mapping@2.10.33 :: Apache-2.0
before-after-hook@4.0.0 :: Apache-2.0
better-sqlite3@>=9.3.0 (not installed) :: n/a(not-installed-optional-peer)
bignumber.js@9.3.1 :: MIT
bin-links@6.0.2 :: ISC
body-parser@2.2.2 :: MIT
bonjour-service@1.3.0 :: MIT
bowser@2.14.1 :: MIT
brace-expansion@2.1.1 :: MIT
braces@3.0.3 :: MIT
browserslist@4.28.2 :: MIT
buffer-equal-constant-time@1.0.1 :: BSD-3-Clause
bufferutil@^4.0.1 (not installed) :: n/a(not-installed-optional-peer)
bun-ffi-structs@0.2.4 :: MIT
bun-pty@0.4.8 :: MIT
bun-types@1.3.13 :: MIT
bundle-name@4.1.0 :: MIT
bytes@3.1.2 :: MIT
cacache@20.0.4 :: ISC
call-bind-apply-helpers@1.0.2 :: MIT
call-bound@1.0.4 :: MIT
caniuse-lite@1.0.30001793 :: CC-BY-4.0
ccount@2.0.1 :: MIT
character-entities-html4@2.1.0 :: MIT
character-entities-legacy@3.0.0 :: MIT
chokidar@4.0.3 :: MIT
chownr@3.0.0 :: BlueOak-1.0.0
ci-info@4.4.0 :: MIT
cli-spinners@3.4.0 :: MIT
clipboardy@4.0.0 :: MIT
cliui@9.0.1 :: ISC
cluster-key-slot@1.1.1 :: Apache-2.0
cmd-shim@8.0.0 :: ISC
comma-separated-tokens@2.0.3 :: MIT
commander@8.3.0 :: MIT
common-ancestor-path@2.0.0 :: BlueOak-1.0.0
content-disposition@1.1.0 :: MIT
content-type@2.0.0 :: MIT
convert-source-map@2.0.0 :: MIT
cookie@1.1.1 :: MIT
cookie-signature@1.2.2 :: MIT
cors@2.8.6 :: MIT
cross-fetch@3.2.0 :: MIT
cross-spawn@7.0.6 :: MIT
cssesc@3.0.0 :: MIT
csstype@3.2.3 :: MIT
data-uri-to-buffer@4.0.1 :: MIT
debug@4.4.3 :: MIT
decimal.js@10.5.0 :: MIT
default-browser@5.5.1 :: MIT
default-browser-id@5.0.1 :: MIT
define-lazy-prop@3.0.0 :: MIT
denque@2.1.0 :: Apache-2.0
depd@2.0.0 :: MIT
dequal@2.0.3 :: MIT
detect-libc@2.1.2 :: Apache-2.0
devlop@1.1.0 :: MIT
diff@9.0.0 :: BSD-3-Clause
dns-packet@5.6.1 :: MIT
dom-serializer@2.0.0 :: MIT
domelementtype@2.3.0 :: BSD-2-Clause
domhandler@5.0.3 :: BSD-2-Clause
dompurify@3.3.1 :: (MPL-2.0 OR Apache-2.0)
domutils@3.2.2 :: BSD-2-Clause
drizzle-orm@1.0.0-rc.2 :: Apache-2.0
dunder-proto@1.0.1 :: MIT
ecdsa-sig-formatter@1.0.11 :: Apache-2.0
ee-first@1.1.1 :: MIT
effect@4.0.0-beta.83 :: MIT
electron-to-chromium@1.5.364 :: ISC
emoji-regex@10.6.0 :: MIT
encodeurl@2.0.0 :: MIT
engine.io-client@6.6.5 :: MIT
engine.io-parser@5.2.3 :: MIT
entities@7.0.1 :: BSD-2-Clause
env-paths@2.2.1 :: MIT
es-define-property@1.0.1 :: MIT
es-errors@1.3.0 :: MIT
es-object-atoms@1.1.2 :: MIT
escalade@3.2.0 :: MIT
escape-html@1.0.3 :: MIT
esprima@4.0.1 :: BSD-2-Clause
etag@1.8.1 :: MIT
eventsource@3.0.7 :: MIT
eventsource-parser@3.1.0 :: MIT
execa@8.0.1 :: MIT
expo-sqlite@>=14.0.0 (not installed) :: n/a(not-installed-optional-peer)
exponential-backoff@3.1.3 :: Apache-2.0
express@5.2.1 :: MIT
express-rate-limit@8.5.2 :: MIT
extend@3.0.2 :: MIT
extend-shallow@2.0.1 :: MIT
fast-check@4.8.0 :: MIT
fast-decode-uri-component@1.0.1 :: MIT
fast-deep-equal@3.1.3 :: MIT
fast-json-stringify@6.4.0 :: MIT
fast-querystring@1.1.2 :: MIT
fast-uri@3.1.2 :: BSD-3-Clause
fast-xml-builder@1.2.0 :: MIT
fast-xml-parser@5.7.3 :: MIT
fastify@5.8.5 :: MIT
fastify-plugin@5.1.0 :: MIT
fastq@1.20.1 :: ISC
fdir@6.5.0 :: MIT
fetch-blob@3.2.0 :: MIT
fill-range@7.1.1 :: MIT
finalhandler@2.1.1 :: MIT
find-babel-config@2.1.2 :: MIT
find-my-way@9.6.0 :: MIT
find-my-way-ts@0.1.6 :: MIT
find-up@3.0.0 :: MIT
formdata-polyfill@4.0.10 :: MIT
forwarded@0.2.0 :: MIT
framer-motion@12.40.0 :: MIT
fresh@2.0.0 :: MIT
fs-minipass@3.0.3 :: ISC
fs.realpath@1.0.0 :: ISC
function-bind@1.1.2 :: MIT
fuzzysort@3.1.0 :: MIT
gaxios@7.1.4 :: Apache-2.0
gcp-metadata@8.1.2 :: Apache-2.0
generate-function@2.3.1 :: MIT
gensync@1.0.0-beta.2 :: MIT
get-caller-file@2.0.5 :: ISC
get-east-asian-width@1.6.0 :: MIT
get-intrinsic@1.3.0 :: MIT
get-proto@1.0.1 :: MIT
get-stream@8.0.1 :: MIT
gitlab-ai-provider@6.19.0 :: MIT
glob@9.3.5 :: ISC
google-auth-library@10.5.0 :: Apache-2.0
google-logging-utils@1.1.3 :: Apache-2.0
gopd@1.2.0 :: MIT
graceful-fs@4.2.11 :: ISC
graphql@16.14.0 :: MIT
graphql-request@6.1.0 :: MIT
gray-matter@4.0.3 :: MIT
gtoken@8.0.0 :: MIT
has-symbols@1.1.0 :: MIT
hasown@2.0.4 :: MIT
hast-util-to-html@9.0.5 :: MIT
hast-util-whitespace@3.0.0 :: MIT
hono@4.12.23 :: MIT
hosted-git-info@9.0.3 :: ISC
html-entities@2.3.3 :: MIT
html-void-elements@3.0.0 :: MIT
htmlparser2@8.0.2 :: MIT
http-cache-semantics@4.2.0 :: BSD-2-Clause
http-errors@2.0.1 :: MIT
http-proxy-agent@7.0.2 :: MIT
https-proxy-agent@7.0.6 :: MIT
human-signals@5.0.0 :: Apache-2.0
iconv-lite@0.7.2 :: MIT
ignore@7.0.5 :: MIT
ignore-walk@8.0.0 :: ISC
immer@11.1.4 :: MIT
inherits@2.0.4 :: ISC
ini@7.0.0 :: ISC
ioredis@5.11.0 :: MIT
ip-address@10.2.0 :: MIT
ipaddr.js@2.4.0 :: MIT
is-core-module@2.16.2 :: MIT
is-docker@3.0.0 :: MIT
is-extendable@0.1.1 :: MIT
is-extglob@2.1.1 :: MIT
is-glob@4.0.3 :: MIT
is-in-ssh@1.0.0 :: MIT
is-inside-container@1.0.0 :: MIT
is-number@7.0.0 :: MIT
is-promise@4.0.0 :: MIT
is-property@1.0.2 :: MIT
is-stream@3.0.0 :: MIT
is-wsl@3.1.1 :: MIT
is64bit@2.0.0 :: MIT
isexe@2.0.0 :: ISC
isomorphic-ws@5.0.0 :: MIT
jose@5.9.6 :: MIT
js-tokens@4.0.0 :: MIT
js-yaml@3.14.2 :: MIT
jsesc@3.1.0 :: MIT
json-bigint@1.0.0 :: MIT
json-parse-even-better-errors@5.0.0 :: MIT
json-schema@0.4.0 :: (AFL-2.1 OR BSD-3-Clause)
json-schema-ref-resolver@3.0.0 :: MIT
json-schema-to-ts@3.1.1 :: MIT
json-schema-traverse@1.0.0 :: MIT
json-schema-typed@8.0.2 :: BSD-2-Clause
json-stringify-nice@1.1.4 :: ISC
json-with-bigint@3.5.8 :: MIT
json5@2.2.3 :: MIT
jsonc-parser@3.3.1 :: MIT
jsonparse@1.3.1 :: MIT
just-diff@6.0.2 :: MIT
just-diff-apply@5.5.0 :: MIT
jwa@2.0.1 :: MIT
jws@4.0.1 :: MIT
katex@0.16.27 :: MIT
kind-of@6.0.3 :: MIT
kubernetes-types@1.30.0 :: Apache-2.0
light-my-request@6.6.0 :: BSD-3-Clause
locate-path@3.0.0 :: MIT
long@5.3.2 :: Apache-2.0
loose-envify@1.4.0 :: MIT
lru-cache@5.1.1 :: ISC
lru.min@1.1.4 :: MIT
lru_map@0.4.1 :: MIT
luxon@3.6.1 :: MIT
make-fetch-happen@15.0.6 :: ISC
marked@17.0.1 :: MIT
marked-shiki@1.2.1 :: MIT
math-intrinsics@1.1.0 :: MIT
mdast-util-to-hast@13.2.1 :: MIT
media-typer@1.1.0 :: MIT
merge-descriptors@2.0.0 :: MIT
merge-stream@2.0.0 :: MIT
micromark-util-character@2.1.1 :: MIT
micromark-util-encode@2.0.1 :: MIT
micromark-util-sanitize-uri@2.0.1 :: MIT
micromark-util-symbol@2.0.1 :: MIT
micromark-util-types@2.0.2 :: MIT
micromatch@4.0.8 :: MIT
mime@4.1.0 :: MIT
mime-db@1.54.0 :: MIT
mime-types@3.0.2 :: MIT
mimic-fn@4.0.0 :: MIT
minimatch@8.0.7 :: ISC
minipass@7.1.3 :: BlueOak-1.0.0
minipass-collect@2.0.1 :: ISC
minipass-fetch@5.0.2 :: MIT
minipass-flush@1.0.7 :: BlueOak-1.0.0
minipass-pipeline@1.2.4 :: ISC
minipass-sized@2.0.0 :: ISC
minizlib@3.1.0 :: MIT
morphdom@2.7.8 :: MIT
motion@12.34.5 :: MIT
motion-dom@12.34.3 :: MIT
motion-utils@12.29.2 :: MIT
ms@2.1.3 :: MIT
msgpackr@2.0.2 :: MIT
msgpackr-extract@3.0.4 :: MIT
mssql@^11.0.1 (not installed) :: n/a(not-installed-optional-peer)
multicast-dns@7.2.5 :: MIT
multipasta@0.2.7 :: MIT
mysql2@3.14.4 :: MIT
named-placeholders@1.1.6 :: MIT
nanoevents@7.0.1 :: MIT
negotiator@1.0.0 :: MIT
node-addon-api@7.1.1 :: MIT
node-domexception@1.0.0 :: MIT
node-fetch@3.3.2 :: MIT
node-gyp@12.3.0 :: MIT
node-gyp-build@4.8.4 :: MIT
node-gyp-build-optional-packages@5.2.2 :: MIT
node-releases@2.0.46 :: MIT
nopt@9.0.0 :: ISC
npm-bundled@5.0.0 :: ISC
npm-install-checks@8.0.0 :: BSD-2-Clause
npm-normalize-package-bin@5.0.0 :: ISC
npm-package-arg@13.0.2 :: ISC
npm-packlist@10.0.4 :: ISC
npm-pick-manifest@11.0.3 :: ISC
npm-registry-fetch@19.1.1 :: ISC
npm-run-path@5.3.0 :: MIT
object-assign@4.1.1 :: MIT
object-inspect@1.13.4 :: MIT
on-exit-leak-free@2.1.2 :: MIT
on-finished@2.4.1 :: MIT
once@1.4.0 :: ISC
onetime@6.0.0 :: MIT
oniguruma-parser@0.12.2 :: MIT
oniguruma-to-es@4.3.6 :: MIT
open@11.0.4 :: MIT
openai@6.39.1 :: Apache-2.0
opencode-gitlab-auth@2.1.0 :: MIT
opencode-poe-auth@0.0.1 :: MIT
opentui-spinner@0.0.7 :: MIT
p-limit@2.3.0 :: MIT
p-locate@3.0.0 :: MIT
p-map@7.0.4 :: MIT
p-try@2.2.0 :: MIT
pacote@21.5.0 :: ISC
parse-conflict-json@5.0.1 :: ISC
parse5@7.3.0 :: MIT
parseurl@1.3.3 :: MIT
partial-json@0.1.7 :: MIT
path-exists@3.0.0 :: MIT
path-expression-matcher@1.5.0 :: MIT
path-key@3.1.1 :: MIT
path-parse@1.0.7 :: MIT
path-scurry@1.11.1 :: BlueOak-1.0.0
path-to-regexp@8.4.2 :: MIT
pg@>=8 (not installed) :: n/a(not-installed-optional-peer)
picocolors@1.1.1 :: ISC
picomatch@2.3.2 :: MIT
pino@10.3.1 :: MIT
pino-abstract-transport@3.0.0 :: MIT
pino-std-serializers@7.1.0 :: MIT
pkce-challenge@5.0.1 :: MIT
pkg-up@3.1.0 :: MIT
poe-oauth@0.0.8 :: MIT(repo-poe-platform/poe-code)
postcss-selector-parser@7.1.1 :: MIT
postgres@3.4.7 :: Unlicense
powershell-utils@0.1.0 :: MIT
proc-log@6.1.0 :: ISC
process-warning@5.0.0 :: MIT
proggy@4.0.0 :: ISC
promise-all-reject-late@1.0.1 :: ISC
promise-call-limit@3.0.2 :: ISC
property-information@7.1.0 :: MIT
protobufjs@7.6.2 :: BSD-3-Clause
proxy-addr@2.0.7 :: MIT
pure-rand@8.4.0 :: MIT
qs@6.15.2 :: BSD-3-Clause
quick-format-unescaped@4.0.4 :: MIT
range-parser@1.2.1 :: MIT
raw-body@3.0.2 :: MIT
react@18.2.0 :: MIT
react-dom@18.2.0 (peer-deduped) :: MIT
read-cmd-shim@6.0.0 :: ISC
readdirp@4.1.2 :: MIT
real-require@1.0.0 :: MIT
redis-errors@1.2.0 :: MIT
redis-parser@3.0.0 :: MIT
regex@6.1.0 :: MIT
regex-recursion@6.0.2 :: MIT
regex-utilities@2.3.0 :: MIT
remeda@2.26.0 :: MIT
remend@1.3.0 :: Apache-2.0
require-from-string@2.0.2 :: MIT
reselect@4.1.8 :: MIT
resolve@1.22.12 :: MIT
ret@0.5.0 :: MIT
reusify@1.1.0 :: MIT
rfdc@1.4.1 :: MIT
router@2.2.0 :: MIT
run-applescript@7.1.0 :: MIT
s-js@0.4.9 :: MIT
safe-buffer@5.2.1 :: MIT
safe-regex2@5.1.1 :: MIT
safe-stable-stringify@2.5.0 :: MIT
safer-buffer@2.1.2 :: MIT
scheduler@0.23.2 :: MIT
section-matter@1.0.0 :: MIT
secure-json-parse@4.1.0 :: BSD-3-Clause
semver@7.8.5 :: ISC
send@1.2.1 :: MIT
seq-queue@0.0.5 :: MIT(repo-changchang/seq-queue)
seroval@1.3.2 :: MIT
seroval-plugins@1.3.3 :: MIT
serve-static@2.2.1 :: MIT
set-cookie-parser@2.7.2 :: MIT
setprototypeof@1.2.0 :: ISC
shebang-command@2.0.0 :: MIT
shebang-regex@3.0.0 :: MIT
shiki@4.2.0 :: MIT
side-channel@1.1.0 :: MIT
side-channel-list@1.0.1 :: MIT
side-channel-map@1.0.1 :: MIT
side-channel-weakmap@1.0.2 :: MIT
signal-exit@4.1.0 :: ISC
sigstore@4.1.1 :: Apache-2.0
sisteransi@1.0.5 :: MIT
smart-buffer@4.2.0 :: MIT
socket.io-client@4.8.3 :: MIT
socket.io-parser@4.2.6 :: MIT
socks@2.8.9 :: MIT
socks-proxy-agent@8.0.5 :: MIT
solid-js@1.9.10 :: MIT
solid-list@0.3.0 :: MIT
solid-presence@0.1.8 :: MIT
solid-prevent-scroll@0.1.10 :: MIT
solid-sonner@0.3.1 :: MIT
sonic-boom@4.2.1 :: MIT
space-separated-tokens@2.0.2 :: MIT
spdx-exceptions@2.5.0 :: CC-BY-3.0
spdx-expression-parse@4.0.0 :: MIT
spdx-license-ids@3.0.23 :: CC0-1.0
split2@4.2.0 :: ISC
sprintf-js@1.0.3 :: BSD-3-Clause
sql.js@>=1 (not installed) :: n/a(not-installed-optional-peer)
sqlite3@>=5 (not installed) :: n/a(not-installed-optional-peer)
sqlstring@2.3.3 :: MIT
ssri@13.0.1 :: ISC
standard-as-callback@2.1.0 :: MIT
statuses@2.0.2 :: MIT
string-width@7.2.0 :: MIT
stringify-entities@4.0.4 :: MIT
strip-ansi@7.1.2 :: MIT
strip-bom-string@1.0.0 :: MIT
strip-final-newline@3.0.0 :: MIT
strnum@2.3.0 :: MIT
supports-color@10.2.2 :: MIT
supports-preserve-symlinks-flag@1.0.0 :: MIT
system-architecture@0.1.0 :: MIT
tar@7.5.15 :: BlueOak-1.0.0
thread-stream@4.2.0 :: MIT
thunky@1.1.0 :: MIT
tinyglobby@0.2.17 :: MIT
to-regex-range@5.0.1 :: MIT
toad-cache@3.7.1 :: MIT
toidentifier@1.0.1 :: MIT
toml@4.1.1 :: MIT
tree-sitter@^0.25.0 (not installed) :: n/a(not-installed-optional-peer)
tree-sitter-bash@0.25.0 :: MIT
tree-sitter-powershell@0.25.10 :: MIT
treeverse@3.0.0 :: ISC
trim-lines@3.0.1 :: MIT
ts-algebra@2.0.0 :: MIT
tslib@2.8.1 :: 0BSD
tuf-js@4.1.0 :: MIT
tunnel@0.0.6 :: MIT
turndown@7.2.0 :: MIT
type-fest@4.41.0 :: (MIT OR CC0-1.0)
type-is@2.1.0 :: MIT
typebox@>=1.0.0 (not installed) :: n/a(not-installed-optional-peer)
typescript@5.8.2 :: Apache-2.0
ulid@3.0.1 :: MIT
uncrypto@0.1.3 :: MIT
undici@6.28.0 :: MIT
undici-types@7.16.0 :: MIT
unist-util-is@6.0.1 :: MIT
unist-util-position@5.0.0 :: MIT
unist-util-stringify-position@4.0.0 :: MIT
unist-util-visit@5.1.0 :: MIT
unist-util-visit-parents@6.0.2 :: MIT
universal-user-agent@7.0.3 :: ISC
unpipe@1.0.0 :: MIT
update-browserslist-db@1.2.3 :: MIT
utf-8-validate@>=5.0.2 (not installed) :: n/a(not-installed-optional-peer)
util-deprecate@1.0.2 :: MIT
uuid@14.0.0 :: MIT
valibot@1.4.1 :: MIT
validate-npm-package-name@7.0.2 :: ISC
vary@1.1.2 :: MIT
venice-ai-sdk-provider@2.1.1 :: Apache-2.0
vfile@6.0.3 :: MIT
vfile-message@4.0.3 :: MIT
vscode-jsonrpc@8.2.1 :: MIT
vue@^3.2.0 (not installed) :: n/a(not-installed-optional-peer)
walk-up-path@4.0.0 :: ISC
web-streams-polyfill@3.3.3 :: MIT
web-tree-sitter@0.25.10 :: MIT
which@2.0.2 :: ISC
wrap-ansi@9.0.2 :: MIT
wrappy@1.0.2 :: ISC
write-file-atomic@7.0.1 :: ISC
ws@8.21.0 :: MIT
wsl-utils@1.0.0 :: MIT
xdg-basedir@5.1.0 :: MIT
xml-naming@0.1.0 :: MIT
xmlhttprequest-ssl@2.1.2 :: MIT(repo-mjwwit/node-XMLHttpRequest)
y18n@5.0.8 :: ISC
yallist@3.1.1 :: ISC
yaml@2.9.0 :: ISC
yargs@18.0.0 :: MIT
yargs-parser@22.0.0 :: ISC
zod@4.1.8 :: MIT
zod-to-json-schema@3.25.2 :: ISC
zwitch@2.0.4 :: MIT
```
