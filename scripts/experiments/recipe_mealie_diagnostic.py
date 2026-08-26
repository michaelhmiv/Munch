#!/usr/bin/env python3

from __future__ import annotations

import asyncio
import json
import os
import resource
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import httpx
from httpx_curl_cffi import AsyncCurlTransport
from recipe_scrapers import NoSchemaFoundInWildMode, scrape_html

BROWSER_IMPERSONATIONS = ["chrome", "firefox", "safari", "edge"]
BRIDGE = "scripts/experiments/recipe-munch-bridge.ts"

CASES = [
    {"site": "Allrecipes", "kind": "native_blocker", "url": "https://www.allrecipes.com/recipe/20144/banana-banana-bread/"},
    {"site": "Serious Eats", "kind": "native_blocker", "url": "https://www.seriouseats.com/the-best-slow-cooked-bolognese-sauce-recipe"},
    {"site": "Simply Recipes", "kind": "native_blocker", "url": "https://www.simplyrecipes.com/recipes/banana_bread/"},
    {"site": "Martha Stewart", "kind": "native_blocker", "url": "https://www.marthastewart.com/336138/basic-chicken-soup"},
    {"site": "Food & Wine", "kind": "native_blocker", "url": "https://www.foodandwine.com/recipes/classic-beef-chili"},
    {"site": "Maangchi", "kind": "native_blocker", "url": "https://www.maangchi.com/recipe/bibimbap"},
    {"site": "Food52", "kind": "native_blocker", "url": "https://food52.com/recipes/27821-julia-child-s-coq-au-vin"},
    {"site": "NYT Cooking", "kind": "parser_gap", "url": "https://cooking.nytimes.com/recipes/1015819-chocolate-chip-cookies"},
    {"site": "Half Baked Harvest", "kind": "control", "url": "https://www.halfbakedharvest.com/slow-cooker-coq-au-vin/"},
    {"site": "BBC Good Food", "kind": "control", "url": "https://www.bbcgoodfood.com/recipes/chicken-tikka-masala"},
    {"site": "Sally's Baking Addiction", "kind": "control", "url": "https://sallysbakingaddiction.com/chewy-chocolate-chip-cookies/"},
    {"site": "Love and Lemons", "kind": "control", "url": "https://www.loveandlemons.com/lemon-pasta/"},
    {"site": "King Arthur Baking", "kind": "control", "url": "https://www.kingarthurbaking.com/recipes/big-and-bubbly-focaccia-recipe"},
    {"site": "RecipeTin Eats", "kind": "control", "url": "https://www.recipetineats.com/one-pot-moussaka-beef-rice-pilaf/"},
]


def run_bridge(*args: str) -> dict[str, Any]:
    proc = subprocess.run(
        ["bun", BRIDGE, *args],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    lines = [line for line in proc.stdout.splitlines() if line.strip().startswith("{")]
    if lines:
        try:
            result = json.loads(lines[-1])
            result["process_exit"] = proc.returncode
            if proc.stderr.strip():
                result["stderr_tail"] = proc.stderr.strip()[-500:]
            return result
        except json.JSONDecodeError:
            pass
    return {
        "ok": False,
        "process_exit": proc.returncode,
        "error": proc.stderr.strip()[-1000:] or proc.stdout.strip()[-1000:] or "bridge produced no JSON",
    }


def recipe_scrapers_parse(html_path: Path, url: str) -> dict[str, Any]:
    started = time.perf_counter()
    html = html_path.read_text(encoding="utf-8", errors="replace")
    try:
        scraper = scrape_html(html, org_url=url, supported_only=False)
        try:
            ingredients = scraper.ingredients() or []
        except Exception:
            ingredients = []
        try:
            instructions = scraper.instructions() or ""
        except Exception:
            instructions = ""
        try:
            title = scraper.title()
        except Exception:
            title = None
        instruction_count = (
            len(instructions)
            if isinstance(instructions, list)
            else (1 if str(instructions).strip() else 0)
        )
        return {
            "ok": bool(ingredients or instruction_count),
            "duration_ms": round((time.perf_counter() - started) * 1000, 2),
            "scraper": type(scraper).__name__,
            "name": title,
            "ingredients": len(ingredients),
            "instructions": instruction_count,
        }
    except (NoSchemaFoundInWildMode, AttributeError) as exc:
        return {
            "ok": False,
            "duration_ms": round((time.perf_counter() - started) * 1000, 2),
            "error": f"{type(exc).__name__}: {exc}",
        }
    except Exception as exc:
        return {
            "ok": False,
            "duration_ms": round((time.perf_counter() - started) * 1000, 2),
            "error": f"{type(exc).__name__}: {exc}",
        }


def challenge_detected(response: httpx.Response) -> bool:
    status = response.status_code
    if status in (404, 410):
        return False
    if 400 <= status < 500:
        return True
    if status == 503:
        return True
    if response.headers.get("cf-mitigated", "").lower() == "challenge":
        return True
    sample = response.text[:120_000].lower()
    markers = (
        "challenge-platform",
        "just a moment...",
        "cf-chl-",
        "captcha",
        "access denied",
    )
    return any(marker in sample for marker in markers)


def hard_http_error(status: int) -> bool:
    if status in (404, 410):
        return True
    if status >= 500 and status != 503:
        return True
    return False


async def mealie_style_fetch(url: str, output_path: Path) -> dict[str, Any]:
    started_all = time.perf_counter()
    attempts: list[dict[str, Any]] = []
    for profile in BROWSER_IMPERSONATIONS:
        attempt_started = time.perf_counter()
        try:
            transport = AsyncCurlTransport(impersonate=profile, default_headers=True)
            async with httpx.AsyncClient(
                transport=transport,
                follow_redirects=True,
                timeout=httpx.Timeout(15.0),
            ) as client:
                response = await client.get(url)
                blocked = challenge_detected(response)
                attempts.append(
                    {
                        "profile": profile,
                        "status": response.status_code,
                        "blocked": blocked,
                        "duration_ms": round((time.perf_counter() - attempt_started) * 1000, 2),
                        "bytes": len(response.content),
                        "final_url": str(response.url),
                    }
                )
                if response.is_success and not blocked:
                    output_path.write_bytes(response.content)
                    return {
                        "ok": True,
                        "status": response.status_code,
                        "profile": profile,
                        "final_url": str(response.url),
                        "duration_ms": round((time.perf_counter() - started_all) * 1000, 2),
                        "bytes": len(response.content),
                        "attempts": attempts,
                    }
                if hard_http_error(response.status_code):
                    return {
                        "ok": False,
                        "status": response.status_code,
                        "duration_ms": round((time.perf_counter() - started_all) * 1000, 2),
                        "attempts": attempts,
                        "error": f"hard HTTP {response.status_code}",
                    }
                if response.status_code in (429, 503):
                    await asyncio.sleep(1.0)
        except Exception as exc:
            attempts.append(
                {
                    "profile": profile,
                    "status": None,
                    "blocked": False,
                    "duration_ms": round((time.perf_counter() - attempt_started) * 1000, 2),
                    "error": f"{type(exc).__name__}: {exc}",
                }
            )
    return {
        "ok": False,
        "status": attempts[-1].get("status") if attempts else None,
        "duration_ms": round((time.perf_counter() - started_all) * 1000, 2),
        "attempts": attempts,
        "error": "all browser impersonations were blocked or failed",
    }


def parser_pair(path: Path, url: str) -> dict[str, Any]:
    return {
        "munch": run_bridge("parse", str(path)),
        "recipe_scrapers": recipe_scrapers_parse(path, url),
    }


async def run_case(case: dict[str, str], temp_root: Path) -> dict[str, Any]:
    slug = "".join(ch.lower() if ch.isalnum() else "-" for ch in case["site"]).strip("-")
    native_path = temp_root / f"{slug}-native.html"
    mealie_path = temp_root / f"{slug}-mealie.html"

    native_fetch = run_bridge("fetch", case["url"], str(native_path))
    native_parsers = parser_pair(native_path, case["url"]) if native_fetch.get("ok") and native_path.exists() else None

    mealie_fetch = await mealie_style_fetch(case["url"], mealie_path)
    mealie_parsers = parser_pair(mealie_path, case["url"]) if mealie_fetch.get("ok") and mealie_path.exists() else None

    row = {
        "type": "row",
        **case,
        "native": {
            "fetch": native_fetch,
            "parsers": native_parsers,
        },
        "mealie_transport": {
            "fetch": mealie_fetch,
            "parsers": mealie_parsers,
        },
    }
    print(json.dumps(row), flush=True)
    return row


def parser_ok(row: dict[str, Any], side: str, parser: str) -> bool:
    parsers = row.get(side, {}).get("parsers") or {}
    return bool((parsers.get(parser) or {}).get("ok"))


def fetch_ok(row: dict[str, Any], side: str) -> bool:
    return bool(row.get(side, {}).get("fetch", {}).get("ok"))


async def main() -> int:
    started = time.perf_counter()
    rows: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="munch-mealie-diagnostic-") as temp_dir:
        root = Path(temp_dir)
        for case in CASES:
            rows.append(await run_case(case, root))

    native_failures = [row for row in rows if not fetch_ok(row, "native")]
    recovered = [row for row in native_failures if fetch_ok(row, "mealie_transport")]
    same_html_recipe_scrapers_only = [
        row
        for row in rows
        if fetch_ok(row, "native")
        and not parser_ok(row, "native", "munch")
        and parser_ok(row, "native", "recipe_scrapers")
    ]
    same_html_munch_only = [
        row
        for row in rows
        if fetch_ok(row, "native")
        and parser_ok(row, "native", "munch")
        and not parser_ok(row, "native", "recipe_scrapers")
    ]
    summary = {
        "type": "summary",
        "cases": len(rows),
        "native_fetch_ok": sum(fetch_ok(row, "native") for row in rows),
        "mealie_fetch_ok": sum(fetch_ok(row, "mealie_transport") for row in rows),
        "native_fetch_failures": len(native_failures),
        "native_failures_recovered_by_mealie_transport": len(recovered),
        "recovered_sites": [row["site"] for row in recovered],
        "same_native_html_recipe_scrapers_only": [row["site"] for row in same_html_recipe_scrapers_only],
        "same_native_html_munch_only": [row["site"] for row in same_html_munch_only],
        "wall_ms": round((time.perf_counter() - started) * 1000, 2),
        "python_max_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
        "versions": {
            "python": sys.version.split()[0],
            "httpx": httpx.__version__,
            "recipe_scrapers": "15.12.0",
            "httpx_curl_cffi": "0.1.5",
        },
    }
    print(json.dumps(summary), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
