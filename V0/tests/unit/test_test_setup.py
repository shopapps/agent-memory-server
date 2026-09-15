from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from tests import conftest as setup


def test_api_tests_require_a_key_before_starting(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    config = Mock()
    config.getoption.return_value = True
    with pytest.raises(pytest.UsageError, match="OPENAI_API_KEY"):
        setup.pytest_configure(config)


def test_standard_tests_do_not_require_a_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    config = Mock()
    config.getoption.return_value = False
    setup.pytest_configure(config)


def test_api_tests_accept_a_configured_key(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-only-placeholder")
    config = Mock()
    config.getoption.return_value = True
    setup.pytest_configure(config)


def test_redis_uses_native_compose(monkeypatch):
    monkeypatch.setattr(
        "subprocess.run", Mock(return_value=SimpleNamespace(returncode=0))
    )
    compose = Mock()
    factory = Mock(return_value=compose)
    monkeypatch.setattr(setup, "DockerCompose", factory)
    fixture = setup.redis_container.__wrapped__(
        SimpleNamespace(config=SimpleNamespace())
    )
    assert next(fixture) is compose
    assert factory.call_args.kwargs["compose_file_name"] == "docker-compose.yml"
    with pytest.raises(StopIteration):
        next(fixture)
    compose.stop.assert_called_once()


def test_failed_redis_start_aborts_instead_of_using_default_database(monkeypatch):
    monkeypatch.setattr(
        "subprocess.run", Mock(return_value=SimpleNamespace(returncode=0))
    )
    compose = Mock()
    compose.start.side_effect = RuntimeError("unhealthy")
    monkeypatch.setattr(setup, "DockerCompose", Mock(return_value=compose))
    fixture = setup.redis_container.__wrapped__(
        SimpleNamespace(config=SimpleNamespace())
    )
    with pytest.raises(pytest.exit.Exception, match="test Redis"):
        next(fixture)
    compose.stop.assert_called_once()


def test_unavailable_docker_aborts(monkeypatch):
    monkeypatch.setattr(
        "subprocess.run", Mock(return_value=SimpleNamespace(returncode=1))
    )
    fixture = setup.redis_container.__wrapped__(
        SimpleNamespace(config=SimpleNamespace())
    )
    with pytest.raises(pytest.exit.Exception, match="Docker"):
        next(fixture)


def test_missing_test_url_cannot_fall_back_to_default_database():
    fixture = setup.use_test_redis_connection.__wrapped__(None)
    with pytest.raises(pytest.exit.Exception, match="refusing default database access"):
        next(fixture)
