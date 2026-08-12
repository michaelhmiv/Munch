import { Hono } from "hono";
import { requireSameOrigin } from "../accounts/csrf.js";
import { clearWebSession, requireWebSession } from "../accounts/session.js";
import { resolveMunchCapabilities } from "../billing/capabilities.js";
import {
    getHouseholdSeatCoverage,
    householdMonthlyTotalCents,
    ownerCanPurchaseHouseholdSeats,
} from "../billing/household-seats.js";
import { getSubscriptionSnapshot } from "../billing/repository.js";
import { getRailwayExportFile } from "../export.js";
import { listHouseholdMembers } from "../households/repository.js";
import { listSavedFoods } from "../saved-foods/repository.js";
import { deleteAllUserData, getProfile, upsertProfile } from "../storage.js";
import { listOAuthConnections, revokeOAuthConnection } from "./repository.js";

function escapeHtml(value: unknown): string {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function isTimezone(value: string): boolean {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
        return true;
    } catch {
        return false;
    }
}

function dollars(cents: number): string {
    return `$${(cents / 100).toFixed(2)}`;
}

interface PortalMember {
    membershipId: string;
    displayName: string;
    role: "owner" | "member" | "viewer";
    joinedAt: string;
}

interface PortalHousehold {
    householdId: string;
    householdName: string;
    role: "owner" | "member" | "viewer";
    displayName: string;
    canInvite: boolean;
    canWrite: boolean;
    activeNonOwnerCount: number;
    billedSeatQuantity: number;
    seatCoverage: boolean;
    members: PortalMember[];
}

function householdSection(input: {
    tier: "free" | "premium";
    entitlementSource: string;
    household: PortalHousehold | null;
}): string {
    if (!input.household) {
        if (input.tier === "premium") {
            return `<section class="portal-card wide"><h2>Household</h2><p>Create one shared workspace for recipes, meal plans, and grocery lists. Personal meals, water, weight, goals, and saved foods remain private.</p><p class="tiny">Your Premium subscription includes you. Each additional active household member is $2.00/month and receives Premium while participating in the shared household workspace.</p><form id="create-household" class="portal-form"><div class="field"><label for="household-name">Household name</label><input id="household-name" name="name" required maxlength="120"></div><div class="field"><label for="household-display-name">Your household display name</label><input id="household-display-name" name="display_name" required maxlength="80"></div><button class="button button-primary" type="submit">Create household</button></form></section>`;
        }
        return `<section class="portal-card wide"><h2>Household</h2><p>You are not connected to a household. Premium owners can create a household and add members for $2.00/month each.</p><a class="button button-secondary" href="/#pricing">Compare plans</a></section>`;
    }

    const household = input.household;
    const owner = household.role === "owner";
    const members = household.members
        .map((member) => {
            const roleControls =
                owner && member.role !== "owner"
                    ? `<div class="portal-actions"><select aria-label="Role for ${escapeHtml(member.displayName)}" data-role-select="${escapeHtml(member.membershipId)}"><option value="member"${member.role === "member" ? " selected" : ""}>Member</option><option value="viewer"${member.role === "viewer" ? " selected" : ""}>Viewer</option></select><button class="button button-quiet button-small" data-save-role="${escapeHtml(member.membershipId)}">Save role</button><button class="button button-danger button-small" data-remove-member="${escapeHtml(member.membershipId)}">Remove</button></div>`
                    : "";
            const price = member.role === "owner" ? "Included" : "+$2.00/month";
            return `<li><div><strong>${escapeHtml(member.displayName)}</strong><small>${escapeHtml(member.role)} · ${price} · joined ${escapeHtml(member.joinedAt)}</small></div>${roleControls}</li>`;
        })
        .join("");

    const ownerBilling = owner
        ? `<div class="portal-form"><h3>Household billing</h3><p>Munch Premium ${dollars(499)}/month + ${household.activeNonOwnerCount} household member${household.activeNonOwnerCount === 1 ? "" : "s"} × $2.00/month = <strong>${dollars(householdMonthlyTotalCents(household.activeNonOwnerCount))}/month</strong>.</p>${household.seatCoverage ? "" : `<p class="tiny">Seat billing is reconciling. Shared writes and inherited Premium remain fail-closed until Stripe covers the active household roster.</p>`}</div>`
        : input.entitlementSource === "household_subscription"
          ? `<div class="portal-form"><h3>Premium through household</h3><p>Your Premium access is paid for by the household owner as a $2.00/month household seat. Household recipes, meal plans, and grocery lists are shared automatically; your personal nutrition history remains private.</p><p class="tiny">Leaving this household ends household-provided Premium unless you also have your own active Premium subscription.</p></div>`
          : "";

    const invite =
        owner && household.canInvite
            ? `<form id="invite-household-member" class="portal-form"><h3>Invite a member</h3><p class="tiny">Invitations are free. When the invited person accepts, your subscription increases by $2.00/month with Stripe proration. The member receives Premium and automatically participates in shared recipes, meal plans, and grocery lists.</p><div class="field"><label for="invite-email">Email</label><input id="invite-email" name="email" type="email" required maxlength="320"></div><div class="field"><label for="invite-role">Role</label><select id="invite-role" name="role"><option value="member">Member — can edit shared household data</option><option value="viewer">Viewer — read-only shared household data</option></select></div><button class="button button-primary" type="submit">Send invitation</button></form>`
            : owner
              ? `<p class="tiny spacer-top">New invitations require the household owner to have an active paid Munch Premium subscription. Existing shared data remains available according to current access.</p>`
              : "";

    const lifecycle = owner
        ? `<div class="portal-form"><h3>Dissolve household</h3><p>Paid household ownership is tied to your Stripe subscription, so ownership is not transferable. Dissolving removes all household seats from your subscription and permanently deletes shared household records.</p><div class="field"><label for="dissolve-confirmation">Type DISSOLVE HOUSEHOLD</label><input id="dissolve-confirmation" autocomplete="off"></div><button class="button button-danger" id="dissolve-household">Dissolve household</button></div>`
        : `<div class="portal-actions"><button class="button button-danger" id="leave-household">Leave household</button></div>`;

    return `<section class="portal-card wide"><h2>${escapeHtml(household.householdName)}</h2><p>You appear to other members as <strong>${escapeHtml(household.displayName)}</strong>. Your role is <strong>${escapeHtml(household.role)}</strong>. ${household.canWrite ? "Shared editing is active." : "Shared records are currently read-only."}</p>${ownerBilling}<ul class="portal-list">${members}</ul>${invite}${lifecycle}</section>`;
}

function page(input: {
    email: string;
    tier: "free" | "premium";
    entitlementSource: string;
    subscriptionStatus: string | null;
    timezone: string;
    weightUnit: string | null;
    drinkUnit: string | null;
    widgetsEnabled: boolean;
    alcoholEnabled: boolean;
    connections: Array<{
        tokenFamilyId: string;
        clientName: string | null;
        clientId: string;
        expiresAt: string;
    }>;
    savedFoods: Array<{ id: string; label: string; useCount: number }>;
    household: PortalHousehold | null;
}): string {
    const connections = input.connections.length
        ? input.connections
              .map(
                  (connection) =>
                      `<li><div><strong>${escapeHtml(connection.clientName ?? "ChatGPT / MCP client")}</strong><small>${escapeHtml(connection.clientId)} · expires ${escapeHtml(connection.expiresAt)}</small></div><button class="button button-quiet button-small" data-revoke="${escapeHtml(connection.tokenFamilyId)}">Revoke</button></li>`,
              )
              .join("")
        : "<li><div><strong>No active connections</strong><small>Connect Munch from ChatGPT to see it here.</small></div></li>";
    const savedFoods = input.savedFoods.length
        ? input.savedFoods
              .map(
                  (food) =>
                      `<li><div><strong>${escapeHtml(food.label)}</strong><small>used ${food.useCount} times</small></div></li>`,
              )
              .join("")
        : "<li><div><strong>No saved foods yet</strong><small>Ask ChatGPT to save a food or recurring meal.</small></div></li>";
    const householdProvided =
        input.entitlementSource === "household_subscription";
    const planLabel = householdProvided
        ? "Premium · household"
        : input.tier === "premium"
          ? "Premium"
          : "Free";
    const billingAction = input.subscriptionStatus ? "portal" : "checkout";
    const billingCopy = householdProvided
        ? "Your Premium access is provided by your household owner's subscription. You are not billed separately for this household seat."
        : input.subscriptionStatus
          ? `Stripe subscription status: ${escapeHtml(input.subscriptionStatus)}. Stripe hosts payment methods, invoices, and cancellation. Household seat quantity is managed from the Munch household controls.`
          : "Munch Free is permanent. Premium is $4.99/month and includes unlimited history and saved foods, personal recipes and planning, and household ownership.";
    const billingButton = householdProvided
        ? ""
        : `<div class="portal-actions"><button class="button button-primary" id="billing" data-billing-action="${billingAction}">${input.subscriptionStatus ? "Manage billing in Stripe" : "Upgrade to Premium — $4.99/month"}</button></div>`;

    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0B8F4D"><title>Munch account</title><link rel="icon" href="/favicon.ico"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/portal-controls.css"></head><body class="portal-page"><header class="portal-header"><div class="container portal-header-inner"><a class="brand" href="/"><img class="brand-logo" src="/brand/munch-mark-white.svg" alt=""><span>Munch</span></a><button class="button button-quiet button-small" id="logout">Sign out</button></div></header><main class="portal-main"><div class="container"><div class="portal-welcome"><div><p class="section-kicker">Account control center</p><h1>Your Munch account</h1><p>${escapeHtml(input.email)}</p></div><span class="status-pill">${escapeHtml(planLabel)} · ChatGPT access active</span></div><p id="message" class="message-bar" role="status"></p><div class="portal-grid"><section class="portal-card wide"><h2>ChatGPT connections</h2><p>Authorized clients can call Munch nutrition tools. Revoke anything you no longer recognize or use.</p><ul class="portal-list">${connections}</ul></section><section class="portal-card"><h2>Billing</h2><p>${billingCopy}</p>${billingButton}</section><section class="portal-card"><h2>Your data</h2><p>Download a short-lived JSON export of your personal data and household records you are authorized to view. Other members' emails and internal account identifiers are excluded.</p><ul class="portal-list">${savedFoods}</ul><div class="portal-actions"><button class="button button-secondary" id="export">Export complete account data</button></div></section>${householdSection({ tier: input.tier, entitlementSource: input.entitlementSource, household: input.household })}<section class="portal-card wide"><h2>Preferences</h2><form id="preferences" class="portal-form"><div class="field"><label for="timezone">Timezone</label><input id="timezone" name="timezone" value="${escapeHtml(input.timezone)}" required></div><div class="field"><label for="weight-unit">Weight unit</label><select id="weight-unit" name="preferred_weight_unit"><option value="">No preference</option><option value="kg"${input.weightUnit === "kg" ? " selected" : ""}>kg</option><option value="lb"${input.weightUnit === "lb" ? " selected" : ""}>lb</option></select></div><label class="checkbox-row"><input type="checkbox" name="widgets_enabled"${input.widgetsEnabled ? " checked" : ""}> Show interactive widgets</label><label class="checkbox-row"><input type="checkbox" name="alcohol_tracking_enabled"${input.alcoholEnabled ? " checked" : ""}> Enable alcohol tracking</label><div class="field"><label for="drink-unit">Drink units</label><select id="drink-unit" name="preferred_drink_unit"><option value="">Default</option><option value="us"${input.drinkUnit === "us" ? " selected" : ""}>US</option><option value="uk"${input.drinkUnit === "uk" ? " selected" : ""}>UK</option></select></div><button class="button button-primary" type="submit">Save preferences</button></form></section><section class="portal-card wide danger"><h2>Delete account</h2><p>This permanently deletes your personal Munch records, saved foods, drafts, preferences, and active connections. Paid household owners must dissolve their household first. Cancel your Stripe subscription separately if applicable.</p><div class="portal-form"><div class="field"><label for="delete-confirmation">Type DELETE MY MUNCH ACCOUNT</label><input id="delete-confirmation" autocomplete="off"></div><button class="button button-danger" id="delete-account">Permanently delete account</button></div></section></div></div></main><script>
const message=document.getElementById('message');
async function post(url,body={}){const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||'Request failed');return data}
function show(text){message.textContent=text;message.scrollIntoView({behavior:'smooth',block:'nearest'})}
function reloadWith(text){sessionStorage.setItem('munchPortalMessage',text);location.reload()}
const restored=sessionStorage.getItem('munchPortalMessage');if(restored){sessionStorage.removeItem('munchPortalMessage');show(restored)}
document.getElementById('preferences')?.addEventListener('submit',async(event)=>{event.preventDefault();const form=new FormData(event.currentTarget);try{await post('/account/portal/preferences',{timezone:form.get('timezone'),preferred_weight_unit:form.get('preferred_weight_unit')||null,widgets_enabled:form.has('widgets_enabled'),alcohol_tracking_enabled:form.has('alcohol_tracking_enabled'),preferred_drink_unit:form.get('preferred_drink_unit')||null});show('Preferences saved.')}catch(error){show(error.message)}});
document.querySelectorAll('[data-revoke]').forEach(button=>button.addEventListener('click',async()=>{try{await post('/account/portal/connections/revoke',{token_family_id:button.dataset.revoke});button.closest('li')?.remove();show('Connection revoked.')}catch(error){show(error.message)}}));
document.getElementById('billing')?.addEventListener('click',async(event)=>{try{const action=event.currentTarget.dataset.billingAction;const data=await post(action==='checkout'?'/billing/checkout':'/billing/portal',{returnTo:'/account/portal'});location.href=data.url}catch(error){show(error.message)}});
document.getElementById('export')?.addEventListener('click',async()=>{try{const data=await post('/account/portal/export');if(data.url)location.href=data.url;else show('No data was available to export.')}catch(error){show(error.message)}});
document.getElementById('create-household')?.addEventListener('submit',async(event)=>{event.preventDefault();const form=new FormData(event.currentTarget);try{await post('/account/household/create',{name:form.get('name'),display_name:form.get('display_name')});reloadWith('Household created.')}catch(error){show(error.message)}});
document.getElementById('invite-household-member')?.addEventListener('submit',async(event)=>{event.preventDefault();const form=new FormData(event.currentTarget);try{await post('/account/household/invite',{email:form.get('email'),role:form.get('role')});show('Invitation sent. Your bill changes only if the invited person accepts.')}catch(error){show(error.message)}});
document.querySelectorAll('[data-save-role]').forEach(button=>button.addEventListener('click',async()=>{const id=button.dataset.saveRole;const select=document.querySelector('[data-role-select="'+CSS.escape(id)+'"]');try{await post('/account/household/member/role',{membership_id:id,role:select.value});reloadWith('Member role updated.')}catch(error){show(error.message)}}));
document.querySelectorAll('[data-remove-member]').forEach(button=>button.addEventListener('click',async()=>{if(!confirm('Remove this member? Their household-provided Premium ends and your household seat quantity will decrease.'))return;try{await post('/account/household/member/remove',{membership_id:button.dataset.removeMember});reloadWith('Member removed and household billing updated.')}catch(error){show(error.message)}}));
document.getElementById('leave-household')?.addEventListener('click',async()=>{if(!confirm('Leave this household? Household-provided Premium ends immediately unless you have your own Premium subscription.'))return;try{await post('/account/household/leave',{confirm:true});reloadWith('You left the household.')}catch(error){show(error.message)}});
document.getElementById('dissolve-household')?.addEventListener('click',async()=>{try{await post('/account/household/dissolve',{confirmation:document.getElementById('dissolve-confirmation').value});reloadWith('Household dissolved, shared records deleted, and paid member seats removed.')}catch(error){show(error.message)}});
document.getElementById('logout')?.addEventListener('click',async()=>{try{await post('/account/logout');location.href='/'}catch(error){show(error.message)}});
document.getElementById('delete-account')?.addEventListener('click',async()=>{try{await post('/account/portal/delete',{confirmation:document.getElementById('delete-confirmation').value});location.href='/?deleted=1'}catch(error){show(error.message)}});
</script></body></html>`;
}

export function createPortalRouter(): Hono {
    const portal = new Hono();

    portal.use("*", async (c, next) => {
        await next();
        c.header("Cache-Control", "private, no-store");
        c.header("Pragma", "no-cache");
    });

    portal.get("/account/portal", requireWebSession, async (c) => {
        const userId = c.get("munchUserId");
        const [subscription, profile, connections, savedFoods, capabilities] =
            await Promise.all([
                getSubscriptionSnapshot(userId),
                getProfile(userId),
                listOAuthConnections(userId),
                listSavedFoods(userId, 20),
                resolveMunchCapabilities(userId),
            ]);
        const members = capabilities.household
            ? await listHouseholdMembers(
                  userId,
                  capabilities.household.householdId,
              )
            : [];
        const seatCoverage = capabilities.household
            ? await getHouseholdSeatCoverage({
                  ownerUserId: capabilities.household.ownerUserId,
                  householdId: capabilities.household.householdId,
              })
            : null;
        const canInvite =
            capabilities.household?.role === "owner"
                ? await ownerCanPurchaseHouseholdSeats(userId)
                : false;
        return c.html(
            page({
                email: c.get("munchUserEmail"),
                tier: capabilities.tier,
                entitlementSource: capabilities.entitlementSource,
                subscriptionStatus: subscription.status,
                timezone: profile?.timezone ?? "UTC",
                weightUnit: profile?.preferred_weight_unit ?? null,
                drinkUnit: profile?.preferred_drink_unit ?? null,
                widgetsEnabled: profile?.widgets_enabled ?? true,
                alcoholEnabled: profile?.alcohol_tracking_enabled ?? false,
                connections,
                savedFoods: savedFoods.map((food) => ({
                    id: food.id,
                    label: food.label,
                    useCount: food.useCount,
                })),
                household: capabilities.household
                    ? {
                          householdId: capabilities.household.householdId,
                          householdName: capabilities.household.householdName,
                          role: capabilities.household.role,
                          displayName: capabilities.household.displayName,
                          canInvite,
                          canWrite: capabilities.householdWrite,
                          activeNonOwnerCount:
                              seatCoverage?.activeNonOwnerCount ?? 0,
                          billedSeatQuantity:
                              seatCoverage?.billedSeatQuantity ?? 0,
                          seatCoverage: seatCoverage?.covered ?? false,
                          members: members.map((member) => ({
                              membershipId: member.membershipId,
                              displayName: member.displayName,
                              role: member.role,
                              joinedAt: member.joinedAt,
                          })),
                      }
                    : null,
            }),
        );
    });

    portal.post(
        "/account/portal/preferences",
        requireSameOrigin,
        requireWebSession,
        async (c) => {
            const body = (await c.req.json()) as Record<string, unknown>;
            const timezone =
                typeof body.timezone === "string" ? body.timezone.trim() : "";
            if (!timezone || !isTimezone(timezone)) {
                return c.json({ error: "invalid_timezone" }, 400);
            }
            const weightUnit = body.preferred_weight_unit;
            const drinkUnit = body.preferred_drink_unit;
            if (
                weightUnit !== null &&
                weightUnit !== "kg" &&
                weightUnit !== "lb"
            ) {
                return c.json({ error: "invalid_weight_unit" }, 400);
            }
            if (
                drinkUnit !== null &&
                drinkUnit !== "us" &&
                drinkUnit !== "uk"
            ) {
                return c.json({ error: "invalid_drink_unit" }, 400);
            }
            const profile = await upsertProfile(c.get("munchUserId"), {
                timezone,
                preferred_weight_unit: weightUnit,
                widgets_enabled: body.widgets_enabled === true,
                alcohol_tracking_enabled:
                    body.alcohol_tracking_enabled === true,
                preferred_drink_unit: drinkUnit,
            });
            return c.json({ saved: true, profile });
        },
    );

    portal.post(
        "/account/portal/connections/revoke",
        requireSameOrigin,
        requireWebSession,
        async (c) => {
            const body = (await c.req.json()) as {
                token_family_id?: unknown;
            };
            if (typeof body.token_family_id !== "string") {
                return c.json({ error: "token_family_id_required" }, 400);
            }
            const revoked = await revokeOAuthConnection(
                c.get("munchUserId"),
                body.token_family_id,
            );
            return c.json({ revoked });
        },
    );

    portal.post(
        "/account/portal/delete",
        requireSameOrigin,
        requireWebSession,
        async (c) => {
            const body = (await c.req.json()) as { confirmation?: unknown };
            if (body.confirmation !== "DELETE MY MUNCH ACCOUNT") {
                return c.json({ error: "confirmation_mismatch" }, 400);
            }
            const userId = c.get("munchUserId");
            try {
                await deleteAllUserData(userId);
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : "deletion_failed";
                if (message.includes("household_owner_transfer_required")) {
                    return c.json(
                        { error: "dissolve_household_before_deletion" },
                        409,
                    );
                }
                throw error;
            }
            await clearWebSession(c);
            return c.json({ deleted: true });
        },
    );

    portal.get("/exports/download", async (c) => {
        c.set("suppressAccessLog", true);
        const token = c.req.query("token");
        if (!token) return c.json({ error: "export_token_required" }, 400);
        const file = await getRailwayExportFile(token);
        if (!file) return c.json({ error: "invalid_or_expired_export" }, 404);
        const safeName = file.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
        return c.body(file.content, 200, {
            "Content-Type": file.contentType,
            "Content-Disposition": `attachment; filename="${safeName}"`,
            "Cache-Control": "private, no-store",
            Pragma: "no-cache",
            "X-Content-Type-Options": "nosniff",
        });
    });

    return portal;
}
