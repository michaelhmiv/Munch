export const GRAMS_PER_POUND = 453.59237;

export function savedWeightUnit(value) {
    return value === "lb" || value === "kg" ? value : null;
}

export function displayWeightUnit(value) {
    return savedWeightUnit(value) ?? "kg";
}

export function weightFromGrams(grams, unit) {
    const value = Number(grams);
    if (!Number.isFinite(value)) return null;
    return displayWeightUnit(unit) === "lb"
        ? value / GRAMS_PER_POUND
        : value / 1000;
}
