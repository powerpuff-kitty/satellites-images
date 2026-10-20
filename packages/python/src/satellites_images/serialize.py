"""Optional camelCase serialization matching the canonical JSON contract.

The Python package stores scenes as native snake_case dataclasses; this module
converts them to the camelCase JSON contract documented in `specs/README.md` so a
Python consumer can emit the same on-wire shape as the TypeScript package.
Provider-native metadata under ``raw`` is preserved verbatim.
"""
from __future__ import annotations

import json
from dataclasses import fields, is_dataclass
from typing import Any


def _camel(name: str) -> str:
    head, *tail = name.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in tail)


def to_camel(value: Any) -> Any:
    """Convert dataclass field names to camelCase; preserve dictionary keys as data."""
    if is_dataclass(value) and not isinstance(value, type):
        out: dict[str, Any] = {}
        for field in fields(value):
            raw = getattr(value, field.name)
            out[_camel(field.name)] = raw if field.name == "raw" else to_camel(raw)
        return out
    if isinstance(value, dict):
        return {str(key): to_camel(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_camel(item) for item in value]
    return value


def to_json(value: Any) -> str:
    """Serialize a scene/page/summary to the camelCase JSON contract."""
    return json.dumps(to_camel(value), separators=(",", ":"), default=str)
