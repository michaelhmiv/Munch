const VALID_GTIN_LENGTHS = new Set([8, 12, 13, 14]);

export function normalizeGtin(raw: string): string | null {
    const digits = String(raw ?? "").replace(/\D/g, "");
    if (!VALID_GTIN_LENGTHS.has(digits.length)) return null;
    if (/^0+$/.test(digits)) return null;

    const payload = digits.slice(0, -1);
    let sum = 0;
    for (let index = 0; index < payload.length; index += 1) {
        const digit = Number(payload[payload.length - 1 - index]);
        sum += digit * (index % 2 === 0 ? 3 : 1);
    }
    const expected = (10 - (sum % 10)) % 10;
    return expected === Number(digits.at(-1)) ? digits : null;
}

export function isValidGtin(raw: string): boolean {
    return normalizeGtin(raw) !== null;
}
