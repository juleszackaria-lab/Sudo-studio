"""MISSION P1 - Mock proofs for backend/runtime/openai_compat.py (no Flask/llama needed).

Stubs: flask (route collector, request, jsonify, Response), llama model
(FakeLlama with scripted replies). Exercises the REAL handler code.
Run:  python3 test_p1_openai_mock.py
ASCII-only.
"""

import json
import sys
import types
from argparse import Namespace

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("PASS " if cond else "FAIL ") + name + ((" :: " + str(detail)[:160]) if detail and not cond else ""))


# ---------------------------------------------------------------- flask stub
flask_stub = types.ModuleType("flask")


class _Req:
    _json = None

    def get_json(self, force=True, silent=True):
        return self._json


flask_stub.request = _Req()
flask_stub.jsonify = lambda obj: obj  # passthrough: handlers return (dict, status)


class _Resp:
    def __init__(self, gen, mimetype=None, headers=None):
        self.gen = gen
        self.mimetype = mimetype
        self.headers = headers or {}


flask_stub.Response = _Resp
sys.modules["flask"] = flask_stub


class _App:
    def __init__(self):
        self.routes = {}

    def route(self, path, methods=None):
        def deco(fn):
            self.routes[(path, tuple(methods or ["GET"]))] = fn
            return fn
        return deco


# ---------------------------------------------------------------- fakes
import openai_compat as oc  # noqa: E402  (real module under test)


class FakeLlama:
    """Scripted llama_cpp.Llama: replies popped per create_chat_completion call."""

    def __init__(self, script=None):
        self.script = list(script or [])
        self.calls = []
        self.n_chat = 0

    def create_chat_completion(self, messages, temperature=0.1, max_tokens=512,
                               stop=None, stream=False, response_format=None,
                               top_p=None, top_k=None, repeat_penalty=None):
        self.calls.append({"messages": messages, "temperature": temperature,
                           "max_tokens": max_tokens, "stop": stop,
                           "stream": stream, "response_format": response_format,
                           "top_p": top_p, "top_k": top_k,
                           "repeat_penalty": repeat_penalty})
        if stream:
            return self._gen_stream()
        self.n_chat += 1
        text = self.script.pop(0) if self.script else "default reply"
        return {"id": "chatcmpl-fake%d" % self.n_chat, "object": "chat.completion",
                "created": 1700000000, "model": "fake-path",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                             "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 3, "total_tokens": 13}}

    def _gen_stream(self):
        for i, tok in enumerate(["Hel", "lo", "!"]):
            yield {"id": "x", "object": "chat.completion.chunk", "created": 1,
                   "model": "fake-path",
                   "choices": [{"index": 0, "delta": ({"role": "assistant"} if i == 0 else {}) if False else {"content": tok},
                                "finish_reason": None}]}
        yield {"id": "x", "object": "chat.completion.chunk", "created": 1,
               "model": "fake-path",
               "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}

    def create_completion(self, prompt, temperature=0.1, max_tokens=512,
                          stop=None, stream=False, grammar=None,
                          top_p=None, top_k=None, repeat_penalty=None):
        self.calls.append({"prompt": prompt, "stream": stream,
                           "grammar": bool(grammar), "top_p": top_p,
                           "top_k": top_k, "repeat_penalty": repeat_penalty})
        if stream:
            def _g():
                for tok in ["A", "B"]:
                    yield {"choices": [{"text": tok}]}
            return _g()
        return {"choices": [{"text": "completion-text"}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7}}


class OldLlama(FakeLlama):
    """llama without create_chat_completion (fallback path)."""

    def __getattribute__(self, name):
        if name == "create_chat_completion":
            raise AttributeError("missing")
        return super().__getattribute__(name)


def make_ctx(model=None, loaded=False):
    state = Namespace(model=model, model_name="Qwen-mock-GGUF" if loaded else None,
                      loaded=loaded, requests=0, startup_time=1700000000,
                      n_ctx=2048 if loaded else None)
    logs = []
    return {"state": state, "default_model": "Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF",
            "dlog": logs.append, "logger": Namespace(
                info=logs.append, warning=logs.append, error=logs.append)}, logs


def call(path, methods, body):
    flask_stub.request._json = body
    return app.routes[(path, tuple(methods))]()


TOOLS = [{"type": "function", "function": {
    "name": "get_weather",
    "description": "city weather",
    "parameters": {"type": "object", "properties": {"city": {"type": "string"}}}}}]

# ---------------------------------------------------------------- run
app = _App()
ctx, _logs = make_ctx(model=FakeLlama(), loaded=True)
oc.register_openai_routes(app, ctx)
state = ctx["state"]

# 1. /v1/models loaded
r = call("/v1/models", ["GET"], None)
print("PROOF models: " + json.dumps(r))
check("models loaded shape", r["object"] == "list" and r["data"][0]["id"] == "Qwen-mock-GGUF"
      and r["data"][0]["owned_by"] == "sudo-studio")
check("models n_ctx exposed (P26-b)", r["data"][0].get("n_ctx") == 2048, r["data"][0])

# 2. /v1/models unloaded -> empty list (200, honest)
state.loaded, state.model, state.model_name = False, None, None
r = call("/v1/models", ["GET"], None)
check("models unloaded empty", r == {"object": "list", "data": []}, r)

# 3. chat 503 sans modele
r, s = call("/v1/chat/completions", ["POST"], {"messages": [{"role": "user", "content": "hi"}]})
print("PROOF 503: status=%s body=%s" % (s, json.dumps(r)))
check("chat 503 no_model", s == 503 and r == {"error": "no_model_loaded"}, (s, r))

# reload model for next tests
state.loaded, state.model, state.model_name = True, FakeLlama(), "Qwen-mock-GGUF"

# 4. chat 400
r, s = call("/v1/chat/completions", ["POST"], {})
check("chat 400 empty body", s == 400 and r["error"]["type"] == "invalid_request_error", (s, r))
r, s = call("/v1/chat/completions", ["POST"], {"messages": []})
check("chat 400 empty messages", s == 400, s)
r, s = call("/v1/chat/completions", ["POST"], {"messages": [{"content": "x"}]})
check("chat 400 missing role", s == 400, s)

# 5. chat ok non-stream (usage natif conserve, model override)
state.model = FakeLlama(script=["Paris est la capitale."])
r = call("/v1/chat/completions", ["POST"],
         {"messages": [{"role": "user", "content": "capitale ?"}],
          "temperature": 0.2, "max_tokens": 100, "stop": ["END"]})
check("chat ok shape", r["object"] == "chat.completion"
      and r["choices"][0]["message"]["content"] == "Paris est la capitale."
      and r["model"] == "Qwen-mock-GGUF" and r["usage"]["total_tokens"] == 13, r)
c = state.model.calls[-1]
check("chat params passthrough", c["temperature"] == 0.2 and c["max_tokens"] == 100
      and c["stop"] == ["END"], c)

# 6. chat stream SSE
state.model = FakeLlama()
r = call("/v1/chat/completions", ["POST"],
         {"messages": [{"role": "user", "content": "hi"}], "stream": True})
check("stream mimetype", r.mimetype == "text/event-stream", r.mimetype)
lines = list(r.gen)
print("PROOF SSE first lines:")
for ln in lines[:3]:
    print("  " + ln.strip())
check("stream framing", lines[0].startswith("data: ") and lines[-1] == "data: [DONE]\n\n"
      and json.loads(lines[0][6:])["object"] == "chat.completion.chunk"
      and json.loads(lines[0][6:])["model"] == "Qwen-mock-GGUF")

# 7. tools: valide du 1er coup
state.model = FakeLlama(script=['{"name": "get_weather", "arguments": {"city": "Paris"}}'])
r = call("/v1/chat/completions", ["POST"],
         {"messages": [{"role": "user", "content": "meteo Paris ?"}], "tools": TOOLS})
print("PROOF tool_call: " + json.dumps(r["choices"][0]["message"]["tool_calls"]))
tc = r["choices"][0]["message"]["tool_calls"][0]
check("tools valid shape", tc["type"] == "function" and tc["id"].startswith("call_")
      and tc["function"]["name"] == "get_weather"
      and json.loads(tc["function"]["arguments"]) == {"city": "Paris"}
      and r["choices"][0]["finish_reason"] == "tool_calls", r)
check("tools GBNF constraint", state.model.calls[-1]["response_format"] == {"type": "json_object"})

# 8. tools: invalide puis retry valide
state.model = FakeLlama(script=['oops pas du json', '{"name": "get_weather", "arguments": {"city": "Lyon"}}'])
r = call("/v1/chat/completions", ["POST"],
         {"messages": [{"role": "user", "content": "meteo ?"}], "tools": TOOLS})
check("tools retry recovers", r["choices"][0]["message"]["tool_calls"][0]["function"]["name"] == "get_weather"
      and len(state.model.calls) == 2, len(state.model.calls))
check("tools retry has repair prompt", any("not a valid tool call" in str(m.get("content", ""))
      for m in state.model.calls[-1]["messages"]))

# 9. tools: invalide x2 -> 500 claire, PAS de succes fictif
state.model = FakeLlama(script=['nope', 'toujours pas'])
r, s = call("/v1/chat/completions", ["POST"],
            {"messages": [{"role": "user", "content": "meteo ?"}], "tools": TOOLS})
check("tools double-fail 500", s == 500 and "after retry" in r["error"]["message"], (s, r))

# 10. tools + stream
state.model = FakeLlama(script=['{"name": "get_weather", "arguments": {}}'])
r = call("/v1/chat/completions", ["POST"],
         {"messages": [{"role": "user", "content": "meteo ?"}], "tools": TOOLS, "stream": True})
lines = list(r.gen)
check("tools stream SSE", len(lines) == 4 and lines[-1] == "data: [DONE]\n\n"
      and "tool_calls" in lines[1]
      and json.loads(lines[2][6:])["choices"][0]["finish_reason"] == "tool_calls")

# 11. fallback ChatML (vieux llama)
state.model = OldLlama()
r = call("/v1/chat/completions", ["POST"],
         {"messages": [{"role": "system", "content": "sys"}, {"role": "user", "content": "hi"}]})
check("fallback chatml non-stream", r["choices"][0]["message"]["content"] == "completion-text"
      and "<|im_start|>system" in state.model.calls[-1]["prompt"]
      and state.model.calls[-1]["prompt"].endswith("<|im_start|>assistant\n"))
r = call("/v1/chat/completions", ["POST"],
         {"messages": [{"role": "user", "content": "hi"}], "stream": True})
lines = list(r.gen)
check("fallback chatml stream", lines[-1] == "data: [DONE]\n\n"
      and json.loads(lines[0][6:])["choices"][0]["delta"]["role"] == "assistant")

# 12. politique n_ctx (P39-e: 4096 des 4 Go libres, cf. openai_compat)
check("default_n_ctx", oc.default_n_ctx(16) == 8192 and oc.default_n_ctx(8) == 4096
      and oc.default_n_ctx(4) == 4096 and oc.default_n_ctx(3.9) == 2048
      and oc.default_n_ctx("xx") == 4096)
check("clamp_n_ctx", oc.clamp_n_ctx(100) == 512 and oc.clamp_n_ctx(99999) == 32768
      and oc.clamp_n_ctx("abc") is None and oc.clamp_n_ctx(4096) == 4096)

# 12b. P43-1 fit-based auto policy (<=3B ladder 8192/4096/2048)
_M15 = "Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF"
_M3 = "Qwen/Qwen2.5-3B-Instruct-GGUF"
_M7 = "Mistral-7B-GGUF"
check("parse_params_b", oc.parse_params_b(_M15) == 1.5 and oc.parse_params_b(_M3) == 3.0
      and oc.parse_params_b(_M7) == 7.0 and oc.parse_params_b("mystery-model") is None
      and oc.parse_params_b("") is None)
check("kv_bytes_per_token", oc.kv_bytes_per_token(_M15) == 28 * 1024
      and oc.kv_bytes_per_token(_M3) == 48 * 1024
      and oc.kv_bytes_per_token("mystery-model") == 64 * 1024)
check("auto 1.5B roomy -> 8192", oc.auto_n_ctx(_M15, 1.0, 8.0)["n_ctx"] == 8192,
      oc.auto_n_ctx(_M15, 1.0, 8.0))
check("auto 1.5B 3GB free -> 8192 (fit proves it)",
      oc.auto_n_ctx(_M15, 1.0, 3.0)["n_ctx"] == 8192, oc.auto_n_ctx(_M15, 1.0, 3.0))
check("auto 1.5B tight -> 4096 then 2048",
      oc.auto_n_ctx(_M15, 1.0, 2.2)["n_ctx"] == 4096
      and oc.auto_n_ctx(_M15, 1.0, 2.05)["n_ctx"] == 2048)
check("auto 1.5B starved -> floor 2048 + warn",
      oc.auto_n_ctx(_M15, 1.0, 1.0)["n_ctx"] == 2048
      and "floor" in oc.auto_n_ctx(_M15, 1.0, 1.0)["explain"])
check("auto 3B roomy -> 8192, tight -> step down",
      oc.auto_n_ctx(_M3, 2.0, 8.0)["n_ctx"] == 8192
      and oc.auto_n_ctx(_M3, 2.0, 3.3)["n_ctx"] == 4096)
check("auto 7B/unknown -> legacy default_n_ctx",
      oc.auto_n_ctx(_M7, 4.0, 8.0)["n_ctx"] == oc.default_n_ctx(8.0)
      and oc.auto_n_ctx("mystery", 1.0, 8.0)["n_ctx"] == oc.default_n_ctx(8.0))
check("auto bad inputs safe", oc.auto_n_ctx(_M15, "xx", "yy")["n_ctx"] == 4096)

# 13. schema + parse
sch = oc.build_toolcall_json_schema(TOOLS)
check("toolcall schema", sch["properties"]["name"]["enum"] == ["get_weather"]
      and sch["required"] == ["name", "arguments"], sch)
p, e = oc.parse_toolcall_json('```json\n{"name": "get_weather", "arguments": "{\\"city\\": \\"Nice\\"}"}\n```', TOOLS)
check("parse fenced+string-args", p == {"name": "get_weather", "arguments": {"city": "Nice"}}, (p, e))
p, e = oc.parse_toolcall_json('{"name": "nope", "arguments": {}}', TOOLS)
check("parse unknown tool rejected", p is None and "unknown tool" in e, (p, e))
p, e = oc.parse_toolcall_json('pas json', TOOLS)
check("parse garbage rejected", p is None and "invalid JSON" in e, (p, e))

# 14. P49-4: sampling overrides forwarded to llama, invalid dropped
sk = oc.sampling_kwargs({"top_p": 0.9, "top_k": 40, "repeat_penalty": 1.12})
check("sampling pure valid", sk == {"top_p": 0.9, "top_k": 40, "repeat_penalty": 1.12}, sk)
sk = oc.sampling_kwargs({"top_p": 99, "top_k": -1, "repeat_penalty": "x", "top_q": 1})
check("sampling pure invalid dropped", sk == {}, sk)
state.model = FakeLlama(script=["ok"])
r = call("/v1/chat/completions", ["POST"],
         {"messages": [{"role": "user", "content": "hi"}],
          "temperature": 0.15, "top_p": 0.9, "top_k": 40,
          "repeat_penalty": 1.12, "max_tokens": 1200})
c = state.model.calls[-1]
check("sampling forwarded", c["top_p"] == 0.9 and c["top_k"] == 40
      and c["repeat_penalty"] == 1.12 and c["temperature"] == 0.15
      and c["max_tokens"] == 1200, c)
state.model = FakeLlama(script=["ok"])
r = call("/v1/chat/completions", ["POST"],
         {"messages": [{"role": "user", "content": "hi"}], "top_p": 99})
c = state.model.calls[-1]
check("sampling invalid dropped (call)", c["top_p"] is None, c)

# 15. P49-1: tool_choice honored
check("tools pure required", oc.tools_for_request({"tools": TOOLS, "tool_choice": "required"}) == TOOLS)
check("tools pure none", oc.tools_for_request({"tools": TOOLS, "tool_choice": "none"}) is None)
check("tools pure absent", oc.tools_for_request({"tools": TOOLS}) == TOOLS)
state.model = FakeLlama(script=['{"name": "get_weather", "arguments": {"city": "Nice"}}'])
r = call("/v1/chat/completions", ["POST"],
         {"messages": [{"role": "user", "content": "meteo ?"}],
          "tools": TOOLS, "tool_choice": "required"})
check("tool_choice required forces call",
      r["choices"][0]["message"]["tool_calls"][0]["function"]["name"] == "get_weather", r)
state.model = FakeLlama(script=["plain answer"])
r = call("/v1/chat/completions", ["POST"],
         {"messages": [{"role": "user", "content": "meteo ?"}],
          "tools": TOOLS, "tool_choice": "none"})
check("tool_choice none disables tools",
      "tool_calls" not in r["choices"][0]["message"]
      and r["choices"][0]["message"]["content"] == "plain answer", r)

print("\n== %d PASS, %d FAIL ==" % (len(PASS), len(FAIL)))
sys.exit(1 if FAIL else 0)
