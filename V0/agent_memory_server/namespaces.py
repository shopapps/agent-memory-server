"""Small helpers for safe hierarchical namespace paths."""


def normalize_namespace(namespace: str) -> str:
    """Return the canonical form of a slash-separated namespace path."""
    if not isinstance(namespace, str):
        raise ValueError("namespace must be a string")
    if "," in namespace:
        raise ValueError("namespace must not contain commas")
    if namespace.startswith("/") or namespace.endswith("/"):
        raise ValueError("namespace cannot start or end with a slash")

    parts = [part.strip() for part in namespace.split("/")]
    if not parts or any(not part or part in {".", ".."} for part in parts):
        raise ValueError("namespace contains an empty or unsafe path segment")

    return "/".join(parts)


def expand_namespace_parents(namespace: str) -> list[str]:
    """Return one namespace and its exact parents, deepest path first."""
    normalized = normalize_namespace(namespace)
    parts = normalized.split("/")
    return ["/".join(parts[:end]) for end in range(len(parts), 0, -1)]
