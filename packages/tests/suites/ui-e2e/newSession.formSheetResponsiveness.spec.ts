import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';

const run = createRunDirs({ runLabel: 'ui-e2e' });

const startNewSessionTestIds = [
    'main-header-start-new-session',
    'home-header-start-new-session',
    'nav-new-session',
    'session-getting-started-start-new-session',
] as const;

async function firstVisibleByTestId(
    page: Page,
    testIds: readonly string[],
): Promise<Locator | null> {
    for (const testId of testIds) {
        const locator = page.getByTestId(testId);
        const count = await locator.count();
        for (let index = 0; index < count; index += 1) {
            const candidate = locator.nth(index);
            if (await candidate.isVisible().catch(() => false)) {
                return candidate;
            }
        }
    }
    return null;
}

async function waitForVisibleByTestId(
    page: Page,
    testIds: readonly string[],
    timeoutMs: number,
): Promise<Locator> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const locator = await firstVisibleByTestId(page, testIds);
        if (locator) return locator;

        await page.waitForTimeout(250);
    }

    throw new Error(`Timed out waiting for visible testID in ${testIds.join(', ')}`);
}

test.describe('ui e2e: new-session formSheet responsiveness', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('new-session-formsheet-responsiveness-suite');
    const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;
    let daemon: StartedDaemon | null = null;
    let authStorageState: AuthStorageState | null = null;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(900_000);
        await mkdir(suiteDir, { recursive: true });
        await mkdir(cliHomeDir, { recursive: true });

        server = await startServerLight({
            testDir: suiteDir,
            dbProvider: 'sqlite',
            extraEnv: {
                HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
            },
        });

        ui = await startUiWeb({
            testDir: suiteDir,
            env: {
                ...process.env,
                EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
                EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
            },
        });
        uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);

        // Authenticate once so every test can open its own context from the saved session.
        const authContext = await browser.newContext();
        try {
            const page = await authContext.newPage();
            await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 240_000);
            daemon = await authenticateAndStartDaemon({
                page,
                testDir: suiteDir,
                cliHomeDir,
                serverUrl: server.baseUrl,
                uiBaseUrl,
                terminalConnectUrlTimeoutMs: 180_000,
                daemonStartupTimeoutMs: 180_000,
            });
            await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 240_000);
            await ensureAccountReadyForConnect({ page, timeoutMs: 120_000, clickCreateAccount: false });
            authStorageState = await authContext.storageState();
        } finally {
            await authContext.close();
        }
    });

    test.afterAll(async () => {
        test.setTimeout(120_000);
        await daemon?.stop().catch(() => {});
        await ui?.stop().catch(() => {});
        await server?.stop().catch(() => {});
    });

    test('opens from the sessions surface and closes through the stable cancel affordance', async ({ browser }) => {
        test.setTimeout(180_000);
        if (!uiBaseUrl || !authStorageState) throw new Error('missing ui/auth fixtures');

        const context = await browser.newContext({ storageState: authStorageState });
        try {
            const page = await openNewSessionFromSessionsSurface(context, uiBaseUrl);

            await page.getByTestId('new-session-composer-input').fill('formsheet responsiveness smoke');
            await expect(page.getByTestId('new-session-composer-input')).toHaveValue('formsheet responsiveness smoke');
            await expect(page.getByTestId('new-session-composer-send')).toBeVisible({ timeout: 60_000 });

            await expect(page.getByTestId('new-session-cancel')).toBeVisible({ timeout: 60_000 });
            await page.getByTestId('new-session-cancel').click();

            await page.waitForURL((url) => !url.pathname.endsWith('/new'), { timeout: 60_000 });
            await expect(page.getByTestId('new-session-composer-input')).toHaveCount(0);
        } finally {
            await context.close();
        }
    });

    test('settles the composer height in one step when a large prompt is pasted', async ({ browser }) => {
        test.setTimeout(180_000);
        if (!uiBaseUrl || !authStorageState) throw new Error('missing ui/auth fixtures');

        // Desktop web: the composer is hosted in the centered web modal, where the jank was reported.
        const context = await browser.newContext({
            storageState: authStorageState,
            viewport: { width: 1440, height: 900 },
        });
        try {
            const page = await openNewSessionFromSessionsSurface(context, uiBaseUrl);
            const composer = page.getByTestId('new-session-composer-input');
            await composer.focus();
            const initialInputHeight = await composer.evaluate((input: HTMLTextAreaElement) => input.offsetHeight);

            const largePrompt = Array.from(
                { length: 300 },
                (_, index) => `${index + 1}. Handoff step: inspect the owner, write the failing test, then fix it.`,
            ).join('\n');
            const trace = await recordComposerHeightsAcrossPaste(page, largePrompt);
            const tracePath = test.info().outputPath('composer-height-trace.json');
            await writeFile(tracePath, JSON.stringify(trace, null, 2));
            await test.info().attach('composer-height-trace.json', { path: tracePath, contentType: 'application/json' });

            await expect(composer).toHaveValue(largePrompt);
            expect(trace.inputHeights.length).toBeGreaterThan(30);
            expect(trace.inputHeights.at(-1)).toBeGreaterThan(initialInputHeight);
            // Pasting is one input event: the composer must reach its final height in the
            // frame after the paste and stay there, not creep toward it over many frames.
            expect(countHeightChanges(trace.inputHeights)).toBeLessThanOrEqual(1);
            expect(countHeightChanges(trace.panelHeights)).toBeLessThanOrEqual(1);
            expect(countHeightChanges(trace.scaffoldHeights)).toBeLessThanOrEqual(1);
        } finally {
            await context.close();
        }
    });
});

type AuthStorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

async function openNewSessionFromSessionsSurface(context: BrowserContext, uiBaseUrl: string): Promise<Page> {
    const page = await context.newPage();
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 240_000);
    // The entry button can be replaced while the restored session list hydrates.
    await expect(async () => {
        const startNewSession = await waitForVisibleByTestId(page, startNewSessionTestIds, 10_000);
        await startNewSession.click({ timeout: 5_000 });
    }).toPass({ timeout: 120_000 });
    await page.waitForURL((url) => url.pathname.endsWith('/new'), { timeout: 60_000 });
    await expect(page.getByTestId('new-session-composer-input')).toBeVisible({ timeout: 60_000 });
    return page;
}

type ComposerHeightTrace = Readonly<{
    inputHeights: readonly number[];
    panelHeights: readonly number[];
    scaffoldHeights: readonly number[];
}>;

function countHeightChanges(heights: readonly number[]): number {
    let changes = 0;
    for (let index = 1; index < heights.length; index += 1) {
        if (heights[index] !== heights[index - 1]) changes += 1;
    }
    return changes;
}

async function recordComposerHeightsAcrossPaste(page: Page, text: string): Promise<ComposerHeightTrace> {
    await page.evaluate(() => {
        const input = document.querySelector<HTMLElement>('[data-testid="new-session-composer-input"]');
        const panel = document.querySelector<HTMLElement>('[data-testid="agent-input-drop-zone"]');
        const scaffold = document.querySelector<HTMLElement>('[data-testid="new-session-keyboard-host"]');
        if (!input || !panel || !scaffold) throw new Error('composer elements not found');
        const trace = {
            inputHeights: [] as number[],
            panelHeights: [] as number[],
            scaffoldHeights: [] as number[],
            done: false,
        };
        (window as unknown as { __composerHeightTrace: typeof trace }).__composerHeightTrace = trace;
        const sample = () => {
            trace.inputHeights.push(input.offsetHeight);
            trace.panelHeights.push(panel.offsetHeight);
            trace.scaffoldHeights.push(scaffold.offsetHeight);
            if (trace.inputHeights.length >= 120) {
                trace.done = true;
                return;
            }
            requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
    });
    // insertText dispatches a single input event carrying the whole string, like a paste.
    await page.keyboard.insertText(text);
    await page.waitForFunction(
        () => (window as unknown as { __composerHeightTrace?: { done: boolean } }).__composerHeightTrace?.done === true,
        undefined,
        { timeout: 30_000 },
    );
    return page.evaluate(() => {
        const { inputHeights, panelHeights, scaffoldHeights } = (window as unknown as {
            __composerHeightTrace: ComposerHeightTrace;
        }).__composerHeightTrace;
        return { inputHeights, panelHeights, scaffoldHeights };
    });
}
