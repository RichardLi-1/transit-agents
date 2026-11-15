import json
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

import httpx2
from google.genai import errors, types

import core
import openai_compat
import prices
from tests import support
from tests.support import URL, FakeGemini, reply


def setUpModule():
    support.service.start()


def completion(content=None, calls=(), usage=(120, 30), finish="stop"):
    """A chat completion: text, or tool calls as (id, name, arguments)."""
    message = {"role": "assistant", "content": content}
    if calls:
        message["tool_calls"] = [
            {"id": id_, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}} for id_, name, args in calls
        ]
    return {
        "choices": [{"index": 0, "message": message, "finish_reason": finish}],
        "usage": {"prompt_tokens": usage[0], "completion_tokens": usage[1], "total_tokens": sum(usage)},
    }


class Server:
    """A chat completions server that answers from a script, keeping each request."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.requests = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append({"url": str(request.url), "headers": dict(request.headers), "body": json.loads(request.content)})
        status, body = self.answers.pop(0)
        return httpx2.Response(status, json=body)

    def client(self, key=None):
        return openai_compat.OpenAICompatClient("http://127.0.0.1:11434/v1/", key, transport=httpx2.MockTransport(self))


NOTE = core.LocalTool(
    "note", "Keep a note.", lambda text: f"noted {text}", {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}
)


class RequestTest(unittest.TestCase):
    def test_a_conversation_becomes_chat_messages(self):
        contents = [
            types.Content(role="user", parts=[types.Part(text="Find the minimum.")]),
            types.Content(
                role="model",
                parts=[
                    types.Part(text="Thinking aloud", thought=True),
                    types.Part(function_call=types.FunctionCall(id="c1", name="list_rules", args={"prefix": "ttc"})),
                ],
            ),
            types.Content(
                role="user",
                parts=[types.Part(function_response=types.FunctionResponse(id="c1", name="list_rules", response={"result": [1]}))],
            ),
        ]
        settings = types.GenerateContentConfig(system_instruction="Be careful.", max_output_tokens=500)
        body = openai_compat.request("qwen3.5:9b", contents, settings)
        self.assertEqual(body["model"], "qwen3.5:9b")
        self.assertEqual(body["max_tokens"], 500)
        roles = [m["role"] for m in body["messages"]]
        self.assertEqual(roles, ["system", "user", "assistant", "tool"])
        assistant = body["messages"][2]
        self.assertIsNone(assistant["content"])  # the thought is left out
        self.assertEqual(assistant["tool_calls"][0]["id"], "c1")
        self.assertEqual(json.loads(assistant["tool_calls"][0]["function"]["arguments"]), {"prefix": "ttc"})
        self.assertEqual(body["messages"][3]["tool_call_id"], "c1")
        self.assertEqual(json.loads(body["messages"][3]["content"]), {"result": [1]})

    def test_tools_from_the_service_and_local_ones_become_functions(self):
        mcp_tool = SimpleNamespace(
            name="read_page",
            description="Read a page.",
            input_schema={"$schema": "x", "type": "object", "properties": {"page": {"type": "integer"}}},
        )
        local = types.Tool(function_declarations=[NOTE.declaration()])
        body = openai_compat.request("m", [], types.GenerateContentConfig(tools=[mcp_tool, local]))
        names = [tool["function"]["name"] for tool in body["tools"]]
        self.assertEqual(names, ["read_page", "note"])
        self.assertNotIn("$schema", body["tools"][0]["function"]["parameters"])
        note = body["tools"][1]["function"]["parameters"]
        self.assertEqual(note["type"], "object")
        self.assertEqual(note["properties"]["text"]["type"], "string")
        self.assertEqual(note["required"], ["text"])

    def test_tools_off_leaves_the_tools_out(self):
        local = types.Tool(function_declarations=[NOTE.declaration()])
        settings = core._last_call(types.GenerateContentConfig(system_instruction="Go.", tools=[local]))
        body = openai_compat.request("m", [], settings)
        self.assertNotIn("tools", body)

    def test_a_schema_asks_for_json_in_its_shape(self):
        schema = types.Schema.from_json_schema(json_schema=types.JSONSchema(type="object", properties={"value": {"type": "number"}}))
        body = openai_compat.request("m", [], types.GenerateContentConfig(response_mime_type="application/json", response_schema=schema))
        self.assertEqual(body["response_format"]["type"], "json_schema")
        self.assertEqual(body["response_format"]["json_schema"]["schema"]["properties"]["value"]["type"], "number")

    def test_json_is_asked_for_in_words_too_for_a_server_that_ignores_response_format(self):
        schema = types.Schema.from_json_schema(json_schema=types.JSONSchema(type="object", properties={"value": {"type": "number"}}))
        settings = types.GenerateContentConfig(system_instruction="Read it.", response_mime_type="application/json", response_schema=schema)
        system = openai_compat.request("m", [], settings)["messages"][0]
        self.assertEqual(system["role"], "system")
        self.assertTrue(system["content"].startswith("Read it.\n\nReply with one JSON object and nothing else, in this JSON schema: {"))
        self.assertIn('"value": {"type": "number"}', system["content"])
        bare = openai_compat.request("m", [], types.GenerateContentConfig(response_mime_type="application/json"))
        self.assertEqual(bare["messages"], [{"role": "system", "content": "Reply with one JSON object and nothing else."}])
        self.assertEqual(openai_compat.request("m", [], types.GenerateContentConfig(system_instruction="Go."))["messages"],
                         [{"role": "system", "content": "Go."}])

    def test_model_extra_is_added_to_each_request(self):
        with mock.patch.dict(os.environ, {"MODEL_EXTRA": '{"reasoning_effort": "none"}'}):
            body = openai_compat.request("m", [], None)
        self.assertEqual(body["reasoning_effort"], "none")


class ResponseTest(unittest.TestCase):
    def test_a_completion_becomes_a_gemini_response(self):
        response = openai_compat.response(
            completion("<think>hmm</think>The answer.", [("c9", "note", {"text": "x"})], usage=(200, 40))
        )
        self.assertEqual(response.text, "The answer.")
        self.assertEqual(response.function_calls[0].id, "c9")
        self.assertEqual(response.function_calls[0].args, {"text": "x"})
        self.assertEqual(response.usage_metadata.prompt_token_count, 200)
        self.assertEqual(response.usage_metadata.candidates_token_count, 40)

    def test_a_json_reply_is_cut_to_its_first_json_value(self):
        fenced = completion('```json\n{"behaviour": "answer"}\n```')
        self.assertEqual(openai_compat.response(fenced, json_reply=True).text, '{"behaviour": "answer"}')
        stray = completion('{"behaviour": "flag", "checks": {"productivity": "fail"}}}')
        self.assertEqual(openai_compat.response(stray, json_reply=True).text, '{"behaviour": "flag", "checks": {"productivity": "fail"}}')
        self.assertEqual(openai_compat.response(completion("- behaviour: answer"), json_reply=True).text, "- behaviour: answer")
        self.assertEqual(openai_compat.response(stray).text, stray["choices"][0]["message"]["content"])

    def test_bad_arguments_become_empty_and_a_cut_off_reply_says_so(self):
        body = completion(finish="length")
        body["choices"][0]["message"]["tool_calls"] = [{"id": "c1", "function": {"name": "note", "arguments": "{not json"}}]
        response = openai_compat.response(body)
        self.assertEqual(response.function_calls[0].args, {})
        self.assertEqual(response.candidates[0].finish_reason, types.FinishReason.MAX_TOKENS)


class ClientTest(unittest.IsolatedAsyncioTestCase):
    async def test_posts_to_chat_completions_with_the_key(self):
        server = Server((200, completion("Hi.")))
        async with server.client("secret").aio as aio:
            response = await aio.models.generate_content(model="m", contents=[types.Content(role="user", parts=[types.Part(text="Hello")])])
        self.assertEqual(response.text, "Hi.")
        self.assertEqual(server.requests[0]["url"], "http://127.0.0.1:11434/v1/chat/completions")
        self.assertEqual(server.requests[0]["headers"]["authorization"], "Bearer secret")

    async def test_model_log_keeps_each_raw_request_and_reply(self):
        server = Server((200, completion("Hi.")))
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "raw.jsonl")
            with mock.patch.dict(os.environ, {"MODEL_LOG": path}):
                async with server.client().aio as aio:
                    await aio.models.generate_content(model="m", contents=[types.Content(role="user", parts=[types.Part(text="Hello")])])
            (line,) = open(path).read().splitlines()
        kept = json.loads(line)
        self.assertEqual(kept["request"]["messages"][0]["content"], "Hello")
        self.assertEqual(json.loads(kept["reply"])["choices"][0]["message"]["content"], "Hi.")

    async def test_a_server_error_is_an_api_error_work_can_retry(self):
        server = Server((503, {"error": {"message": "loading model"}}))
        async with server.client().aio as aio:
            with self.assertRaises(errors.APIError) as caught:
                await aio.models.generate_content(model="m", contents=[])
        self.assertEqual(caught.exception.code, 503)
        self.assertIn("loading model", caught.exception.message)

    async def test_gemini_models_go_to_gemini_and_the_rest_to_the_server(self):
        server = Server((200, completion("From the server.")))
        gemini = SimpleNamespace(aio=FakeAio(FakeGemini(lambda request: reply(text="From Gemini."))))
        async with openai_compat.RoutingClient(server.client(), gemini).aio as aio:
            local = await aio.models.generate_content(model="qwen3.5:9b", contents=[])
            remote = await aio.models.generate_content(model="gemini-3.6-flash", contents=[])
        self.assertEqual(local.text, "From the server.")
        self.assertEqual(remote.text, "From Gemini.")

    async def test_no_gemini_key_means_no_gemini_models(self):
        async with openai_compat.RoutingClient(Server().client()).aio as aio:
            with self.assertRaises(errors.APIError) as caught:
                await aio.models.generate_content(model="gemini-3.6-flash", contents=[])
        self.assertIn("GEMINI_API_KEY", caught.exception.message)


class FakeAio:
    def __init__(self, client):
        self.client = client

    async def __aenter__(self):
        return self.client

    async def __aexit__(self, *_):
        return None


class LocalPriceTest(unittest.TestCase):
    def test_a_model_on_this_machine_costs_nothing(self):
        with mock.patch.dict(os.environ, {"MODEL_BASE_URL": "http://127.0.0.1:11434/v1", "MODEL_PRICES": ""}):
            self.assertEqual(prices.cost("qwen3.5:9b", 10_000, 2_000), 0.0)
            self.assertGreater(prices.cost("gemini-3.6-flash", 10_000, 2_000), 0)

    def test_a_remote_server_has_no_price_unless_given(self):
        with mock.patch.dict(os.environ, {"MODEL_BASE_URL": "https://api.example.com/v1", "MODEL_PRICES": ""}):
            self.assertIsNone(prices.cost("qwen3.5:9b", 10_000, 2_000))

    def test_off_makes_every_model_gemini(self):
        with mock.patch.dict(os.environ, {"MODEL_BASE_URL": "off"}):
            self.assertIsNone(openai_compat.base_url())
            self.assertFalse(openai_compat.is_local("qwen3.5:9b"))

    def test_on_prem_by_default_ollama_on_this_machine(self):
        # As when Ollama runs; without it, Gemini's fallback (ConfigTest in test_core).
        with mock.patch.dict(os.environ, {"MODEL_BASE_URL": ""}), mock.patch.object(openai_compat, "answers", return_value=True):
            self.assertEqual(openai_compat.base_url(), "http://127.0.0.1:11434/v1")
            self.assertTrue(openai_compat.is_local("qwen3.5:9b"))
            self.assertFalse(openai_compat.is_local("gemini-3.6-flash"))
            self.assertEqual(core.config().specialist_concurrency, 1)


class WorkTest(unittest.IsolatedAsyncioTestCase):
    """The agents' own tool loop, on an open model behind a chat completions server."""

    def setUp(self):
        self.enterContext(
            mock.patch.dict(
                os.environ, {"MAX_MODEL_CALLS": "", "TRANSIT_URL": URL, "MODEL_BASE_URL": "http://127.0.0.1:11434/v1", "MODEL_PRICES": ""}
            )
        )

    async def test_runs_service_and_local_tools_and_reports_usage_at_no_cost(self):
        study = support.open_study("compat")
        notes = []
        note = core.LocalTool("note", "Keep a note.", lambda text: notes.append(text) or "noted", NOTE.parameters)
        server = Server(
            (200, completion(calls=[("a1", "list_sources", {}), ("a2", "note", {"text": "hello"})])),
            (200, completion("Done: two sources.")),
        )
        async with server.client().aio as aio, support.session() as session:
            answer = await core.work(
                session, aio, study=study, model="qwen3.5:9b", instructions="Test agent.", task="Go.", local=[note]
            )
        self.assertEqual(answer, "Done: two sources.")
        self.assertEqual(notes, ["hello"])
        first, second = (request["body"] for request in server.requests)
        names = {tool["function"]["name"] for tool in first["tools"]}
        self.assertIn("list_sources", names)
        self.assertIn("note", names)
        answered = {m["tool_call_id"] for m in second["messages"] if m["role"] == "tool"}
        self.assertEqual(answered, {"a1", "a2"})
        usage = support.activities(study, "usage")
        self.assertEqual([u["model"] for u in usage], ["qwen3.5:9b", "qwen3.5:9b"])
        self.assertEqual([u.get("costUsd") for u in usage], [0, 0])
