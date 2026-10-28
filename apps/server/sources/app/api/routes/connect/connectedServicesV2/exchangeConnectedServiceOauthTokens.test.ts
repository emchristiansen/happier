import { afterEach, describe, expect, it, vi } from "vitest";
import { AGY_OAUTH_CLIENT_ID, AGY_OAUTH_CLIENT_SECRET, AGY_OAUTH_TOKEN_URL, AGY_OAUTH_SCOPES } from "@happier-dev/agents";
import tweetnacl from "tweetnacl";

import { decodeBase64, encodeBase64, openBoxBundle, BOX_BUNDLE_PUBLIC_KEY_BYTES } from "@happier-dev/protocol";

import {
    ConnectedServiceOauthExchangeError,
    ConnectedServiceOauthStateMismatchError,
    ConnectedServiceOauthTimeoutError,
    exchangeConnectedServiceOauthTokens,
} from "./exchangeConnectedServiceOauthTokens";
import { createEnvReset } from "../../../testkit/env";

afterEach(() => { vi.unstubAllEnvs(); });

function buildRecipientPublicKeyB64Url(): string {
    const bytes = new Uint8Array(BOX_BUNDLE_PUBLIC_KEY_BYTES).fill(7);
    return encodeBase64(bytes, "base64url");
}

function buildRecipientKeyPair(): Readonly<{ publicKeyB64Url: string; secretKey: Uint8Array }> {
    const secretKey = new Uint8Array(32).fill(7);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(secretKey).publicKey;
    return { publicKeyB64Url: encodeBase64(publicKey, "base64url"), secretKey };
}

function buildJwt(payload: Record<string, unknown>): string {
    return [
        "hdr",
        Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"),
        "sig",
    ].join(".");
}

describe("exchangeConnectedServiceOauthTokens", () => {
    const resetOauthExchangeEnv = createEnvReset();

    it.each([false, true])("seals Antigravity tokens and selected-token identity using its registered issuer (legacy-looking overrides: %s)", async (withOverrides) => {
        if (withOverrides) {
            vi.stubEnv('HAPPIER_CONNECTED_SERVICES_ANTIGRAVITY_OAUTH_CLIENT_ID', 'machine-client');
            vi.stubEnv('HAPPIER_CONNECTED_SERVICES_ANTIGRAVITY_OAUTH_CLIENT_SECRET', 'machine-client-secret');
            vi.stubEnv('HAPPIER_CONNECTED_SERVICES_ANTIGRAVITY_OAUTH_TOKEN_URL', 'https://machine-issuer.example.test/token');
        }
        const recipient = buildRecipientKeyPair();
        let tokenRequest: Readonly<{ url: string; body: URLSearchParams }> | undefined;
        const fetcher = vi.fn<typeof fetch>(async (input, init) => {
            if (String(input).endsWith('/userinfo')) {
                expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer agy-access');
                return Response.json({ sub: 'google-account-a', email: 'account-a@example.test' });
            }
            const body = new URLSearchParams(String(init?.body));
            tokenRequest = { url: String(input), body };
            expect(body.get('redirect_uri')).toBe('https://antigravity.google/oauth-callback');
            expect(body.get('code_verifier')).toBe('verifier');
            return Response.json({ access_token: 'agy-access', refresh_token: 'agy-refresh', expires_in: 3600, scope: 'scope', token_type: 'Bearer' });
        });
        const result = await exchangeConnectedServiceOauthTokens({
            serviceId: 'antigravity', publicKeyB64Url: recipient.publicKeyB64Url,
            code: 'code', verifier: 'verifier', redirectUri: 'https://antigravity.google/oauth-callback', now: 1000, fetcher,
        });
        expect(tokenRequest?.url).toBe(AGY_OAUTH_TOKEN_URL);
        expect(tokenRequest?.body.get('client_id')).toBe(AGY_OAUTH_CLIENT_ID);
        expect(tokenRequest?.body.get('client_secret')).toBe(AGY_OAUTH_CLIENT_SECRET);
        const opened = openBoxBundle({ bundle: decodeBase64(result.bundleB64Url, 'base64url'), recipientSecretKeyOrSeed: recipient.secretKey });
        expect(opened).toBeTruthy();
        expect(JSON.parse(new TextDecoder().decode(opened!))).toMatchObject({
            serviceId: 'antigravity', accessToken: 'agy-access', refreshToken: 'agy-refresh',
            providerEmail: 'account-a@example.test', providerAccountId: 'google-account-a', expiresAt: 3601000,
        });
    });

    it.each([
        [undefined, AGY_OAUTH_SCOPES.join(' ')],
        ['https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.email'],
    ])('seals effective grants from a known Antigravity authorization exchange (%s)', async (scope, expectedScope) => {
        const recipient = buildRecipientKeyPair();
        const fetcher = vi.fn<typeof fetch>(async (input) => String(input).endsWith('/userinfo')
            ? Response.json({ sub: 'account-a' })
            : Response.json({ access_token: 'access', refresh_token: 'refresh', ...(scope === undefined ? {} : { scope }) }));
        const result = await exchangeConnectedServiceOauthTokens({
            serviceId: 'antigravity', publicKeyB64Url: recipient.publicKeyB64Url,
            code: 'code', verifier: 'verifier', redirectUri: 'https://antigravity.google/oauth-callback', now: 1000, fetcher,
        });
        const opened = openBoxBundle({ bundle: decodeBase64(result.bundleB64Url, 'base64url'), recipientSecretKeyOrSeed: recipient.secretKey });
        expect(JSON.parse(new TextDecoder().decode(opened!)).scope).toBe(expectedScope);
    });

    it("rejects an unregistered Antigravity redirect before contacting Google", async () => {
        const fetcher = vi.fn<typeof fetch>();
        await expect(exchangeConnectedServiceOauthTokens({
            serviceId: 'antigravity', publicKeyB64Url: buildRecipientPublicKeyB64Url(),
            code: 'code', verifier: 'verifier', redirectUri: 'http://localhost:54545/oauth2callback', now: 1000, fetcher,
        })).rejects.toMatchObject({ errorCode: 'connect_oauth_exchange_failed' });
        expect(fetcher).not.toHaveBeenCalled();
    });

    it.each([401, 503])("handles Antigravity userinfo status %i honestly", async (status) => {
        const recipient = buildRecipientKeyPair();
        const fetcher = vi.fn<typeof fetch>(async (input) => String(input).endsWith('/userinfo')
            ? new Response('', { status })
            : Response.json({ access_token: 'agy-access', refresh_token: 'agy-refresh' }));
        const exchange = exchangeConnectedServiceOauthTokens({
            serviceId: 'antigravity', publicKeyB64Url: recipient.publicKeyB64Url,
            code: 'code', verifier: 'verifier', redirectUri: 'https://antigravity.google/oauth-callback', now: 1000, fetcher,
        });
        if (status === 401) {
            await expect(exchange).rejects.toMatchObject({ errorCode: 'connect_oauth_exchange_failed' });
        } else {
            const result = await exchange;
            const opened = openBoxBundle({ bundle: decodeBase64(result.bundleB64Url, 'base64url'), recipientSecretKeyOrSeed: recipient.secretKey });
            expect(JSON.parse(new TextDecoder().decode(opened!))).toMatchObject({ providerEmail: null, providerAccountId: null });
        }
    });

    it.each([
        [{ error: 'invalid_grant' }, 400, 'connect_oauth_invalid_grant'],
        [{ error: 'invalid_client' }, 401, 'connect_oauth_invalid_client'],
        [{ access_token: 'agy-access' }, 200, 'connect_oauth_missing_refresh_token'],
    ] as const)("preserves Antigravity OAuth error classification for %j", async (body, status, errorCode) => {
        await expect(exchangeConnectedServiceOauthTokens({
            serviceId: 'antigravity', publicKeyB64Url: buildRecipientPublicKeyB64Url(),
            code: 'code', verifier: 'verifier', redirectUri: 'https://antigravity.google/oauth-callback', now: 1000,
            fetcher: async () => Response.json(body, { status }),
        })).rejects.toMatchObject({ errorCode });
    });

    it("rejects openai api-key service oauth exchange", async () => {
        await expect(exchangeConnectedServiceOauthTokens({
            serviceId: "openai",
            publicKeyB64Url: buildRecipientPublicKeyB64Url(),
            code: "c",
            verifier: "v",
            redirectUri: "http://localhost:54545/oauth2callback",
            now: 1700000000000,
            fetcher: vi.fn() as any,
            state: "s",
        })).rejects.toThrow(/openai api key/i);
    });

    it("rejects anthropic oauth exchange", async () => {
        await expect(exchangeConnectedServiceOauthTokens({
            serviceId: "anthropic",
            publicKeyB64Url: buildRecipientPublicKeyB64Url(),
            code: "c",
            verifier: "v",
            redirectUri: "http://localhost:54545/oauth2callback",
            now: 1700000000000,
            fetcher: vi.fn() as any,
            state: "s",
        })).rejects.toThrow(/anthropic/i);
    });

    it("extracts OpenAI Codex account email from id_token claims during exchange", async () => {
        const recipient = buildRecipientKeyPair();
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                access_token: "at",
                refresh_token: "rt",
                id_token: buildJwt({
                    chatgpt_account_id: "acct-from-token",
                    email: "codex-user@example.test",
                }),
                expires_in: 3600,
            }),
            text: async () => "",
        }));

        const res = await exchangeConnectedServiceOauthTokens({
            serviceId: "openai-codex",
            publicKeyB64Url: recipient.publicKeyB64Url,
            code: "c",
            verifier: "v",
            redirectUri: "http://localhost:54545/oauth2callback",
            now: 1700000000000,
            fetcher: fetchMock as any,
            state: "s",
        });

        const opened = openBoxBundle({
            bundle: decodeBase64(res.bundleB64Url, "base64url"),
            recipientSecretKeyOrSeed: recipient.secretKey,
        });
        expect(opened).toBeTruthy();
        const payload = JSON.parse(new TextDecoder().decode(opened!));
        expect(payload.providerAccountId).toBe("acct-from-token");
        expect(payload.providerEmail).toBe("codex-user@example.test");
    });

    it("exchanges claude-subscription tokens", async () => {
        const recipient = buildRecipientKeyPair();
        const fetchMock = vi.fn(async (url: any, init: any) => {
            if (String(url).endsWith('/api/oauth/profile')) {
                expect(init?.headers?.Authorization).toBe('Bearer at');
                return new Response(JSON.stringify({
                    account: { has_claude_max: true },
                    organization: {
                        organization_type: 'claude_max',
                        rate_limit_tier: 'default_claude_max_20x',
                    },
                }), { status: 200, headers: { "Content-Type": "application/json" } });
            }
            expect(String(url)).toBe("https://platform.claude.com/v1/oauth/token");
            const body = JSON.parse(String(init?.body ?? "{}"));
            expect(body.grant_type).toBe("authorization_code");
            expect(body.code).toBe("c");
            expect(body.client_id).toBeTruthy();
            expect(body.code_verifier).toBe("v");
            expect(body.state).toBe("s");
            return new Response(JSON.stringify({
                access_token: "at",
                refresh_token: "rt",
                expires_in: 3600,
                token_type: "Bearer",
                scope: "user:inference",
                account: { uuid: "acct", email_address: "user@example.com" },
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        });

        const res = await exchangeConnectedServiceOauthTokens({
            serviceId: "claude-subscription",
            publicKeyB64Url: recipient.publicKeyB64Url,
            code: "c",
            verifier: "v",
            redirectUri: "http://localhost:54545/oauth2callback",
            now: 1700000000000,
            fetcher: fetchMock as any,
            state: "s",
        });

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(typeof res.bundleB64Url).toBe("string");
        expect(res.bundleB64Url.length).toBeGreaterThan(0);
        const opened = openBoxBundle({
            bundle: decodeBase64(res.bundleB64Url, "base64url"),
            recipientSecretKeyOrSeed: recipient.secretKey,
        });
        expect(opened).toBeTruthy();
        const payload = JSON.parse(new TextDecoder().decode(opened!));
        expect(payload.raw).toEqual({
            claudeAiOauth: {
                subscriptionType: 'max',
                rateLimitTier: 'default_claude_max_20x',
            },
        });
    });

    it("rejects a Claude exchange when the provider profile endpoint rejects the issued access token", async () => {
        const recipient = buildRecipientKeyPair();
        const fetchMock = vi.fn(async (url: any) => {
            if (String(url).endsWith("/api/oauth/profile")) {
                return new Response("", { status: 401, statusText: "Unauthorized" });
            }
            return new Response(JSON.stringify({
                access_token: "provider-rejected-access",
                refresh_token: "refresh",
                expires_in: 3600,
                token_type: "Bearer",
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        });

        await expect(exchangeConnectedServiceOauthTokens({
            serviceId: "claude-subscription",
            publicKeyB64Url: recipient.publicKeyB64Url,
            code: "c",
            verifier: "v",
            redirectUri: "https://platform.claude.com/oauth/code/callback",
            now: 1700000000000,
            fetcher: fetchMock as any,
            state: "s",
        })).rejects.toThrow(/access-token verification failed \(401\)/);
    });

    it("keeps Claude exchange usable when optional profile evidence is temporarily unavailable", async () => {
        const recipient = buildRecipientKeyPair();
        const fetchMock = vi.fn(async (url: any) => {
            if (String(url).endsWith("/api/oauth/profile")) {
                return new Response("", { status: 503, statusText: "Service Unavailable" });
            }
            return new Response(JSON.stringify({
                access_token: "accepted-access",
                refresh_token: "refresh",
                expires_in: 3600,
                token_type: "Bearer",
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        });

        await expect(exchangeConnectedServiceOauthTokens({
            serviceId: "claude-subscription",
            publicKeyB64Url: recipient.publicKeyB64Url,
            code: "c",
            verifier: "v",
            redirectUri: "https://platform.claude.com/oauth/code/callback",
            now: 1700000000000,
            fetcher: fetchMock as any,
            state: "s",
        })).resolves.toEqual({ bundleB64Url: expect.any(String) });
    });

    it("rejects claude-subscription exchange when state is missing", async () => {
        await expect(exchangeConnectedServiceOauthTokens({
            serviceId: "claude-subscription",
            publicKeyB64Url: buildRecipientPublicKeyB64Url(),
            code: "c",
            verifier: "v",
            redirectUri: "http://localhost:54545/oauth2callback",
            now: 1700000000000,
            fetcher: vi.fn() as any,
            state: "",
        })).rejects.toBeInstanceOf(ConnectedServiceOauthStateMismatchError);
    });

    it("exchanges gemini tokens and sends client_secret", async () => {
        const fetchMock = vi.fn(async (_url: any, init: any) => {
            const body = String(init?.body?.toString?.() ?? init?.body ?? "");
            expect(body).toContain("client_secret=");
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    access_token: "at",
                    refresh_token: "rt",
                    id_token: "id",
                    expires_in: 3600,
                    scope: "s",
                    token_type: "Bearer",
                }),
                text: async () => "",
            } as any;
        });

        const res = await exchangeConnectedServiceOauthTokens({
            serviceId: "gemini",
            publicKeyB64Url: buildRecipientPublicKeyB64Url(),
            code: "c",
            verifier: "v",
            redirectUri: "http://localhost:54545/oauth2callback",
            now: 1700000000000,
            fetcher: fetchMock as any,
        });

        expect(typeof res.bundleB64Url).toBe("string");
        expect(res.bundleB64Url.length).toBeGreaterThan(0);
    });

    it("returns a dedicated error when Gemini does not return a refresh token", async () => {
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                access_token: "at",
                // refresh_token intentionally omitted
                expires_in: 3600,
                scope: "s",
                token_type: "Bearer",
            }),
            text: async () => "",
        }));

        await expect(exchangeConnectedServiceOauthTokens({
            serviceId: "gemini",
            publicKeyB64Url: buildRecipientPublicKeyB64Url(),
            code: "c",
            verifier: "v",
            redirectUri: "http://localhost:54545/oauth2callback",
            now: 1700000000000,
            fetcher: fetchMock as any,
        })).rejects.toMatchObject({
            errorCode: "connect_oauth_missing_refresh_token",
        } satisfies Partial<ConnectedServiceOauthExchangeError>);
    });

    it("returns a dedicated error when Gemini OAuth code is invalid", async () => {
        const fetchMock = vi.fn(async () => ({
            ok: false,
            status: 400,
            json: async () => ({ error: "invalid_grant", error_description: "Bad Request" }),
            text: async () => "invalid_grant",
        }));

        await expect(exchangeConnectedServiceOauthTokens({
            serviceId: "gemini",
            publicKeyB64Url: buildRecipientPublicKeyB64Url(),
            code: "c",
            verifier: "v",
            redirectUri: "http://localhost:54545/oauth2callback",
            now: 1700000000000,
            fetcher: fetchMock as any,
        })).rejects.toMatchObject({
            errorCode: "connect_oauth_invalid_grant",
        } satisfies Partial<ConnectedServiceOauthExchangeError>);
    });

    it("returns a dedicated error when Gemini OAuth client is rejected", async () => {
        const fetchMock = vi.fn(async () => ({
            ok: false,
            status: 401,
            json: async () => ({ error: "invalid_client", error_description: "Unauthorized" }),
            text: async () => "invalid_client",
        }));

        await expect(exchangeConnectedServiceOauthTokens({
            serviceId: "gemini",
            publicKeyB64Url: buildRecipientPublicKeyB64Url(),
            code: "c",
            verifier: "v",
            redirectUri: "http://localhost:54545/oauth2callback",
            now: 1700000000000,
            fetcher: fetchMock as any,
        })).rejects.toMatchObject({
            errorCode: "connect_oauth_invalid_client",
        } satisfies Partial<ConnectedServiceOauthExchangeError>);
    });

    it("passes an AbortSignal to token exchange fetch requests", async () => {
        resetOauthExchangeEnv({ HAPPIER_CONNECTED_SERVICES_OAUTH_EXCHANGE_TIMEOUT_MS: "5000" });
        const fetchMock = vi.fn(async (_url: any, init: any) => ({
            ok: true,
            status: 200,
            json: async () => ({
                access_token: "at",
                refresh_token: "rt",
                id_token: "id",
                expires_in: 3600,
                scope: "s",
                token_type: "Bearer",
            }),
            text: async () => "",
        }));

        await exchangeConnectedServiceOauthTokens({
            serviceId: "gemini",
            publicKeyB64Url: buildRecipientPublicKeyB64Url(),
            code: "c",
            verifier: "v",
            redirectUri: "http://localhost:54545/oauth2callback",
            now: 1700000000000,
            fetcher: fetchMock as any,
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const init = fetchMock.mock.calls[0]?.[1] as any;
        expect(init?.signal).toBeTruthy();
        expect(typeof init.signal.aborted).toBe("boolean");
    });

    it("aborts token exchange when the timeout elapses", async () => {
        resetOauthExchangeEnv({ HAPPIER_CONNECTED_SERVICES_OAUTH_EXCHANGE_TIMEOUT_MS: "1000" });
        vi.useFakeTimers();
        try {
            const fetchMock = vi.fn(async (_url: any, init: any) => {
                return await new Promise((_resolve, reject) => {
                    init?.signal?.addEventListener?.("abort", () => {
                        const err = new Error("AbortError");
                        (err as any).name = "AbortError";
                        reject(err);
                    });
                });
            });

            const promise = exchangeConnectedServiceOauthTokens({
                serviceId: "gemini",
                publicKeyB64Url: buildRecipientPublicKeyB64Url(),
                code: "c",
                verifier: "v",
                redirectUri: "http://localhost:54545/oauth2callback",
                now: 1700000000000,
                fetcher: fetchMock as any,
            });

            const expectation = expect(promise).rejects.toBeInstanceOf(ConnectedServiceOauthTimeoutError);
            await vi.advanceTimersByTimeAsync(1500);
            await expectation;
        } finally {
            vi.useRealTimers();
            resetOauthExchangeEnv();
        }
    });
});
