"""Gemini's prices, to put a cost on every model call.

US dollars per million tokens, on the paid tier, from Google's pricing page
(aistudio.google.com/docs/pricing), read on 2026-11-07. Thinking is billed as output.
MODEL_PRICES adds or replaces a model's price, from today:

    MODEL_PRICES=gemini-3.6-flash=0.75/3.75/0.075,gemini-x=2/12    input/output[/cached input]
"""

import os
from dataclasses import dataclass
from datetime import UTC, date, datetime

import openai_compat


@dataclass(frozen=True)
class Price:
    input: float
    output: float
    cached: float | None = None  # cached input; without it, cached input costs as input


FLASH = [(date.min, Price(0.75, 3.75, 0.075)), (date(2027, 1, 1), Price(1.50, 7.50, 0.15))]

# Each model's prices, from the day each applies.
PRICES: dict[str, list[tuple[date, Price]]] = {
    "gemini-3.6-flash": FLASH,
    "gemini-3.8-flash": FLASH,
    "gemini-3.5-flash-lite": [(date.min, Price(0.30, 2.50))],
    "gemini-3.1-pro-preview": [(date.min, Price(2.00, 12.00))],  # prompts up to 200,000 tokens
    "gemini-4-argon": [(date.min, Price(2.00, 10.00)), (date(2026, 12, 1), Price(4.00, 20.00))],
}


def price(model: str, on: date | None = None) -> Price | None:
    """The model's price on a day (default: today, UTC), or None if it has none."""
    model = model.removeprefix("models/")
    if (given := overrides().get(model)) is not None:
        return given
    if openai_compat.is_local(model):  # served from this machine: no charge per call
        return Price(0.0, 0.0)
    on = on or datetime.now(UTC).date()
    current = None
    for start, each in PRICES.get(model, []):
        if start <= on:
            current = each
    return current


def cost(
    model: str, input_tokens: int, output_tokens: int, cached_tokens: int = 0, on: date | None = None
) -> float | None:
    """What a call cost in US dollars, or None for a model with no price.

    input_tokens counts the cached ones too, as Gemini's prompt_token_count does.
    """
    rate = price(model, on)
    if rate is None:
        return None
    cached = min(max(cached_tokens, 0), input_tokens)
    cached_rate = rate.input if rate.cached is None else rate.cached
    usd = (input_tokens - cached) * rate.input + cached * cached_rate + output_tokens * rate.output
    return round(usd / 1_000_000, 8)


def overrides() -> dict[str, Price]:
    """MODEL_PRICES, read on each call. A ValueError says what's wrong with it."""
    text = os.environ.get("MODEL_PRICES", "").strip()
    found: dict[str, Price] = {}
    for item in filter(None, (part.strip() for part in text.split(","))):
        model, equals, numbers = item.partition("=")
        try:
            values = [float(number) for number in numbers.split("/")]
        except ValueError:
            values = []
        if not (equals and model.strip() and 2 <= len(values) <= 3 and all(value >= 0 for value in values)):
            raise ValueError(
                f"MODEL_PRICES: write each as model=input/output or model=input/output/cached, "
                f"in US dollars per million tokens, not {item!r}"
            )
        found[model.strip()] = Price(*values)
    return found
