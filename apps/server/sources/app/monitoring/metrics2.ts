import { register, Counter, Gauge, Histogram, type Metric } from 'prom-client';
import { db } from '@/storage/db';
import { forever } from '@/utils/runtime/forever';
import { delay } from '@/utils/runtime/delay';
import { shutdownSignal } from '@/utils/process/shutdown';

function getOrCreateMetric<TMetric extends Metric>(name: string, createMetric: () => TMetric): TMetric {
    return (register.getSingleMetric(name) as TMetric | undefined) ?? createMetric();
}

// Application metrics
export const websocketConnectionsGauge = getOrCreateMetric('websocket_connections_total', () => new Gauge({
    name: 'websocket_connections_total',
    help: 'Number of active WebSocket connections',
    labelNames: ['type'] as const,
    registers: [register]
}));

export const sessionAliveEventsCounter = getOrCreateMetric('session_alive_events_total', () => new Counter({
    name: 'session_alive_events_total',
    help: 'Total number of session-alive events',
    registers: [register]
}));

export const machineAliveEventsCounter = getOrCreateMetric('machine_alive_events_total', () => new Counter({
    name: 'machine_alive_events_total',
    help: 'Total number of machine-alive events',
    registers: [register]
}));

export const sessionCacheCounter = getOrCreateMetric('session_cache_operations_total', () => new Counter({
    name: 'session_cache_operations_total',
    help: 'Total session cache operations',
    labelNames: ['operation', 'result'] as const,
    registers: [register]
}));

export const databaseUpdatesSkippedCounter = getOrCreateMetric('database_updates_skipped_total', () => new Counter({
    name: 'database_updates_skipped_total',
    help: 'Number of database updates skipped due to debouncing',
    labelNames: ['type'] as const,
    registers: [register]
}));

export const websocketEventsCounter = getOrCreateMetric('websocket_events_total', () => new Counter({
    name: 'websocket_events_total',
    help: 'Total WebSocket events received by type',
    labelNames: ['event_type'] as const,
    registers: [register]
}));

export const socketEmissionsCounter = getOrCreateMetric('socket_emissions_total', () => new Counter({
    name: 'socket_emissions_total',
    help: 'Total Socket.IO emissions by event, recipient filter, and payload type',
    labelNames: ['event_name', 'recipient_filter', 'payload_type'] as const,
    registers: [register]
}));

export const socketEmissionPayloadBytesHistogram = getOrCreateMetric('socket_emission_payload_bytes', () => new Histogram({
    name: 'socket_emission_payload_bytes',
    help: 'Serialized Socket.IO emission payload size in bytes',
    labelNames: ['event_name', 'recipient_filter', 'payload_type'] as const,
    buckets: [100, 500, 1000, 5000, 10000, 50000, 100000, 500000, 1000000, 5000000],
    registers: [register]
}));

export const socketMessageAckCounter = getOrCreateMetric('socket_message_ack_total', () => new Counter({
    name: 'socket_message_ack_total',
    help: 'Total socket message acknowledgements by result',
    labelNames: ['result', 'error'] as const,
    registers: [register]
}));

export const changesRequestsCounter = getOrCreateMetric('changes_requests_total', () => new Counter({
    name: 'changes_requests_total',
    help: 'Total /v2/changes requests by result',
    labelNames: ['result'] as const,
    registers: [register]
}));

export const changesReturnedChangesCounter = getOrCreateMetric('changes_returned_changes_total', () => new Counter({
    name: 'changes_returned_changes_total',
    help: 'Total number of changes entries returned by /v2/changes',
    registers: [register]
}));

export const catchupFollowupFetchesCounter = getOrCreateMetric('catchup_followup_fetches_total', () => new Counter({
    name: 'catchup_followup_fetches_total',
    help: 'Total catch-up follow-up fetches by type',
    labelNames: ['type'] as const,
    registers: [register]
}));

export const catchupFollowupReturnedCounter = getOrCreateMetric('catchup_followup_returned_total', () => new Counter({
    name: 'catchup_followup_returned_total',
    help: 'Total number of entities returned by catch-up follow-up fetches by type',
    labelNames: ['type'] as const,
    registers: [register]
}));

export const sessionMessageRoleMismatchCounter = getOrCreateMetric('session_message_role_mismatch_total', () => new Counter({
    name: 'session_message_role_mismatch_total',
    help: 'Total session message role mismatches between supplied metadata and derived plaintext content',
    labelNames: ['supplied_role', 'derived_role', 'final_role', 'content_kind', 'storage_mode', 'source'] as const,
    registers: [register]
}));

export const usageReportWritesCounter = getOrCreateMetric('usage_report_writes_total', () => new Counter({
    name: 'usage_report_writes_total',
    help: 'Total usage report write attempts by scope and result',
    labelNames: ['scope', 'result'] as const,
    registers: [register]
}));

export const dbReadinessChecksCounter = getOrCreateMetric('db_readiness_checks_total', () => new Counter({
    name: 'db_readiness_checks_total',
    help: 'Total database readiness checks by result and reason',
    labelNames: ['result', 'reason'] as const,
    registers: [register]
}));

export const dbReadinessDurationHistogram = getOrCreateMetric('db_readiness_duration_seconds', () => new Histogram({
    name: 'db_readiness_duration_seconds',
    help: 'Database readiness check duration in seconds by result and reason',
    labelNames: ['result', 'reason'] as const,
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10],
    registers: [register]
}));

export const sqliteMaintenanceDurationHistogram = getOrCreateMetric('sqlite_maintenance_duration_seconds', () => new Histogram({
    name: 'sqlite_maintenance_duration_seconds',
    help: 'SQLite maintenance duration by operation and outcome',
    labelNames: ['operation', 'outcome'] as const,
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30],
    registers: [register]
}));

export const httpRequestsCounter = getOrCreateMetric('http_requests_total', () => new Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [register]
}));

export const httpRequestDurationHistogram = getOrCreateMetric('http_request_duration_seconds', () => new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10],
    registers: [register]
}));

// Database count metrics
export const databaseRecordCountGauge = getOrCreateMetric('database_records_total', () => new Gauge({
    name: 'database_records_total',
    help: 'Total number of records in database tables',
    labelNames: ['table'] as const,
    registers: [register]
}));

// WebSocket connection tracking
const connectionCounts = {
    'user-scoped': 0,
    'session-scoped': 0,
    'machine-scoped': 0
};

export function incrementWebSocketConnection(type: 'user-scoped' | 'session-scoped' | 'machine-scoped'): void {
    connectionCounts[type]++;
    websocketConnectionsGauge.set({ type }, connectionCounts[type]);
}

export function decrementWebSocketConnection(type: 'user-scoped' | 'session-scoped' | 'machine-scoped'): void {
    connectionCounts[type] = Math.max(0, connectionCounts[type] - 1);
    websocketConnectionsGauge.set({ type }, connectionCounts[type]);
}

// Database metrics updater
export async function updateDatabaseMetrics(): Promise<void> {
    // Query counts for each table
    const [accountCount, sessionCount, messageCount, machineCount] = await Promise.all([
        db.account.count(),
        db.session.count(),
        db.sessionMessage.count(),
        db.machine.count()
    ]);

    // Update metrics
    databaseRecordCountGauge.set({ table: 'accounts' }, accountCount);
    databaseRecordCountGauge.set({ table: 'sessions' }, sessionCount);
    databaseRecordCountGauge.set({ table: 'messages' }, messageCount);
    databaseRecordCountGauge.set({ table: 'machines' }, machineCount);
}

export function startDatabaseMetricsUpdater(): void {
    forever('database-metrics-updater', async () => {
        await updateDatabaseMetrics();
        
        // Wait 60 seconds before next update
        await delay(60 * 1000, shutdownSignal);
    });
}

// Export the register for combining metrics
export { register };
