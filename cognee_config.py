"""
cognee_config.py — the ONE place Cognee's provider/storage config lives.

Import this BEFORE anything cognee-related (cognee reads env vars at import
time via pydantic settings). Because these are ENV VARS, they are inherited
by SUBPROCESSES too — that's how the Cognee UI backend (spawned by
cognee_ui.py) picks up the same providers and the same ./.cognee/ store.

All-Ollama stack — no API keys, no per-day request quotas:
  LLM:        gemma4:31b-cloud runs on Ollama Cloud (free tier; the signed-in
              local daemon proxies it, so the endpoint is still localhost).
  Embeddings: embeddinggemma:300m runs LOCALLY — unlimited + private, and
              it's Cognee's heaviest API traffic. Via the openai_compatible
              engine, NOT "ollama": the ollama embedding engine hard-requires
              the transformers package; openai_compatible falls back to a
              TikToken tokenizer instead.

BOTH providers must be set, or the unset one silently falls back to OpenAI.
Hard-set (not setdefault) so stale shell/.env values can't override.
"""

import os

os.environ["LLM_PROVIDER"] = "ollama"
os.environ["LLM_MODEL"] = "gemma4:31b-cloud"
os.environ["LLM_ENDPOINT"] = "http://localhost:11434/v1"
os.environ["LLM_API_KEY"] = "ollama"  # must be non-empty; local daemon ignores it

os.environ["EMBEDDING_PROVIDER"] = "openai_compatible"
os.environ["EMBEDDING_MODEL"] = "embeddinggemma:300m"
os.environ["EMBEDDING_ENDPOINT"] = "http://localhost:11434/v1"
os.environ["EMBEDDING_API_KEY"] = "ollama"
os.environ["EMBEDDING_DIMENSIONS"] = "768"
os.environ["EMBEDDING_MAX_COMPLETION_TOKENS"] = "2048"  # embeddinggemma context window

# Storage backends — all file-based, no servers. kuzu is the graph store
# (networkx was dropped as a provider in cognee 1.2.2). NOTE: kuzu is
# SINGLE-PROCESS — only the cognee backend (cognee_ui.py) may open the store.
os.environ.setdefault("DB_PROVIDER", "sqlite")
os.environ.setdefault("VECTOR_DB_PROVIDER", "lancedb")
os.environ.setdefault("GRAPH_DATABASE_PROVIDER", "kuzu")
# Single patient per phone → no multi-tenant ACL. Off also means the API
# serves unauthenticated requests as the default user, so the MCP proxy and
# the UI need no tokens.
os.environ.setdefault("ENABLE_BACKEND_ACCESS_CONTROL", "false")
# Skip the 30s startup LLM probe.
os.environ.setdefault("COGNEE_SKIP_CONNECTION_TEST", "true")

# KEEP DATA INSIDE THE PROJECT — as ENV VARS (not cognee.config calls) so the
# UI backend SUBPROCESS inherits them and opens ./.cognee/, not the default
# site-packages store.
_HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("SYSTEM_ROOT_DIRECTORY", os.path.join(_HERE, ".cognee", "system"))
os.environ.setdefault("DATA_ROOT_DIRECTORY", os.path.join(_HERE, ".cognee", "data"))
