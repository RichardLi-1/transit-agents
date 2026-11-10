"""Models other than Gemini: any server with OpenAI's chat completions API, such as
Ollama on this machine, vLLM, or a hosted fine-tuning service.

The agents are written against google-genai, so this gives them a client with the
same shape: `client.aio` to hold it open, and `client.models.generate_content(model,
contents, config)`. It turns each Gemini request into a chat completion and the reply
back into a Gemini response, so work(), its tools, retries and usage reports are
unchanged. Model names starting "gemini" still go to Gemini, so an open model's run
can be read and scored by a Gemini reader, or by a local one for a free run.

    MODEL_BASE_URL=http://127.0.0.1:11434/v1   the server (Ollama's, here)
    MODEL_API_KEY=...                          if the server needs one
    MODEL_TIMEOUT_S=900                        a slow local model can take minutes
    MODEL_EXTRA={"reasoning_effort": "none"}   JSON added to every request
    MODEL_LOG=runs/raw.jsonl                    keep each raw request and reply, one a line

With MODEL_BASE_URL unset, every model is Gemini, as before. A server on this machine
costs nothing per call, so its models are priced at zero (prices.py).
"""

import json
import os
import re
from typing import Any
from urllib.parse import urlparse

import httpx2
from google.genai import errors, types

DEFAULT_TIMEOUT_S = 900
THINK = re.compile(r"<think>.*?</think>\s*", re.S)


def base_url() -> str | None:
    """The OpenAI-compatible server, or None when every model is Gemini."""
    return os.environ.get("MODEL_BASE_URL", "").strip().rstrip("/") or None


def is_gemini(model: str) -> bool:
    return model.startswith("gemini")


def is_local(model: str) -> bool:
    """A model served from this machine, whose calls cost nothing."""
    url = base_url()
    return bool(url) and not is_gemini(model) and (urlparse(url).hostname or "") in {"127.0.0.1", "localhost", "::1"}


# Requests ------------------------------------------------------------------


def _schema(declaration: types.FunctionDeclaration) -> dict[str, Any]:
    if declaration.parameters_json_schema is not None:
        return dict(declaration.parameters_json_schema)
    if declaration.parameters is not None:
        return declaration.parameters.json_schema.model_dump(exclude_none=True, mode="json")
    return {"type": "object", "properties": {}}


def _tools(tools: list[Any] | None) -> list[dict[str, Any]]:
    """Tools as OpenAI functions: MCP tools from the service, and google-genai ones."""
    out: list[dict[str, Any]] = []
    for tool in tools or []:
        if isinstance(tool, types.Tool):
            for declaration in tool.function_declarations or []:
                out.append(
                    {
                        "type": "function",
                        "function": {
                            "name": declaration.name,
                            "description": declaration.description or "",
                            "parameters": _schema(declaration),
                        },
                    }
                )
        elif (given := getattr(tool, "input_schema", None) or getattr(tool, "inputSchema", None)) is not None:  # an MCP tool
            schema = {k: v for k, v in given.items() if k != "$schema"}
            out.append(
                {"type": "function", "function": {"name": tool.name, "description": tool.description or "", "parameters": schema}}
            )
    return out


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, types.Content):
        return "".join(part.text for part in content.parts or [] if part.text and not part.thought)
    return str(content)


def messages(contents: list[types.Content], settings: types.GenerateContentConfig | None) -> list[dict[str, Any]]:
    """A Gemini conversation as chat messages: the system instruction, then each turn.

    A model turn's function calls become tool_calls, and each function response after
    it a tool message answering its call's id. Thoughts are left out."""
    out: list[dict[str, Any]] = []
    if settings is not None and settings.system_instruction:
        out.append({"role": "system", "content": _text(settings.system_instruction)})
    for content in contents:
        parts = content.parts or []
        if content.role == "model":
            calls = [part.function_call for part in parts if part.function_call]
            message: dict[str, Any] = {
                "role": "assistant",
                "content": "".join(part.text for part in parts if part.text and not part.thought) or None,
            }
            if calls:
                message["tool_calls"] = [
                    {
                        "id": call.id or f"call_{i}",
                        "type": "function",
                        "function": {"name": call.name, "arguments": json.dumps(call.args or {})},
                    }
                    for i, call in enumerate(calls)
                ]
            out.append(message)
            continue
        text = "".join(part.text for part in parts if part.text)
        if text:
            out.append({"role": "user", "content": text})
        for i, part in enumerate(parts):
            if response := part.function_response:
                out.append(
                    {
                        "role": "tool",
                        "tool_call_id": response.id or f"call_{i}",
                        "content": json.dumps(response.response, ensure_ascii=False, default=str),
                    }
                )
    return out


def request(model: str, contents: list[types.Content], settings: types.GenerateContentConfig | None) -> dict[str, Any]:
    """The chat completion request for one Gemini call."""
    body: dict[str, Any] = {"model": model, "messages": messages(contents, settings), "stream": False}
    if settings is not None:
        tools = _tools(settings.tools)
        mode = settings.tool_config and settings.tool_config.function_calling_config and settings.tool_config.function_calling_config.mode
        # Tools off: left out, so a server that ignores tool_choice can't call one.
        if tools and mode != types.FunctionCallingConfigMode.NONE:
            body["tools"] = tools
        if settings.max_output_tokens:
            body["max_tokens"] = settings.max_output_tokens
        if settings.temperature is not None:
            body["temperature"] = settings.temperature
        schema = settings.response_json_schema or (
            settings.response_schema.json_schema.model_dump(exclude_none=True, mode="json")
            if isinstance(settings.response_schema, types.Schema)
            else None
        )
        if schema is not None:
            body["response_format"] = {"type": "json_schema", "json_schema": {"name": "answer", "schema": schema}}
        elif settings.response_mime_type == "application/json":
            body["response_format"] = {"type": "json_object"}
    if extra := os.environ.get("MODEL_EXTRA", "").strip():
        body.update(json.loads(extra))
    return body


# Responses -----------------------------------------------------------------


def _arguments(text: str | None) -> dict[str, Any]:
    try:
        value = json.loads(text or "{}")
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def response(body: dict[str, Any]) -> types.GenerateContentResponse:
    """A chat completion as a Gemini response: its text and function calls as parts,
    and its tokens as usage. Reasoning counts as output, as Gemini bills thinking."""
    choice = (body.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    parts: list[types.Part] = []
    if text := THINK.sub("", message.get("content") or "").strip():
        parts.append(types.Part(text=text))
    for i, call in enumerate(message.get("tool_calls") or []):
        function = call.get("function") or {}
        parts.append(
            types.Part(
                function_call=types.FunctionCall(
                    id=call.get("id") or f"call_{i}", name=function.get("name", ""), args=_arguments(function.get("arguments"))
                )
            )
        )
    usage = body.get("usage") or {}
    finish = types.FinishReason.MAX_TOKENS if choice.get("finish_reason") == "length" else types.FinishReason.STOP
    return types.GenerateContentResponse(
        candidates=[types.Candidate(content=types.Content(role="model", parts=parts), finish_reason=finish)],
        usage_metadata=types.GenerateContentResponseUsageMetadata(
            prompt_token_count=usage.get("prompt_tokens", 0),
            candidates_token_count=usage.get("completion_tokens", 0),
            total_token_count=usage.get("total_tokens", 0),
        ),
    )


# Clients -------------------------------------------------------------------


class _Models:
    def __init__(self, client: "OpenAICompatClient"):
        self._client = client

    async def generate_content(self, *, model: str, contents: Any, config: types.GenerateContentConfig | None = None):
        return await self._client.generate(model, list(contents), config)


class OpenAICompatClient:
    """A google-genai-shaped client for a chat completions server."""

    def __init__(self, url: str, api_key: str | None = None, timeout_s: float | None = None, **http: Any):
        self.url = url.rstrip("/")
        headers = {"authorization": f"Bearer {api_key}"} if api_key else {}
        timeout = timeout_s or float(os.environ.get("MODEL_TIMEOUT_S") or DEFAULT_TIMEOUT_S)
        self._http = httpx2.AsyncClient(headers=headers, timeout=httpx2.Timeout(timeout), **http)
        self.models = _Models(self)

    @property
    def aio(self) -> "OpenAICompatClient":
        return self

    async def __aenter__(self) -> "OpenAICompatClient":
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self._http.aclose()

    async def generate(self, model: str, contents: list[types.Content], settings: types.GenerateContentConfig | None):
        body = request(model, contents, settings)
        reply = await self._http.post(f"{self.url}/chat/completions", json=body)
        if path := os.environ.get("MODEL_LOG", "").strip():
            with open(path, "a", encoding="utf-8") as log:
                log.write(json.dumps({"request": body, "status": reply.status_code, "reply": reply.text}, ensure_ascii=False) + "\n")
        if reply.status_code >= 400:
            try:
                said = reply.json()
            except ValueError:
                said = {"error": {"message": reply.text[:400]}}
            error = said.get("error") if isinstance(said, dict) else None
            message = error.get("message") if isinstance(error, dict) else str(error or said)
            raise errors.APIError(reply.status_code, {"error": {"code": reply.status_code, "message": message, "status": "ERROR"}})
        return response(reply.json())


class _RoutedModels:
    def __init__(self, router: "RoutingClient"):
        self._router = router

    async def generate_content(self, *, model: str, contents: Any, config: types.GenerateContentConfig | None = None):
        target = self._router.gemini if is_gemini(model) else self._router.other
        if target is None:
            raise errors.APIError(400, {"error": {"code": 400, "message": f"No server for {model}: set GEMINI_API_KEY for Gemini models.", "status": "INVALID_ARGUMENT"}})
        return await target.models.generate_content(model=model, contents=contents, config=config)


class RoutingClient:
    """Gemini models to Gemini, the rest to the chat completions server.

    `gemini` is a google-genai client, or None when there's no key: a run on open
    models alone needs none."""

    def __init__(self, other: OpenAICompatClient, gemini: Any | None = None):
        self.other = other
        self._gemini_client = gemini
        self.gemini: Any | None = None
        self.models = _RoutedModels(self)
        self._held: Any | None = None

    @property
    def aio(self) -> "RoutingClient":
        return self

    async def __aenter__(self) -> "RoutingClient":
        await self.other.__aenter__()
        if self._gemini_client is not None:
            self._held = self._gemini_client.aio
            self.gemini = await self._held.__aenter__()
        return self

    async def __aexit__(self, *exc: Any) -> None:
        if self._held is not None:
            await self._held.__aexit__(*exc)
        await self.other.__aexit__(*exc)
