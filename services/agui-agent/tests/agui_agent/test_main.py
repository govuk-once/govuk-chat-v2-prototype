from types import SimpleNamespace

import pytest
from ag_ui.core import (
    RunAgentInput,
    RunFinishedEvent,
    RunStartedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
)
from agui_agent.main import app, invoke
from govuk_chat_v2_prototype_private import load_prompts


async def fake_agui_stream():
    yield RunStartedEvent(
        thread_id="session-123",
        run_id="run-456",
    )

    yield TextMessageStartEvent(
        message_id="msg-1",
        role="assistant",
    )

    yield TextMessageContentEvent(
        message_id="msg-1",
        delta="Knock knock",
    )

    yield TextMessageContentEvent(
        message_id="msg-1",
        delta="Who's there?",
    )

    yield TextMessageEndEvent(
        message_id="msg-1",
    )

    yield RunFinishedEvent(
        thread_id="session-123",
        run_id="run-456",
    )


def test_app_has_entrypoint():
    assert app is not None
    assert hasattr(app, "entrypoint")


@pytest.mark.asyncio
async def test_invoke_yields_agui_events(mocker):
    mock_strands_agent = mocker.Mock()
    mock_strands_agent.run = mocker.Mock(return_value=fake_agui_stream())

    mocker.patch(
        "agui_agent.main.StrandsAgent",
        return_value=mock_strands_agent,
    )
    mocker.patch("agui_agent.main.Agent")
    mocker.patch("agui_agent.main.BedrockModel")
    mocker.patch("agui_agent.main.AgentCoreMemorySessionManager")
    mocker.patch("agui_agent.main.AgentCoreMemoryConfig")

    mocker.patch.dict(
        "agui_agent.main.os.environ",
        {"BEDROCK_AGENTCORE_MEMORY_ID": "mem-123"},
    )

    context = SimpleNamespace(session_id="test-session")

    result = []
    async for event in invoke({"prompt": "Tell me a joke"}, context):
        result.append(event)

    assert result == [
        RunStartedEvent(
            thread_id="session-123",
            run_id="run-456",
        ),
        TextMessageStartEvent(
            message_id="msg-1",
            role="assistant",
        ),
        TextMessageContentEvent(
            message_id="msg-1",
            delta="Knock knock",
        ),
        TextMessageContentEvent(
            message_id="msg-1",
            delta="Who's there?",
        ),
        TextMessageEndEvent(
            message_id="msg-1",
        ),
        RunFinishedEvent(
            thread_id="session-123",
            run_id="run-456",
        ),
    ]


@pytest.mark.asyncio
async def test_memory_config_uses_default_session_and_user_id(mocker):
    config = mocker.patch("agui_agent.main.AgentCoreMemoryConfig")

    mock_strands_agent = mocker.Mock()
    mock_strands_agent.run = mocker.Mock(return_value=fake_agui_stream())

    mocker.patch(
        "agui_agent.main.StrandsAgent",
        return_value=mock_strands_agent,
    )

    mocker.patch("agui_agent.main.Agent")
    mocker.patch("agui_agent.main.BedrockModel")
    mocker.patch("agui_agent.main.AgentCoreMemorySessionManager")

    mocker.patch.dict(
        "agui_agent.main.os.environ",
        {"BEDROCK_AGENTCORE_MEMORY_ID": "mem-123"},
    )

    context = SimpleNamespace()

    async for _ in invoke({"prompt": "hi"}, context):
        break

    _, kwargs = config.call_args

    assert kwargs["session_id"] == "default-session"
    assert kwargs["actor_id"] == "default-session"


@pytest.mark.asyncio
async def test_invoke_passes_system_prompt_from_private_package(mocker):
    mock_session_manager = mocker.MagicMock()
    mock_session_manager.__enter__.return_value = mock_session_manager

    mocker.patch(
        "agui_agent.main.AgentCoreMemorySessionManager",
        return_value=mock_session_manager,
    )
    mocker.patch("agui_agent.main.AgentCoreMemoryConfig")

    mocker.patch.dict(
        "agui_agent.main.os.environ",
        {"BEDROCK_AGENTCORE_MEMORY_ID": "mem-123"},
    )

    prompts = load_prompts()
    expected_prompt = prompts["structured_answer_composer"]["system_prompt"]

    mock_agent_instance = mocker.Mock()

    mock_agent_class = mocker.patch(
        "agui_agent.main.Agent",
        return_value=mock_agent_instance,
    )

    mock_strands_agent = mocker.Mock()
    mock_strands_agent.run = mocker.Mock(return_value=fake_agui_stream())

    mocker.patch(
        "agui_agent.main.StrandsAgent",
        return_value=mock_strands_agent,
    )

    mocker.patch("agui_agent.main.BedrockModel")

    async for _ in invoke(
        {"prompt": "Test prompt"},
        SimpleNamespace(session_id="test-session"),
    ):
        pass

    assert mock_agent_class.called

    _, kwargs = mock_agent_class.call_args

    if kwargs["system_prompt"] != expected_prompt:
        pytest.fail("System prompt passed to Agent does not match expected prompt")


@pytest.mark.asyncio
async def test_strands_agent_config(mocker):
    config_class = mocker.patch("agui_agent.main.StrandsAgentConfig")

    mock_strands_agent = mocker.Mock()
    mock_strands_agent.run = mocker.Mock(return_value=fake_agui_stream())

    mocker.patch(
        "agui_agent.main.StrandsAgent",
        return_value=mock_strands_agent,
    )

    mocker.patch("agui_agent.main.Agent")
    mocker.patch("agui_agent.main.BedrockModel")
    mocker.patch("agui_agent.main.AgentCoreMemorySessionManager")
    mocker.patch("agui_agent.main.AgentCoreMemoryConfig")

    mocker.patch.dict(
        "agui_agent.main.os.environ",
        {"BEDROCK_AGENTCORE_MEMORY_ID": "mem-123"},
    )

    async for _ in invoke({"prompt": "hi"}, SimpleNamespace()):
        break

    config_class.assert_called_once_with(
        emit_messages_snapshot=False,
    )


@pytest.mark.asyncio
async def test_run_agent_input_construction(mocker):
    mock_strands_agent = mocker.Mock()
    mock_strands_agent.run = mocker.Mock(return_value=fake_agui_stream())

    mocker.patch(
        "agui_agent.main.StrandsAgent",
        return_value=mock_strands_agent,
    )

    mocker.patch("agui_agent.main.Agent")
    mocker.patch("agui_agent.main.BedrockModel")
    mocker.patch("agui_agent.main.AgentCoreMemorySessionManager")
    mocker.patch("agui_agent.main.AgentCoreMemoryConfig")

    mocker.patch.dict(
        "agui_agent.main.os.environ",
        {"BEDROCK_AGENTCORE_MEMORY_ID": "mem-123"},
    )

    context = SimpleNamespace(session_id="test-session")

    async for _ in invoke({"prompt": "Tell me a joke"}, context):
        break

    run_input = mock_strands_agent.run.call_args.args[0]

    assert isinstance(run_input, RunAgentInput)
    assert run_input.thread_id == "test-session"
    assert run_input.run_id == "run-456"
    assert run_input.state == {}
    assert run_input.tools == []
    assert run_input.context == []
    assert run_input.forwarded_props == []

    assert len(run_input.messages) == 1
    assert run_input.messages[0].role == "user"
    assert run_input.messages[0].content == "Tell me a joke"
    assert run_input.messages[0].id == "msg-1"
