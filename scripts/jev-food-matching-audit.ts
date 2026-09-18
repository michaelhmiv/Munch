#!/usr/bin/env bun

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { FoodSearchService, isStrongLocalMatch, summarizeFoodCandidate } from "../src/food-providers/service.js";
import type { FoodCandidate } from "../src/food-providers/types.js";
import { closePlatformDatabase } from "../src/platform/database.js";

const typesafeKey = process.env.TYPESAFE_API_KEY?.trim();
const openrouterKey = process.env.OPENROUTER_API_KEY?.trim();
if (!typesafeKey) throw new Error("TYPESAFE_API_KEY is required");
if (!openrouterKey) throw new Error("OPENROUTER_API_KEY is required");
if (!process.env.USDA_FDC_API_KEY?.trim()) throw new Error("USDA_FDC_API_KEY is required for live-provider audit");

const JEV_MODEL = process.env.JEV_MODEL?.trim() || "jev-latest";
const QWEN_MODEL = process.env.QWEN_MODEL?.trim() || "qwen/qwen3.7-flash";
const LIMIT = 10;
const TS_PRICE_INPUT_PER_M = 0.042;
const QWEN_PRICE_INPUT_PER_M = 0.03;
const QWEN_PRICE_OUTPUT_PER_M = 0.13;

interface CaseDefinition {
    id: string;
    query: string;
    context: string;
    required: string[];
    requiredAny?: string[];
    forbidden: string[];
}

const CASES: CaseDefinition[] = [
    { id:"bacon-strips", query:"bacon", context:"I ate 3 strips of regular pork bacon with breakfast.", required:["bacon"], forbidden:["bit","canadian","meatless","beef","turkey"] },
    { id:"bacon-bits", query:"bacon", context:"I added 2 tablespoons of bacon bits to a salad.", required:["bacon","bit"], forbidden:["meatless"] },
    { id:"diced-onion", query:"onion", context:"The recipe used 1 medium onion, diced.", required:["onion"], forbidden:["gravy","mix","ring","powder","dip","bread","soup","green","red","white","yellow","sweet"] },
    { id:"white-rice-cooked", query:"white rice", context:"I ate 1 cup of cooked white rice.", required:["rice","white","cooked"], forbidden:["flour","bean","pea","corn","wild"] },
    { id:"plain-walnuts", query:"walnuts", context:"I ate 1 ounce of plain walnuts as a snack.", required:["walnut"], forbidden:["glazed","honey","oil"] },
    { id:"salmon-grilled", query:"salmon", context:"Dinner included a 6 ounce grilled salmon fillet.", required:["salmon","grilled"], forbidden:["salad","sandwich"] },
    { id:"blueberries-fresh", query:"blueberries", context:"I ate 1 cup of fresh blueberries.", required:["blueberr"], forbidden:["juice","milk","dried","frozen","canned"] },
    { id:"spaghetti-cooked", query:"spaghetti", context:"I ate 2 cups of cooked spaghetti noodles with sauce logged separately.", required:["cooked"], requiredAny:["spaghetti","noodle","pasta"], forbidden:["spinach","squash","meatball","sauce","dry","protein fortified","rice noodle","egg noodle","whole grain"] },
    { id:"whole-egg", query:"egg", context:"Breakfast included 1 large whole egg.", required:["egg","whole"], forbidden:["yolk","dried","bread","burrito","soup"] },
    { id:"chicken-thigh-grilled", query:"chicken thigh", context:"I ate one grilled boneless skinless chicken thigh.", required:["chicken","thigh","grilled"], forbidden:["breaded","reheated","coated","skin eaten","with sauce","raw","stewed","sauteed","rotisserie"] },
    { id:"two-percent-milk", query:"2% milk", context:"I drank 1 cup of 2% dairy milk.", required:["milk","2%"], forbidden:["yogurt","rennin","mix","chocolate","strawberry","evaporated","lactose free"] },
    { id:"skim-milk", query:"skim milk", context:"I used 1 cup of skim milk in the recipe.", required:["milk"], requiredAny:["skim","fat free","nonfat"], forbidden:["yogurt","chocolate","strawberry","cheese","evaporated","lactose free"] },
    { id:"peanut-butter-creamy", query:"peanut butter", context:"I spread 2 tablespoons of plain creamy peanut butter on toast.", required:["peanut","butter"], forbidden:["powder","cookie","candy","sandwich","granola"] },
    { id:"greek-yogurt-nonfat", query:"greek yogurt", context:"I ate 1 cup of plain nonfat Greek yogurt.", required:["yogurt"], requiredAny:["greek","strained"], forbidden:["flavored","vanilla","strawberry","whole milk","lowfat"] },
    { id:"sweet-potato-baked", query:"sweet potato", context:"I ate one baked sweet potato with no toppings.", required:["sweet potato"], forbidden:["fries","casserole","pie","candied","chips"] },
    { id:"avocado-raw", query:"avocado", context:"I ate half of a plain raw avocado.", required:["avocado"], forbidden:["dip","guacamole","oil","toast"] },
    { id:"black-beans-canned", query:"black beans", context:"I ate canned black beans, drained and rinsed.", required:["black","bean"], forbidden:["soup","dip","sauce","refried"] },
    { id:"tuna-water-canned", query:"tuna", context:"I ate canned light tuna packed in water, drained.", required:["tuna"], requiredAny:["water","canned"], forbidden:["oil","salad","sandwich","noodle"] },
    { id:"rolled-oats-dry", query:"oats", context:"I measured 1/2 cup of dry old-fashioned rolled oats before cooking.", required:["oat"], forbidden:["cookie","cereal bar","granola","instant flavored","cooked"] },
    { id:"olive-oil", query:"olive oil", context:"I used 1 tablespoon of plain olive oil for cooking.", required:["olive","oil"], forbidden:["dressing","spread","margarine"] },
    { id:"flour-tortilla", query:"tortilla", context:"I ate one plain flour tortilla.", required:["tortilla"], requiredAny:["flour","wheat"], forbidden:["corn","chips","bowl"] },
    { id:"cottage-cheese-2pct", query:"cottage cheese", context:"I ate 1 cup of 2% low-fat cottage cheese.", required:["cottage","cheese"], requiredAny:["2%","lowfat","low fat"], forbidden:["nonfat","cream cottage"] },
    { id:"chicken-broth", query:"chicken broth", context:"The soup used plain ready-to-serve chicken broth.", required:["chicken"], requiredAny:["broth","stock"], forbidden:["soup","gravy","bouillon cube"] },
    { id:"almond-milk-unsweetened", query:"almond milk", context:"I drank unsweetened plain almond milk.", required:["almond"], requiredAny:["milk","beverage"], forbidden:["sweetened","chocolate","vanilla","yogurt"] },
    { id:"banana-raw", query:"banana", context:"I ate one plain fresh banana.", required:["banana"], forbidden:["chips","bread","pudding","dried","fried"] },
    { id:"broccoli-cooked", query:"broccoli", context:"I ate steamed cooked broccoli with no sauce.", required:["broccoli"], requiredAny:["cooked","steamed","boiled"], forbidden:["raw","casserole","cheese","soup"] },
    { id:"ground-beef-lean", query:"ground beef", context:"I ate cooked 90% lean ground beef with no sauce.", required:["ground","beef"], requiredAny:["90","lean"], forbidden:["patty","meatloaf","sauce","breaded"] },
    { id:"cheddar-cheese", query:"cheddar cheese", context:"I ate one ounce of regular cheddar cheese.", required:["cheddar","cheese"], forbidden:["sauce","spread","reduced fat","low fat","nonfat"] }
];

function norm(value:string):string {
    return value.toLowerCase().replace(/[^a-z0-9%]+/g," ").trim();
}

function candidatePasses(def:CaseDefinition, candidate:FoodCandidate | undefined):boolean {
    if (!candidate) return false;
    const name = norm([candidate.brand, candidate.name].filter(Boolean).join(" "));
    const hasRequired = def.required.every(t => name.includes(norm(t)));
    const hasAny = !def.requiredAny?.length || def.requiredAny.some(t => name.includes(norm(t)));
    const avoids = def.forbidden.every(t => !name.includes(norm(t)));
    return hasRequired && hasAny && avoids;
}

function candidateView(candidate:FoodCandidate,index:number) {
    const s = summarizeFoodCandidate(candidate);
    return {
        key:"c"+index,
        index,
        candidate_id:s.candidate_id,
        name:s.name,
        brand:s.brand,
        provider:s.provider,
        data_kind:s.data_kind,
        confidence:s.confidence,
        portion:s.default_portion
    };
}

async function typesafeDecision(def:CaseDefinition, candidates:FoodCandidate[]) {
    const views = candidates.map(candidateView);
    const criteria:Record<string,string|null> = {};
    for (const v of views) {
        criteria[v.key] = JSON.stringify({
            name:v.name, brand:v.brand, provider:v.provider, data_kind:v.data_kind,
            default_portion:v.portion
        });
    }
    criteria.NO_MATCH = "None of the listed foods is a defensible nutritional match for the user's explicit food identity and preparation/form.";
    const state = {
        user_query:def.query,
        eating_context:def.context,
        candidates:views.map(v => ({
            key:v.key, name:v.name, brand:v.brand, provider:v.provider,
            data_kind:v.data_kind, confidence:v.confidence, default_portion:v.portion
        }))
    };
    const started = performance.now();
    const response = await fetch("https://api.typesafe.ai/v1/systemone",{
        method:"POST",
        headers:{ authorization:"Bearer "+typesafeKey, "content-type":"application/json" },
        body:JSON.stringify({
            model:JEV_MODEL,
            state,
            questions:{
                best_candidate:{
                    type:"choice",
                    instructions:"Choose the single candidate that best matches the full eating context for nutrition logging. Candidate order is retrieval relevance, not truth. Respect explicit food form, preparation, species, fat level, packing medium, and branded/generic facts. Do not invent facts. Prefer a generic nutritionally equivalent food over a candidate that contradicts an explicit fact. Choose NO_MATCH if none is defensible.",
                    criteria
                },
                any_defensible_match:{
                    type:"noul",
                    instructions:"Does at least one listed candidate defensibly match the user's full eating context for nutrition logging?",
                    criteria:{
                        true:"At least one candidate is nutritionally and semantically consistent with all important explicit facts.",
                        false:"Every candidate conflicts with an important explicit fact or represents a different food."
                    }
                }
            }
        }),
        signal:AbortSignal.timeout(30000)
    });
    const durationMs = performance.now()-started;
    if (!response.ok) throw new Error("TypeSafe HTTP "+response.status+" "+(await response.text()).slice(0,500));
    const payload:any = await response.json();
    const answer = payload?.answers?.best_candidate;
    const anyMatch = payload?.answers?.any_defensible_match;
    if (answer?.type !== "choice") throw new Error("TypeSafe missing choice answer");
    const choice = String(answer.choice);
    const index = /^c\d+$/.test(choice) ? Number(choice.slice(1)) : -1;
    const usage = payload.usage || {};
    const inputTokens = Number(usage.input_tokens || 0);
    return {
        model:String(payload.model || JEV_MODEL),
        choice,
        selectedIndex:index,
        selectedName:index>=0 ? candidates[index]?.name ?? null : null,
        confidence:Number(answer.confidence ?? 0),
        chosenProbability:Number(answer.probabilities?.[choice] ?? 0),
        anyMatch:Number(anyMatch?.noul ?? 0),
        durationMs,
        inputTokens,
        outputTokens:Number(usage.output_tokens || 0),
        estimatedCostUsd:inputTokens/1_000_000*TS_PRICE_INPUT_PER_M
    };
}

async function qwenDecision(def:CaseDefinition, candidates:FoodCandidate[]) {
    const views = candidates.map(candidateView);
    const options = [...views.map(v=>v.key),"NO_MATCH"];
    const started = performance.now();
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions",{
        method:"POST",
        headers:{
            authorization:"Bearer "+openrouterKey,
            "content-type":"application/json",
            "HTTP-Referer":"https://munch.business",
            "X-Title":"Munch Jev food matching audit"
        },
        body:JSON.stringify({
            model:QWEN_MODEL,
            temperature:0,
            reasoning:{enabled:false},
            max_tokens:200,
            messages:[
                {role:"system",content:"Select the single food database candidate that best matches the user's complete eating context for nutrition logging. Candidate order is retrieval relevance, not correctness. Respect explicit preparation, form, species, fat level, packing medium, and generic/branded facts. Prefer a generic nutritionally equivalent candidate over one that contradicts explicit facts. If none is defensible, choose NO_MATCH. Return only the required JSON."},
                {role:"user",content:JSON.stringify({query:def.query,context:def.context,candidates:views})}
            ],
            response_format:{
                type:"json_schema",
                json_schema:{
                    name:"food_match_choice",
                    strict:true,
                    schema:{
                        type:"object",
                        additionalProperties:false,
                        required:["choice","confidence"],
                        properties:{
                            choice:{type:"string",enum:options},
                            confidence:{type:"number",minimum:0,maximum:1}
                        }
                    }
                }
            }
        }),
        signal:AbortSignal.timeout(60000)
    });
    const durationMs = performance.now()-started;
    if (!response.ok) throw new Error("OpenRouter HTTP "+response.status+" "+(await response.text()).slice(0,500));
    const payload:any = await response.json();
    const raw = payload?.choices?.[0]?.message?.content;
    if (!raw) throw new Error("Qwen returned no content");
    const parsed = JSON.parse(raw);
    const choice = String(parsed.choice);
    const index = /^c\d+$/.test(choice) ? Number(choice.slice(1)) : -1;
    const usage = payload.usage || {};
    const inputTokens = Number(usage.prompt_tokens || usage.input_tokens || 0);
    const outputTokens = Number(usage.completion_tokens || usage.output_tokens || 0);
    return {
        model:QWEN_MODEL,
        choice,
        selectedIndex:index,
        selectedName:index>=0 ? candidates[index]?.name ?? null : null,
        confidence:Number(parsed.confidence ?? 0),
        durationMs,
        inputTokens,
        outputTokens,
        estimatedCostUsd:inputTokens/1_000_000*QWEN_PRICE_INPUT_PER_M + outputTokens/1_000_000*QWEN_PRICE_OUTPUT_PER_M
    };
}

function percentile(values:number[], p:number):number {
    if (!values.length) return 0;
    const sorted=[...values].sort((a,b)=>a-b);
    const idx=Math.min(sorted.length-1,Math.max(0,Math.ceil(p*sorted.length)-1));
    return sorted[idx]!;
}

function summarize(label:string, rows:any[]) {
    const eligible=rows.filter(r=>r.oracleHasMatch);
    const correct=eligible.filter(r=>r[label]?.correct).length;
    const noMatchRows=rows.filter(r=>!r.oracleHasMatch);
    const noMatchCorrect=noMatchRows.filter(r=>r[label]?.selectedIndex===-1).length;
    const durations=rows.map(r=>Number(r[label]?.durationMs||0)).filter(v=>v>0);
    const costs=rows.map(r=>Number(r[label]?.estimatedCostUsd||0));
    return {
        evaluated_with_oracle_match:eligible.length,
        correct,
        accuracy:eligible.length ? correct/eligible.length : 0,
        no_oracle_match_cases:noMatchRows.length,
        no_match_correct:noMatchCorrect,
        overall_correct:rows.filter(r=>r[label]?.correct).length,
        overall_accuracy:rows.length ? rows.filter(r=>r[label]?.correct).length/rows.length : 0,
        latency_ms:{p50:percentile(durations,.5),p90:percentile(durations,.9),p95:percentile(durations,.95),mean:durations.reduce((a,b)=>a+b,0)/(durations.length||1)},
        total_estimated_cost_usd:costs.reduce((a,b)=>a+b,0),
        mean_estimated_cost_usd:costs.reduce((a,b)=>a+b,0)/(costs.length||1)
    };
}

const search = new FoodSearchService();
const rows:any[]=[];

for (const def of CASES) {
    const searchStarted=performance.now();
    const retrieved=await search.search(def.query,LIMIT);
    const candidates=retrieved.candidates.slice(0,LIMIT);
    const oracleIndexes=candidates.map((c,i)=>candidatePasses(def,c)?i:-1).filter(i=>i>=0);
    const oracleHasMatch=oracleIndexes.length>0;
    const deterministicIndex=candidates.length ? 0 : -1;
    const deterministicCorrect=oracleHasMatch ? oracleIndexes.includes(deterministicIndex) : deterministicIndex===-1;

    const jev=await typesafeDecision(def,candidates);
    const qwen=await qwenDecision(def,candidates);
    jev.correct=oracleHasMatch ? oracleIndexes.includes(jev.selectedIndex) : jev.selectedIndex===-1;
    qwen.correct=oracleHasMatch ? oracleIndexes.includes(qwen.selectedIndex) : qwen.selectedIndex===-1;

    rows.push({
        id:def.id,
        query:def.query,
        context:def.context,
        searchDurationMs:performance.now()-searchStarted-jev.durationMs-qwen.durationMs,
        providerFailures:retrieved.failures,
        candidates:candidates.map((c,i)=>({...candidateView(c,i),oraclePass:oracleIndexes.includes(i)})),
        oracleIndexes,
        oracleHasMatch,
        deterministic:{selectedIndex:deterministicIndex,selectedName:candidates[0]?.name??null,correct:deterministicCorrect,strongLocal:isStrongLocalMatch(def.query,candidates[0])},
        jev,
        qwen
    });
    console.log("[jev_audit_case] "+JSON.stringify({id:def.id,oracle:oracleIndexes,deterministic:deterministicCorrect,jev:jev.correct,qwen:qwen.correct,jev_ms:Math.round(jev.durationMs),qwen_ms:Math.round(qwen.durationMs),jev_conf:jev.confidence,jev_any:jev.anyMatch}));
}

const stabilityTargets=rows
    .filter(r=>r.oracleHasMatch)
    .sort((a,b)=>Number(a.jev.confidence)-Number(b.jev.confidence))
    .slice(0,8);
const stability:any[]=[];
for (const target of stabilityTargets) {
    const def=CASES.find(c=>c.id===target.id)!;
    const candidates=target.candidates.map((v:any)=> {
        const originalIndex=Number(v.index);
        return rows.find(r=>r.id===target.id)._rawCandidates?.[originalIndex];
    }).filter(Boolean);
}
// Re-retrieve stability cases so report remains serializable and implementation simple.
for (const target of stabilityTargets) {
    const def=CASES.find(c=>c.id===target.id)!;
    const retrieved=await search.search(def.query,LIMIT);
    const candidates=retrieved.candidates.slice(0,LIMIT);
    const runs:any[]=[];
    for (let i=0;i<3;i++) runs.push(await typesafeDecision(def,candidates));
    stability.push({
        id:def.id,
        firstChoice:target.jev.choice,
        repeatChoices:runs.map(r=>r.choice),
        allSame:runs.every(r=>r.choice===target.jev.choice),
        confidence:[target.jev.confidence,...runs.map(r=>r.confidence)]
    });
}

const thresholds=[0.5,0.6,0.7,0.8,0.9,0.95];
const thresholdPolicies=thresholds.map(t=>{
    let accepted=0,acceptedCorrect=0,fallback=0;
    for (const r of rows) {
        if (r.deterministic.strongLocal && r.deterministic.correct) {
            accepted++; acceptedCorrect++; continue;
        }
        const acceptJev=r.jev.choice!=="NO_MATCH" && r.jev.confidence>=t && r.jev.anyMatch>=t;
        if (acceptJev) {
            accepted++;
            if (r.jev.correct) acceptedCorrect++;
        } else {
            fallback++;
        }
    }
    return {threshold:t,accepted,acceptedCorrect,precision:accepted?acceptedCorrect/accepted:0,fallback,fallbackRate:fallback/rows.length};
});

const summary={
    generatedAt:new Date().toISOString(),
    cases:rows.length,
    jevModel:JEV_MODEL,
    qwenModel:QWEN_MODEL,
    retrievalOracleCoverage:rows.filter(r=>r.oracleHasMatch).length/rows.length,
    deterministic:summarize("deterministic",rows),
    jev:summarize("jev",rows),
    qwen:summarize("qwen",rows),
    stability:{
        cases:stability.length,
        fullyStable:stability.filter(s=>s.allSame).length,
        rate:stability.length?stability.filter(s=>s.allSame).length/stability.length:0,
        details:stability
    },
    thresholdPolicies
};

const report={summary,rows};
mkdirSync("artifacts",{recursive:true});
writeFileSync("artifacts/jev-food-matching-audit.json",JSON.stringify(report,null,2));

const pct=(v:number)=>(v*100).toFixed(1)+"%";
const usd=(v:number)=>"$"+v.toFixed(6);
const md=[
    "# Jev food matching audit",
    "",
    "Cases: **"+summary.cases+"**",
    "",
    "| Path | Accuracy | p50 | p95 | Estimated cost |",
    "|---|---:|---:|---:|---:|",
    "| Deterministic top-1 | "+pct(summary.deterministic.overall_accuracy)+" | n/a | n/a | $0 |",
    "| Jev | "+pct(summary.jev.overall_accuracy)+" | "+Math.round(summary.jev.latency_ms.p50)+" ms | "+Math.round(summary.jev.latency_ms.p95)+" ms | "+usd(summary.jev.total_estimated_cost_usd)+" |",
    "| Qwen | "+pct(summary.qwen.overall_accuracy)+" | "+Math.round(summary.qwen.latency_ms.p50)+" ms | "+Math.round(summary.qwen.latency_ms.p95)+" ms | "+usd(summary.qwen.total_estimated_cost_usd)+" |",
    "",
    "Retrieval oracle coverage: **"+pct(summary.retrievalOracleCoverage)+"**",
    "",
    "Jev stability on lowest-confidence matched cases: **"+summary.stability.fullyStable+"/"+summary.stability.cases+"**",
    "",
    "## Confidence routing",
    "",
    "| Threshold | Accepted without Qwen | Precision of accepted | Qwen fallback rate |",
    "|---:|---:|---:|---:|",
    ...summary.thresholdPolicies.map(p=>"| "+p.threshold.toFixed(2)+" | "+p.accepted+"/"+summary.cases+" | "+pct(p.precision)+" | "+pct(p.fallbackRate)+" |")
].join("\n");

writeFileSync("artifacts/jev-food-matching-audit.md",md+"\n");
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,"\n"+md+"\n");
console.log("[jev_audit_summary] "+JSON.stringify(summary));
await closePlatformDatabase();
