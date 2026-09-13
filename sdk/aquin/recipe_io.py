"""Recipe YAML as the durable path map — SDK authors; disk keeps the projection."""

from __future__ import annotations

from pathlib import Path
from typing import Any


HEADER = (
    "# Path map for this run (authored by aquin SDK; edit via code or hand).\n"
    "# Runtime output lives under artifacts/ — not here.\n"
)


def _fmt_scalar(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return str(v)
    s = str(v)
    if s == "" or any(c in s for c in ":#[]{},\n\"'"):
        return json_escape(s)
    return s


def json_escape(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _dump_lines(data: dict[str, Any], indent: int = 0) -> list[str]:
    pad = "  " * indent
    lines: list[str] = []
    for key, val in data.items():
        if isinstance(val, dict):
            lines.append(f"{pad}{key}:")
            if not val:
                continue
            lines.extend(_dump_lines(val, indent + 1))
        elif isinstance(val, list):
            # Prefer inline for simple scalar lists (plans.steps)
            if val and all(not isinstance(x, (dict, list)) for x in val):
                inner = ", ".join(_fmt_scalar(x) for x in val)
                lines.append(f"{pad}{key}: [{inner}]")
            else:
                lines.append(f"{pad}{key}:")
                for item in val:
                    if isinstance(item, dict):
                        lines.append(f"{pad}  -")
                        for sk, sv in item.items():
                            if isinstance(sv, (dict, list)):
                                raise ValueError(f"unsupported deep list item under {key}")
                            lines.append(f"{pad}    {sk}: {_fmt_scalar(sv)}")
                    else:
                        lines.append(f"{pad}  - {_fmt_scalar(item)}")
        else:
            lines.append(f"{pad}{key}: {_fmt_scalar(val)}")
    return lines


def dump_recipe(
    data: dict[str, Any],
    path: str | Path,
    *,
    header: bool = True,
) -> Path:
    """Write recipe.yaml (nested maps + simple lists). YAML = path map; artifacts/ = runtime."""
    dest = Path(path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    body = "\n".join(_dump_lines(data)) + "\n"
    text = (HEADER + body) if header else body
    dest.write_text(text, encoding="utf-8")
    return dest


def load_recipe_dict(path: str | Path) -> dict[str, Any]:
    """Indent-aware subset (enough for plans: and path keys)."""
    text = Path(path).read_text(encoding="utf-8")
    return parse_simple_yaml(text)


def parse_simple_yaml(text: str) -> dict[str, Any]:
    root: dict[str, Any] = {}
    stack: list[tuple[int, Any]] = [(-1, root)]

    def indent_of(line: str) -> int:
        n = 0
        for ch in line:
            if ch == " ":
                n += 1
            elif ch == "\t":
                n += 2
            else:
                break
        return n

    def scalar(raw: str) -> Any:
        s = raw.strip()
        if s in ("", "null", "~", "None"):
            return None
        if s in ("true", "yes"):
            return True
        if s in ("false", "no"):
            return False
        if (s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'")):
            return s[1:-1]
        if s.startswith("[") and s.endswith("]"):
            inner = s[1:-1].strip()
            if not inner:
                return []
            return [scalar(x) for x in inner.split(",") if x.strip()]
        try:
            if "." in s or "e" in s.lower():
                return float(s)
            return int(s)
        except ValueError:
            return s

    lines = text.splitlines()
    for i, raw in enumerate(lines):
        no_comment = raw.split("#", 1)[0]
        if not no_comment.strip():
            continue
        ind = indent_of(no_comment)
        trimmed = no_comment.strip()
        while len(stack) > 1 and ind <= stack[-1][0]:
            stack.pop()
        parent = stack[-1][1]

        if trimmed.startswith("- "):
            if not isinstance(parent, list):
                raise ValueError(f"yaml list item without list parent: {trimmed}")
            item = trimmed[2:].strip()
            parent.append(scalar(item))
            continue

        if ":" not in trimmed:
            continue
        colon = trimmed.index(":")
        key = trimmed[:colon].strip()
        rest = trimmed[colon + 1 :].strip()
        if not isinstance(parent, dict):
            continue

        if rest == "":
            is_list = False
            for j in range(i + 1, len(lines)):
                peek = lines[j].split("#", 1)[0]
                if not peek.strip():
                    continue
                if indent_of(peek) <= ind:
                    break
                is_list = peek.strip().startswith("- ")
                break
            child: Any = [] if is_list else {}
            parent[key] = child
            stack.append((ind, child))
        else:
            parent[key] = scalar(rest)

    return root
