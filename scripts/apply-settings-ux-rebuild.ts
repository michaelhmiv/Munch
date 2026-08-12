#!/usr/bin/env bun

async function text(path: string) {
    return Bun.file(path).text();
}

async function write(path: string, value: string) {
    await Bun.write(path, value);
}

function replaceOnce(source: string, from: string, to: string, label: string) {
    const first = source.indexOf(from);
    if (first < 0) throw new Error(`Missing patch anchor: ${label}`);
    if (source.indexOf(from, first + from.length) >= 0) {
        throw new Error(`Patch anchor is not unique: ${label}`);
    }
    return source.slice(0, first) + to + source.slice(first + from.length);
}

// public/app.html
{
    const path = "public/app.html";
    let source = await text(path);
    source = replaceOnce(
        source,
        '        <link rel="stylesheet" href="/app-overrides.css" />',
        '        <link rel="stylesheet" href="/app-overrides.css" />\n        <link rel="stylesheet" href="/account-settings.css" />',
        "account settings stylesheet",
    );
    source = replaceOnce(
        source,
        '            <a data-route="settings" href="/app/settings"\n                ><span>•••</span><span>More</span></a\n            >',
        '            <a data-route="more" href="/app/more"\n                ><span>•••</span><span>More</span></a\n            >',
        "mobile more navigation",
    );
    await write(path, source);
}

// src/app/repository.ts
{
    const path = "src/app/repository.ts";
    let source = await text(path);
    source = replaceOnce(
        source,
        '            tier: capabilities.tier,\n            historyDays: capabilities.historyDays,',
        '            tier: capabilities.tier,\n            entitlementSource: capabilities.entitlementSource,\n            historyDays: capabilities.historyDays,',
        "app entitlement source",
    );
    await write(path, source);
}

// src/households/repository.ts
{
    const path = "src/households/repository.ts";
    let source = await text(path);
    source = replaceOnce(
        source,
        'export interface HouseholdInvitationResult {\n    invitationId: string;\n    rawToken: string;\n    expiresAt: string;\n}\n',
        'export interface HouseholdInvitationResult {\n    invitationId: string;\n    rawToken: string;\n    expiresAt: string;\n}\n\nexport interface PendingHouseholdInvitation {\n    invitationId: string;\n    email: string;\n    role: Exclude<HouseholdRole, "owner">;\n    createdAt: string;\n    expiresAt: string;\n}\n',
        "pending household invitation type",
    );
    const anchor = 'export async function createHouseholdInvitation(input: {';
    const insertion = `export async function listPendingHouseholdInvitations(\n    userId: string,\n    householdId: string,\n): Promise<PendingHouseholdInvitation[]> {\n    return withUserDatabase(userId, async (tx) => {\n        const ownerRows = await tx<Array<{ id: string }>>\`\n            select id\n            from munch.household_memberships\n            where household_id = \${householdId}\n              and user_id = \${userId}\n              and status = 'active'\n              and role = 'owner'\n            limit 1\n        \`;\n        if (!ownerRows[0]) throw new Error("Household owner required");\n\n        const rows = await tx<\n            Array<{\n                invitation_id: string;\n                email: string;\n                role: Exclude<HouseholdRole, "owner">;\n                created_at: Date;\n                expires_at: Date;\n            }>\n        >\`\n            select\n                id as invitation_id,\n                email,\n                role,\n                created_at,\n                expires_at\n            from munch.household_invitations\n            where household_id = \${householdId}\n              and accepted_at is null\n              and revoked_at is null\n              and expires_at > now()\n            order by created_at desc\n        \`;\n        return rows.map((row) => ({\n            invitationId: row.invitation_id,\n            email: row.email,\n            role: row.role,\n            createdAt: new Date(row.created_at).toISOString(),\n            expiresAt: new Date(row.expires_at).toISOString(),\n        }));\n    });\n}\n\n`;
    const index = source.indexOf(anchor);
    if (index < 0) throw new Error("Missing pending invitation insertion anchor");
    source = source.slice(0, index) + insertion + source.slice(index);
    await write(path, source);
}

// src/households/routes.ts
{
    const path = "src/households/routes.ts";
    let source = await text(path);
    source = replaceOnce(
        source,
        '                return c.redirect("/account/portal", 303);',
        '                return c.redirect("/app/household", 303);',
        "household acceptance redirect",
    );
    await write(path, source);
}

// src/app/routes.ts
{
    const path = "src/app/routes.ts";
    let source = await text(path);
    source = replaceOnce(
        source,
        'import { Hono, type Context } from "hono";\n',
        'import { Hono, type Context } from "hono";\nimport { resolveMunchCapabilities } from "../billing/capabilities.js";\nimport {\n    getHouseholdSeatCoverage,\n    ownerCanPurchaseHouseholdSeats,\n} from "../billing/household-seats.js";\nimport {\n    listHouseholdMembers,\n    listPendingHouseholdInvitations,\n} from "../households/repository.js";\n',
        "app account imports",
    );
    source = replaceOnce(
        source,
        '    app.get("/weight-display.js", async (c) =>\n        c.body(await Bun.file("./public/weight-display.js").text(), 200, {\n            "Content-Type": "text/javascript; charset=utf-8",\n            "Cache-Control": "no-cache",\n        }),\n    );\n',
        '    app.get("/weight-display.js", async (c) =>\n        c.body(await Bun.file("./public/weight-display.js").text(), 200, {\n            "Content-Type": "text/javascript; charset=utf-8",\n            "Cache-Control": "no-cache",\n        }),\n    );\n    app.get("/app-account.js", async (c) =>\n        c.body(await Bun.file("./public/app-account.js").text(), 200, {\n            "Content-Type": "text/javascript; charset=utf-8",\n            "Cache-Control": "no-cache",\n        }),\n    );\n    app.get("/account-settings.css", async (c) =>\n        c.body(await Bun.file("./public/account-settings.css").text(), 200, {\n            "Content-Type": "text/css; charset=utf-8",\n            "Cache-Control": "no-cache",\n        }),\n    );\n',
        "account asset routes",
    );
    const householdAnchor = '    app.get("/api/app/household", async (c) =>\n        privateJson(c, await getHouseholdWorkspace(c.get("munchUserId"))),\n    );\n';
    const householdManage = `${householdAnchor}\n    app.get("/api/app/household/manage", async (c) => {\n        const userId = c.get("munchUserId");\n        const capabilities = await resolveMunchCapabilities(userId);\n        const household = capabilities.household;\n        if (!household) {\n            return privateJson(c, {\n                household: null,\n                members: [],\n                pendingInvitations: [],\n                tier: capabilities.tier,\n                entitlementSource: capabilities.entitlementSource,\n                canInvite: false,\n                canWrite: false,\n                activeNonOwnerCount: 0,\n                billedSeatQuantity: 0,\n                seatCoverage: true,\n            });\n        }\n\n        const owner = household.role === "owner";\n        const [members, coverage, pendingInvitations, canInvite] =\n            await Promise.all([\n                listHouseholdMembers(userId, household.householdId),\n                getHouseholdSeatCoverage({\n                    ownerUserId: household.ownerUserId,\n                    householdId: household.householdId,\n                }),\n                owner\n                    ? listPendingHouseholdInvitations(\n                          userId,\n                          household.householdId,\n                      )\n                    : Promise.resolve([]),\n                owner\n                    ? ownerCanPurchaseHouseholdSeats(userId)\n                    : Promise.resolve(false),\n            ]);\n\n        return privateJson(c, {\n            household: {\n                householdId: household.householdId,\n                householdName: household.householdName,\n                role: household.role,\n                displayName: household.displayName,\n            },\n            members: members.map((member) => ({\n                membershipId: member.membershipId,\n                displayName: member.displayName,\n                role: member.role,\n                joinedAt: member.joinedAt,\n            })),\n            pendingInvitations,\n            tier: capabilities.tier,\n            entitlementSource: capabilities.entitlementSource,\n            canInvite,\n            canWrite: capabilities.householdWrite,\n            activeNonOwnerCount: coverage.activeNonOwnerCount,\n            billedSeatQuantity: coverage.billedSeatQuantity,\n            seatCoverage: coverage.covered,\n        });\n    });\n`;
    source = replaceOnce(
        source,
        householdAnchor,
        householdManage,
        "household management endpoint",
    );
    await write(path, source);
}

// public/app.js
{
    const path = "public/app.js";
    let source = await text(path);
    source = replaceOnce(
        source,
        '} from "./weight-display.js";\n',
        '} from "./weight-display.js";\nimport {\n    accountRoutes,\n    accountTitles,\n    handleAccountAction,\n    handleAccountSubmit,\n    isAccountRoute,\n    renderAccountRoute,\n} from "./app-account.js";\n',
        "app account module import",
    );
    const routeStart = '    "/app/household": "household",\n    "/app/settings": "settings",\n    "/app/settings/profile": "settings",\n    "/app/settings/goals": "settings",\n    "/app/settings/connections": "settings",\n    "/app/settings/billing": "settings",\n    "/app/settings/import-export": "settings",\n    "/app/settings/privacy": "settings",\n';
    source = replaceOnce(source, routeStart, '    ...accountRoutes,\n', "account route map");
    source = replaceOnce(
        source,
        '    household: ["Shared workspace", "Household"],\n    settings: ["Account and preferences", "Settings"],\n',
        '    ...accountTitles,\n',
        "account title map",
    );
    const activeStart = source.indexOf('function setActiveRoute(route) {');
    const activeEnd = source.indexOf('\n}\n\nfunction metricCard', activeStart);
    if (activeStart < 0 || activeEnd < 0) throw new Error("Missing setActiveRoute block");
    const activeBlock = `function setActiveRoute(route) {\n    const moreRoutes = new Set([\n        "more",\n        "household",\n        "insights",\n        "foods",\n        "recipes",\n        "settings",\n        "settings-profile",\n        "settings-goals",\n        "settings-billing",\n        "settings-connections",\n        "settings-data",\n        "settings-account",\n    ]);\n    const primaryRoute = route.startsWith("settings-") ? "settings" : route;\n    document.querySelectorAll("[data-route]").forEach((link) => {\n        const requested = link.dataset.route;\n        const active =\n            requested === primaryRoute ||\n            (requested === "more" && moreRoutes.has(route));\n        link.classList.toggle("is-active", active);\n        if (active) link.setAttribute("aria-current", "page");\n        else link.removeAttribute("aria-current");\n    });\n    const [kicker, title] = titles[route] || titles.today;\n    pageKicker.textContent = kicker;\n    pageTitle.textContent = title;\n    document.title = \`\${title} — Munch\`;\n}`;
    source = source.slice(0, activeStart) + activeBlock + source.slice(activeEnd + 2);

    const accountRenderStart = source.indexOf('async function renderHousehold() {');
    const renderRouteMarker = source.indexOf('async function renderRoute() {', accountRenderStart);
    if (accountRenderStart < 0 || renderRouteMarker < 0) {
        throw new Error("Missing legacy settings renderer block");
    }
    const contextBlock = `function accountContext() {\n    return {\n        content,\n        api,\n        state,\n        toast,\n        setLoading,\n        renderRoute,\n        navigate,\n    };\n}\n\n`;
    source = source.slice(0, accountRenderStart) + contextBlock + source.slice(renderRouteMarker);

    source = replaceOnce(
        source,
        '            groceries: renderGroceries,\n            household: renderHousehold,\n            settings: renderSettings,\n',
        '            groceries: renderGroceries,\n            more: () => renderAccountRoute("more", accountContext()),\n            household: () => renderAccountRoute("household", accountContext()),\n            settings: () => renderAccountRoute("settings", accountContext()),\n            "settings-profile": () =>\n                renderAccountRoute("settings-profile", accountContext()),\n            "settings-goals": () =>\n                renderAccountRoute("settings-goals", accountContext()),\n            "settings-billing": () =>\n                renderAccountRoute("settings-billing", accountContext()),\n            "settings-connections": () =>\n                renderAccountRoute("settings-connections", accountContext()),\n            "settings-data": () =>\n                renderAccountRoute("settings-data", accountContext()),\n            "settings-account": () =>\n                renderAccountRoute("settings-account", accountContext()),\n',
        "account renderers",
    );
    source = replaceOnce(
        source,
        '    const action = button.dataset.action;\n    if (!action) return;\n    if (action === "refresh") return renderRoute();',
        '    const action = button.dataset.action;\n    if (!action) return;\n    if (await handleAccountAction(button, accountContext())) return;\n    if (action === "refresh") return renderRoute();',
        "account action delegation",
    );
    source = replaceOnce(
        source,
        '    const form = event.target;\n    if (!(form instanceof HTMLFormElement)) return;\n    if (\n        ![\n            "edit-meal-form",',
        '    const form = event.target;\n    if (!(form instanceof HTMLFormElement)) return;\n    if (\n        [\n            "settings-profile-form",\n            "settings-goals-form",\n            "household-create-form",\n            "household-invite-form",\n        ].includes(form.id)\n    ) {\n        event.preventDefault();\n        try {\n            await handleAccountSubmit(form, accountContext());\n        } catch (error) {\n            toast(error.message || "Save failed", "error");\n        }\n        return;\n    }\n    if (\n        ![\n            "edit-meal-form",',
        "account form delegation",
    );
    if (!source.includes("isAccountRoute")) throw new Error("Account module import was lost");
    // Keep the imported route predicate intentionally referenced so static checks
    // catch accidental removal of the account route family.
    source = source.replace(
        '        const renderers = {',
        '        if (isAccountRoute(state.route) && !accountTitles[state.route]) {\n            throw new Error("Unknown account route");\n        }\n        const renderers = {',
    );
    await write(path, source);
}

console.log("Applied unified settings and household UX patches.");
