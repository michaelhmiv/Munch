#!/usr/bin/env python3

import json
import os
import re
import resource
import time
from scrapling.fetchers import StealthySession

CORPUS = [
    ("101 Cookbooks", "https://www.101cookbooks.com/spicy-cauliflower/"),
    ("Food Network", "https://www.foodnetwork.com/recipes/food-network-kitchen/gorgonzola-pasta-with-spinach-and-walnuts-10024399"),
    ("Natasha's Kitchen", "https://natashaskitchen.com/pierogi-recipe/"),
    ("The Mediterranean Dish", "https://www.themediterraneandish.com/mediterranean-vegetable-medley/"),
    ("Bon Appétit", "https://www.bonappetit.com/recipe/honey-glazed-lemon-chicken"),
    ("The Stay At Home Chef", "https://thestayathomechef.com/frito-pie/"),
    ("RecipeTin Eats", "https://www.recipetineats.com/one-pot-moussaka-beef-rice-pilaf/"),
    ("Spend with Pennies", "https://www.spendwithpennies.com/one-pot-chicken-pasta/"),
    ("Minimalist Baker", "https://minimalistbaker.com/easy-vegan-ramen/"),
    ("The Modern Proper", "https://themodernproper.com/stuffed-pepper-soup"),
    ("The Pioneer Woman", "https://www.thepioneerwoman.com/food-cooking/recipes/a35916631/lemon-thyme-sheet-pan-chicken-and-potatoes-recipe/"),
    ("Delish", "https://www.delish.com/cooking/recipe-ideas/a73467103/cheesy-ritz-cracker-chicken-cutlets-recipe/"),
    ("King Arthur Baking", "https://www.kingarthurbaking.com/recipes/big-and-bubbly-focaccia-recipe"),
    ("A Couple Cooks", "https://www.acouplecooks.com/apple-crisp-recipe/"),
    ("Epicurious", "https://www.epicurious.com/recipes/food/views/ba-syn-baked-feta-pasta-green-sauce"),
    ("Just One Cookbook", "https://www.justonecookbook.com/shrimp-pork-wonton/"),
    ("Once Upon a Chef", "https://www.onceuponachef.com/recipes/beef-stew-with-carrots-potatoes.html"),
    ("Budget Bytes", "https://www.budgetbytes.com/slow-cooker-white-chicken-chili/"),
    ("Skinnytaste", "https://www.skinnytaste.com/red-lentil-soup-with-spinach/"),
    ("Gimme Some Oven", "https://www.gimmesomeoven.com/baked-mac-and-cheese/"),
    ("Half Baked Harvest", "https://www.halfbakedharvest.com/slow-cooker-coq-au-vin/"),
    ("Allrecipes", "https://www.allrecipes.com/recipe/20144/banana-banana-bread/"),
    ("Serious Eats", "https://www.seriouseats.com/the-best-slow-cooked-bolognese-sauce-recipe"),
    ("Sally's Baking Addiction", "https://sallysbakingaddiction.com/chewy-chocolate-chip-cookies/"),
    ("BBC Good Food", "https://www.bbcgoodfood.com/recipes/chicken-tikka-masala"),
    ("Simply Recipes", "https://www.simplyrecipes.com/recipes/banana_bread/"),
]

BLOCKED_SITES = {"Allrecipes", "Serious Eats", "Simply Recipes"}
if os.environ.get("SCRAPLING_BLOCKERS_ONLY", "").lower() in {"1", "true", "yes"}:
    CORPUS = [entry for entry in CORPUS if entry[0] in BLOCKED_SITES]


def rss_mb():
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    if os.uname().sysname == "Darwin":
        return round(value / 1024 / 1024, 1)
    return round(value / 1024, 1)


def detect_recipe(html):
    recipe_json_ld = bool(re.search(r'["\']@type["\']\s*:\s*(?:["\']Recipe["\']|\[[^\]]*["\']Recipe["\'])', html, re.I))
    ingredient_signals = len(re.findall(r"recipeIngredient", html, re.I))
    instruction_signals = len(re.findall(r"recipeInstructions", html, re.I))
    title_match = re.search(r"<title\b[^>]*>([\s\S]*?)</title>", html, re.I)
    title = re.sub(r"<[^>]+>", " ", title_match.group(1)) if title_match else None
    if title:
        title = re.sub(r"\s+", " ", title).strip()[:180]
    return {
        "usable": bool(recipe_json_ld and ingredient_signals and instruction_signals),
        "recipeJsonLd": recipe_json_ld,
        "ingredientSignals": ingredient_signals,
        "instructionSignals": instruction_signals,
        "title": title,
    }


with StealthySession(headless=True, solve_cloudflare=True) as session:
    for site, url in CORPUS:
        started = time.perf_counter()
        try:
            page = session.fetch(url, google_search=False, network_idle=False)
            html = getattr(page, "html_content", None) or getattr(page, "html", None) or getattr(page, "text", None) or str(page)
            if not isinstance(html, str):
                html = str(html)
            detection = detect_recipe(html)
            print(json.dumps({
                "strategy": "scrapling",
                "site": site,
                "url": url,
                "ok": detection["usable"],
                "status": getattr(page, "status", None),
                "finalUrl": str(getattr(page, "url", url)),
                "durationMs": round((time.perf_counter() - started) * 1000, 2),
                "bytes": len(html.encode("utf-8", errors="ignore")),
                "rssMb": rss_mb(),
                "detection": detection,
                **({"error": "browser HTML did not contain complete Recipe JSON-LD"} if not detection["usable"] else {}),
            }), flush=True)
        except Exception as error:
            print(json.dumps({
                "strategy": "scrapling",
                "site": site,
                "url": url,
                "ok": False,
                "status": None,
                "finalUrl": None,
                "durationMs": round((time.perf_counter() - started) * 1000, 2),
                "bytes": 0,
                "rssMb": rss_mb(),
                "error": f"{type(error).__name__}: {error}",
            }), flush=True)
