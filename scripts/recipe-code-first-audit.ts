#!/usr/bin/env bun

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import type { FoodCandidate } from "../src/food-providers/types.js";
import type { ParsedRecipe, RecipeImportSemanticResolver, RecipeImportIngredientIntent } from "../src/recipe-import/types.js";
import { parseIngredientText, parseRecipeHtml } from "../src/recipe-import/parser.js";
import { OpenRouterDecisionClient } from "../src/website-decision-client.js";
import { fetchRecipePage } from "../src/recipe-import/fetch.js";
import { previewRecipeUrl } from "../src/recipe-import/service.js";
import {
    HybridRecipeImportResolver,
    OpenRouterRecipeImportResolver,
    recipeImportAiConfig,
} from "../src/recipe-import/semantic-resolver.js";
import { CodeFirstRecipeImportResolver } from "../src/recipe-import/code-first-resolver.js";
import { RECIPE_IMPORT_CORPUS } from "../src/recipe-import/fixtures/recipe-corpus.js";

const openrouterKey = process.env.OPENROUTER_API_KEY?.trim();
if (!openrouterKey) throw new Error("OPENROUTER_API_KEY is required");
const JEV_MODEL = process.env.JEV_MODEL?.trim() || "~typesafe/jev-latest";
const QWEN_MODEL = process.env.QWEN_MODEL?.trim() || "qwen/qwen3.7-flash";
const QWEN_PRICE_INPUT_PER_M = 0.03;
const QWEN_PRICE_OUTPUT_PER_M = 0.13;

type Meter = {
    calls: number;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    retries: number;
};
const blankMeter = (): Meter => ({
    calls: 0,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    retries: 0,
});

async function retryFetch(
    label: string,
    input: RequestInfo | URL,
    init?: RequestInit,
    meter?: Meter,
    maxAttempts = 8,
): Promise<Response> {
    let last: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const r = await fetch(input, {
                ...init,
                signal: AbortSignal.timeout(60_000),
            });
            if (![429, 529].includes(r.status) && r.status < 500) return r;
            if (attempt === maxAttempts - 1) return r;
            meter && (meter.retries += 1);
            const retryAfter = Number(r.headers.get("retry-after") || "0");
            await r.arrayBuffer().catch(() => new ArrayBuffer(0));
            await Bun.sleep(
                retryAfter > 0
                    ? retryAfter * 1000
                    : Math.min(15000, 1000 * Math.pow(2, attempt)),
            );
        } catch (e) {
            last = e;
            if (attempt === maxAttempts - 1) throw e;
            meter && (meter.retries += 1);
            await Bun.sleep(Math.min(15000, 1000 * Math.pow(2, attempt)));
        }
    }
    throw last instanceof Error ? last : new Error(label + " failed");
}

function openRouterMeteredFetcher(meter: Meter) {
    return async (
        input: RequestInfo | URL,
        init?: RequestInit,
    ): Promise<Response> => {
        const started = performance.now();
        const r = await retryFetch("OpenRouter", input, init, meter);
        const text = await r.text();
        meter.calls += 1;
        meter.durationMs += performance.now() - started;
        try {
            const p = JSON.parse(text);
            const u = p?.usage || {};
            const inputTokens = Number(u.prompt_tokens || u.input_tokens || 0);
            const outputTokens = Number(
                u.completion_tokens || u.output_tokens || 0,
            );
            meter.inputTokens += inputTokens;
            meter.outputTokens += outputTokens;
            meter.costUsd +=
                (inputTokens / 1_000_000) * QWEN_PRICE_INPUT_PER_M +
                (outputTokens / 1_000_000) * QWEN_PRICE_OUTPUT_PER_M;
        } catch {}
        return new Response(text, {
            status: r.status,
            statusText: r.statusText,
            headers: r.headers,
        });
    };
}

function jevMeteredFetcher(meter: Meter) {
    return async (
        input: RequestInfo | URL,
        init?: RequestInit,
    ): Promise<Response> => {
        const started = performance.now();
        const r = await fetch(input, {
            ...init,
            signal: AbortSignal.timeout(60_000),
        });
        const text = await r.text();
        meter.calls += 1;
        meter.durationMs += performance.now() - started;
        if ([429, 529].includes(r.status) || r.status >= 500)
            meter.retries += 1;
        try {
            const p = JSON.parse(text);
            const u = p?.usage || {};
            meter.inputTokens += Number(u.input_tokens || 0);
            meter.outputTokens += Number(u.output_tokens || 0);
            meter.costUsd += Number(u.cost || 0);
        } catch {}
        return new Response(text, {
            status: r.status,
            statusText: r.statusText,
            headers: r.headers,
        });
    };
}

const portionUnits = [
    ["g", "1 gram"],
    ["cup", "1 cup"],
    ["tbsp", "1 tablespoon"],
    ["tsp", "1 teaspoon"],
    ["lb", "1 pound"],
    ["piece", "1 piece"],
    ["slice", "1 slice"],
    ["clove", "1 clove"],
    ["head", "1 head"],
    ["sprig", "1 sprig"],
    ["oz", "1 ounce"],
    ["each", "1 each"],
] as const;

function foodCandidate(
    query: string,
    kind: "target" | "snack" | "sauce",
): FoodCandidate {
    const name =
        kind === "target"
            ? query
            : kind === "snack"
              ? query + " flavored prepared snack"
              : query + " sauce, prepared";
    return {
        provider: "usda",
        providerFoodId: kind + "-" + encodeURIComponent(query).slice(0, 150),
        name,
        dataKind: kind === "target" ? "generic" : "packaged",
        brand:
            kind === "target"
                ? undefined
                : kind === "snack"
                  ? "Benchmark Snack Co"
                  : "Benchmark Sauce Co",
        portions: portionUnits.map(([unit, label]) => ({
            id: unit,
            amount: 1,
            unit,
            label,
            gramWeight: 100,
            nutrients: {
                calories:
                    kind === "target" ? 100 : kind === "snack" ? 220 : 160,
                protein_g: kind === "target" ? 5 : 2,
                carbs_g: kind === "target" ? 10 : 25,
                fat_g: kind === "target" ? 4 : 12,
            },
        })),
        attribution: { label: "Jev benchmark fixture" },
        confidence: 0.78,
    };
}
function candidatesFor(query: string) {
    return [
        foodCandidate(query, "target"),
        foodCandidate(query, "snack"),
        foodCandidate(query, "sauce"),
    ];
}

function draftQuality(draft: any) {
    const unresolved = draft.ingredient_review.filter(
        (x: any) => x.resolution === "unresolved",
    ).length;
    const ambiguous = draft.ingredient_review.filter(
        (x: any) => x.resolution === "ambiguous",
    ).length;
    const blocking = draft.warnings.filter(
        (x: any) => x.blocking !== false,
    ).length;
    const targetSelections = draft.recipe.ingredients.filter((x: any) =>
        String(x.provider_food_id || "").startsWith("target-"),
    ).length;
    const decoySelections = draft.recipe.ingredients.filter((x: any) =>
        /^snack-|^sauce-/.test(String(x.provider_food_id || "")),
    ).length;
    const modelEstimates = draft.recipe.ingredients.filter(
        (x: any) => x.source_type === "model_estimate",
    ).length;
    const decoyDetails = draft.recipe.ingredients
        .filter((x: any) =>
            /^snack-|^sauce-/.test(String(x.provider_food_id || "")),
        )
        .map((x: any) => ({
            name: x.name,
            raw: x.source_snapshot?.raw_ingredient,
            id: x.provider_food_id,
            sourceSnapshot: x.source_snapshot,
        }));
    return {
        ingredients: draft.recipe.ingredients.length,
        unresolved,
        ambiguous,
        blocking,
        requiresReview: draft.requires_review,
        nutritionStatus: draft.nutrition.status,
        targetSelections,
        decoySelections,
        decoyDetails,
        modelEstimates,
        ok:
            draft.recipe.ingredients.length > 0 &&
            unresolved === 0 &&
            ambiguous === 0 &&
            !draft.requires_review &&
            blocking === 0 &&
            decoySelections === 0,
    };
}

const baseConfig = recipeImportAiConfig();
if (!baseConfig) throw new Error("OpenRouter recipe config unavailable");
const qwenConfig = {
    ...baseConfig,
    model: QWEN_MODEL,
    maxCallsPerImport: 2,
    responseFormat: "json_object" as const,
    responseHealing: true,
};


type Mode = "qwen_only" | "code_only" | "code_first_jev" | "selective_qwen" | "code_first_jev_no_qwen" | "code_first_guarded";
type RecordRow = {id:string;site:string;url:string;fetchMs:number;parserStrategy:string;parserIngredients:number;parserWarnings:string[];modes:Record<string,unknown>};
const allRows:RecordRow[]=[];
const modes:Mode[]=(process.env.MUNCH_CODE_FIRST_MODES?.split(",").filter(Boolean) as Mode[] | undefined) ?? ["code_only","code_first_jev","selective_qwen","code_first_jev_no_qwen"];
const idFilter=process.env.MUNCH_JEV_AUDIT_CASE_ID?.trim();
const items=RECIPE_IMPORT_CORPUS.filter(x=>!idFilter||x.id===idFilter);
const runMode=(mode:Mode, parsed:ParsedRecipe,meter:Meter,jevMeter:Meter):RecipeImportSemanticResolver|undefined=>{
 if(mode==="code_only")return undefined;
 const qwen=new OpenRouterRecipeImportResolver(qwenConfig,{fetcher:openRouterMeteredFetcher(meter)});
 if(mode==="qwen_only")return qwen;
 const jev=new OpenRouterDecisionClient(
  {apiKey:openrouterKey,model:JEV_MODEL,endpoint:"https://openrouter.ai/api/alpha/decisions",timeoutMs:10_000,minConfidence:0.75},
  {fetcher:jevMeteredFetcher(jevMeter)}
 );
 const generative:RecipeImportSemanticResolver=mode==="code_first_jev_no_qwen"
   ? {
       label:"experiment:no-generative-model",
       normalizeRecipe:async()=>[],
       resolveUncertainIngredients:async()=>new Map(),
       chooseCandidates:async()=>new Map()
     }
   :qwen;
 if(mode==="code_first_guarded")return new CodeFirstRecipeImportResolver(qwen,jev);
 const hybrid=new HybridRecipeImportResolver(generative,jev);
 const risks=parsed.warnings.filter(w=>["quantity_unparsed","quantity_range"].includes(w.code));
 const possibleComposite=parsed.ingredients.some(i=> /\b(?:and|or)\b/i.test(i.name) && !/\b(?:salt and pepper|half and half)\b/i.test(i.name));
 const missedNumbers=parsed.ingredients.some(i=>i.quantity===undefined && /^\s*[0-9¼½¾⅓⅔⅛⅜⅝⅞]/.test(i.rawText));
 const needsQwen=risks.length>0||possibleComposite||missedNumbers;
 return {
  label:mode==="selective_qwen"?"experiment:selective-qwen+jev":"experiment:code-first+jev",
  normalizeRecipe:async(recipe):Promise<RecipeImportIngredientIntent[]>=>{
   if(mode==="selective_qwen" && needsQwen) return hybrid.normalizeRecipe(recipe);
   return recipe.ingredients.map((i,rawIndex)=>({
    rawIndex,componentIndex:0,rawText:i.rawText,name:i.name,
    ...(i.quantity===undefined?{}:{quantity:i.quantity}),
    ...(i.unit?{unit:i.unit}:{}),
    ...(i.preparation?{preparation:i.preparation}:{}),
    optional:Boolean(i.optional),searchQueries:[],
    impact: /\b(?:salt|pepper|thyme|parsley|bay leaf|oregano|basil|rosemary|sage|cumin|paprika|seasoning|spice|herb)\b/i.test(i.name)?"low":"medium",
    confidence:0.85
   }));
  },
  resolveUncertainIngredients:(requests)=>hybrid.resolveUncertainIngredients(requests),
  chooseCandidates:(requests)=>hybrid.chooseCandidates(requests)
 };
};
function auditDraft(draft:any){
 const quality=draftQuality(draft);
 const ingredients=draft.recipe.ingredients.map((i:any,index:number)=>({
  index,raw:draft.ingredient_review[index]?.raw_text,name:i.name,quantity:i.quantity??null,
  unit:i.unit??null,providerFoodId:i.provider_food_id??null,sourceType:i.source_type,
  resolution:draft.ingredient_review[index]?.resolution,nutrition:i.nutrients??{},
 }));
 return {quality,ingredients,warnings:draft.warnings,assumptions:draft.assumptions};
}
mkdirSync("artifacts",{recursive:true});
for(const entry of items){
 const fetchAt=performance.now();
 let page;
 try{page=await fetchRecipePage(entry.url);}catch(error){
  console.log("[code_first_fetch_error] "+JSON.stringify({id:entry.id,error:String(error)}));continue;
 }
 const fetchMs=performance.now()-fetchAt;
 const parsed=parseRecipeHtml(page.html);
 const flagged=parsed.ingredients.flatMap((ingredient,index)=>{
  const problems=parseIngredientText(ingredient.rawText).warnings.map(w=>w.code);
  return problems.length?[{index,raw:ingredient.rawText,name:ingredient.name,quantity:ingredient.quantity??null,unit:ingredient.unit??null,problems}]:[];
 });
 console.log("[code_first_source] "+JSON.stringify({id:entry.id,flagged}));
 const row:RecordRow={id:entry.id,site:entry.site,url:entry.url,fetchMs,parserStrategy:parsed.strategy,parserIngredients:parsed.ingredients.length,
 parserWarnings:parsed.warnings.map(w=>w.code),modes:{}};
 const foodSearch={search:async(query:string)=>({candidates:candidatesFor(query),failures:[]})};
 for(const mode of modes){
  const meter=blankMeter(),jevMeter=blankMeter();
  const resolver=runMode(mode,parsed,meter,jevMeter);
  const started=performance.now();
  try{
   const draft=await previewRecipeUrl(entry.url,{fetchPage:async()=>page,foodSearch,preserveSourceWarnings:mode!=="selective_qwen"&&mode!=="qwen_only",...(resolver?{semanticResolver:resolver}:{})});
   row.modes[mode]={durationMs:performance.now()-started,qwen:meter,jev:jevMeter,...auditDraft(draft)};
  }catch(error){
   row.modes[mode]={durationMs:performance.now()-started,qwen:meter,jev:jevMeter,error:String(error)};
  }
 }
 allRows.push(row);
 writeFileSync("artifacts/code-first-partial.json",JSON.stringify({rows:allRows},null,2));
 console.log("[code_first_case] "+JSON.stringify({id:row.id,fetchMs:Math.round(row.fetchMs),strategy:row.parserStrategy,warnings:row.parserWarnings,
  modes:Object.fromEntries(modes.map(m=>{const x:any=row.modes[m];return[m,{ms:Math.round(x.durationMs),qwen:x.qwen?.calls,jev:x.jev?.calls,ok:x.quality?.ok,decoy:x.quality?.decoySelections,ingredients:x.quality?.ingredients,missing:x.quality?.unresolved,ambiguous:x.quality?.ambiguous,error:x.error}] }))}));
}
function percentile(vals:number[],p:number){const a=[...vals].sort((x,y)=>x-y);return a[Math.max(0,Math.ceil(a.length*p)-1)]??0;}
const summary=Object.fromEntries(modes.map(m=>{
 const vals=allRows.map(x=>x.modes[m] as any);
 return [m,{sample:vals.length,ok:vals.filter(x=>x.quality?.ok).length,decoys:vals.reduce((a,x)=>a+(x.quality?.decoySelections||0),0),
  medianMs:percentile(vals.map(x=>x.durationMs),.5),p95Ms:percentile(vals.map(x=>x.durationMs),.95),
  qwenCalls:vals.reduce((a,x)=>a+(x.qwen?.calls||0),0),jevCalls:vals.reduce((a,x)=>a+(x.jev?.calls||0),0),
  costUsd:vals.reduce((a,x)=>a+(x.qwen?.costUsd||0)+(x.jev?.costUsd||0),0),
  ingredientCount:vals.reduce((a,x)=>a+(x.ingredients?.length||0),0),
  blocking:vals.reduce((a,x)=>a+(x.quality?.blocking||0),0)}];
}));
writeFileSync("artifacts/code-first-report.json",JSON.stringify({summary,rows:allRows},null,2));
console.log("[code_first_summary] "+JSON.stringify(summary));
