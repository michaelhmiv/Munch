# Host AI and Website AI Boundary

## Architectural rule

Munch has two distinct execution environments:

1. **MCP / host-AI clients** such as ChatGPT or Claude.
2. **The standalone Munch website**, where no conversational host model is available.

When Munch is invoked through MCP, the connected host model owns semantic interpretation, vision understanding, recipe ideation, conversational planning, and other generative reasoning. The Munch MCP server must not call OpenRouter or another standalone model provider on the host model's behalf.

Munch MCP tools own factual and deterministic application responsibilities: authorization, household scope, canonical food/provider lookup, barcode lookup, Pantry state, structured nutrition data, deterministic Pantry/recipe matching and ranking, quantity/unit handling, idempotency, validation, persistence, and explicit mutations.

The standalone website may use Munch's configured OpenRouter model when a feature genuinely needs semantic or vision inference and there is no host model present. Website model selection is centralized through `MUNCH_AI_MODEL`.

## Expected flows

### Pantry or refrigerator photo through ChatGPT / Claude

Host vision -> `get_pantry` when existing state is relevant -> host interpretation/review -> `reconcile_pantry` after explicit authorization.

There is no Munch OpenRouter call in this flow.

### Receipt through ChatGPT / Claude

Host vision -> structured purchased lines -> `reconcile_purchase`.

There is no Munch OpenRouter call in this flow.

### Pantry meal planning through ChatGPT / Claude

`get_pantry(detail_level=planning)` + `search_recipes(pantry_match=true)` -> host reasoning over the full kitchen context -> optional Grocery/Recipe tool calls.

There is no Munch OpenRouter call in this flow. Munch's deterministic saved-recipe ranking is data processing, not model inference.

### Recipe URL through ChatGPT / Claude

`parse_recipe_url` performs safe URL fetch/parsing and deterministic food-provider matching. The host model interprets ambiguous language and can use `search_foods` before `save_recipe` or `save_recipe_and_plan`.

The shared recipe import service performs model inference only when a website semantic resolver is explicitly injected.

### Standalone website

Website receipt/photo upload, website Pantry meal ideas, and website-assisted recipe import may call OpenRouter because no host model is present. These clients use the single shared website model selector `MUNCH_AI_MODEL`.

## Cost and reliability implications

This boundary is intentional. Users who access Munch primarily through an AI host consume the host's model inference rather than causing duplicate Munch-paid inference. It also avoids model-within-a-model latency, duplicated semantic work, and an additional provider failure surface.

Provider food searches (for example USDA or Open Food Facts) are factual data retrieval and are allowed from MCP. They are not generative model calls.

## Enforcement

`src/host-ai-boundary.test.ts` traverses the transitive source dependency graph rooted at `src/mcp-runtime.ts` and fails if MCP can reach website AI modules, model-provider credentials/endpoints, or the website model selector.

The same test runs deterministic recipe URL preview with website AI credentials deliberately present and traps global network fetches. This proves that credentials alone cannot silently activate the website semantic resolver on the MCP/shared-service path.

Any future AI-backed website module must remain outside the MCP dependency graph. If a new MCP use case needs reasoning, expose the factual state and deterministic action primitives required for the host model to perform that reasoning instead of adding an internal model call.
