"""Training data for train.py from an eval run: each agent's whole conversation, in the
cases of one split that the scorer passed.

    python agents/sft/extract.py --run evals/runs/<UTC time>.jsonl --scores scores.json --out train.jsonl

Run it in the training venv: it checks each conversation tokenises as train.py needs, and
counts its tokens. --scores is the run's `node evals/score-run.ts --json <run>`. Only cases
of --split (dev unless set; never train on test cases) that passed are read.

The eval runner, with EVAL_MODEL_LOGS=1, keeps each case's raw model calls beside its log,
<id>.model.jsonl: the lead's and its specialists', never the reader's, which has a file of
its own. Each call sends the whole conversation so far, so a conversation is rebuilt by
chaining each call onto the one whose messages and reply it extends; its last call and
reply are the whole of it. Messages are put as mlx-lm's server puts them before the chat
template, so training sees what serving saw: no content is "", and a call's arguments are
an object. An agent's last call, made with its tools off and told so, keeps the agent's
own instructions and tools, as do its earlier calls.
"""

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

# Appended to an agent's instructions for its last call (core.LAST_CALL).
LAST_CALL = (
    "\n\nThis is your last model call, and your tools are off. Answer now from what you have, "
    "and say what you couldn't find or check."
)


def served(message: dict[str, Any]) -> dict[str, Any]:
    """A message as mlx-lm's server gives it to the chat template."""
    out = dict(message)
    if out.get("content") is None:
        out["content"] = ""
    if out.get("role") == "system" and out["content"].endswith(LAST_CALL):
        out["content"] = out["content"][: -len(LAST_CALL)]
    if calls := out.get("tool_calls"):
        fixed = []
        for call in calls:
            function = dict(call.get("function") or {})
            if isinstance(function.get("arguments"), str):
                try:
                    function["arguments"] = json.loads(function["arguments"] or "{}")
                except json.JSONDecodeError:
                    function["arguments"] = {}
            fixed.append({"type": "function", "function": {"name": function.get("name", ""), "arguments": function.get("arguments") or {}}})
        out["tool_calls"] = fixed
    else:
        out.pop("tool_calls", None)
    return {key: out[key] for key in ("role", "content", "tool_calls") if key in out}


def reply_message(reply: dict[str, Any]) -> dict[str, Any] | None:
    """The assistant's message in a chat completion, as the agents send it back next call:
    its text with any reasoning left out, and its tool calls."""
    choice = (reply.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    text = message.get("content") or ""
    if "</think>" in text:
        text = text.split("</think>", 1)[1]
    text = text.strip()
    calls = message.get("tool_calls") or []
    if not text and not calls:
        return None
    out: dict[str, Any] = {"role": "assistant", "content": text or None}
    if calls:
        out["tool_calls"] = calls
    return out


def conversations(path: Path) -> list[dict[str, Any]]:
    """The conversations in a case's raw model calls, each its last request and reply."""
    chains: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        kept = json.loads(line)
        if kept.get("status") != 200:
            continue
        try:
            reply = json.loads(kept["reply"])
        except (ValueError, TypeError):
            continue
        request = kept["request"]
        sent = [served(m) for m in request["messages"]]
        best = None
        for chain in chains:
            done = chain["messages"]
            # A retry sends the same messages; a next call adds the reply and the results.
            if len(sent) >= len(done) and sent[: len(done)] == done and (best is None or len(done) > len(best["messages"])):
                best = chain
        if best is None:
            best = {"tools": None}
            chains.append(best)
        best["messages"] = sent
        best["reply"] = reply_message(reply)
        if request.get("tools"):
            best["tools"] = request["tools"]
        # What the next call in this conversation will start with.
        best["messages"] = sent + ([served(best["reply"])] if best["reply"] else [])
    return chains


def agent_of(messages: list[dict[str, Any]]) -> tuple[str, str | None]:
    system = messages[0]["content"] if messages and messages[0]["role"] == "system" else ""
    if "You lead the first pass on study" in system:
        return "lead", None
    if "You are a specialist working on study" in system:
        skill = None
        if "\n\nSkill " in system:
            skill = system.split("\n\nSkill ", 1)[1].split(":", 1)[0].strip()
        return "specialist", skill
    return "other", None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--run", required=True, help="the run file, evals/runs/<UTC time>.jsonl")
    parser.add_argument("--scores", required=True, help="score-run.ts --json's output for the run")
    parser.add_argument("--cases", default=str(Path(__file__).resolve().parents[2] / "evals" / "cases.jsonl"))
    parser.add_argument("--split", default="dev", help="the split to take passing cases from (default: dev)")
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", default=None, help="tokeniser to check and count with (default: train.py's MODEL)")
    args = parser.parse_args(argv)
    if args.split == "test":
        print("Never train on test cases.", file=sys.stderr)
        return 1

    split = {c["id"]: c["split"] for c in map(json.loads, Path(args.cases).read_text().splitlines()) if c}
    rows = json.loads(Path(args.scores).read_text())["rows"]
    passed = [row["id"] for row in rows if row["passed"] is True and split.get(row["id"]) == args.split]
    logs = Path(args.run).with_suffix("")

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from mlx_lm.tokenizer_utils import load as load_tokenizer  # noqa: E402
    from mlx_lm.utils import _download  # noqa: E402

    import train  # noqa: E402

    tokenizer = load_tokenizer(_download(args.model or train.MODEL))
    out, counts, tokens, targets, skipped = [], Counter(), 0, 0, Counter()
    for case in passed:
        path = logs / f"{case}.model.jsonl"
        if not path.exists():
            skipped["no model log"] += 1
            continue
        for n, chain in enumerate(conversations(path)):
            if chain["reply"] is None:
                skipped["no reply"] += 1
                continue
            agent, skill = agent_of(chain["messages"])
            if agent == "other":
                skipped["not an agent's"] += 1
                continue
            row = {"messages": chain["messages"], "tools": chain["tools"], "meta": {"id": f"{case}#{n}", "case": case, "agent": agent, "skill": skill}}
            try:
                full, spans = train.tokenize(tokenizer, row)
            except ValueError as error:
                skipped[f"doesn't tokenise as a prefix: {error}"[:80]] += 1
                continue
            out.append(row)
            counts[f"{agent}:{skill}"] += 1
            tokens += len(full)
            targets += sum(end - start for start, end in spans)
    Path(args.out).write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in out))
    summary = {
        "cases": len(passed), "caseIds": passed, "conversations": len(out), "byAgent": dict(counts),
        "tokens": tokens, "assistantTokens": targets, "skipped": dict(skipped),
    }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
