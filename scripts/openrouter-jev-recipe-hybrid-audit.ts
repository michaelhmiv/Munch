#!/usr/bin/env bun

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import type { FoodCandidate } from "../src/food-providers/types.js";
import { OpenRouterDecisionClient } from "../src/website-decision-client.js";
import { fetchRecipePage } from "../src/recipe-import/fetch.js";
import { previewRecipeUrl } from "../src/recipe-import/service.js";
import {
  HybridRecipeImportResolver,
  OpenRouterRecipeImportResolver,
  recipeImportAiConfig,
} from "../src/recipe-import/semantic-resolver.js";
import { RECIPE_IMPORT_CORPUS } from "../src/recipe-import/fixtures/recipe-corpus.js";

const openrouterKey=process.env.OPENROUTER_API_KEY?.trim();
if(!openrouterKey) throw new Error("OPENROUTER_API_KEY is required");
const JEV_MODEL=process.env.JEV_MODEL?.trim()||"~typesafe/jev-latest";
const QWEN_MODEL=process.env.QWEN_MODEL?.trim()||"qwen/qwen3.7-flash";
const QWEN_PRICE_INPUT_PER_M=0.03;
const QWEN_PRICE_OUTPUT_PER_M=0.13;

type Meter={calls:number;durationMs:number;inputTokens:number;outputTokens:number;costUsd:number;retries:number};
const blankMeter=():Meter=>({calls:0,durationMs:0,inputTokens:0,outputTokens:0,costUsd:0,retries:0});

async function retryFetch(label:string,input:RequestInfo|URL,init?:RequestInit,meter?:Meter,maxAttempts=8):Promise<Response>{
 let last:unknown;
 for(let attempt=0;attempt<maxAttempts;attempt++){
  try{
   const r=await fetch(input,init);
   if(![429,529].includes(r.status)&&r.status<500) return r;
   if(attempt===maxAttempts-1) return r;
   meter && (meter.retries+=1);
   const retryAfter=Number(r.headers.get("retry-after")||"0");
   await r.arrayBuffer().catch(()=>new ArrayBuffer(0));
   await Bun.sleep(retryAfter>0?retryAfter*1000:Math.min(15000,1000*Math.pow(2,attempt)));
  }catch(e){
   last=e;
   if(attempt===maxAttempts-1) throw e;
   meter && (meter.retries+=1);
   await Bun.sleep(Math.min(15000,1000*Math.pow(2,attempt)));
  }
 }
 throw last instanceof Error?last:new Error(label+" failed");
}

function openRouterMeteredFetcher(meter:Meter){
 return async(input:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{
  const started=performance.now();
  const r=await retryFetch("OpenRouter",input,init,meter);
  const text=await r.text();
  meter.calls+=1;
  meter.durationMs+=performance.now()-started;
  try{
   const p=JSON.parse(text);
   const u=p?.usage||{};
   const inputTokens=Number(u.prompt_tokens||u.input_tokens||0);
   const outputTokens=Number(u.completion_tokens||u.output_tokens||0);
   meter.inputTokens+=inputTokens;
   meter.outputTokens+=outputTokens;
   meter.costUsd+=inputTokens/1_000_000*QWEN_PRICE_INPUT_PER_M+outputTokens/1_000_000*QWEN_PRICE_OUTPUT_PER_M;
  }catch{}
  return new Response(text,{status:r.status,statusText:r.statusText,headers:r.headers});
 };
}

function jevMeteredFetcher(meter:Meter){
 return async(input:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{
  const started=performance.now();
  const r=await fetch(input,init);
  const text=await r.text();
  meter.calls+=1;
  meter.durationMs+=performance.now()-started;
  if([429,529].includes(r.status)||r.status>=500) meter.retries+=1;
  try{
   const p=JSON.parse(text);
   const u=p?.usage||{};
   meter.inputTokens+=Number(u.input_tokens||0);
   meter.outputTokens+=Number(u.output_tokens||0);
   meter.costUsd+=Number(u.cost||0);
  }catch{}
  return new Response(text,{status:r.status,statusText:r.statusText,headers:r.headers});
 };
}

const portionUnits=[
 ["g","1 gram"],["cup","1 cup"],["tbsp","1 tablespoon"],["tsp","1 teaspoon"],
 ["lb","1 pound"],["piece","1 piece"],["slice","1 slice"],["clove","1 clove"],
 ["head","1 head"],["sprig","1 sprig"],["oz","1 ounce"],["each","1 each"]
] as const;

function foodCandidate(query:string,kind:"target"|"snack"|"sauce"):FoodCandidate{
 const name=kind==="target"?query:kind==="snack"?query+" flavored prepared snack":query+" sauce, prepared";
 return{
  provider:"usda",
  providerFoodId:kind+"-"+encodeURIComponent(query).slice(0,150),
  name,
  dataKind:kind==="target"?"generic":"packaged",
  brand:kind==="target"?undefined:kind==="snack"?"Benchmark Snack Co":"Benchmark Sauce Co",
  portions:portionUnits.map(([unit,label])=>({
   id:unit,amount:1,unit,label,gramWeight:100,
   nutrients:{calories:kind==="target"?100:kind==="snack"?220:160,protein_g:kind==="target"?5:2,carbs_g:kind==="target"?10:25,fat_g:kind==="target"?4:12}
  })),
  attribution:{label:"Jev benchmark fixture"},
  confidence:0.78
 };
}
function candidatesFor(query:string){return [foodCandidate(query,"target"),foodCandidate(query,"snack"),foodCandidate(query,"sauce")];}

function draftQuality(draft:any){
 const unresolved=draft.ingredient_review.filter((x:any)=>x.resolution==="unresolved").length;
 const ambiguous=draft.ingredient_review.filter((x:any)=>x.resolution==="ambiguous").length;
 const blocking=draft.warnings.filter((x:any)=>x.blocking!==false).length;
 const targetSelections=draft.recipe.ingredients.filter((x:any)=>String(x.provider_food_id||"").startsWith("target-")).length;
 const decoySelections=draft.recipe.ingredients.filter((x:any)=>/^snack-|^sauce-/.test(String(x.provider_food_id||""))).length;
 const modelEstimates=draft.recipe.ingredients.filter((x:any)=>x.source_type==="model_estimate").length;
 return{ingredients:draft.recipe.ingredients.length,unresolved,ambiguous,blocking,requiresReview:draft.requires_review,nutritionStatus:draft.nutrition.status,targetSelections,decoySelections,modelEstimates,ok:draft.recipe.ingredients.length>0&&unresolved===0&&ambiguous===0&&!draft.requires_review&&blocking===0&&decoySelections===0};
}

const baseConfig=recipeImportAiConfig();
if(!baseConfig) throw new Error("OpenRouter recipe config unavailable");
const qwenConfig={...baseConfig,model:QWEN_MODEL,maxCallsPerImport:2,responseFormat:"json_object" as const,responseHealing:true};

mkdirSync("artifacts",{recursive:true});
const rows:any[]=[];
for(const entry of RECIPE_IMPORT_CORPUS){
 const row:any={id:entry.id,site:entry.site,url:entry.url};
 let page;
 try{
  const fs=performance.now();
  page=await fetchRecipePage(entry.url);
  row.fetchMs=performance.now()-fs;
  row.htmlBytes=page.html.length;
 }catch(e){
  row.fetchError=e instanceof Error?e.message:String(e);
  rows.push(row);continue;
 }
 const foodSearch={search:async(query:string)=>({candidates:candidatesFor(query),failures:[]})};

 const baselineMeter=blankMeter();
 const baselineResolver=new OpenRouterRecipeImportResolver(qwenConfig,{fetcher:openRouterMeteredFetcher(baselineMeter)});
 try{
  const s=performance.now();
  const draft=await previewRecipeUrl(entry.url,{fetchPage:async()=>page,semanticResolver:baselineResolver,foodSearch});
  row.baseline={durationMs:performance.now()-s,meter:baselineMeter,quality:draftQuality(draft)};
 }catch(e){row.baseline={error:e instanceof Error?e.message:String(e),meter:baselineMeter};}

 const hybridQwenMeter=blankMeter();
 const jevMeter=blankMeter();
 const hybridQwen=new OpenRouterRecipeImportResolver(qwenConfig,{fetcher:openRouterMeteredFetcher(hybridQwenMeter)});
 const decisionClient=new OpenRouterDecisionClient(
  {
   apiKey:openrouterKey,
   model:JEV_MODEL,
   endpoint:"https://openrouter.ai/api/alpha/decisions",
   timeoutMs:10_000,
   minConfidence:0.75
  },
  {fetcher:jevMeteredFetcher(jevMeter)}
 );
 const hybridResolver=new HybridRecipeImportResolver(hybridQwen,decisionClient);
 try{
  const s=performance.now();
  const draft=await previewRecipeUrl(entry.url,{fetchPage:async()=>page,semanticResolver:hybridResolver,foodSearch});
  row.hybrid={durationMs:performance.now()-s,qwenMeter:hybridQwenMeter,jevMeter,quality:draftQuality(draft)};
 }catch(e){row.hybrid={error:e instanceof Error?e.message:String(e),qwenMeter:hybridQwenMeter,jevMeter};}

 rows.push(row);
 writeFileSync("artifacts/openrouter-jev-recipe-hybrid-partial.json",JSON.stringify({rows},null,2));
 console.log("[hybrid_recipe] "+JSON.stringify({id:entry.id,baselineMs:Math.round(row.baseline?.durationMs||0),hybridMs:Math.round(row.hybrid?.durationMs||0),baselineOk:row.baseline?.quality?.ok??false,hybridOk:row.hybrid?.quality?.ok??false,baselineCalls:row.baseline?.meter?.calls??0,hybridQwenCalls:row.hybrid?.qwenMeter?.calls??0,hybridJevCalls:row.hybrid?.jevMeter?.calls??0}));
 await Bun.sleep(250);
}

const comparable=rows.filter(r=>r.baseline?.quality&&r.hybrid?.quality);
function sum(path:(r:any)=>number){return comparable.reduce((s,r)=>s+path(r),0);}
function percentile(values:number[],p:number){const a=[...values].sort((x,y)=>x-y);return a[Math.max(0,Math.ceil(a.length*p)-1)]??0;}
const bTimes=comparable.map(r=>r.baseline.durationMs),hTimes=comparable.map(r=>r.hybrid.durationMs);
const baselineCost=sum(r=>r.baseline.meter.costUsd);
const hybridCost=sum(r=>r.hybrid.qwenMeter.costUsd+r.hybrid.jevMeter.costUsd);
const summary={
 generatedAt:new Date().toISOString(),requested:RECIPE_IMPORT_CORPUS.length,fetched:rows.filter(r=>!r.fetchError).length,comparable:comparable.length,
 baselinePassed:comparable.filter(r=>r.baseline.quality.ok).length,hybridPassed:comparable.filter(r=>r.hybrid.quality.ok).length,
 baselineDecoySelections:sum(r=>r.baseline.quality.decoySelections),hybridDecoySelections:sum(r=>r.hybrid.quality.decoySelections),
 baseline:{p50Ms:percentile(bTimes,.5),p95Ms:percentile(bTimes,.95),meanMs:sum(r=>r.baseline.durationMs)/(comparable.length||1),qwenCalls:sum(r=>r.baseline.meter.calls),qwenRetries:sum(r=>r.baseline.meter.retries),costUsd:baselineCost},
 hybrid:{p50Ms:percentile(hTimes,.5),p95Ms:percentile(hTimes,.95),meanMs:sum(r=>r.hybrid.durationMs)/(comparable.length||1),qwenCalls:sum(r=>r.hybrid.qwenMeter.calls),qwenRetries:sum(r=>r.hybrid.qwenMeter.retries),jevCalls:sum(r=>r.hybrid.jevMeter.calls),jevRetries:sum(r=>r.hybrid.jevMeter.retries),costUsd:hybridCost,qwenCostUsd:sum(r=>r.hybrid.qwenMeter.costUsd),jevCostUsd:sum(r=>r.hybrid.jevMeter.costUsd)},
 speedupP50:percentile(bTimes,.5)/percentile(hTimes,.5),
 speedupMean:(sum(r=>r.baseline.durationMs)/(comparable.length||1))/(sum(r=>r.hybrid.durationMs)/(comparable.length||1)),
 costRatio:hybridCost/(baselineCost||1)
};
writeFileSync("artifacts/openrouter-jev-recipe-hybrid-audit.json",JSON.stringify({summary,rows},null,2));
const pct=(x:number)=>(x*100).toFixed(1)+"%";
const usd=(x:number)=>"$"+x.toFixed(6);
const md=[
 "# OpenRouter Jev production recipe-import hybrid audit","",
 "Fetched/comparable corpus entries: **"+summary.comparable+"/"+summary.requested+"**.","",
 "| Path | Pass | p50 | p95 | Qwen calls | Jev calls | Cost |",
 "|---|---:|---:|---:|---:|---:|---:|",
 "| Current Qwen | "+summary.baselinePassed+"/"+summary.comparable+" | "+Math.round(summary.baseline.p50Ms)+" ms | "+Math.round(summary.baseline.p95Ms)+" ms | "+summary.baseline.qwenCalls+" | 0 | "+usd(summary.baseline.costUsd)+" |",
 "| Hybrid | "+summary.hybridPassed+"/"+summary.comparable+" | "+Math.round(summary.hybrid.p50Ms)+" ms | "+Math.round(summary.hybrid.p95Ms)+" ms | "+summary.hybrid.qwenCalls+" | "+summary.hybrid.jevCalls+" | "+usd(summary.hybrid.costUsd)+" |",
 "",
 "Median end-to-end AI-stage speedup: **"+summary.speedupP50.toFixed(2)+"x**; mean speedup: **"+summary.speedupMean.toFixed(2)+"x**.",
 "",
 "Hybrid/current cost ratio: **"+summary.costRatio.toFixed(2)+"x**."
].join("\n");
writeFileSync("artifacts/openrouter-jev-recipe-hybrid-audit.md",md+"\n");
if(process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,"\n"+md+"\n");
console.log("[hybrid_summary] "+JSON.stringify(summary));
