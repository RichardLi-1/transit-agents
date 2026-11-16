"""Train a LoRA adapter on the generated trajectories, on this Mac, with mlx-lm.

    agents/.venv-train/bin/python agents/sft/train.py --data <dir>/train.jsonl --out <dir>/adapter

It runs in the training venv (agents/sft/requirements.txt), not the agents' own. Each
line of the data is one agent's whole conversation, as openai_compat.py sends it: the
system message, the task, each assistant turn with its tool calls, and the tool results.
Every assistant turn is trained on at once (its tokens alone count in the loss), so a
trajectory is one forward and one backward pass, not one per turn.

16 GB is tight, and every conversation opens with the same long block of tool
declarations and instructions, about 3,000 tokens before the study's name. So:

- conversations are grouped by agent and skill, whose openings are the same, and that
  shared opening is run once a group, without gradients, with the adapter as it is,
  and kept as the attention cache. It is run again every --refresh steps. The adapter
  learns only from what follows the opening: how the model reads it isn't trained.
- only the last --layers layers get adapters; the rest run in inference mode, on
  mlx-lm's fast kernels, since nothing flows back through them.
- Qwen3.5's linear-attention layers use gdn_chunked.py's chunked recurrence, whose
  backward pass fits in memory.
- the logits are computed only where the loss is: the vocabulary is 248,320 wide.

The adapter is saved as mlx-lm saves one, so `mlx_lm.server --adapter-path` serves it.
"""

import argparse
import json
import math
import random
import sys
import time
from collections import defaultdict
from pathlib import Path

import mlx.core as mx
import mlx.nn as nn
import mlx.optimizers as optim
from mlx.utils import tree_flatten
from mlx_lm import load
from mlx_lm.models.cache import ArraysCache, KVCache
from mlx_lm.tuner.utils import linear_to_lora_layers

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gdn_chunked  # noqa: E402

MODEL = "mlx-community/Qwen3.5-4B-4bit"


def tokenize(tokenizer, row: dict) -> tuple[list[int], list[tuple[int, int]]]:
    """The conversation's tokens, and each assistant turn's [start, end) in them, its
    closing <|im_end|> included, so the model learns to stop.

    The turns have no reasoning, so Qwen3.5's template gives each an empty think block,
    as it does a prompt with thinking off: the model is served with enable_thinking
    false, and the prompt then ends where each turn's own words begin."""
    messages, tools = row["messages"], row.get("tools") or None

    def ids(part, generation=False):
        return list(
            tokenizer.apply_chat_template(
                part, tools=tools, tokenize=True, add_generation_prompt=generation, enable_thinking=False
            )
        )

    full = ids(messages)
    spans = []
    for i, message in enumerate(messages):
        if message["role"] != "assistant":
            continue
        before, after = ids(messages[:i], True), ids(messages[: i + 1])
        if full[: len(after)] != after or after[: len(before)] != before:
            raise ValueError(f"{row.get('meta', {}).get('id')}: turn {i} doesn't tokenize as a prefix of the conversation")
        end = len(after)
        while end > len(before) and full[end - 1] != tokenizer.convert_tokens_to_ids("<|im_end|>"):
            end -= 1  # leave out the newline after <|im_end|>
        spans.append((len(before), end))
    return full, spans


def common_prefix(sequences: list[list[int]]) -> int:
    first = sequences[0]
    n = min(map(len, sequences))
    for other in sequences[1:]:
        i = 0
        while i < n and other[i] == first[i]:
            i += 1
        n = i
    return n


class PrefixKV(KVCache):
    """An attention cache that starts from a shared opening and only ever grows a copy of it."""

    def __init__(self, keys, values):
        super().__init__()
        self.keys, self.values, self.offset = keys, values, keys.shape[2]

    def update_and_fetch(self, keys, values):
        self.keys = mx.concatenate([self.keys, keys], axis=2)
        self.values = mx.concatenate([self.values, values], axis=2)
        self.offset += keys.shape[2]
        return self.keys, self.values


def snapshot(model, tokens: list[int]):
    """Run the shared opening with the adapter as it is, in inference mode, and keep its cache."""
    caches = model.make_cache()
    trained = [layer.training for layer in model.layers]
    for layer in model.layers:
        layer.eval()
    model.language_model.model(mx.array([tokens]), cache=caches)
    for layer, was in zip(model.layers, trained):
        layer.train(was)
    kept = []
    for cache in caches:
        if isinstance(cache, ArraysCache):
            kept.append(("ssm", [mx.stop_gradient(c) for c in cache.cache]))
        else:
            k, v = cache.keys[..., : cache.offset, :], cache.values[..., : cache.offset, :]
            kept.append(("kv", [mx.stop_gradient(k), mx.stop_gradient(v)]))
    mx.eval([arrays for _, arrays in kept])
    return kept


def fresh(kept):
    """New cache objects over a snapshot's arrays, for one example."""
    caches = []
    for kind, arrays in kept:
        if kind == "ssm":
            cache = ArraysCache(size=len(arrays))
            cache.cache = list(arrays)
        else:
            cache = PrefixKV(*arrays)
        caches.append(cache)
    return caches


def loss_fn(model, suffix, targets, positions, caches):
    hidden = model.language_model.model(suffix, cache=caches)
    picked = hidden[0, positions]
    head = model.language_model
    logits = head.lm_head(picked) if hasattr(head, "lm_head") else head.model.embed_tokens.as_linear(picked)
    return nn.losses.cross_entropy(logits.astype(mx.float32), targets).mean()


def prepare(tokenizer, rows, max_tokens):
    """Tokenise, group by agent and skill, find each group's shared opening, and drop
    conversations too long to train on here."""
    items, dropped = [], 0
    for row in rows:
        tokens, spans = tokenize(tokenizer, row)
        meta = row.get("meta", {})
        items.append({"tokens": tokens, "spans": spans, "group": f"{meta.get('agent')}:{meta.get('skill')}", "id": meta.get("id")})
    groups = defaultdict(list)
    for item in items:
        groups[item["group"]].append(item)
    prefix = {}
    for name, members in groups.items():
        # The opening runs to the study's name. A group of one keeps 64 tokens back.
        n = common_prefix([m["tokens"] for m in members]) if len(members) > 1 else max(0, len(members[0]["tokens"]) - 64)
        n = min(n, min(m["spans"][0][0] for m in members) - 1)
        prefix[name] = n
    kept = []
    for item in items:
        p = prefix[item["group"]]
        if len(item["tokens"]) - p > max_tokens:
            dropped += 1
            continue
        kept.append(item)
    return kept, {name: members[0]["tokens"][: prefix[name]] for name, members in groups.items()}, dropped


def batch_for(item, opening: int):
    tokens = item["tokens"]
    suffix = mx.array([tokens[opening:-1]])
    positions, targets = [], []
    for start, end in item["spans"]:
        positions += range(start - 1 - opening, end - 1 - opening)
        targets += tokens[start:end]
    return suffix, mx.array(targets), mx.array(positions)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data", required=True, help="trajectories, one JSON line each")
    parser.add_argument("--val", help="held-out trajectories, for a validation loss")
    parser.add_argument("--out", required=True, help="the adapter's folder")
    parser.add_argument("--model", default=MODEL)
    parser.add_argument("--layers", type=int, default=8, help="layers, from the last, with adapters")
    parser.add_argument("--rank", type=int, default=16)
    parser.add_argument("--scale", type=float, default=20.0)
    parser.add_argument("--lr", type=float, default=1e-4)
    parser.add_argument("--warmup", type=int, default=10)
    parser.add_argument("--steps", type=int, help="examples to train on (default: one epoch)")
    parser.add_argument("--max-tokens", type=int, default=5000, help="the most tokens after the shared opening")
    parser.add_argument("--refresh", type=int, default=16, help="steps before a group's opening is run again")
    parser.add_argument("--block", type=int, default=8, help="examples of one group in a row")
    parser.add_argument("--save-every", type=int, default=50)
    parser.add_argument("--val-every", type=int, default=100)
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args(argv)

    random.seed(args.seed)
    mx.random.seed(args.seed)
    mx.set_cache_limit(1 << 30)
    gdn_chunked.patch()
    model, tokenizer = load(args.model)
    model.freeze()
    lora = {"rank": args.rank, "scale": args.scale, "dropout": 0.0}
    linear_to_lora_layers(model, args.layers, lora)
    model.train()
    for layer in model.layers[: len(model.layers) - args.layers]:
        layer.eval()  # no adapter: mlx-lm's kernels, and nothing kept for a backward pass
    trainable = sum(v.size for _, v in tree_flatten(model.trainable_parameters()))

    read = lambda path: [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]
    started = time.time()
    items, openings, dropped = prepare(tokenizer, read(args.data), args.max_tokens)
    val_items, val_openings, _ = prepare(tokenizer, read(args.val), args.max_tokens) if args.val else ([], {}, 0)
    print(f"{len(items)} trajectories ({dropped} too long), {len(openings)} groups, {trainable:,} trainable parameters, "
          f"tokenised in {time.time() - started:.0f} s", flush=True)

    # Blocks of one group in a row, the blocks shuffled, so an opening is reused while it's fresh.
    by_group = defaultdict(list)
    for item in items:
        by_group[item["group"]].append(item)
    blocks = []
    for members in by_group.values():
        random.shuffle(members)
        blocks += [members[i : i + args.block] for i in range(0, len(members), args.block)]
    random.shuffle(blocks)
    order = [item for block in blocks for item in block]
    total = args.steps or len(order)
    order = (order * math.ceil(total / len(order)))[:total]

    schedule = optim.join_schedules(
        [optim.linear_schedule(1e-7, args.lr, args.warmup), optim.cosine_decay(args.lr, max(1, total - args.warmup), args.lr * 0.1)],
        [args.warmup],
    )
    optimizer = optim.AdamW(learning_rate=schedule, weight_decay=0.0)
    step_fn = nn.value_and_grad(model, loss_fn)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "adapter_config.json").write_text(
        json.dumps({"model": args.model, "fine_tune_type": "lora", "num_layers": args.layers, "lora_parameters": lora}, indent=2)
    )
    log = (out / "log.jsonl").open("a")
    cached: dict[str, tuple[int, list]] = {}

    def opening(name, table):
        when, kept = cached.get(name, (-(10**9), None))
        if kept is None or step - when >= args.refresh:
            kept = snapshot(model, table[name])
            cached[name] = (step, kept)
        return kept

    def save(name="adapters.safetensors"):
        mx.save_safetensors(str(out / name), dict(tree_flatten(model.trainable_parameters())))

    def validate():
        losses = []
        for item in val_items:
            kept = snapshot(model, val_openings[item["group"]])
            suffix, targets, positions = batch_for(item, len(val_openings[item["group"]]))
            losses.append(loss_fn(model, suffix, targets, positions, fresh(kept)).item())
        return sum(losses) / len(losses) if losses else None

    seen_tokens, window = 0, []
    began = time.time()
    for step, item in enumerate(order, 1):
        t = time.time()
        kept = opening(item["group"], openings)
        length = len(openings[item["group"]])
        suffix, targets, positions = batch_for(item, length)
        loss, grads = step_fn(model, suffix, targets, positions, fresh(kept))
        optimizer.update(model, grads)
        mx.eval(loss, model.trainable_parameters(), optimizer.state)
        seen_tokens += suffix.shape[1]
        window.append(loss.item())
        entry = {
            "step": step, "loss": round(loss.item(), 4), "id": item["id"], "group": item["group"],
            "tokens": suffix.shape[1], "targets": int(targets.size), "opening": length,
            "seconds": round(time.time() - t, 2), "peakGB": round(mx.get_peak_memory() / 1e9, 2),
            "lr": float(optimizer.learning_rate),
        }
        if step % args.val_every == 0 and val_items:
            entry["valLoss"] = round(validate(), 4)
        log.write(json.dumps(entry) + "\n")
        log.flush()
        if step % 10 == 0 or step == total or "valLoss" in entry:
            mean = sum(window) / len(window)
            window = []
            print(f"step {step}/{total} loss {mean:.3f}{' val ' + str(entry['valLoss']) if 'valLoss' in entry else ''} "
                  f"{entry['seconds']} s, {seen_tokens:,} tokens, {(time.time() - began) / 60:.1f} min, peak {entry['peakGB']} GB",
                  flush=True)
        if step % args.save_every == 0:
            save()
            save(f"{step:07d}_adapters.safetensors")
    save()
    summary = {"steps": total, "minutes": round((time.time() - began) / 60, 1), "tokens": seen_tokens,
               "peakGB": round(mx.get_peak_memory() / 1e9, 2), "trainable": trainable, "dropped": dropped}
    if val_items:
        summary["valLoss"] = validate()
    (out / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
