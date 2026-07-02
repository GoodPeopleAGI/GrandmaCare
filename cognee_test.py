"""
cognee_test.py — a standalone SMOKE TEST for the Cognee setup.

⚠️  DESTRUCTIVE: this WIPES ALL cognee data (forget everything) and rebuilds
a small fake-patient graph from scratch. Do NOT run it once the real app has
patient data you care about. To just LOOK at the current data, use
cognee_ui.py instead — it never wipes anything.

NOTE: this test uses cognee's DEFAULT store location, NOT the app's
./.cognee/ store (cognee_config sets that) — so it shouldn't touch app data,
but don't rely on it: the wipe is still global for whatever store it hits.

Run:
    python cognee_test.py
Then open:
    .artifacts/test_graph.html
"""
import os
import asyncio

# ─────────────────────────────────────────────────────────────
# 1. POINT COGNEE AT OLLAMA — must happen BEFORE `import cognee`.
#
# Cognee reads its provider config from environment variables at import
# time (via pydantic settings). All-Ollama stack, no API keys:
#
# LLM: gemma4:31b-cloud — runs on Ollama Cloud's free tier; the signed-in
# local daemon proxies it, so the endpoint stays localhost:11434.
#
# Embeddings: embeddinggemma:300m — runs LOCALLY (unlimited, private).
# Uses the `openai_compatible` engine, NOT `ollama`: cognee's ollama
# embedding engine hard-requires the `transformers` package, while
# openai_compatible falls back to a TikToken tokenizer.
#
# CRITICAL: set BOTH the LLM *and* the embedding provider. Per Cognee's
# docs, if you configure only one, the other SILENTLY defaults to OpenAI —
# and without an OpenAI key the run fails with a confusing error.
# Hard-set (not setdefault) so stale shell/.env values can't override.
# ─────────────────────────────────────────────────────────────
os.environ["LLM_PROVIDER"] = "ollama"
os.environ["LLM_MODEL"] = "gemma4:31b-cloud"
os.environ["LLM_ENDPOINT"] = "http://localhost:11434/v1"
os.environ["LLM_API_KEY"] = "ollama"  # must be non-empty; local daemon ignores it

os.environ["EMBEDDING_PROVIDER"] = "openai_compatible"
os.environ["EMBEDDING_MODEL"] = "embeddinggemma:300m"
os.environ["EMBEDDING_ENDPOINT"] = "http://localhost:11434/v1"
os.environ["EMBEDDING_API_KEY"] = "ollama"
os.environ["EMBEDDING_DIMENSIONS"] = "768"                       # embeddinggemma:300m
os.environ["EMBEDDING_MAX_COMPLETION_TOKENS"] = "2048"           # its context window

# ── Storage backends (all file-based, no servers) ─────────────
# Pinned explicitly so the stack is self-documenting. Variable names match
# Cognee's .env.template exactly (DB_PROVIDER, not RELATIONAL_DB_PROVIDER).
#
# GRAPH STORE: kuzu — a file-based embedded graph DB that Cognee 1.2.2
# bundles (kuzu 0.17.1 is installed with cognee, verified in the venv).
# NOTE: networkx does NOT work here — it's still a dependency but was dropped
# as a valid GRAPH_DATABASE_PROVIDER in 1.2.2 ("Unsupported graph database
# provider: networkx"). Supported file-based options are kuzu or ladybug.
os.environ.setdefault("DB_PROVIDER", "sqlite")            # relational: documents/chunks
os.environ.setdefault("VECTOR_DB_PROVIDER", "lancedb")    # embeddings
os.environ.setdefault("GRAPH_DATABASE_PROVIDER", "kuzu")  # entities/relations

# Cognee 1.2.2 turns ON multi-user access control by default, which is NOT
# compatible with the networkx graph store (it needs kuzu/neo4j/etc.). Our
# app is single-patient-per-phone, so we don't need Cognee's internal
# multi-tenant ACL — turn it off so networkx works.
os.environ.setdefault("ENABLE_BACKEND_ACCESS_CONTROL", "false")

# Skip the 30s startup "can I reach the LLM?" probe. On Gemini's free tier a
# transient 503 ("high demand") can make that probe time out and abort the
# whole run; the real calls will surface any genuine error anyway.
os.environ.setdefault("COGNEE_SKIP_CONNECTION_TEST", "true")

import cognee  # noqa: E402  — must come AFTER the env vars above are set
from cognee.api.v1.visualize.visualize import visualize_graph  # noqa: E402


# ─────────────────────────────────────────────────────────────
# 2. THE PATIENT FACTS
# In the real app these will come from prescriptions the agent reads and
# things the caretaker tells it. Here we hard-code a few so we can see the
# graph connect medicines ↔ conditions ↔ doctor ↔ caretaker ↔ allergies.
# ─────────────────────────────────────────────────────────────
PATIENT_FACTS = [
    "Grandma Rose is 78 years old and has type 2 diabetes and high blood pressure.",
    "Dr. Mehta prescribed Metformin 500mg for Rose's diabetes, taken twice daily after meals.",
    "Rose takes Amlodipine 5mg once every morning for her blood pressure.",
    "Rose is allergic to penicillin.",
    "Rose's daughter Priya is her main caretaker and should be alerted if a dose is missed.",
]


async def main():
    # Start clean so repeated runs don't pile duplicate nodes into the graph.
    print("- Resetting Cognee memory ...")
    await cognee.forget(everything=True)

    # Build the knowledge graph from our facts.
    print("- Remembering patient facts (this builds the graph) ...")
    await cognee.remember(PATIENT_FACTS, self_improvement=False)

    # Ask something that requires joining several facts together.
    question = "What does Rose take for diabetes, and what is she allergic to?"
    print(f"- Asking: {question}")
    answer = await cognee.recall(question)

    print("\n----- Answer -------------------------------------------------")
    for row in (answer if isinstance(answer, list) else [answer]):
        print(row)
    print("--------------------------------------------------------------\n")

    # Write the interactive HTML "wiki" graph.
    # test_graph.html on purpose — patient_graph.html belongs to the REAL app
    # (cognee_layer/app.py); the test must never overwrite it.
    out = os.path.join(os.path.dirname(__file__), ".artifacts", "test_graph.html")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    await visualize_graph(out)
    print(f"Graph written to: {out}")
    print("Open it in a browser to check the extraction worked.")
    print("(To browse the REAL app data in the Cognee UI, run: uv run cognee_ui.py)")


if __name__ == "__main__":
    asyncio.run(main())
