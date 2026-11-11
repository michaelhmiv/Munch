# Jev-1.14 front-door probe — results

Model under test: `typesafe/jev-1.14` via POST https://openrouter.ai/api/alpha/decisions (image as an `image_url` part in the top-level `state` array; `TypeSafe-Danger-Zone-Images: true` header sent). Measurement only — no product code touched. Raw answers with probabilities: `results.json`.

## Format discovery

| Style | HTTP | Parsed | Detail |
| --- | --- | --- | --- |
| plain | 200 | yes | answers parsed |

Winning style: **plain** (used for every call below).

## 1. Front-door gate

Calls: 42 (30 positive, 12 negative); parsed 42/42. All photos verified inside the 280–1568 px/side range: yes. Per-call latency: median 142 ms, p95 259 ms. Reported cost: $0.00534 total ($0.00013/call).

### Gate food probability — threshold table

Reject = p(food) strictly below the threshold. Positive false-rejects are the dangerous direction (a real meal turned away); the conservative operating point Jeff specified is 0.10.

| Threshold | Positives falsely rejected (of 30 scored) | Headline negatives correctly rejected (of 8) |
| --- | --- | --- |
| 0.50 | 0 (0.0%) | 7 (87.5%) |
| 0.30 | 0 (0.0%) | 6 (75.0%) |
| 0.10 | 0 (0.0%) | 6 (75.0%) |
| 0.05 | 0 (0.0%) | 6 (75.0%) |

### Route choice accuracy

Positives (ground truth from fixture family: drinks→drink, packaged→packaged product, else plated meal): **29/30** correct. Negatives (manifest labels): **12/12** correct.

Positive-set confusion (expected -> chosen):

- drink -> drink: 1
- drink -> plated_meal: 1
- packaged_product -> packaged_product: 2
- plated_meal -> plated_meal: 26

### Clarity question (no ground truth — distribution only)

Positives: median p(clear) 0.960, min 0.910. Poorly-lit fixtures: poorly-lit-01-chicken-caesar-salad = 0.930, poorly-lit-02-schnitzel-and-fries = 0.920.

### Borderline negatives — individually

- **neg-07-person-eating** (person_eating; label call: gate_food=true, route=plated_meal): p(food)=0.980, route=plated_meal, p(clear)=0.800. BORDERLINE, called POSITIVE for the gate: the primary subject is a person, but he is mid-bite into a gyro wrap and the tray in front of him holds a plated meal and a can of Coca-Cola. Loggable food and drink are unmistakable, so a front-door gate should let this through. Excluded from the headline negative-set rates; reported individually.
- **neg-08-empty-plate** (empty_plate; label call: gate_food=false, route=other): p(food)=0.300, route=other, p(clear)=0.570. BORDERLINE, called NEGATIVE: the plate holds only crumbs and a fork after a finished meal. A mug containing a dark drink is partly visible at the frame edge, but there is no loggable meal item; called not-food with the borderline flag.
- **neg-09-grocery-shelf** (grocery_shelf; label call: gate_food=false, route=packaged_product): p(food)=0.680, route=packaged_product, p(clear)=0.950. BORDERLINE, called NEGATIVE for the gate: supermarket shelves stacked with packaged milk drinks. Packaged products are plainly visible, but the photo shows no meal someone would log. Route call is 'packaged product' because that is the visible content; 'something else' would also be defensible and is noted as ambiguity.
- **neg-10-nutrition-label** (nutrition_label; label call: gate_food=false, route=packaged_product): p(food)=0.620, route=packaged_product, p(clear)=0.960. BORDERLINE, called NEGATIVE for the gate: the frame is filled by the Nutrition Facts label of a SunnyD bottle. The drink bottle is physically present, but the photo's content is label text rather than a presented drink; this is the closest call in the set and a gate pass would also be defensible. Route call is 'packaged product' (it is a product label close-up).

### Per-photo gate detail

| Fixture | Set | p(food) | Route (conf) | p(clear) | Latency ms | Cost $ |
| --- | --- | --- | --- | --- | --- | --- |
| single-01-banana | positive | 0.890 | plated_meal (0.91) | 0.990 | 93 | 0.00009 |
| single-02-apple | positive | 0.810 | plated_meal (0.96) | 0.990 | 97 | 0.00009 |
| single-03-avocado | positive | 0.930 | plated_meal (0.80) | 0.980 | 103 | 0.00009 |
| single-04-tomato-soup | positive | 0.970 | plated_meal (1.00) | 0.970 | 221 | 0.00010 |
| single-05-granola-bar | positive | 0.930 | plated_meal (0.99) | 0.910 | 347 | 0.00009 |
| mixed-01-boiled-egg-and-toast | positive | 0.980 | plated_meal (1.00) | 0.950 | 109 | 0.00010 |
| mixed-02-pancakes | positive | 0.980 | plated_meal (1.00) | 0.970 | 98 | 0.00009 |
| mixed-03-full-english-breakfast | positive | 0.990 | plated_meal (1.00) | 0.980 | 154 | 0.00012 |
| mixed-04-chicken-rice-vegetables | positive | 0.990 | plated_meal (1.00) | 0.970 | 989 | 0.00016 |
| mixed-05-salmon-sweet-potato | positive | 0.990 | plated_meal (1.00) | 0.970 | 152 | 0.00016 |
| mixed-06-chicken-cobb-salad | positive | 0.990 | plated_meal (1.00) | 0.950 | 259 | 0.00009 |
| mixed-07-macaroni-and-mashed-potato | positive | 0.980 | plated_meal (1.00) | 0.950 | 98 | 0.00009 |
| sauced-01-chili-over-noodles | positive | 0.980 | plated_meal (1.00) | 0.940 | 106 | 0.00010 |
| sauced-02-lasagna | positive | 0.990 | plated_meal (1.00) | 0.970 | 232 | 0.00013 |
| sauced-03-spaghetti-and-meatballs | positive | 0.990 | plated_meal (1.00) | 0.960 | 190 | 0.00010 |
| sauced-04-chicken-curry-and-rice | positive | 0.990 | plated_meal (1.00) | 0.960 | 116 | 0.00010 |
| restaurant-01-burger-and-fries | positive | 0.990 | plated_meal (1.00) | 0.960 | 88 | 0.00010 |
| restaurant-02-pepperoni-pizza | positive | 0.990 | plated_meal (0.94) | 0.980 | 166 | 0.00016 |
| restaurant-03-ramen | positive | 0.980 | plated_meal (1.00) | 0.940 | 115 | 0.00016 |
| restaurant-04-taco | positive | 0.980 | plated_meal (1.00) | 0.910 | 91 | 0.00009 |
| restaurant-05-sushi-platter | positive | 0.980 | plated_meal (0.99) | 0.960 | 172 | 0.00016 |
| restaurant-06-sandwich-and-waffle-fries | positive | 0.980 | plated_meal (1.00) | 0.950 | 184 | 0.00009 |
| restaurant-07-steak-and-fries | positive | 0.990 | plated_meal (1.00) | 0.960 | 114 | 0.00009 |
| packaged-01-cola-can | positive | 0.800 | packaged_product (0.90) | 0.980 | 159 | 0.00016 |
| packaged-02-orange-drink-bottle | positive | 0.740 | packaged_product (0.99) | 0.980 | 124 | 0.00013 |
| drinks-01-orange-juice | positive | 0.730 | drink (1.00) | 0.960 | 105 | 0.00016 |
| drinks-02-coffee-and-cookies | positive | 0.900 | plated_meal (0.68) | 0.970 | 112 | 0.00016 |
| poorly-lit-01-chicken-caesar-salad | positive | 0.980 | plated_meal (1.00) | 0.930 | 122 | 0.00009 |
| poorly-lit-02-schnitzel-and-fries | positive | 0.980 | plated_meal (1.00) | 0.920 | 98 | 0.00009 |
| partial-01-chocolate-cake | positive | 0.850 | plated_meal (1.00) | 0.970 | 224 | 0.00010 |
| neg-01-receipt | negative | 0.650 | receipt (1.00) | 0.870 | 236 | 0.00022 |
| neg-02-screenshot | negative | 0.010 | other (1.00) | 0.040 | 204 | 0.00015 |
| neg-03-dog | negative | 0.010 | other (1.00) | 0.090 | 220 | 0.00022 |
| neg-04-menu | negative | 0.360 | other (0.96) | 0.890 | 183 | 0.00014 |
| neg-05-restaurant-interior | negative | 0.030 | other (1.00) | 0.060 | 118 | 0.00014 |
| neg-06-car | negative | 0.010 | other (1.00) | 0.100 | 130 | 0.00010 |
| neg-07-person-eating | negative | 0.980 | plated_meal (0.75) | 0.800 | 176 | 0.00007 |
| neg-08-empty-plate | negative | 0.300 | other (0.59) | 0.570 | 204 | 0.00020 |
| neg-09-grocery-shelf | negative | 0.680 | packaged_product (0.70) | 0.950 | 142 | 0.00014 |
| neg-10-nutrition-label | negative | 0.620 | packaged_product (1.00) | 0.960 | 163 | 0.00022 |
| neg-11-handwritten-note | negative | 0.010 | other (1.00) | 0.030 | 134 | 0.00012 |
| neg-12-landscape | negative | 0.020 | other (1.00) | 0.130 | 143 | 0.00014 |

## 2. Receipt routing reality check

The receipt fixture (neg-01-receipt — itemized paper restaurant receipt) was routed as **receipt** (confidence 1.000, route probabilities {"plated_meal":0,"drink":0,"packaged_product":0,"receipt":1,"other":0}), with p(food)=0.650. The front door recognises the receipt for what it is.

## 3. Verification pass over Ember identifications

Ember (meta/muse-ember) identified the 30 positive photos once each (production identify path). Identify-level scoring with the existing namesMatch matcher: expected 67 items, predicted 96, matched 53 → **precision 0.552 / recall 0.791** before any Jev filtering.

Jev per-item presence probabilities (drop = p(present) below threshold; items whose call failed keep p=null and are never dropped):

| Drop threshold | Items kept | Matched kept | Precision after | Recall after |
| --- | --- | --- | --- | --- |
| 0.3 | 96 | 53 | 0.552 | 0.791 |
| 0.5 | 96 | 53 | 0.552 | 0.791 |
| 0.7 | 95 | 53 | 0.558 | 0.791 |

Anything-missing Noul (flag at p ≥ 0.5): Ember actually missed ≥1 expected item in 13 photos; Jev flagged 0/13 of those (hit rate 0.0%). False flags on the 17 photos where Ember missed nothing: 1 (5.9%).

Added verification cost per photo: Jev latency median 116 ms / p95 197 ms (summed across the photo's batched calls — the sequential figure; wall time is lower under concurrency), Jev cost median $0.00009 per photo. Verification Jev calls: 30 requests, reported cost $0.00334 total. Ember identify: 30 calls, computed cost $0.00893 (tokens × catalog price), API-reported $0.00725.

## Spend

Gate $0.00534 + verification Jev $0.00334 + Ember identify (API-reported) $0.00725 = **$0.01593** total reported spend for the probe (the 1–2 format-discovery attempts are extra calls of gate-call size, itemised in results.json `formatAttempts`).
