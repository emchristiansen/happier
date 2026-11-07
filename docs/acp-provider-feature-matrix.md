# ACP agent capability source map

This page is an internal map to the owners of shared ACP agent behavior. It is
not a second capability matrix. The generated
[`/agents/capabilities`](../apps/docs/content/docs/agents/capabilities.mdx)
reference is the current agent-by-agent projection; agent pages under
`apps/docs/content/docs/agents/` own setup instructions and user-facing limits.

Do not add agent rows here. A row-by-row copy of runtime facts drifts as soon as
an agent moves onto the shared ACP path.

## Canonical owners

| Concern | Canonical source |
| --- | --- |
| Agent IDs, resume declarations, session-listing declarations, tool delivery and support | `packages/agents/src/manifest.ts` |
| Built-in ACP commands, static capability policy, MCP descriptor handling, and transport profiles | `packages/agents/src/acp.ts` |
| Auth status commands and background-check policy | `packages/agents/src/auth.ts` |
| Login launch actions | `packages/agents/src/localCli.ts` |
| Binary resolution and install policy | `packages/agents/src/providers/providerCliRuntime.ts` |
| Generic ACP catalog entry and runtime construction | `apps/cli/src/agent/acp/catalog/createCatalogDefinedAcpEntry.ts`, `apps/cli/src/agent/acp/catalog/createCatalogDefinedAcpBackend.ts`, `apps/cli/src/agent/acp/catalog/runCatalogDefinedAcpAgent.ts` |
| Negotiated ACP runtime capabilities | `apps/cli/src/agent/acp/AcpBackend.ts` |
| Resume-only ACP `session/list` projection | `apps/cli/src/backends/directSessions/acpSessionListProviderOps.ts` |
| Execution-run availability | `apps/cli/src/agent/executionRuns/registry/executionRunBackendRegistry.ts` |
| UI catalog composition and ACP-list browse option | `apps/ui/sources/agents/registry/registryCore.ts`, `apps/ui/sources/agents/registry/registryUiBehavior.ts` |
| Published agent capability reference | `apps/docs/scripts/generateAgentReference.mjs` |

## Reading session capabilities

Static declarations decide which product surface Happier offers. The live ACP
handshake is the runtime authority before Happier dispatches an optional method.
Both facts matter: a declaration alone does not prove that the installed agent
negotiates the method.

The shared ACP `session/list` source is intentionally resume-only. It turns an
ACP-listed ID into a new Happier-controlled resume. It does not assert that ACP
and an interactive CLI share session identity, nor does it provide live
takeover, writer safety, transcript following or import, or terminal attachment.

`sessionStorage.direct` is a storage-mode declaration, not proof of session
listing or any of those stronger external-session behaviors.

## Reading tool support

`tools.support` records whether the integration is supported, experimental, or
unsupported. `tools.delivery` records how Happier supplies those tools. For
ACP agents, `native_mcp` is paired with the `mcpServers` handling in
`packages/agents/src/acp.ts`; neither field should be restated in an
agent-specific matrix.

## Validation

When these owners change, update their owner-level tests and run the generated
documentation checks. The published projection is regenerated with:

```bash
yarn --cwd apps/docs generate:reference
```

Then verify it with `yarn --cwd apps/docs check:content`. Authenticated provider
behavior remains unverified until the relevant live recipe runs; a declaration
or generated row is not live evidence.
