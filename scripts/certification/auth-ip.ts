const TEST_NET_PREFIX = "198.51.100";

export function certificationAuthIp(label: string): string {
    const normalized = label.trim().toLowerCase();
    if (!normalized) throw new Error("Certification identity label is required");

    let hash = 0;
    for (const character of normalized) {
        hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    }

    return `${TEST_NET_PREFIX}.${10 + (hash % 200)}`;
}
