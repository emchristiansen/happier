import { describe, expect, it } from 'vitest';

import { buildCodexAppServerConfigOverrides } from './buildCodexAppServerConfigOverrides';

describe('buildCodexAppServerConfigOverrides', () => {
    it('preserves ordered opaque native config overrides and ignores prompt text after the argument terminator', () => {
        expect(buildCodexAppServerConfigOverrides({}, {
            codexArgs: ['-c', 'model_reasoning_effort=low', '--config', 'custom.value="a=b"', '--config=model_reasoning_effort=high', '-cmodel_reasoning_effort=low', '-c=personality="friendly"', '--', '-c', 'model_reasoning_effort=medium'],
        })).toEqual(['model_reasoning_effort=low', 'custom.value="a=b"', 'model_reasoning_effort=high', 'model_reasoning_effort=low', 'personality="friendly"']);
        expect(() => buildCodexAppServerConfigOverrides({}, { codexArgs: ['-c'] })).toThrow();
    });
    it('translates materialized Happier MCP servers into additive app-server config overrides', () => {
        const overrides = buildCodexAppServerConfigOverrides({
            happier: {
                command: '/tmp/happier-mcp-bridge',
                args: ['--url', 'http://127.0.0.1:0'],
                env: {
                    HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: '/tmp/bridge-config.json',
                },
            },
        });

        expect(overrides).toEqual([
            'mcp_optional_startup_grace_ms=60000',
            'mcp_servers.happier.command="/tmp/happier-mcp-bridge"',
            'mcp_servers.happier.args=["--url","http://127.0.0.1:0"]',
            'mcp_servers.happier.env={HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE="/tmp/bridge-config.json"}',
            'mcp_servers.happier.enabled=true',
            'mcp_servers.happier.startup_timeout_sec=60',
            'mcp_servers.happier.tool_timeout_sec=3720',
            'mcp_servers.happier.tools.execution_run_get.approval_mode="approve"',
            'mcp_servers.happier.tools.execution_run_list.approval_mode="approve"',
            'mcp_servers.happier.tools.execution_run_wait.approval_mode="approve"',
        ]);
    });

    it('uses the app-server startup budget for optional Happier MCP discovery without making it required', () => {
        const overrides = buildCodexAppServerConfigOverrides({
            happier: { command: 'happier-mcp' },
        }, {
            processEnv: {
                HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS: '90000',
            },
        });

        expect(overrides).toContain('mcp_optional_startup_grace_ms=90000');
        expect(overrides).toContain('mcp_servers.happier.startup_timeout_sec=90');
        expect(overrides.some((override) => override.includes('.required='))).toBe(false);
    });

    it('prefixes configured server names so user Codex MCP entries cannot collide with Happier-injected ones', () => {
        const overrides = buildCodexAppServerConfigOverrides({
            context7: {
                command: 'echo',
                args: ['hello'],
            },
            'server.with spaces': {
                command: 'node',
            },
        });

        expect(overrides).toContain('mcp_servers.happier__context7.command="echo"');
        expect(overrides).toContain('mcp_servers.happier__server_with_spaces.command="node"');
        expect(overrides).not.toContain('mcp_servers.context7.command="echo"');
        expect(overrides.some((override) => override.includes('.tool_timeout_sec='))).toBe(false);
        expect(overrides.some((override) => override.includes('.tools.execution_run_wait.approval_mode'))).toBe(false);
    });

    it('uses the configured bounded Happier MCP tool-call timeout', () => {
        const overrides = buildCodexAppServerConfigOverrides({
            happier: { command: 'happier-mcp' },
        }, {
            happierMcpToolCallTimeoutMs: 7_230_500,
        });

        expect(overrides).toContain('mcp_servers.happier.tool_timeout_sec=7230.5');
    });

    it('injects only the explicit Happier session context into Codex shell subprocesses', () => {
        const overrides = buildCodexAppServerConfigOverrides({}, {
            happierSessionId: 'session-123',
        });

        expect(overrides).toEqual([
            'shell_environment_policy.set.HAPPIER_SESSION_ID="session-123"',
        ]);
    });

    it('does not inject unresolved offline session context', () => {
        expect(buildCodexAppServerConfigOverrides({}, {
            happierSessionId: 'offline-session-123',
        })).toEqual([]);
    });
});
