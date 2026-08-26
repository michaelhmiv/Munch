#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import json
import resource
import time

import httpx
from httpx_curl_cffi import AsyncCurlTransport

TARGETS = [
    ("Serious Eats", "https://www.seriouseats.com/foolproof-pan-pizza-recipe"),
    ("Simply Recipes", "https://www.simplyrecipes.com/recipes/banana_bread/"),
    ("Martha Stewart", "https://www.marthastewart.com/336138/basic-chicken-soup"),
    ("Food & Wine", "https://www.foodandwine.com/recipes/classic-beef-chili"),
    ("Maangchi", "https://www.maangchi.com/recipe/bibimbap"),
    ("Food52", "https://food52.com/recipes/27821-julia-child-s-coq-au-vin"),
]
PROFILES = ("chrome", "firefox", "safari", "edge")
MARKERS = (
    b"__cf_chl", b"cf-browser-verification", b"/cdn-cgi/challenge-platform",
    b"challenges.cloudflare.com", b"_incapsula_resource", b"distil_r_captcha",
    b"px-captcha", b"perimeterx", b"datadome",
)


def blocked(response: httpx.Response) -> bool:
    if response.status_code == 503:
        return True
    if 400 <= response.status_code < 500 and response.status_code not in (404, 410):
        return True
    if "cf-mitigated" in response.headers:
        return True
    sample = response.content[:4096].lower()
    return any(marker in sample for marker in MARKERS)


async def main() -> None:
    for site, url in TARGETS:
        attempts = []
        for profile in PROFILES:
            started = time.perf_counter()
            try:
                transport = AsyncCurlTransport(
                    impersonate=profile,
                    default_headers=True,
                    verify=True,
                )
                async with httpx.AsyncClient(
                    transport=transport,
                    follow_redirects=False,
                    timeout=httpx.Timeout(5.0),
                ) as client:
                    response = await client.get(url)
                    is_blocked = blocked(response)
                    attempts.append({
                        "profile": profile,
                        "status": response.status_code,
                        "ok": response.is_success and not is_blocked,
                        "blocked": is_blocked,
                        "ms": round((time.perf_counter() - started) * 1000, 2),
                        "bytes": len(response.content),
                        "location": response.headers.get("location"),
                    })
                    if response.is_success and not is_blocked:
                        break
                    if response.status_code in (404, 410) or (response.status_code >= 500 and response.status_code != 503):
                        break
            except Exception as exc:
                attempts.append({
                    "profile": profile,
                    "ok": False,
                    "ms": round((time.perf_counter() - started) * 1000, 2),
                    "error": f"{type(exc).__name__}: {exc}",
                })
        print(json.dumps({
            "site": site,
            "attempts": attempts,
            "python_max_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
        }), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
