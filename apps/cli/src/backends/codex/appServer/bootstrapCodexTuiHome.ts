import { buildCodexAppServerConfigOverrides } from './buildCodexAppServerConfigOverrides';
import { bootstrapCodexNativeHome } from './client/createCodexAppServerClient';

/** Initialize resources owned by a separate, managed disk-auth TUI process. */
export async function bootstrapCodexTuiHome(params: Readonly<{
    cwd: string;
    processEnv: NodeJS.ProcessEnv;
    codexArgs: readonly string[];
}>): Promise<void> {
    // Match the TUI's existing executable owner. An app-server-only override
    // can select a different native binary and cannot bootstrap this TUI.
    const processEnv = { ...params.processEnv, HAPPIER_CODEX_APP_SERVER_BIN: undefined };
    const configOverrides = buildCodexAppServerConfigOverrides({}, params);
    await bootstrapCodexNativeHome({ ...params, processEnv, configOverrides });
}
