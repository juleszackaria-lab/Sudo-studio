"""MISSION P1-a/b/c - OpenAI-compatible API for the Sudo Studio runtime.

This module is SELF-CONTAINED: stdlib imports only at module level, Flask is
imported lazily inside register_openai_routes() so pure helpers stay testable
without Flask/llama_cpp installed.

Exposed endpoints (registered on the runtime Flask app):
  GET  /v1/models
  POST /v1/chat/completions   (messages, stream SSE, tools/tool_calls,
                               temperature, max_tokens, stop, top_p, top_k,
                               repeat_penalty, tool_choice)

Rules enforced here:
  - The loaded model's own chat template is used (native
    create_chat_completion; manual ChatML fallback only if the native
    method is missing).
  - Tool calls are constrained to valid JSON via llama.cpp GBNF
    (response_format json_object) + ONE retry with a repair prompt.
  - No model loaded -> HTTP 503 {"error": "no_model_loaded"}. Never a
    simulated reply (not even in SUDO_DEMO_MOCK mode).
  - /infer and /health are NOT touched (compatibility).

ASCII-only source (project rule).
"""

import json
import re
import time
import uuid

# ---------------------------------------------------------------------------
# n_ctx policy (P1-c)
# ---------------------------------------------------------------------------
N_CTX_MIN = 512
N_CTX_MAX = 32768


def default_n_ctx(avail_gb):
    """Prudent default context size from free RAM (GB). Pure function.

    P39-e: 4096 from 4 GB free (was 6 GB). Rationale: a 1.5B Q4_K_M GGUF is
    ~1 GB and the 2048->4096 KV-cache delta is ~0.1-0.2 GB, so 4096 still
    fits a 4 GB-free machine with margin; the RAM watchdog (critical min)
    still aborts pathological loads. The agent needs ~2-4k tokens (system
    prompt + tool schemas + project map + tool results, see journal est0).
    """
    try:
        avail = float(avail_gb)
    except (TypeError, ValueError):
        return 4096
    if avail >= 12.0:
        return 8192
    if avail >= 4.0:
        return 4096
    return 2048


def clamp_n_ctx(n):
    """Clamp a user-supplied n_ctx to [512, 32768]. None if unparsable."""
    try:
        v = int(n)
    except (TypeError, ValueError):
        return None
    return max(N_CTX_MIN, min(N_CTX_MAX, v))


# ---------------------------------------------------------------------------
# n_ctx auto policy (P43-1): fit-based default for <=3B models.
# ---------------------------------------------------------------------------
P43_KV_MARGIN_GB = 1.0  # free RAM kept beyond weights + KV cache


def parse_params_b(model_id):
    """Parameter count in billions from a model id, None if unknown. Pure."""
    m = re.search(r'(\d+(?:[._]\d+)?)\s*b\b', str(model_id or ''), re.IGNORECASE)
    if not m:
        return None
    try:
        v = float(m.group(1).replace('_', '.'))
    except ValueError:
        return None
    return v if v > 0 else None


def kv_bytes_per_token(model_id):
    """Heuristic KV-cache cost per context token. Pure function.

    Qwen2.5-Coder-1.5B reference: ~28 KB/token (28 layers x 256 kv-dim x
    2 (K+V) x 2 bytes fp16 = 28672; 8192 ctx ~= 235 MB decimal). Scales
    ~linearly with size; unknown models stay conservative (64 KB). The
    loader journals a measured cross-check after each load ([GGUF] kv_check).
    """
    b = parse_params_b(model_id)
    if b is None:
        return 64 * 1024
    if b <= 1.5:
        return 28 * 1024
    if b <= 3.0:
        return 48 * 1024
    return 64 * 1024


def auto_n_ctx(model_id, weights_gb, avail_gb):
    """Fit-based default context for <=3B models, else default_n_ctx. Pure.

    Ladder [8192, 4096, 2048]: largest n with
    weights_gb + n*kv_per_token + margin <= avail_gb.
    Returns {'n_ctx', 'params_b', 'kv_kb', 'explain'}.
    """
    b = parse_params_b(model_id)
    try:
        avail = float(avail_gb)
    except (TypeError, ValueError):
        avail = 0.0
    try:
        weights = float(weights_gb)
    except (TypeError, ValueError):
        weights = 0.0
    if b is None or b > 3.0 or avail <= 0:
        n = default_n_ctx(avail_gb)
        return {'n_ctx': n, 'params_b': b, 'kv_kb': None,
                'explain': 'default_n_ctx (model %s)' % ('unknown' if b is None else '>3B')}
    kv = kv_bytes_per_token(model_id)
    for n in (8192, 4096, 2048):
        need = weights + (n * kv) / 1e9 + P43_KV_MARGIN_GB
        if need <= avail:
            return {'n_ctx': n, 'params_b': b, 'kv_kb': kv // 1024,
                    'explain': 'fit: weights %.2fGB + %d*%dKB + margin <= %.1fGB free'
                               % (weights, n, kv // 1024, avail)}
    return {'n_ctx': 2048, 'params_b': b, 'kv_kb': kv // 1024,
            'explain': 'tight RAM: floor 2048 (watchdog guards)'}


# ---------------------------------------------------------------------------
# Tool-call helpers (P1-a)
# ---------------------------------------------------------------------------
def build_toolcall_json_schema(tools):
    """JSON schema for ONE tool call: {"name": <enum>, "arguments": {...}}."""
    names = []
    for t in (tools or []):
        if not isinstance(t, dict):
            continue
        fn = t.get("function", {})
        if isinstance(fn, dict) and fn.get("name"):
            names.append(str(fn["name"]))
    name_prop = {"type": "string", "enum": names} if names else {"type": "string"}
    return {
        "type": "object",
        "properties": {
            "name": name_prop,
            "arguments": {"type": "object"},
        },
        "required": ["name", "arguments"],
        "additionalProperties": False,
    }


def tool_defs_for_prompt(tools):
    """Compact JSON list of tool definitions, injected in the prompt."""
    compact = []
    for t in (tools or []):
        if not isinstance(t, dict):
            continue
        fn = t.get("function", {}) if isinstance(t.get("function"), dict) else {}
        compact.append({
            "name": str(fn.get("name", "")),
            "description": str(fn.get("description", "")),
            "parameters": fn.get("parameters", {"type": "object"}),
        })
    return json.dumps(compact, ensure_ascii=True)


def parse_toolcall_json(text, tools):
    """Parse model output into ({"name","arguments"}, None) or (None, reason).

    Accepts raw JSON, ```json fenced blocks, and arguments given either as
    an object or as a JSON-encoded string. The name must match a declared tool.
    """
    if text is None:
        return None, "empty reply"
    s = str(text).strip()
    if not s:
        return None, "empty reply"
    # Strip markdown fences if the model added any.
    if s.startswith("```"):
        s = s[3:]
        if s.lower().startswith("json"):
            s = s[4:]
        end = s.rfind("```")
        if end != -1:
            s = s[:end]
        s = s.strip()
    try:
        obj = json.loads(s)
    except (ValueError, TypeError) as e:
        return None, "invalid JSON: %s" % e
    if not isinstance(obj, dict):
        return None, "top level must be an object"
    name = obj.get("name")
    args = obj.get("arguments")
    valid_names = set()
    for t in (tools or []):
        if isinstance(t, dict) and isinstance(t.get("function"), dict):
            if t["function"].get("name"):
                valid_names.add(str(t["function"]["name"]))
    if not isinstance(name, str) or not name:
        return None, "missing string field 'name'"
    if valid_names and name not in valid_names:
        return None, "unknown tool '%s'" % name
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except (ValueError, TypeError):
            return None, "'arguments' string is not valid JSON"
    if not isinstance(args, dict):
        return None, "'arguments' must be an object"
    return {"name": name, "arguments": args}, None


def chatml_from_messages(messages):
    """Fallback ChatML renderer (used only if create_chat_completion is missing)."""
    parts = []
    for m in messages or []:
        role = str(m.get("role", "user"))
        if role not in ("system", "user", "assistant", "tool"):
            role = "user"
        parts.append("<|im_start|>" + role + "\n" + str(m.get("content", "")) + "<|im_end|>\n")
    parts.append("<|im_start|>assistant\n")
    return "".join(parts)


def normalize_messages(messages):
    """Validate + flatten OpenAI messages. Returns (norm_list, None) or (None, reason)."""
    if not isinstance(messages, list) or not messages:
        return None, "messages (non-empty array) is required"
    norm = []
    for m in messages:
        if not isinstance(m, dict) or not m.get("role"):
            return None, "each message needs a 'role'"
        c = m.get("content", "")
        if isinstance(c, list):
            c = " ".join([str(p.get("text", "")) for p in c if isinstance(p, dict)])
        norm.append({"role": str(m["role"]), "content": str(c)})
    return norm, None


def sampling_kwargs(data):
    """Validated sampling overrides for llama calls (P49-4). Pure.

    Only finite, in-range values pass through; anything else is dropped
    (the runtime defaults apply). Unknown keys are ignored.
    """
    out = {}
    try:
        tp = float(data.get("top_p"))
        if 0.0 < tp <= 1.0:
            out["top_p"] = tp
    except (TypeError, ValueError):
        pass
    try:
        tk = int(data.get("top_k"))
        if 0 <= tk <= 1000:
            out["top_k"] = tk
    except (TypeError, ValueError):
        pass
    try:
        rp = float(data.get("repeat_penalty"))
        if 1.0 <= rp <= 2.0:
            out["repeat_penalty"] = rp
    except (TypeError, ValueError):
        pass
    return out


def tools_for_request(data):
    """Tool list honoring tool_choice (P49-1). Pure.

    tool_choice 'none' disables tools (plain chat). Absent/'auto'/
    'required' keep the constrained tool path: the runtime grammar-forces
    exactly one JSON call whenever tools are present.
    """
    tools = data.get("tools")
    if not isinstance(tools, list) or not tools:
        return None
    if data.get("tool_choice") == "none":
        return None
    return tools


# ---------------------------------------------------------------------------
# Flask route registration
# ---------------------------------------------------------------------------
def register_openai_routes(app, ctx):
    """Register /v1/models + /v1/chat/completions on the runtime Flask app.

    ctx: dict with state, default_model (str), dlog (fn), logger.
    """
    from flask import request, jsonify, Response  # lazy: keeps module Flask-free

    state = ctx["state"]
    default_model = ctx.get("default_model", "sudo-studio")
    dlog = ctx["dlog"]
    logger = ctx["logger"]

    def _model_id():
        return state.model_name or default_model

    def _no_model():
        dlog("[OPENAI] Rejected: no model loaded (503 no_model_loaded)")
        return jsonify({"error": "no_model_loaded"}), 503

    def _openai_400(reason):
        return jsonify({"error": {
            "message": reason, "type": "invalid_request_error", "code": 400}}), 400

    def _openai_500(message):
        logger.error("[OPENAI] " + message)
        return jsonify({"error": {
            "message": message, "type": "server_error", "code": 500}}), 500

    # -- GET /v1/models ------------------------------------------------------
    @app.route('/v1/models', methods=['GET'])
    def v1_models():
        state.requests += 1
        if not state.loaded or state.model is None:
            # Honest empty list (this is a listing, not inference).
            return jsonify({"object": "list", "data": []})
        return jsonify({"object": "list", "data": [{
            "id": _model_id(),
            "object": "model",
            "created": int(getattr(state, "startup_time", time.time())),
            "owned_by": "sudo-studio",
            # P26-b: active context size (None = unknown). Lets the agent
            # budget instructions + tools + results against real capacity.
            "n_ctx": getattr(state, "n_ctx", None),
        }]})

    # -- POST /v1/chat/completions -------------------------------------------
    @app.route('/v1/chat/completions', methods=['POST'])
    def v1_chat_completions():
        state.requests += 1
        data = request.get_json(force=True, silent=True)
        if not isinstance(data, dict):
            return _openai_400("JSON body must be an object")
        messages, err = normalize_messages(data.get("messages"))
        if err:
            return _openai_400(err)
        if not state.loaded or state.model is None:
            return _no_model()
        try:
            temperature = float(data.get("temperature", 0.1))
        except (TypeError, ValueError):
            temperature = 0.1
        try:
            max_tokens = int(data.get("max_tokens", 512))
        except (TypeError, ValueError):
            max_tokens = 512
        max_tokens = max(1, min(2048, max_tokens))
        stop = data.get("stop")
        if isinstance(stop, str):
            stop = [stop]
        if not isinstance(stop, list):
            stop = None
        stream = bool(data.get("stream", False))
        tools = tools_for_request(data)
        sampling = sampling_kwargs(data)

        llm = state.model
        dlog("[OPENAI] chat: msgs=%d stream=%s tools=%s temp=%s max_tok=%d extra=%s" % (
            len(messages), stream, bool(tools), temperature, max_tokens,
            ",".join(sorted(sampling)) if sampling else "-"))

        if tools:
            return _chat_with_tools(llm, messages, tools, temperature,
                                    max_tokens, stop, stream, sampling)
        if hasattr(llm, "create_chat_completion"):
            if stream:
                return Response(
                    _stream_native(llm, messages, temperature, max_tokens,
                                   stop, sampling),
                    mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache",
                             "X-Accel-Buffering": "no"})
            try:
                out = llm.create_chat_completion(
                    messages=messages, temperature=temperature,
                    max_tokens=max_tokens, stop=stop, **sampling)
            except Exception as e:
                return _openai_500("inference failed: %s: %s" % (
                    type(e).__name__, e))
            if not isinstance(out, dict):
                return _openai_500("native completion returned non-dict")
            out["model"] = _model_id()
            return jsonify(out)
        # -- Fallback: manual ChatML + create_completion (old llama versions)
        dlog("[OPENAI] create_chat_completion missing, using ChatML fallback")
        prompt = chatml_from_messages(messages)
        if stream:
            return Response(
                _stream_fallback(llm, prompt, temperature, max_tokens, stop,
                                 sampling),
                mimetype="text/event-stream",
                headers={"Cache-Control": "no-cache",
                         "X-Accel-Buffering": "no"})
        try:
            out = llm.create_completion(
                prompt=prompt, temperature=temperature,
                max_tokens=max_tokens, stop=stop, **sampling)
        except Exception as e:
            return _openai_500("inference failed: %s: %s" % (
                type(e).__name__, e))
        text = ((out.get("choices") or [{}])[0].get("text", "")
                if isinstance(out, dict) else "")
        return jsonify({
            "id": "chatcmpl-" + uuid.uuid4().hex[:12],
            "object": "chat.completion",
            "created": int(time.time()),
            "model": _model_id(),
            "choices": [{"index": 0,
                         "message": {"role": "assistant", "content": text},
                         "finish_reason": "stop"}],
            "usage": out.get("usage", {}) if isinstance(out, dict) else {},
        })

    # -- helpers (closures over state/dlog/logger) ---------------------------
    def _stream_native(llm, messages, temperature, max_tokens, stop, sampling):
        req_id = "chatcmpl-" + uuid.uuid4().hex[:12]
        created = int(time.time())
        try:
            chunks = llm.create_chat_completion(
                messages=messages, temperature=temperature,
                max_tokens=max_tokens, stop=stop, stream=True, **sampling)
            for ch in chunks:
                if not isinstance(ch, dict):
                    continue
                ch = dict(ch)
                ch["id"] = req_id
                ch["model"] = _model_id()
                ch["created"] = created
                ch["object"] = "chat.completion.chunk"
                yield "data: " + json.dumps(ch, ensure_ascii=True) + "\n\n"
        except Exception as e:
            dlog("[OPENAI] stream error: %s" % e)
            yield ("data: " + json.dumps(
                {"error": {"message": str(e), "type": "server_error"}},
                ensure_ascii=True) + "\n\n")
        yield "data: [DONE]\n\n"

    def _stream_fallback(llm, prompt, temperature, max_tokens, stop, sampling):
        req_id = "chatcmpl-" + uuid.uuid4().hex[:12]
        created = int(time.time())
        first = True
        try:
            chunks = llm.create_completion(
                prompt=prompt, temperature=temperature,
                max_tokens=max_tokens, stop=stop, stream=True, **sampling)
            for ch in chunks:
                txt = ""
                if isinstance(ch, dict):
                    txt = ((ch.get("choices") or [{}])[0].get("text", "") or "")
                delta = {"content": txt}
                if first:
                    delta = {"role": "assistant", "content": txt}
                    first = False
                yield ("data: " + json.dumps({
                    "id": req_id, "object": "chat.completion.chunk",
                    "created": created, "model": _model_id(),
                    "choices": [{"index": 0, "delta": delta,
                                 "finish_reason": None}]},
                    ensure_ascii=True) + "\n\n")
        except Exception as e:
            dlog("[OPENAI] fallback stream error: %s" % e)
            yield ("data: " + json.dumps(
                {"error": {"message": str(e), "type": "server_error"}},
                ensure_ascii=True) + "\n\n")
        yield ("data: " + json.dumps({
            "id": req_id, "object": "chat.completion.chunk",
            "created": created, "model": _model_id(),
            "choices": [{"index": 0, "delta": {},
                         "finish_reason": "stop"}]},
            ensure_ascii=True) + "\n\n")
        yield "data: [DONE]\n\n"

    def _chat_with_tools(llm, messages, tools, temperature, max_tokens,
                         stop, stream, sampling):
        """Tool path: JSON grammar (GBNF) + ONE retry on invalid JSON."""
        sys_note = ("You can call functions. Reply with EXACTLY ONE JSON "
                    "object and nothing else: "
                    '{"name": "<function name>", "arguments": {<args>}}. '
                    "Available functions: " + tool_defs_for_prompt(tools))
        aug = [{"role": "system", "content": sys_note}] + list(messages)

        def _attempt(msgs):
            try:
                return llm.create_chat_completion(
                    messages=msgs, temperature=temperature,
                    max_tokens=max_tokens, stop=stop, **sampling,
                    response_format={"type": "json_object"})
            except TypeError:
                # Old llama without response_format: unconstrained attempt.
                dlog("[OPENAI] response_format unsupported, plain attempt")
                return llm.create_chat_completion(
                    messages=msgs, temperature=temperature,
                    max_tokens=max_tokens, stop=stop, **sampling)

        def _text_of(out):
            try:
                return ((out.get("choices") or [{}])[0].get("message") or {}
                        ).get("content", "")
            except (AttributeError, TypeError, IndexError):
                return ""

        try:
            out1 = _attempt(aug)
        except Exception as e:
            return _openai_500("tool inference failed: %s: %s" % (
                type(e).__name__, e))
        text1 = _text_of(out1)
        dlog("[OPENAI] tool attempt1 raw: %.200s" % (text1 or "",))
        parsed, err = parse_toolcall_json(text1, tools)
        usage = out1.get("usage", {}) if isinstance(out1, dict) else {}
        if err:
            # -- ONE retry with a repair prompt (P1-a) --
            dlog("[OPENAI] tool attempt1 invalid (%s), retrying once" % err)
            aug2 = (aug + [{"role": "assistant", "content": text1 or ""}] +
                    [{"role": "user", "content":
                      "That was not a valid tool call (%s). Reply with JSON "
                      "only: {\"name\": ..., \"arguments\": {...}}." % err}])
            try:
                out2 = _attempt(aug2)
            except Exception as e:
                return _openai_500("tool retry failed: %s: %s" % (
                    type(e).__name__, e))
            text2 = _text_of(out2)
            parsed, err = parse_toolcall_json(text2, tools)
            if isinstance(out2, dict) and out2.get("usage"):
                usage = out2["usage"]
            if err:
                dlog("[OPENAI] tool retry invalid too (%s), failing clean" % err)
                return jsonify({"error": {
                    "message": "tool call JSON invalid after retry: " + err,
                    "type": "server_error", "code": 500}}), 500

        call_id = "call_" + uuid.uuid4().hex[:8]
        req_id = "chatcmpl-" + uuid.uuid4().hex[:12]
        created = int(time.time())
        tool_call = {"id": call_id, "type": "function", "function": {
            "name": parsed["name"],
            "arguments": json.dumps(parsed["arguments"], ensure_ascii=True)}}
        if not stream:
            return jsonify({
                "id": req_id, "object": "chat.completion",
                "created": created, "model": _model_id(),
                "choices": [{"index": 0,
                             "message": {"role": "assistant", "content": None,
                                         "tool_calls": [tool_call]},
                             "finish_reason": "tool_calls"}],
                "usage": usage,
            })

        def _tool_sse():
            base = {"id": req_id, "object": "chat.completion.chunk",
                    "created": created, "model": _model_id()}
            e1 = dict(base, choices=[{"index": 0,
                                      "delta": {"role": "assistant"},
                                      "finish_reason": None}])
            yield "data: " + json.dumps(e1, ensure_ascii=True) + "\n\n"
            e2 = dict(base, choices=[{"index": 0,
                                      "delta": {"tool_calls": [dict(
                                          tool_call, index=0)]},
                                      "finish_reason": None}])
            yield "data: " + json.dumps(e2, ensure_ascii=True) + "\n\n"
            e3 = dict(base, choices=[{"index": 0, "delta": {},
                                      "finish_reason": "tool_calls"}])
            yield "data: " + json.dumps(e3, ensure_ascii=True) + "\n\n"
            yield "data: [DONE]\n\n"

        return Response(_tool_sse(), mimetype="text/event-stream",
                        headers={"Cache-Control": "no-cache",
                                 "X-Accel-Buffering": "no"})
