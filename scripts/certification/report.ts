export interface CertificationCheck {
    name: string;
    ok: boolean;
    duration_ms: number;
    skipped?: boolean;
    detail?: string;
}

export function percentile(values: number[], fraction: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil(sorted.length * fraction) - 1),
    );
    return Number(sorted[index]!.toFixed(2));
}

export function summarizeDurations(checks: CertificationCheck[]) {
    const values = checks
        .filter((check) => !check.skipped)
        .map((check) => check.duration_ms);
    return {
        count: values.length,
        p50_ms: percentile(values, 0.5),
        p95_ms: percentile(values, 0.95),
        p99_ms: percentile(values, 0.99),
        max_ms: Number(Math.max(0, ...values).toFixed(2)),
    };
}
