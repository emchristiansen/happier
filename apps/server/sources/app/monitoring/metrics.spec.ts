import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPrismaMetrics = vi.fn();
const mockQueryRaw = vi.fn();
const mockRegisterMetrics = vi.fn();
const mockDbReadinessChecksInc = vi.fn();
const mockDbReadinessDurationObserve = vi.fn();
const mockLog = vi.fn();

vi.mock("@/storage/db", () => ({
    db: {
        $metrics: { prometheus: mockPrismaMetrics },
        $queryRaw: mockQueryRaw,
    },
}));

vi.mock("@/app/monitoring/metrics2", () => ({
    register: { metrics: mockRegisterMetrics },
    dbReadinessChecksCounter: { inc: mockDbReadinessChecksInc },
    dbReadinessDurationHistogram: { observe: mockDbReadinessDurationObserve },
}));

vi.mock("@/utils/logging/log", () => ({
    log: mockLog,
}));

async function listenOnce(port: number): Promise<void> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ port, host: "0.0.0.0" }, () => resolve());
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function reserveFreePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ port: 0, host: "0.0.0.0" }, () => resolve());
    });
    const address = server.address();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (address === null || typeof address === "string") {
        throw new Error("Expected a TCP address for the probe server");
    }
    return address.port;
}

describe("metrics server", () => {
    const originalMetricsEnabled = process.env.METRICS_ENABLED;
    const originalMetricsPort = process.env.METRICS_PORT;

    afterEach(() => {
        if (originalMetricsEnabled === undefined) {
            delete process.env.METRICS_ENABLED;
        } else {
            process.env.METRICS_ENABLED = originalMetricsEnabled;
        }
        if (originalMetricsPort === undefined) {
            delete process.env.METRICS_PORT;
        } else {
            process.env.METRICS_PORT = originalMetricsPort;
        }
    });

    beforeEach(() => {
        vi.resetModules();
        mockPrismaMetrics.mockReset();
        mockQueryRaw.mockReset();
        mockRegisterMetrics.mockReset();
        mockDbReadinessChecksInc.mockReset();
        mockDbReadinessDurationObserve.mockReset();
        mockLog.mockReset();
    });

    it("exposes database readiness on /ready for worker probes", async () => {
        mockQueryRaw.mockResolvedValueOnce([{ one: 1 }]);

        const { createMetricsServer } = await import("./metrics");
        const app = await createMetricsServer();

        try {
            await app.ready();

            const res = await app.inject({ method: "GET", url: "/ready" });

            expect(res.statusCode).toBe(200);
            expect(mockQueryRaw).toHaveBeenCalled();
            expect(mockDbReadinessChecksInc).toHaveBeenCalledWith({ result: "ok", reason: "none" });
        } finally {
            await app.close().catch(() => {});
        }
    });

    it("returns shutting-down liveness from /health during shutdown", async () => {
        const { createMetricsServer } = await import("./metrics");
        const { initiateShutdown } = await import("@/utils/process/shutdown");
        const app = await createMetricsServer();

        try {
            await app.ready();
            await initiateShutdown("test");

            const res = await app.inject({ method: "GET", url: "/health" });

            expect(res.statusCode).toBe(503);
            expect(res.json()).toMatchObject({
                status: "error",
                service: "happier-server",
                reason: "shutting_down",
            });
            expect(mockQueryRaw).not.toHaveBeenCalled();
        } finally {
            await app.close().catch(() => {});
        }
    });

    it("returns shutting-down readiness from /ready during shutdown without querying the database", async () => {
        mockQueryRaw.mockResolvedValueOnce([{ one: 1 }]);

        const { createMetricsServer } = await import("./metrics");
        const { initiateShutdown } = await import("@/utils/process/shutdown");
        const app = await createMetricsServer();

        try {
            await app.ready();
            await initiateShutdown("test");

            const res = await app.inject({ method: "GET", url: "/ready" });

            expect(res.statusCode).toBe(503);
            expect(res.json()).toMatchObject({
                status: "error",
                service: "happier-server",
                reason: "shutting_down",
            });
            expect(mockQueryRaw).not.toHaveBeenCalled();
            expect(mockDbReadinessChecksInc).not.toHaveBeenCalled();
        } finally {
            await app.close().catch(() => {});
        }
    });

    it("releases the metrics port when shutdown is initiated", async () => {
        const port = await reserveFreePort();
        process.env.METRICS_ENABLED = "true";
        process.env.METRICS_PORT = String(port);

        const fastifyModule = await import("fastify");
        const fastifyFactory = vi.spyOn(fastifyModule, "default");

        try {
            const { startMetricsServer } = await import("./metrics");
            const { initiateShutdown } = await import("@/utils/process/shutdown");

            await expect(startMetricsServer()).resolves.toBe(true);
            await expect(listenOnce(port)).rejects.toMatchObject({ code: "EADDRINUSE" });

            await initiateShutdown("test");

            await expect(listenOnce(port)).resolves.toBeUndefined();
        } finally {
            try {
                for (const result of fastifyFactory.mock.results) {
                    if (result.type === "return") {
                        await result.value.close();
                    }
                }
            } finally {
                fastifyFactory.mockRestore();
            }
        }
    });
});
