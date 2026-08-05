function esc(value) {
    return String(value ?? "").replace(
        /[&<>\"]/g,
        (char) =>
            ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char],
    );
}
function fmt(value, digits) {
    if (value == null || Number.isNaN(Number(value))) return "—";
    return Number(value).toLocaleString(undefined, {
        maximumFractionDigits: digits ?? 0,
    });
}
function pct(value, goal) {
    if (value == null || goal == null || Number(goal) <= 0) return null;
    return Math.round((Number(value) / Number(goal)) * 100);
}
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
function humanDate(value) {
    if (!value) return "";
    const date = new Date(
        String(value).length === 10 ? `${value}T12:00:00` : value,
    );
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        year:
            date.getFullYear() === new Date().getFullYear()
                ? undefined
                : "numeric",
    }).format(date);
}
function humanRange(start, end) {
    if (!start) return "";
    if (!end || start === end) return humanDate(start);
    return `${humanDate(start)} – ${humanDate(end)}`;
}
function metric(label, value, unit) {
    return `<div class="metric"><div class="value">${esc(value)}${unit ? `<span class="caption"> ${esc(unit)}</span>` : ""}</div><div class="label">${esc(label)}</div></div>`;
}
function progress(label, value, goal, unit, color) {
    const percentage = pct(value, goal);
    const over = percentage != null && percentage > 100;
    const width = percentage == null ? 0 : clamp(percentage, 0, 100);
    const right =
        goal == null
            ? `${fmt(value, 1)} ${unit}`
            : `${fmt(value, 1)} / ${fmt(goal, 1)} ${unit}`;
    return `<div class="progress-row"><div class="progress-top"><span>${esc(label)}</span><strong class="num"${over ? ' style="color:var(--over)"' : ""}>${esc(right)}</strong></div><div class="progress-track" role="progressbar" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="${goal ?? 100}" aria-valuenow="${value ?? 0}"><span class="progress-fill${over ? " over" : ""}" style="width:${width}%;${color ? `background:${color}` : ""}"></span></div>${percentage == null ? '<div class="caption">No goal set</div>' : `<div class="caption">${percentage}% of target</div>`}</div>`;
}
function sparkline(points, options) {
    const values = points
        .map((point) => Number(point.value))
        .filter(Number.isFinite);
    if (!values.length) return "";
    const width = 520,
        height = 76,
        pad = 5;
    let min = Math.min(...values),
        max = Math.max(...values);
    if (options?.goal != null && Number.isFinite(Number(options.goal))) {
        min = Math.min(min, Number(options.goal));
        max = Math.max(max, Number(options.goal));
    }
    if (max === min) {
        max += 1;
        min -= 1;
    }
    const spread = max - min;
    min -= spread * 0.12;
    max += spread * 0.12;
    const x = (index) =>
        points.length === 1
            ? width / 2
            : pad + (index * (width - pad * 2)) / (points.length - 1);
    const y = (value) =>
        pad + ((max - value) * (height - pad * 2)) / (max - min);
    const coords = points.map((point, index) => [
        x(index),
        y(Number(point.value)),
    ]);
    const line = coords
        .map(
            (point, index) =>
                `${index ? "L" : "M"}${point[0].toFixed(1)} ${point[1].toFixed(1)}`,
        )
        .join(" ");
    const area = `M${coords[0][0].toFixed(1)} ${height - pad} ${coords.map((point) => `L${point[0].toFixed(1)} ${point[1].toFixed(1)}`).join(" ")} L${coords[coords.length - 1][0].toFixed(1)} ${height - pad} Z`;
    const goalLine =
        options?.goal != null
            ? `<line class="goal" x1="${pad}" y1="${y(Number(options.goal)).toFixed(1)}" x2="${width - pad}" y2="${y(Number(options.goal)).toFixed(1)}"></line>`
            : "";
    return `<svg class="spark" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(options?.label || "Trend chart")}"><line class="axis" x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}"></line>${goalLine}<path class="area" d="${area}"></path><path class="line" d="${line}"></path></svg>`;
}
function nutrientMetrics(values) {
    const source = values || {};
    return [
        metric("Calories", fmt(source.calories), "kcal"),
        metric("Protein", fmt(source.protein_g, 1), "g"),
        metric("Carbs", fmt(source.carbs_g, 1), "g"),
        metric("Fat", fmt(source.fat_g, 1), "g"),
    ].join("");
}
