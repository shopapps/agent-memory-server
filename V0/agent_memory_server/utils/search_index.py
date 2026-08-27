"""Small helpers shared by Redis Search index upgrades."""

from typing import Any


def index_field_names(info: dict[str | bytes, Any]) -> set[str]:
    """Read field names from Redis Search INFO output."""
    attributes = info.get("attributes") or info.get(b"attributes") or []
    names: set[str] = set()
    for attribute in attributes:
        if isinstance(attribute, dict):
            name = attribute.get("attribute") or attribute.get(b"attribute")
        else:
            values = list(attribute)
            pairs = dict(zip(values[::2], values[1::2], strict=False))
            name = pairs.get("attribute") or pairs.get(b"attribute")
        if isinstance(name, bytes):
            name = name.decode()
        if name:
            names.add(str(name))
    return names
