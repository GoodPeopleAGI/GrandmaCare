from agno.agent import Agent
from agno.models.google import Gemini
from agno.os import AgentOS

# `id="agent"` is what the mobile app puts in the URL:
#   POST /agents/agent/runs
agent = Agent(
    id="agent",
    name="GrandmaCare",
    model=Gemini("gemini-2.5-flash"),
    instructions=(
        "You help an elderly person and their caretaker with medicines. "
        "When given a prescription, read it and explain in simple, clear "
        "language what to take, how much, and when."
    ),
    markdown=True,
)

agentos = AgentOS(agents=[agent])
app = agentos.get_app()
#agent.print_response("hi")
# Run it so your PHONE can reach it (note --host 0.0.0.0, not localhost):
#   uvicorn agents:app --host 0.0.0.0 --port 8000
