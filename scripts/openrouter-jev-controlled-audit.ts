#!/usr/bin/env bun

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";

const openrouterKey = process.env.OPENROUTER_API_KEY?.trim();
if (!openrouterKey) throw new Error("OPENROUTER_API_KEY is required");

const JEV_MODEL = process.env.JEV_MODEL?.trim() || "~typesafe/jev-latest";
const QWEN_MODEL = process.env.QWEN_MODEL?.trim() || "qwen/qwen3.7-flash";
const JEV_PRICE_INPUT_PER_M = 0.042;
const QWEN_PRICE_INPUT_PER_M = 0.03;
const QWEN_PRICE_OUTPUT_PER_M = 0.13;

type Candidate = {
    id: string;
    name: string;
    brand?: string;
    kind?: "generic" | "packaged" | "branded" | "restaurant";
    portion?: string;
};
type Case = {
    id: string;
    query: string;
    context: string;
    expected: string | null;
    candidates: Candidate[];
};

const C = (
    id: string,
    name: string,
    brand?: string,
    kind: Candidate["kind"] = "generic",
    portion?: string,
): Candidate => ({ id, name, brand, kind, portion });

const CASES: Case[] = [
    {
        id: "bacon-regular",
        query: "bacon",
        context: "I ate 3 strips of regular pork bacon.",
        expected: "pork",
        candidates: [
            C(
                "pork",
                "Pork bacon, cooked, pan-fried",
                undefined,
                "generic",
                "1 slice",
            ),
            C(
                "turkey",
                "Turkey bacon, cooked",
                undefined,
                "generic",
                "1 slice",
            ),
            C("bits", "Bacon bits, imitation", undefined, "generic", "1 tbsp"),
        ],
    },
    {
        id: "bacon-bits",
        query: "bacon",
        context: "I added 2 tablespoons of real bacon bits to a salad.",
        expected: "bits",
        candidates: [
            C(
                "pork",
                "Pork bacon, cooked, pan-fried",
                undefined,
                "generic",
                "1 slice",
            ),
            C(
                "bits",
                "Bacon bits, cooked pork",
                undefined,
                "generic",
                "1 tbsp",
            ),
            C(
                "canadian",
                "Canadian bacon, cooked",
                undefined,
                "generic",
                "1 slice",
            ),
        ],
    },
    {
        id: "onion-raw",
        query: "onion",
        context:
            "The recipe used 1 medium onion, diced. Dicing is preparation only.",
        expected: "raw",
        candidates: [
            C("powder", "Onion powder", undefined, "generic", "1 tsp"),
            C("raw", "Onions, raw", undefined, "generic", "1 medium"),
            C(
                "rings",
                "Onion rings, breaded and fried",
                undefined,
                "generic",
                "1 ring",
            ),
        ],
    },
    {
        id: "white-rice-cooked",
        query: "white rice",
        context: "I ate 1 cup of cooked white rice.",
        expected: "cooked",
        candidates: [
            C(
                "dry",
                "Rice, white, long-grain, dry, unenriched",
                undefined,
                "generic",
                "100 g",
            ),
            C(
                "brown",
                "Rice, brown, long-grain, cooked",
                undefined,
                "generic",
                "1 cup",
            ),
            C(
                "cooked",
                "Rice, white, long-grain, cooked",
                undefined,
                "generic",
                "1 cup",
            ),
        ],
    },
    {
        id: "walnuts-plain",
        query: "walnuts",
        context: "I ate 1 ounce of plain raw walnuts.",
        expected: "plain",
        candidates: [
            C("glazed", "Walnuts, honey glazed", undefined, "packaged", "1 oz"),
            C("plain", "Nuts, walnuts, English", undefined, "generic", "1 oz"),
            C("oil", "Walnuts, oil roasted", undefined, "generic", "1 oz"),
        ],
    },
    {
        id: "salmon-grilled",
        query: "salmon",
        context: "Dinner included a 6 ounce grilled salmon fillet.",
        expected: "grilled",
        candidates: [
            C("raw", "Salmon, Atlantic, raw", undefined, "generic", "100 g"),
            C("smoked", "Salmon, smoked", undefined, "generic", "100 g"),
            C(
                "grilled",
                "Salmon, Atlantic, cooked, grilled",
                undefined,
                "generic",
                "100 g",
            ),
        ],
    },
    {
        id: "blueberries-fresh",
        query: "blueberries",
        context: "I ate 1 cup of fresh blueberries.",
        expected: "raw",
        candidates: [
            C(
                "dried",
                "Blueberries, dried, sweetened",
                undefined,
                "generic",
                "1 cup",
            ),
            C("raw", "Blueberries, raw", undefined, "generic", "1 cup"),
            C(
                "frozen",
                "Blueberries, frozen, sweetened",
                undefined,
                "generic",
                "1 cup",
            ),
        ],
    },
    {
        id: "spaghetti-cooked",
        query: "spaghetti",
        context:
            "I ate 2 cups of cooked plain spaghetti; sauce is logged separately.",
        expected: "cooked",
        candidates: [
            C(
                "dry",
                "Spaghetti, dry, unenriched",
                undefined,
                "generic",
                "2 oz",
            ),
            C(
                "cooked",
                "Spaghetti, cooked, unenriched, without added salt",
                undefined,
                "generic",
                "1 cup",
            ),
            C(
                "ww",
                "Spaghetti, whole-wheat, cooked",
                undefined,
                "generic",
                "1 cup",
            ),
        ],
    },
    {
        id: "egg-whole",
        query: "egg",
        context: "Breakfast included 1 large whole chicken egg.",
        expected: "whole",
        candidates: [
            C(
                "white",
                "Egg white, raw, fresh",
                undefined,
                "generic",
                "1 large",
            ),
            C(
                "whole",
                "Egg, whole, cooked, hard-boiled",
                undefined,
                "generic",
                "1 large",
            ),
            C("yolk", "Egg yolk, raw, fresh", undefined, "generic", "1 large"),
        ],
    },
    {
        id: "chicken-thigh-grilled",
        query: "chicken thigh",
        context: "I ate one grilled boneless skinless chicken thigh.",
        expected: "grilled",
        candidates: [
            C(
                "breaded",
                "Chicken thigh, breaded and fried",
                undefined,
                "generic",
                "1 piece",
            ),
            C(
                "grilled",
                "Chicken thigh, meat only, cooked, grilled",
                undefined,
                "generic",
                "100 g",
            ),
            C(
                "raw",
                "Chicken thigh, meat and skin, raw",
                undefined,
                "generic",
                "100 g",
            ),
        ],
    },
    {
        id: "milk-2pct",
        query: "2% milk",
        context: "I drank 1 cup of plain 2% dairy milk.",
        expected: "two",
        candidates: [
            C("skim", "Milk, nonfat, fluid", undefined, "generic", "1 cup"),
            C(
                "two",
                "Milk, reduced fat, 2% milkfat, fluid",
                undefined,
                "generic",
                "1 cup",
            ),
            C(
                "whole",
                "Milk, whole, 3.25% milkfat, fluid",
                undefined,
                "generic",
                "1 cup",
            ),
        ],
    },
    {
        id: "milk-skim",
        query: "skim milk",
        context: "I used 1 cup of plain skim/nonfat dairy milk.",
        expected: "skim",
        candidates: [
            C(
                "whole",
                "Milk, whole, 3.25% milkfat, fluid",
                undefined,
                "generic",
                "1 cup",
            ),
            C(
                "two",
                "Milk, reduced fat, 2% milkfat, fluid",
                undefined,
                "generic",
                "1 cup",
            ),
            C("skim", "Milk, nonfat, fluid", undefined, "generic", "1 cup"),
        ],
    },
    {
        id: "peanut-butter-creamy",
        query: "peanut butter",
        context:
            "I spread 2 tablespoons of plain creamy peanut butter on toast.",
        expected: "creamy",
        candidates: [
            C(
                "powder",
                "Peanut butter powder",
                undefined,
                "packaged",
                "2 tbsp",
            ),
            C(
                "creamy",
                "Peanut butter, smooth style, without salt",
                undefined,
                "generic",
                "2 tbsp",
            ),
            C(
                "candy",
                "Peanut butter candy confection",
                undefined,
                "packaged",
                "1 piece",
            ),
        ],
    },
    {
        id: "greek-yogurt-nonfat",
        query: "greek yogurt",
        context: "I ate 1 cup of plain nonfat Greek yogurt.",
        expected: "nonfat",
        candidates: [
            C(
                "whole",
                "Greek yogurt, plain, whole milk",
                undefined,
                "generic",
                "1 cup",
            ),
            C(
                "vanilla",
                "Greek yogurt, vanilla, lowfat",
                undefined,
                "generic",
                "1 cup",
            ),
            C(
                "nonfat",
                "Greek yogurt, plain, nonfat",
                undefined,
                "generic",
                "1 cup",
            ),
        ],
    },
    {
        id: "sweet-potato-baked",
        query: "sweet potato",
        context: "I ate one plain baked sweet potato with no toppings.",
        expected: "baked",
        candidates: [
            C(
                "fries",
                "Sweet potato fries, prepared, frozen",
                undefined,
                "generic",
                "100 g",
            ),
            C(
                "baked",
                "Sweet potato, cooked, baked in skin, flesh",
                undefined,
                "generic",
                "1 medium",
            ),
            C(
                "chips",
                "Sweet potato chips, salted",
                undefined,
                "packaged",
                "1 oz",
            ),
        ],
    },
    {
        id: "avocado-raw",
        query: "avocado",
        context: "I ate half of a plain raw avocado.",
        expected: "raw",
        candidates: [
            C("guac", "Guacamole, prepared", undefined, "generic", "2 tbsp"),
            C("oil", "Avocado oil", undefined, "generic", "1 tbsp"),
            C(
                "raw",
                "Avocados, raw, all commercial varieties",
                undefined,
                "generic",
                "0.5 fruit",
            ),
        ],
    },
    {
        id: "black-beans-canned",
        query: "black beans",
        context: "I ate canned black beans, drained and rinsed.",
        expected: "canned",
        candidates: [
            C(
                "refried",
                "Refried beans, canned, traditional",
                undefined,
                "generic",
                "1 cup",
            ),
            C(
                "canned",
                "Black beans, canned, drained, low sodium",
                undefined,
                "generic",
                "1 cup",
            ),
            C(
                "dry",
                "Black beans, mature seeds, dry, uncooked",
                undefined,
                "generic",
                "100 g",
            ),
        ],
    },
    {
        id: "tuna-water",
        query: "tuna",
        context: "I ate canned light tuna packed in water, drained.",
        expected: "water",
        candidates: [
            C(
                "oil",
                "Tuna, light, canned in oil, drained solids",
                undefined,
                "generic",
                "1 can",
            ),
            C(
                "water",
                "Tuna, light, canned in water, drained solids",
                undefined,
                "generic",
                "1 can",
            ),
            C(
                "salad",
                "Tuna salad, prepared with mayonnaise",
                undefined,
                "generic",
                "1 cup",
            ),
        ],
    },
    {
        id: "oats-dry-rolled",
        query: "oats",
        context: "I measured dry old-fashioned rolled oats before cooking.",
        expected: "rolled",
        candidates: [
            C(
                "cooked",
                "Oatmeal, cooked with water",
                undefined,
                "generic",
                "1 cup",
            ),
            C(
                "rolled",
                "Oats, regular and quick, dry",
                undefined,
                "generic",
                "0.5 cup",
            ),
            C(
                "granola",
                "Granola with oats and honey",
                undefined,
                "generic",
                "1 cup",
            ),
        ],
    },
    {
        id: "olive-oil",
        query: "olive oil",
        context: "I used 1 tablespoon of plain olive oil for cooking.",
        expected: "oil",
        candidates: [
            C(
                "dressing",
                "Salad dressing, olive oil vinaigrette",
                undefined,
                "generic",
                "1 tbsp",
            ),
            C(
                "oil",
                "Oil, olive, salad or cooking",
                undefined,
                "generic",
                "1 tbsp",
            ),
            C(
                "spread",
                "Olive oil vegetable spread",
                undefined,
                "packaged",
                "1 tbsp",
            ),
        ],
    },
    {
        id: "flour-tortilla",
        query: "tortilla",
        context: "I ate one plain flour tortilla.",
        expected: "flour",
        candidates: [
            C("corn", "Tortilla, corn", undefined, "generic", "1 tortilla"),
            C(
                "chips",
                "Tortilla chips, plain, salted",
                undefined,
                "generic",
                "1 oz",
            ),
            C(
                "flour",
                "Tortilla, flour, plain",
                undefined,
                "generic",
                "1 tortilla",
            ),
        ],
    },
    {
        id: "cottage-cheese-2pct",
        query: "cottage cheese",
        context: "I ate 1 cup of 2% low-fat cottage cheese.",
        expected: "two",
        candidates: [
            C(
                "full",
                "Cheese, cottage, creamed, large or small curd",
                undefined,
                "generic",
                "1 cup",
            ),
            C(
                "two",
                "Cheese, cottage, lowfat, 2% milkfat",
                undefined,
                "generic",
                "1 cup",
            ),
            C(
                "nonfat",
                "Cheese, cottage, nonfat, uncreamed",
                undefined,
                "generic",
                "1 cup",
            ),
        ],
    },
    {
        id: "chicken-broth",
        query: "chicken broth",
        context: "The soup used plain ready-to-serve chicken broth.",
        expected: "broth",
        candidates: [
            C(
                "bouillon",
                "Chicken bouillon cube, dry",
                undefined,
                "generic",
                "1 cube",
            ),
            C(
                "broth",
                "Chicken broth, ready to serve",
                undefined,
                "generic",
                "1 cup",
            ),
            C(
                "gravy",
                "Chicken gravy, canned",
                undefined,
                "generic",
                "0.25 cup",
            ),
        ],
    },
    {
        id: "almond-milk-unsweetened",
        query: "almond milk",
        context: "I drank plain unsweetened almond milk.",
        expected: "unsweet",
        candidates: [
            C(
                "vanilla",
                "Almond milk, vanilla, sweetened",
                undefined,
                "packaged",
                "1 cup",
            ),
            C(
                "unsweet",
                "Almond milk, plain, unsweetened",
                undefined,
                "packaged",
                "1 cup",
            ),
            C(
                "yogurt",
                "Almond milk yogurt, plain",
                undefined,
                "packaged",
                "1 cup",
            ),
        ],
    },
    {
        id: "banana-raw",
        query: "banana",
        context: "I ate one plain fresh banana.",
        expected: "raw",
        candidates: [
            C(
                "chips",
                "Banana chips, fried, sweetened",
                undefined,
                "generic",
                "1 oz",
            ),
            C("raw", "Bananas, raw", undefined, "generic", "1 medium"),
            C("bread", "Banana bread", undefined, "generic", "1 slice"),
        ],
    },
    {
        id: "broccoli-cooked",
        query: "broccoli",
        context: "I ate steamed cooked broccoli with no sauce.",
        expected: "cooked",
        candidates: [
            C("raw", "Broccoli, raw", undefined, "generic", "1 cup"),
            C(
                "cooked",
                "Broccoli, cooked, boiled, drained, without salt",
                undefined,
                "generic",
                "1 cup",
            ),
            C(
                "casserole",
                "Broccoli casserole with cheese",
                undefined,
                "generic",
                "1 cup",
            ),
        ],
    },
    {
        id: "ground-beef-90",
        query: "ground beef",
        context: "I ate cooked 90% lean ground beef with no sauce.",
        expected: "lean90",
        candidates: [
            C(
                "raw80",
                "Ground beef, 80% lean, raw",
                undefined,
                "generic",
                "100 g",
            ),
            C(
                "lean90",
                "Ground beef, 90% lean, cooked, pan-browned",
                undefined,
                "generic",
                "100 g",
            ),
            C(
                "meatloaf",
                "Beef meatloaf, prepared",
                undefined,
                "generic",
                "100 g",
            ),
        ],
    },
    {
        id: "cheddar-regular",
        query: "cheddar cheese",
        context: "I ate one ounce of regular full-fat cheddar cheese.",
        expected: "regular",
        candidates: [
            C(
                "reduced",
                "Cheddar cheese, reduced fat",
                undefined,
                "generic",
                "1 oz",
            ),
            C("regular", "Cheese, cheddar", undefined, "generic", "1 oz"),
            C(
                "sauce",
                "Cheddar cheese sauce",
                undefined,
                "generic",
                "0.25 cup",
            ),
        ],
    },
    {
        id: "white-american",
        query: "white American cheese",
        context: "I ate one slice of white American cheese.",
        expected: "white",
        candidates: [
            C(
                "yellow",
                "American cheese, pasteurized process, yellow",
                undefined,
                "generic",
                "1 slice",
            ),
            C(
                "white",
                "American cheese, pasteurized process, white",
                undefined,
                "packaged",
                "1 slice",
            ),
            C("cheddar", "Cheddar cheese, white", undefined, "generic", "1 oz"),
        ],
    },
    {
        id: "chicken-breast-grilled",
        query: "chicken breast",
        context: "I ate grilled boneless skinless chicken breast.",
        expected: "grilled",
        candidates: [
            C(
                "raw",
                "Chicken breast, boneless, skinless, raw",
                undefined,
                "generic",
                "100 g",
            ),
            C(
                "grilled",
                "Chicken breast, boneless, skinless, cooked, grilled",
                undefined,
                "generic",
                "100 g",
            ),
            C(
                "breaded",
                "Chicken breast, breaded, fried",
                undefined,
                "generic",
                "100 g",
            ),
        ],
    },
    {
        id: "extra-virgin-olive-oil",
        query: "extra virgin olive oil",
        context: "I used extra virgin olive oil.",
        expected: "evoo",
        candidates: [
            C("canola", "Canola oil", undefined, "generic", "1 tbsp"),
            C("olive", "Olive oil, refined", undefined, "generic", "1 tbsp"),
            C(
                "evoo",
                "Extra virgin olive oil",
                undefined,
                "packaged",
                "1 tbsp",
            ),
        ],
    },
    {
        id: "chickpeas-canned",
        query: "chickpeas",
        context: "I ate canned chickpeas, drained and rinsed.",
        expected: "canned",
        candidates: [
            C("hummus", "Hummus, prepared", undefined, "generic", "2 tbsp"),
            C("dry", "Chickpeas, dry, uncooked", undefined, "generic", "100 g"),
            C(
                "canned",
                "Chickpeas, canned, drained",
                undefined,
                "generic",
                "1 cup",
            ),
        ],
    },
    {
        id: "butter-salted",
        query: "butter",
        context: "I used one tablespoon of salted dairy butter.",
        expected: "salted",
        candidates: [
            C(
                "unsalted",
                "Butter, without salt",
                undefined,
                "generic",
                "1 tbsp",
            ),
            C(
                "margarine",
                "Margarine, regular",
                undefined,
                "generic",
                "1 tbsp",
            ),
            C("salted", "Butter, salted", undefined, "generic", "1 tbsp"),
        ],
    },
    {
        id: "heavy-cream",
        query: "heavy cream",
        context: "The recipe used 1/2 cup of heavy whipping cream.",
        expected: "heavy",
        candidates: [
            C("half", "Half and half cream", undefined, "generic", "0.5 cup"),
            C(
                "heavy",
                "Cream, fluid, heavy whipping",
                undefined,
                "generic",
                "0.5 cup",
            ),
            C(
                "topping",
                "Whipped topping, frozen",
                undefined,
                "generic",
                "0.5 cup",
            ),
        ],
    },
    {
        id: "sourdough-bread",
        query: "sourdough bread",
        context: "I ate one slice of plain sourdough bread.",
        expected: "sourdough",
        candidates: [
            C(
                "white",
                "Bread, white, commercially prepared",
                undefined,
                "generic",
                "1 slice",
            ),
            C("sourdough", "Bread, sourdough", undefined, "generic", "1 slice"),
            C("cracker", "Sourdough crackers", undefined, "packaged", "1 oz"),
        ],
    },
    {
        id: "plain-bagel",
        query: "bagel",
        context: "I ate one plain bagel.",
        expected: "plain",
        candidates: [
            C("onion", "Bagel, onion", undefined, "generic", "1 bagel"),
            C(
                "plain",
                "Bagel, plain, enriched",
                undefined,
                "generic",
                "1 bagel",
            ),
            C(
                "everything",
                "Bagel, everything seasoning",
                undefined,
                "packaged",
                "1 bagel",
            ),
        ],
    },
    {
        id: "deli-turkey",
        query: "turkey breast",
        context: "I ate sliced deli turkey breast meat.",
        expected: "deli",
        candidates: [
            C(
                "whole",
                "Turkey breast, roasted, meat only",
                undefined,
                "generic",
                "100 g",
            ),
            C(
                "deli",
                "Turkey breast, deli/luncheon meat, sliced",
                undefined,
                "generic",
                "2 oz",
            ),
            C(
                "sausage",
                "Turkey sausage, cooked",
                undefined,
                "generic",
                "1 link",
            ),
        ],
    },
    {
        id: "black-coffee",
        query: "coffee",
        context: "I drank black brewed coffee with no milk or sugar.",
        expected: "black",
        candidates: [
            C(
                "latte",
                "Coffee latte with whole milk",
                undefined,
                "restaurant",
                "12 fl oz",
            ),
            C(
                "black",
                "Coffee, brewed, prepared with tap water",
                undefined,
                "generic",
                "8 fl oz",
            ),
            C(
                "creamer",
                "Coffee creamer, liquid",
                undefined,
                "generic",
                "1 tbsp",
            ),
        ],
    },
    {
        id: "lentils-cooked",
        query: "lentils",
        context: "I ate plain cooked lentils.",
        expected: "cooked",
        candidates: [
            C("dry", "Lentils, raw, dry", undefined, "generic", "100 g"),
            C("soup", "Lentil soup, canned", undefined, "generic", "1 cup"),
            C(
                "cooked",
                "Lentils, mature seeds, cooked, boiled",
                undefined,
                "generic",
                "1 cup",
            ),
        ],
    },
    {
        id: "spinach-raw",
        query: "spinach",
        context: "I ate raw baby spinach in a salad.",
        expected: "raw",
        candidates: [
            C(
                "cooked",
                "Spinach, cooked, boiled, drained",
                undefined,
                "generic",
                "1 cup",
            ),
            C("dip", "Spinach dip, prepared", undefined, "generic", "2 tbsp"),
            C("raw", "Spinach, raw", undefined, "generic", "1 cup"),
        ],
    },
    {
        id: "no-match-oat-milk",
        query: "oat milk",
        context: "I drank plain unsweetened oat milk.",
        expected: null,
        candidates: [
            C(
                "almond",
                "Almond milk, plain, unsweetened",
                undefined,
                "packaged",
                "1 cup",
            ),
            C("cow", "Milk, nonfat, fluid", undefined, "generic", "1 cup"),
            C("oats", "Oats, dry", undefined, "generic", "0.5 cup"),
        ],
    },
    {
        id: "no-match-shrimp",
        query: "shrimp",
        context: "I ate plain grilled shrimp.",
        expected: null,
        candidates: [
            C(
                "breaded",
                "Shrimp, breaded and fried",
                undefined,
                "generic",
                "100 g",
            ),
            C(
                "salad",
                "Shrimp salad with mayonnaise",
                undefined,
                "generic",
                "1 cup",
            ),
            C(
                "cocktail",
                "Shrimp cocktail with sauce",
                undefined,
                "restaurant",
                "1 serving",
            ),
        ],
    },
    {
        id: "no-match-tofu",
        query: "tofu",
        context: "I ate plain firm tofu.",
        expected: null,
        candidates: [
            C(
                "soy-milk",
                "Soy milk, unsweetened",
                undefined,
                "packaged",
                "1 cup",
            ),
            C("tempeh", "Tempeh, cooked", undefined, "generic", "100 g"),
            C(
                "tofu-dessert",
                "Tofu pudding, sweetened",
                undefined,
                "packaged",
                "1 cup",
            ),
        ],
    },
    {
        id: "no-match-pork-chop",
        query: "pork chop",
        context: "I ate a grilled boneless pork loin chop.",
        expected: null,
        candidates: [
            C("bacon", "Pork bacon, cooked", undefined, "generic", "3 slices"),
            C(
                "sausage",
                "Pork sausage, cooked",
                undefined,
                "generic",
                "1 link",
            ),
            C(
                "ribs",
                "Pork ribs, barbecue, with sauce",
                undefined,
                "generic",
                "100 g",
            ),
        ],
    },
    {
        id: "no-match-cod",
        query: "cod",
        context: "I ate baked plain cod fillet.",
        expected: null,
        candidates: [
            C("salmon", "Salmon, baked", undefined, "generic", "100 g"),
            C(
                "fishstick",
                "Fish sticks, breaded, frozen",
                undefined,
                "generic",
                "100 g",
            ),
            C("tuna", "Tuna, canned in water", undefined, "generic", "1 can"),
        ],
    },
    {
        id: "no-match-mozzarella",
        query: "mozzarella",
        context: "I ate fresh whole-milk mozzarella.",
        expected: null,
        candidates: [
            C("cheddar", "Cheddar cheese", undefined, "generic", "1 oz"),
            C(
                "parmesan",
                "Parmesan cheese, grated",
                undefined,
                "generic",
                "1 oz",
            ),
            C("cream", "Cream cheese", undefined, "generic", "1 oz"),
        ],
    },
    {
        id: "no-match-coconut-oil",
        query: "coconut oil",
        context: "I used plain coconut oil.",
        expected: null,
        candidates: [
            C("olive", "Olive oil", undefined, "generic", "1 tbsp"),
            C("canola", "Canola oil", undefined, "generic", "1 tbsp"),
            C(
                "coconut-milk",
                "Coconut milk, canned",
                undefined,
                "generic",
                "1 cup",
            ),
        ],
    },
    {
        id: "no-match-protein-bar",
        query: "protein bar",
        context:
            "I ate a chocolate protein bar; the exact product is not among these candidates.",
        expected: null,
        candidates: [
            C(
                "granola",
                "Chocolate chip granola bar",
                undefined,
                "packaged",
                "1 bar",
            ),
            C(
                "candy",
                "Milk chocolate candy bar",
                undefined,
                "packaged",
                "1 bar",
            ),
            C(
                "shake",
                "Chocolate protein shake",
                undefined,
                "packaged",
                "1 bottle",
            ),
        ],
    },
];

function rotate<T>(a: T[], n: number): T[] {
    return a.slice(n).concat(a.slice(0, n));
}
const variants = (c: Case) => [
    { name: "original", candidates: c.candidates },
    { name: "reverse", candidates: [...c.candidates].reverse() },
    { name: "rotate", candidates: rotate(c.candidates, 1) },
];

async function retryFetch(
    label: string,
    url: string,
    init: RequestInit,
    maxAttempts = 8,
): Promise<Response> {
    let last: unknown;
    for (let i = 0; i < maxAttempts; i++) {
        try {
            const r = await fetch(url, {
                ...init,
                signal: AbortSignal.timeout(60_000),
            });
            if (![429, 529].includes(r.status) && r.status < 500) return r;
            if (i === maxAttempts - 1) return r;
            const ra = Number(r.headers.get("retry-after") || "0");
            await r.arrayBuffer().catch(() => new ArrayBuffer(0));
            const delay =
                ra > 0 ? ra * 1000 : Math.min(15000, 1000 * Math.pow(2, i));
            console.warn(
                "[controlled_retry] " +
                    JSON.stringify({
                        label,
                        status: r.status,
                        attempt: i + 1,
                        delay,
                    }),
            );
            await Bun.sleep(delay);
        } catch (e) {
            last = e;
            if (i === maxAttempts - 1) throw e;
            const delay = Math.min(15000, 1000 * Math.pow(2, i));
            await Bun.sleep(delay);
        }
    }
    throw last instanceof Error ? last : new Error(label + " failed");
}

function jevCriteria(candidates: Candidate[]) {
    const x: Record<string, string | null> = {};
    candidates.forEach(
        (c, i) =>
            (x["c" + i] = [
                c.name,
                c.brand ? "brand=" + c.brand : "",
                c.kind ? "kind=" + c.kind : "",
                c.portion ? "portion=" + c.portion : "",
            ]
                .filter(Boolean)
                .join("; ")),
    );
    x.NO_MATCH = "None of the candidates is a defensible match.";
    return x;
}

async function runJev(test: Case, candidates: Candidate[]) {
    const expectedIndex =
        test.expected === null
            ? -1
            : candidates.findIndex((c) => c.id === test.expected);
    const started = performance.now();
    const response = await retryFetch(
        "OpenRouter Jev",
        "https://openrouter.ai/api/alpha/decisions",
        {
            method: "POST",
            headers: {
                authorization: "Bearer " + openrouterKey,
                "content-type": "application/json",
                "HTTP-Referer": "https://munch.business",
                "X-OpenRouter-Title": "Munch Jev controlled audit",
            },
            body: JSON.stringify({
                model: JEV_MODEL,
                state: { query: test.query, context: test.context },
                questions: {
                    best_candidate: {
                        type: "choice",
                        instructions:
                            "Choose the single food database candidate that best matches the user's full context for nutrition logging. Preparation, food form, fat level, packing medium, and species matter when explicitly stated. Ordinary cutting words such as diced or sliced do not make a base food a different food. Prefer a nutritionally equivalent generic food over a candidate that adds unsupported ingredients or preparation. Choose NO_MATCH when every candidate materially conflicts with the requested food.",
                        criteria: jevCriteria(candidates),
                    },
                },
            }),
            signal: AbortSignal.timeout(30000),
        },
    );
    const durationMs = performance.now() - started;
    if (!response.ok)
        throw new Error(
            "OpenRouter Jev HTTP " +
                response.status +
                " " +
                (await response.text()).slice(0, 500),
        );
    const p: any = await response.json();
    const a = p?.answers?.best_candidate;
    if (a?.type !== "choice") throw new Error("OpenRouter Jev missing choice");
    const choice = String(a.choice);
    const selectedIndex = /^c\d+$/.test(choice) ? Number(choice.slice(1)) : -1;
    const u = p.usage || {};
    const inputTokens = Number(u.input_tokens || 0);
    return {
        model: String(p.model || JEV_MODEL),
        choice,
        selectedIndex,
        expectedIndex,
        correct: selectedIndex === expectedIndex,
        confidence: Number(a.confidence || 0),
        probability: Number(a.probabilities?.[choice] || 0),
        noMatchProbability: Number(a.probabilities?.NO_MATCH || 0),
        durationMs,
        inputTokens,
        outputTokens: Number(u.output_tokens || 0),
        estimatedCostUsd: Number(
            u.cost ?? (inputTokens / 1_000_000) * JEV_PRICE_INPUT_PER_M,
        ),
    };
}

async function runQwen(test: Case, candidates: Candidate[]) {
    const expectedIndex =
        test.expected === null
            ? -1
            : candidates.findIndex((c) => c.id === test.expected);
    const opts = [...candidates.map((_, i) => "c" + i), "NO_MATCH"];
    const started = performance.now();
    const response = await retryFetch(
        "OpenRouter",
        "https://openrouter.ai/api/v1/chat/completions",
        {
            method: "POST",
            headers: {
                authorization: "Bearer " + openrouterKey,
                "content-type": "application/json",
                "HTTP-Referer": "https://munch.business",
                "X-Title": "Munch Jev controlled audit",
            },
            body: JSON.stringify({
                model: QWEN_MODEL,
                temperature: 0,
                reasoning: { enabled: false },
                max_tokens: 160,
                messages: [
                    {
                        role: "system",
                        content:
                            "Choose the single food database candidate that best matches the user's full context for nutrition logging. Respect explicit preparation, food form, fat level, packing medium, species, and brand facts. Ordinary cutting words such as diced or sliced do not make a base food a different food. Prefer a nutritionally equivalent generic candidate over one that adds unsupported ingredients or preparation. Choose NO_MATCH when every candidate materially conflicts. Return only the requested JSON.",
                    },
                    {
                        role: "user",
                        content: JSON.stringify({
                            query: test.query,
                            context: test.context,
                            candidates: candidates.map((c, i) => ({
                                key: "c" + i,
                                ...c,
                            })),
                        }),
                    },
                ],
                response_format: {
                    type: "json_schema",
                    json_schema: {
                        name: "controlled_food_match",
                        strict: true,
                        schema: {
                            type: "object",
                            additionalProperties: false,
                            required: ["choice", "confidence"],
                            properties: {
                                choice: { type: "string", enum: opts },
                                confidence: {
                                    type: "number",
                                    minimum: 0,
                                    maximum: 1,
                                },
                            },
                        },
                    },
                },
            }),
            signal: AbortSignal.timeout(60000),
        },
    );
    const durationMs = performance.now() - started;
    if (!response.ok)
        throw new Error(
            "OpenRouter HTTP " +
                response.status +
                " " +
                (await response.text()).slice(0, 500),
        );
    const p: any = await response.json();
    const parsed = JSON.parse(p?.choices?.[0]?.message?.content || "{}");
    const choice = String(parsed.choice);
    const selectedIndex = /^c\d+$/.test(choice) ? Number(choice.slice(1)) : -1;
    const u = p.usage || {};
    const inputTokens = Number(u.prompt_tokens || u.input_tokens || 0);
    const outputTokens = Number(u.completion_tokens || u.output_tokens || 0);
    return {
        model: QWEN_MODEL,
        choice,
        selectedIndex,
        expectedIndex,
        correct: selectedIndex === expectedIndex,
        confidence: Number(parsed.confidence || 0),
        durationMs,
        inputTokens,
        outputTokens,
        estimatedCostUsd:
            (inputTokens / 1_000_000) * QWEN_PRICE_INPUT_PER_M +
            (outputTokens / 1_000_000) * QWEN_PRICE_OUTPUT_PER_M,
    };
}

function percentile(values: number[], p: number) {
    const a = [...values].sort((x, y) => x - y);
    return a[Math.max(0, Math.ceil(a.length * p) - 1)] ?? 0;
}
function stats(rows: any[], key: "jev" | "qwen") {
    const vals = rows.map((r) => r[key]);
    const costs = vals.map((v) => v.estimatedCostUsd);
    return {
        correct: vals.filter((v) => v.correct).length,
        total: vals.length,
        accuracy: vals.filter((v) => v.correct).length / vals.length,
        noMatchAccuracy: rows.filter((r) => r.expected === null).length
            ? rows.filter((r) => r.expected === null && r[key].correct).length /
              rows.filter((r) => r.expected === null).length
            : 0,
        matchAccuracy: rows.filter((r) => r.expected !== null).length
            ? rows.filter((r) => r.expected !== null && r[key].correct).length /
              rows.filter((r) => r.expected !== null).length
            : 0,
        latencyMs: {
            p50: percentile(
                vals.map((v) => v.durationMs),
                0.5,
            ),
            p90: percentile(
                vals.map((v) => v.durationMs),
                0.9,
            ),
            p95: percentile(
                vals.map((v) => v.durationMs),
                0.95,
            ),
            mean: vals.reduce((s, v) => s + v.durationMs, 0) / vals.length,
        },
        inputTokensMean:
            vals.reduce((s, v) => s + v.inputTokens, 0) / vals.length,
        outputTokensMean:
            vals.reduce((s, v) => s + v.outputTokens, 0) / vals.length,
        totalCostUsd: costs.reduce((a, b) => a + b, 0),
        meanCostUsd: costs.reduce((a, b) => a + b, 0) / costs.length,
    };
}

mkdirSync("artifacts", { recursive: true });
const rows: any[] = [];
for (const test of CASES) {
    for (const variant of variants(test)) {
        const jev = await runJev(test, variant.candidates);
        const qwen = await runQwen(test, variant.candidates);
        rows.push({
            caseId: test.id,
            variant: variant.name,
            query: test.query,
            context: test.context,
            expected: test.expected,
            candidates: variant.candidates,
            jev,
            qwen,
        });
        writeFileSync(
            "artifacts/jev-controlled-partial.json",
            JSON.stringify({ rows }, null, 2),
        );
        console.log(
            "[controlled_case] " +
                JSON.stringify({
                    id: test.id,
                    variant: variant.name,
                    expected: test.expected,
                    jev: jev.choice,
                    jevCorrect: jev.correct,
                    jevMs: Math.round(jev.durationMs),
                    jevConfidence: jev.confidence,
                    qwen: qwen.choice,
                    qwenCorrect: qwen.correct,
                    qwenMs: Math.round(qwen.durationMs),
                }),
        );
        await Bun.sleep(250);
    }
}

const positionBias: any = {};
for (const key of ["jev", "qwen"] as const) {
    const byCase = new Map<string, any[]>();
    for (const r of rows) {
        const arr = byCase.get(r.caseId) || [];
        arr.push(r[key]);
        byCase.set(r.caseId, arr);
    }
    positionBias[key] = {
        casesStable: [...byCase.values()].filter(
            (v) =>
                v.every((x) => x.correct) &&
                new Set(v.map((x) => x.selectedIndex)).size >= 1,
        ).length,
        casesAllCorrect: [...byCase.values()].filter((v) =>
            v.every((x) => x.correct),
        ).length,
        casesAnyVariantWrong: [...byCase.values()].filter((v) =>
            v.some((x) => !x.correct),
        ).length,
    };
}

const lowConfidence = [...rows]
    .sort((a, b) => a.jev.confidence - b.jev.confidence)
    .slice(0, 12);
const stability: any[] = [];
for (const target of lowConfidence) {
    const runs: any[] = [];
    for (let i = 0; i < 4; i++)
        runs.push(
            await runJev(
                CASES.find((c) => c.id === target.caseId)!,
                target.candidates,
            ),
        );
    stability.push({
        caseId: target.caseId,
        variant: target.variant,
        first: target.jev.choice,
        repeats: runs.map((r) => r.choice),
        allSame: runs.every((r) => r.choice === target.jev.choice),
        confidence: [target.jev.confidence, ...runs.map((r) => r.confidence)],
    });
}

const thresholds = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98];
const routing = thresholds.map((t) => {
    const accepted = rows.filter(
        (r) => r.jev.choice !== "NO_MATCH" && r.jev.confidence >= t,
    );
    return {
        threshold: t,
        accepted: accepted.length,
        coverage: accepted.length / rows.length,
        precision: accepted.length
            ? accepted.filter((r) => r.jev.correct).length / accepted.length
            : 0,
        fallback: rows.length - accepted.length,
    };
});
const noMatchRouting = thresholds.map((t) => {
    const resolved = rows.filter((r) => r.jev.confidence >= t);
    return {
        threshold: t,
        resolved: resolved.length,
        coverage: resolved.length / rows.length,
        accuracy: resolved.length
            ? resolved.filter((r) => r.jev.correct).length / resolved.length
            : 0,
    };
});

const summary = {
    generatedAt: new Date().toISOString(),
    baseCases: CASES.length,
    evaluations: rows.length,
    jevModel: JEV_MODEL,
    qwenModel: QWEN_MODEL,
    jev: stats(rows, "jev"),
    qwen: stats(rows, "qwen"),
    positionBias,
    stability: {
        tested: stability.length,
        fullyStable: stability.filter((s) => s.allSame).length,
        rate: stability.filter((s) => s.allSame).length / stability.length,
        details: stability,
    },
    routing,
    noMatchRouting,
    speedupP50:
        stats(rows, "qwen").latencyMs.p50 / stats(rows, "jev").latencyMs.p50,
    speedupMean:
        stats(rows, "qwen").latencyMs.mean / stats(rows, "jev").latencyMs.mean,
    costRatio: stats(rows, "jev").meanCostUsd / stats(rows, "qwen").meanCostUsd,
};
writeFileSync(
    "artifacts/jev-controlled-audit.json",
    JSON.stringify({ summary, rows }, null, 2),
);
const pct = (x: number) => (x * 100).toFixed(1) + "%";
const usd = (x: number) => "$" + x.toFixed(6);
const md = [
    "# OpenRouter Jev controlled food candidate audit",
    "",
    "Base semantic cases: **" +
        summary.baseCases +
        "**; position-varied evaluations: **" +
        summary.evaluations +
        "**.",
    "",
    "| Model | Accuracy | Match accuracy | NO_MATCH accuracy | p50 | p95 | Mean cost/eval |",
    "|---|---:|---:|---:|---:|---:|---:|",
    "| Jev | " +
        pct(summary.jev.accuracy) +
        " | " +
        pct(summary.jev.matchAccuracy) +
        " | " +
        pct(summary.jev.noMatchAccuracy) +
        " | " +
        Math.round(summary.jev.latencyMs.p50) +
        " ms | " +
        Math.round(summary.jev.latencyMs.p95) +
        " ms | " +
        usd(summary.jev.meanCostUsd) +
        " |",
    "| Qwen | " +
        pct(summary.qwen.accuracy) +
        " | " +
        pct(summary.qwen.matchAccuracy) +
        " | " +
        pct(summary.qwen.noMatchAccuracy) +
        " | " +
        Math.round(summary.qwen.latencyMs.p50) +
        " ms | " +
        Math.round(summary.qwen.latencyMs.p95) +
        " ms | " +
        usd(summary.qwen.meanCostUsd) +
        " |",
    "",
    "Jev median speedup: **" +
        summary.speedupP50.toFixed(2) +
        "x**; mean speedup: **" +
        summary.speedupMean.toFixed(2) +
        "x**.",
    "",
    "Jev/Qwen mean cost ratio: **" + summary.costRatio.toFixed(2) + "x**.",
    "",
    "Jev stability on 12 lowest-confidence evaluations: **" +
        summary.stability.fullyStable +
        "/" +
        summary.stability.tested +
        "**.",
    "",
    "## Jev confidence-only routing",
    "",
    "| Threshold | Evaluations resolved | Accuracy on resolved |",
    "|---:|---:|---:|",
    ...summary.noMatchRouting.map(
        (x) =>
            "| " +
            x.threshold.toFixed(2) +
            " | " +
            x.resolved +
            "/" +
            summary.evaluations +
            " | " +
            pct(x.accuracy) +
            " |",
    ),
].join("\n");
writeFileSync("artifacts/jev-controlled-audit.md", md + "\n");
if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, "\n" + md + "\n");
console.log("[controlled_summary] " + JSON.stringify(summary));
