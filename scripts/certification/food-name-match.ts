function normalizeToken(token: string): string {
    if (token.length > 4 && token.endsWith("ies")) {
        return `${token.slice(0, -3)}y`;
    }
    if (token.length > 4 && token.endsWith("oes")) {
        return token.slice(0, -2);
    }
    if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) {
        return token.slice(0, -1);
    }
    return token;
}

function normalizedTokens(value: string): string[] {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(normalizeToken);
}

export function foodNameMatches(
    name: string,
    expectedPhrases: readonly string[],
): boolean {
    const candidateTokens = normalizedTokens(name);
    if (candidateTokens.length === 0) return false;

    return expectedPhrases.some((phrase) => {
        const expectedTokens = normalizedTokens(phrase);
        return (
            expectedTokens.length > 0 &&
            expectedTokens.every((token) => candidateTokens.includes(token))
        );
    });
}
