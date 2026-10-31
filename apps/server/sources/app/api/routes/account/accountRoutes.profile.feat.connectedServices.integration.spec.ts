import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { accountRoutes } from "./accountRoutes";
import {
    DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
    stringifyConnectedServiceAuthGroupPolicy,
} from "../connect/connectedServicesV3/authGroupPolicy";
import { resolveConnectedServiceCredentialRevision } from "../connect/credentials/credentialRevision";
import { AccountProfileSchema as ReleasedAccountProfileSchema } from "@happier-dev/protocol/testing/releasedV0215AccountProfile";

describe("Account profile (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-account-profile-", initAuth: false });
        await auth.init();
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.resetEnv();
        vi.unstubAllGlobals();
        await harness.resetDbTables([
            () => db.accountIdentity.deleteMany(),
            () => db.repeatKey.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("projects profiles, pools and credential revisions together for the declared HTTP reader", async () => {
        const account = await db.account.create({ data: { publicKey: "pk-profile-reader-support" }, select: { id: true } });
        await db.serviceAccountToken.create({
            data: {
                accountId: account.id, vendor: "antigravity", profileId: "work", token: Buffer.from("sealed"),
                metadata: { v: 2, format: "account_scoped_v1", kind: "oauth" },
            },
        });
        await db.connectedServiceAuthGroup.create({
            data: { accountId: account.id, vendor: "antigravity", groupId: "pool", generation: 1,
                policyJson: stringifyConnectedServiceAuthGroupPolicy(DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1) },
        });
        await db.serviceAccountToken.create({
            data: {
                accountId: account.id, vendor: "github", profileId: "personal", token: Buffer.from("sealed"),
                metadata: { v: 2, format: "account_scoped_v1", kind: "oauth" },
            },
        });
        await withAuthenticatedTestApp((app) => accountRoutes(app), async (app) => {
            for (const declaration of [undefined, "malformed", JSON.stringify(["antigravity"])]) {
                const supportsAntigravity = declaration === JSON.stringify(["antigravity"]);
                const supported = supportsAntigravity ? ["antigravity", "github"] : ["github"];
                const response = await app.inject({
                    method: "GET",
                    url: declaration === undefined ? "/v1/account/profile" : `/v1/account/profile?happierConnectedServices=${encodeURIComponent(declaration)}`,
                    headers: { "x-test-user-id": account.id },
                });
                expect(response.statusCode).toBe(200);
                const body = response.json();
                expect(body.connectedServicesV2.map((entry: { serviceId: string }) => entry.serviceId)).toEqual(supported);
                expect(body.connectedServiceCredentialRevisionsV1.map((entry: { serviceId: string }) => entry.serviceId)).toEqual(supported);
                if (supportsAntigravity) expect(body.connectedServicesV2[0].groups).toMatchObject([{ groupId: "pool" }]);
                else expect(ReleasedAccountProfileSchema.safeParse(body).success).toBe(true);
            }
            expect(await db.serviceAccountToken.count({ where: { accountId: account.id } })).toBe(2);
        });
    });

    it("GET /v1/account/profile returns linkedProviders derived from AccountIdentity", async () => {
        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const account = await db.account.create({
                    data: { publicKey: "pk-profile-gh" },
                    select: { id: true },
                });

                const githubProfile = { id: 123, login: "octocat", avatar_url: "x", name: "Octo Cat" };
                await db.accountIdentity.create({
                    data: {
                        accountId: account.id,
                        provider: "github",
                        providerUserId: "123",
                        providerLogin: "octocat",
                        profile: githubProfile as any,
                    },
                });

                const res = await app.inject({
                    method: "GET",
                    url: "/v1/account/profile",
                    headers: { "x-test-user-id": account.id },
                });

                expect(res.statusCode).toBe(200);
                const body = res.json() as any;
                expect(body.github).toBeUndefined();
                expect(body.linkedProviders).toEqual([
                    {
                        id: "github",
                        login: "octocat",
                        displayName: "Octo Cat",
                        avatarUrl: "x",
                        profileUrl: "https://github.com/octocat",
                        showOnProfile: true,
                    },
                ]);
            },
        );
    });

    it("GET /v1/account/profile includes connectedServicesV2 with per-profile status", async () => {
        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const account = await db.account.create({
                    data: { publicKey: "pk-profile-csv2" },
                    select: { id: true },
                });

                // Legacy token (v1) stored under the same service id but without v2 metadata.
                await db.serviceAccountToken.create({
                    data: {
                        accountId: account.id,
                        vendor: "anthropic",
                        profileId: "default",
                        token: Buffer.from("legacy", "utf8"),
                        metadata: null,
                    },
                });

                // Sealed v2 record (ciphertext bytes + v2 metadata only; server never decrypts).
                await db.serviceAccountToken.create({
                    data: {
                        accountId: account.id,
                        vendor: "openai-codex",
                        profileId: "work",
                        token: Buffer.from("c2VhbGVk", "utf8"),
                        metadata: {
                            v: 2,
                            format: "account_scoped_v1",
                            kind: "oauth",
                            providerEmail: "user@example.com",
                            credentialRevision: "csr_1123456789ABCDEFGHJKMNPQRS",
                        } as any,
                        expiresAt: new Date(Date.now() + 3600_000),
                    },
                });
                const group = await db.connectedServiceAuthGroup.create({
                    data: {
                        accountId: account.id,
                        vendor: "openai-codex",
                        groupId: "codex-main",
                        displayName: "Codex Main",
                        activeProfileId: "work",
                        generation: 3,
                        policyJson: stringifyConnectedServiceAuthGroupPolicy(DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1),
                    },
                });
                await db.connectedServiceAuthGroupMember.create({
                    data: {
                        groupDbId: group.id,
                        accountId: account.id,
                        vendor: "openai-codex",
                        groupId: "codex-main",
                        profileId: "work",
                        priority: 10,
                    },
                });
                const legacyUnfencedBackup = await db.serviceAccountToken.create({
                    data: {
                        accountId: account.id,
                        vendor: "openai-codex",
                        profileId: "disabled-backup",
                        token: Buffer.from("c2VhbGVkLWJhY2t1cA==", "utf8"),
                        metadata: { v: 2, format: "account_scoped_v1", kind: "oauth", providerEmail: "backup@example.com" } as any,
                    },
                });
                await db.connectedServiceAuthGroupMember.create({
                    data: {
                        groupDbId: group.id,
                        accountId: account.id,
                        vendor: "openai-codex",
                        groupId: "codex-main",
                        profileId: "disabled-backup",
                        priority: 20,
                        enabled: false,
                    },
                });

                // Plain/v3 credential rows are also account-level connected services.
                await db.serviceAccountToken.create({
                    data: {
                        accountId: account.id,
                        vendor: "github",
                        profileId: "personal",
                        token: Buffer.from("{}", "utf8"),
                        metadata: {
                            v: 3,
                            storage: "plain_json_v1",
                            kind: "oauth",
                            providerEmail: "plain@example.com",
                            providerAccountId: "github-plain-account",
                            health: {
                                v: 1,
                                status: "needs_reauth",
                                reconnectRequired: true,
                                lastRefreshFailureKind: "provider_401",
                                lastRuntimeAuthFailureAt: 1234,
                            },
                        } as any,
                    },
                });

                // Legacy token (v1) stored under the same service id but without v2 metadata.
                await db.serviceAccountToken.create({
                    data: {
                        accountId: account.id,
                        vendor: "openai",
                        profileId: "default",
                        token: Buffer.from("legacy-openai", "utf8"),
                        metadata: null,
                    },
                });

                const res = await app.inject({
                    method: "GET",
                    url: "/v1/account/profile",
                    headers: { "x-test-user-id": account.id },
                });

                expect(res.statusCode).toBe(200);
                const body = res.json() as any;
                expect(Array.isArray(body.connectedServicesV2)).toBe(true);
                expect(body.connectedServiceCredentialRevisionsV1).toEqual(expect.arrayContaining([{
                    serviceId: "openai-codex",
                    profileId: "work",
                    credentialRevision: "csr_1123456789ABCDEFGHJKMNPQRS",
                }, {
                    serviceId: "openai-codex",
                    profileId: "disabled-backup",
                    credentialRevision: resolveConnectedServiceCredentialRevision({
                        rowId: legacyUnfencedBackup.id,
                        metadata: legacyUnfencedBackup.metadata,
                    }),
                }]));
                expect(body.connectedServicesV2).toEqual(expect.arrayContaining([
                    expect.objectContaining({
                        serviceId: "openai-codex",
                        profiles: expect.arrayContaining([
                            expect.objectContaining({
                                profileId: "work",
                                status: "connected",
                                providerEmail: "user@example.com",
                            }),
                        ]),
                        groups: [
                            {
                                groupId: "codex-main",
                                displayName: "Codex Main",
                                activeProfileId: "work",
                                generation: 3,
                                memberProfileIds: ["work"],
                            },
                        ],
                    }),
                    expect.objectContaining({
                        serviceId: "github",
                        profiles: [
                            expect.objectContaining({
                                profileId: "personal",
                                status: "needs_reauth",
                                kind: "oauth",
                                providerEmail: "plain@example.com",
                                providerAccountId: "github-plain-account",
                                health: expect.objectContaining({
                                    reconnectRequired: true,
                                    lastRefreshFailureKind: "provider_401",
                                }),
                            }),
                        ],
                    }),
                    expect.objectContaining({
                        serviceId: "openai",
                        profiles: [
                            expect.objectContaining({
                                profileId: "default",
                                status: "needs_reauth",
                            }),
                        ],
                    }),
                    expect.objectContaining({
                        serviceId: "anthropic",
                        profiles: [
                            expect.objectContaining({
                                profileId: "default",
                                status: "needs_reauth",
                            }),
                        ],
                    }),
                ]));
            },
        );
    });

    it("GET /v1/account/profile clears impossible auth-group activeProfileId values from the synced projection", async () => {
        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const account = await db.account.create({
                    data: { publicKey: "pk-profile-disabled-active" },
                    select: { id: true },
                });

                await db.serviceAccountToken.create({
                    data: {
                        accountId: account.id,
                        vendor: "openai-codex",
                        profileId: "work",
                        token: Buffer.from("work", "utf8"),
                        metadata: { v: 2, format: "account_scoped_v1", kind: "oauth" } as any,
                    },
                });
                await db.serviceAccountToken.create({
                    data: {
                        accountId: account.id,
                        vendor: "openai-codex",
                        profileId: "disabled-backup",
                        token: Buffer.from("backup", "utf8"),
                        metadata: { v: 2, format: "account_scoped_v1", kind: "oauth" } as any,
                    },
                });

                const group = await db.connectedServiceAuthGroup.create({
                    data: {
                        accountId: account.id,
                        vendor: "openai-codex",
                        groupId: "codex-main",
                        activeProfileId: "disabled-backup",
                        generation: 4,
                        policyJson: stringifyConnectedServiceAuthGroupPolicy(DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1),
                    },
                });
                await db.connectedServiceAuthGroupMember.create({
                    data: {
                        groupDbId: group.id,
                        accountId: account.id,
                        vendor: "openai-codex",
                        groupId: "codex-main",
                        profileId: "work",
                        priority: 10,
                    },
                });
                await db.connectedServiceAuthGroupMember.create({
                    data: {
                        groupDbId: group.id,
                        accountId: account.id,
                        vendor: "openai-codex",
                        groupId: "codex-main",
                        profileId: "disabled-backup",
                        priority: 20,
                        enabled: false,
                    },
                });

                const res = await app.inject({
                    method: "GET",
                    url: "/v1/account/profile",
                    headers: { "x-test-user-id": account.id },
                });

                expect(res.statusCode).toBe(200);
                const body = res.json() as any;
                expect(body.connectedServicesV2).toEqual(expect.arrayContaining([
                    expect.objectContaining({
                        serviceId: "openai-codex",
                        groups: [
                            {
                                groupId: "codex-main",
                                displayName: null,
                                activeProfileId: null,
                                generation: 4,
                                memberProfileIds: ["work"],
                            },
                        ],
                    }),
                ]));
            },
        );
    });

    it("GET /v1/account/profile returns empty connectedServices + connectedServicesV2 when connected services feature is disabled", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: "0" });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const account = await db.account.create({
                    data: { publicKey: "pk-profile-csv2-disabled" },
                    select: { id: true },
                });

                await db.serviceAccountToken.create({
                    data: {
                        accountId: account.id,
                        vendor: "openai",
                        profileId: "default",
                        token: Buffer.from("legacy-openai", "utf8"),
                        metadata: null,
                    },
                });

                await db.serviceAccountToken.create({
                    data: {
                        accountId: account.id,
                        vendor: "openai-codex",
                        profileId: "work",
                        token: Buffer.from("c2VhbGVk", "utf8"),
                        metadata: { v: 2, format: "account_scoped_v1", kind: "oauth" } as any,
                    },
                });

                const res = await app.inject({
                    method: "GET",
                    url: "/v1/account/profile",
                    headers: { "x-test-user-id": account.id },
                });

                expect(res.statusCode).toBe(200);
                const body = res.json() as any;
                expect(body.connectedServices).toEqual([]);
                expect(body.connectedServicesV2).toEqual([]);
            },
        );
    });
});
