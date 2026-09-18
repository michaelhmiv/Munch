#!/usr/bin/env bun

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import type { FoodCandidate } from "../src/food-providers/types.js";
import { encodeFoodCandidateId, summarizeFoodCandidate } from "../src/food-providers/service.js";
import { fetchRecipePage } from "../src/recipe-import/fetch.js";
import { previewRecipeUrl } from "../src/recipe-import/service.js";
import {
  OpenRouterRecipeImportResolver,
  recipeImportAiConfig,
} from "../src/recipe-import/semantic-resolver.js";
import type {
  RecipeImportIngredientAssignment,
  RecipeImportIngredientAssignmentRequest,
  RecipeImportCandidateChoice,
  RecipeImportCandidateChoiceRequest,
  RecipeImportIngredientIntent,
  RecipeImportSemanticResolver,
  ParsedRecipe,
} from "../src/recipe-import/types.js";
import { RECIPE_IMPORT_CORPUS } from "../src/recipe-import/fixtures/recipe-corpus.js";

const typesafeKey=process.env.TYPESAFE_API_KEY?.trim();
const openrouterKey=process.env.OPENROUTER_API_KEY?.trim();
if(!typesafeKey) throw new Error("TYPESAFE_API_KEY is required");
if(!openrouterKey) throw new Error("OPENROUTER_API_KEY is required");
const JEV_MODEL=process.env.JEV_MODEL?.trim()||"jev-1.13.0";
const QWEN_MODEL=process.env.QWEN_MODEL?.trim()||"qwen/qwen3.7-flash";
const TS_PRICE_INPUT_PER_M=0.042;
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

class HybridResolver implements RecipeImportSemanticResolver{
 readonly label="hybrid:qwen-normalize+jev-candidate-assignment";
 jevMeter=blankMeter();
 constructor(private qwen:OpenRouterRecipeImportResolver,private threshold=0.55){}
 normalizeRecipe(recipe:Pick<ParsedRecipe,"name"|"description"|"servings"|"instructions"|"ingredients">):Promise<RecipeImportIngredientIntent[]>{
  return this.qwen.normalizeRecipe(recipe);
 }
 async jevAssignments(requests:RecipeImportIngredientAssignmentRequest[]):Promise<Map<string,RecipeImportIngredientAssignment>>{
  const result=new Map<string,RecipeImportIngredientAssignment>();
  if(!requests.length) return result;
  const mappings=requests.map((r,i)=>({r,q:"q"+i,candidates:r.candidates.slice(0,3)}));
  const questions:Record<string,unknown>={};
  for(const m of mappings){
   const criteria:Record<string,string|null>={};
   m.candidates.forEach((c,i)=>criteria["c"+i]=JSON.stringify(summarizeFoodCandidate(c)));
   criteria.NO_MATCH="No candidate is a defensible semantic/nutritional match.";
   questions[m.q]={
    type:"choice",
    instructions:"For ingredient "+JSON.stringify(m.r.ingredient.rawText)+", choose the candidate that best represents the ingredient for nutrition lookup. Prefer the base/generic food over a prepared snack, sauce, or other product that adds unsupported ingredients. Preserve explicit form/preparation when relevant. Choose NO_MATCH if none is defensible.",
    criteria
   };
  }
  const started=performance.now();
  const response=await retryFetch("TypeSafe","https://api.typesafe.ai/v1/systemone",{
   method:"POST",
   headers:{authorization:"Bearer "+typesafeKey,"content-type":"application/json"},
   body:JSON.stringify({model:JEV_MODEL,state:{task:"Munch recipe ingredient food-database assignment",ingredients:requests.map(r=>({key:r.key,reason:r.reason,raw:r.ingredient.rawText,name:r.ingredient.name,quantity:r.ingredient.quantity??null,unit:r.ingredient.unit??null}))},questions}),
   signal:AbortSignal.timeout(30000)
  },this.jevMeter);
  const elapsed=performance.now()-started;
  this.jevMeter.calls+=1;this.jevMeter.durationMs+=elapsed;
  if(!response.ok) throw new Error("TypeSafe HTTP "+response.status+" "+(await response.text()).slice(0,500));
  const p:any=await response.json();
  const u=p.usage||{};
  const inputTokens=Number(u.input_tokens||0),outputTokens=Number(u.output_tokens||0);
  this.jevMeter.inputTokens+=inputTokens;this.jevMeter.outputTokens+=outputTokens;
  this.jevMeter.costUsd+=inputTokens/1_000_000*TS_PRICE_INPUT_PER_M;
  const fallback:RecipeImportIngredientAssignmentRequest[]=[];
  for(const m of mappings){
   const a=p?.answers?.[m.q];
   const choice=String(a?.choice??"NO_MATCH");
   const confidence=Number(a?.confidence??0);
   const idx=/^c\d+$/.test(choice)?Number(choice.slice(1)):-1;
   const candidate=idx>=0?m.candidates[idx]:undefined;
   if(!candidate||confidence<this.threshold){
    fallback.push(m.r);continue;
   }
   result.set(m.r.key,{
    key:m.r.key,
    name:m.r.ingredient.name,
    ...(m.r.ingredient.quantity===undefined?{}:{quantity:m.r.ingredient.quantity}),
    ...(m.r.ingredient.unit?{unit:m.r.ingredient.unit}:{}),
    candidateId:encodeFoodCandidateId(candidate),
    decision:"provider_match",
    searchQueries:m.r.ingredient.searchQueries??[],
    confidence,
    rationale:"Jev bounded candidate selection"
   });
  }
  if(fallback.length){
   const qwenFallback=await this.qwen.resolveUncertainIngredients(fallback);
   for(const [k,v] of qwenFallback) result.set(k,v);
  }
  return result;
 }
 async resolveUncertainIngredients(requests:RecipeImportIngredientAssignmentRequest[]):Promise<Map<string,RecipeImportIngredientAssignment>>{
  const jevEligible=requests.filter(r=>r.reason==="ambiguous_candidate"&&r.candidates.length>0);
  const qwenRequired=requests.filter(r=>!(r.reason==="ambiguous_candidate"&&r.candidates.length>0));
  const result=await this.jevAssignments(jevEligible);
  if(qwenRequired.length){
   const fallback=await this.qwen.resolveUncertainIngredients(qwenRequired);
   for(const [k,v] of fallback) result.set(k,v);
  }
  return result;
 }
 async chooseCandidates(requests:RecipeImportCandidateChoiceRequest[]):Promise<Map<string,RecipeImportCandidateChoice>>{
  const assignments=await this.jevAssignments(requests.map(r=>({key:r.key,ingredient:r.ingredient,candidates:r.candidates,reason:"ambiguous_candidate"})));
  return new Map([...assignments].map(([k,a])=>[k,{candidateId:a.candidateId,confidence:a.confidence,rationale:a.rationale}]));
 }
}

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
 const hybridQwen=new OpenRouterRecipeImportResolver(qwenConfig,{fetcher:openRouterMeteredFetcher(hybridQwenMeter)});
 const hybridResolver=new HybridResolver(hybridQwen);
 try{
  const s=performance.now();
  const draft=await previewRecipeUrl(entry.url,{fetchPage:async()=>page,semanticResolver:hybridResolver,foodSearch});
  row.hybrid={durationMs:performance.now()-s,qwenMeter:hybridQwenMeter,jevMeter:hybridResolver.jevMeter,quality:draftQuality(draft)};
 }catch(e){row.hybrid={error:e instanceof Error?e.message:String(e),qwenMeter:hybridQwenMeter,jevMeter:hybridResolver.jevMeter};}

 rows.push(row);
 writeFileSync("artifacts/jev-recipe-hybrid-partial.json",JSON.stringify({rows},null,2));
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
writeFileSync("artifacts/jev-recipe-hybrid-audit.json",JSON.stringify({summary,rows},null,2));
const pct=(x:number)=>(x*100).toFixed(1)+"%";
const usd=(x:number)=>"$"+x.toFixed(6);
const md=[
 "# Jev recipe-import hybrid audit","",
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
writeFileSync("artifacts/jev-recipe-hybrid-audit.md",md+"\n");
if(process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,"\n"+md+"\n");
console.log("[hybrid_summary] "+JSON.stringify(summary));
