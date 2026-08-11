from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


app_path = Path("public/app.js")
app = app_path.read_text()

app = replace_once(
    app,
    'const state = {\n',
    'import { displayWeightUnit, savedWeightUnit, weightFromGrams } from "./weight-display.js";\n\nconst state = {\n',
    "app import",
)

app = replace_once(
    app,
    '    const latestWeight = data.weight?.at(-1);\n    content.innerHTML = ',
    '    const latestWeight = data.weight?.at(-1);\n    const weightUnit = displayWeightUnit(\n        state.bootstrap?.profile?.preferred_weight_unit,\n    );\n    const latestWeightValue = latestWeight\n        ? weightFromGrams(latestWeight.weight_g, weightUnit)\n        : null;\n    content.innerHTML = ',
    "today weight display setup",
)

app = replace_once(
    app,
    '${metricCard("Weight", latestWeight ? latestWeight.weight_g / 1000 : null, " kg", null)}',
    '${metricCard("Weight", latestWeightValue, ` ${weightUnit}`, null)}',
    "today weight metric",
)

old_add_weight = '''    if (action === "add-weight") {
        openDialog(
            "Add weight",
            `<form id="weight-form" class="auth-form"><label class="field"><span>Weight</span><input name="weight" type="number" min="1" step="0.1" required /></label><label class="field"><span>Unit</span><select name="unit"><option value="lb" ${state.bootstrap.profile?.preferred_weight_unit === "lb" ? "selected" : ""}>lb</option><option value="kg" ${state.bootstrap.profile?.preferred_weight_unit === "kg" ? "selected" : ""}>kg</option></select></label><label class="field"><span>Notes</span><input name="notes" placeholder="Optional" /></label><button class="button button-primary" type="submit">Add weight</button></form>`,
        );
        return;
    }
'''
new_add_weight = '''    if (action === "add-weight") {
        const preferredWeightUnit = savedWeightUnit(
            state.bootstrap.profile?.preferred_weight_unit,
        );
        openDialog(
            "Add weight",
            `<form id="weight-form" class="auth-form"><label class="field"><span>Weight</span><input name="weight" type="number" min="1" step="0.1" required /></label><label class="field"><span>Unit</span><select name="unit" required><option value="" disabled ${preferredWeightUnit ? "" : "selected"}>Select unit</option><option value="lb" ${preferredWeightUnit === "lb" ? "selected" : ""}>lb</option><option value="kg" ${preferredWeightUnit === "kg" ? "selected" : ""}>kg</option></select></label><label class="field"><span>Notes</span><input name="notes" placeholder="Optional" /></label><button class="button button-primary" type="submit">Add weight</button></form>`,
        );
        return;
    }
'''
app = replace_once(app, old_add_weight, new_add_weight, "core add-weight dialog")
app_path.write_text(app)

patch_path = Path("public/app-patches.js")
patch = patch_path.read_text()
patch = replace_once(
    patch,
    'const patchDialog = document.getElementById("app-dialog");\n',
    'import { savedWeightUnit } from "./weight-display.js";\n\nconst patchDialog = document.getElementById("app-dialog");\n',
    "patch import",
)

profile_helper = '''\nasync function fetchPatchedPreferredWeightUnit() {
    try {
        const response = await fetch("/api/app/bootstrap", {
            credentials: "same-origin",
            headers: { Accept: "application/json" },
            cache: "no-store",
        });
        if (!response.ok) return null;
        const data = await response.json();
        return savedWeightUnit(data.profile?.preferred_weight_unit);
    } catch {
        return null;
    }
}
'''
patch = replace_once(
    patch,
    '\nfunction showPatchedDialog(title, body) {\n',
    profile_helper + '\nfunction showPatchedDialog(title, body) {\n',
    "patch profile helper",
)
patch = replace_once(
    patch,
    '    (event) => {\n',
    '    async (event) => {\n',
    "async patched click handler",
)
patch = replace_once(
    patch,
    '''        const preferredUnit =
            document.querySelector("select[name='preferred_weight_unit']")
                ?.value || "lb";
''',
    '''        const preferredUnit = await fetchPatchedPreferredWeightUnit();
''',
    "patched preferred unit lookup",
)
patch = replace_once(
    patch,
    '<select name="unit"><option value="lb" ${preferredUnit === "lb" ? "selected" : ""}>lb</option><option value="kg" ${preferredUnit === "kg" ? "selected" : ""}>kg</option></select>',
    '<select name="unit" required><option value="" disabled ${preferredUnit ? "" : "selected"}>Select unit</option><option value="lb" ${preferredUnit === "lb" ? "selected" : ""}>lb</option><option value="kg" ${preferredUnit === "kg" ? "selected" : ""}>kg</option></select>',
    "patched add-weight unit select",
)
patch_path.write_text(patch)
