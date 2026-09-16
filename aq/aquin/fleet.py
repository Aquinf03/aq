"""Fleet places & remote jobs — thin wrappers around the `aq` CLI.

Same verbs as the shell, from a short Python snippet:

    from aquin import Place

    p = Place("temp")
    j = p.train()          # or p.run(["aq", "train"]) / p.eval() / p.serve()
    print(j.id, j.status())
    print(j.logs())
    j.pull()
    # j.down()
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence


def _aq_bin() -> str:
    return shutil.which("aq") or "aq"


def _aq(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [_aq_bin(), *args],
        check=check,
        capture_output=True,
        text=True,
    )


@dataclass
class Job:
    """One remote job on a place (`aq jobs …`)."""

    id: str
    place: str | None = None

    def status(self) -> dict[str, Any]:
        args = ["jobs", "status", self.id, "--json"]
        if self.place:
            args += ["--on", self.place]
        r = _aq(*args)
        return json.loads(r.stdout.strip() or "{}")

    def logs(self, n: int = 80) -> str:
        args = ["jobs", "logs", self.id, "-n", str(n)]
        if self.place:
            args += ["--on", self.place]
        r = _aq(*args, check=False)
        return r.stdout

    def pull(self, dest: str | Path | None = None) -> Path:
        args = ["jobs", "pull", self.id]
        out = Path(dest) if dest else Path("jobs-pull") / self.id
        args.append(str(out))
        if self.place:
            args += ["--on", self.place]
        _aq(*args)
        return out.resolve()

    def down(self) -> None:
        args = ["jobs", "down", self.id]
        if self.place:
            args += ["--on", self.place]
        _aq(*args)


class Place:
    """Named SSH place from `aq add` / `~/.aquin/places.json`."""

    def __init__(self, name: str):
        self.name = name

    def run(self, cmd: Sequence[str]) -> Job:
        """Background `cmd` on this place. Returns a Job."""
        if not cmd:
            raise ValueError("run() needs a command")
        r = _aq("jobs", "run", "--on", self.name, "--json", "--", *cmd)
        data = json.loads(r.stdout.strip() or "{}")
        jid = data.get("id")
        if not jid:
            raise RuntimeError("aq jobs run --json returned no id:\n" + (r.stdout or r.stderr))
        return Job(id=str(jid), place=self.name)

    def train(self, *extra: str) -> Job:
        return self.run(["aq", "train", *extra])

    def eval(self, name: str | None = None, *extra: str) -> Job:
        cmd = ["aq", "eval", *([name] if name else []), *extra]
        return self.run(cmd)

    def serve(self, *extra: str) -> Job:
        return self.run(["aq", "serve", *extra])

    def jobs(self) -> str:
        """Raw `aq jobs list` text for this place."""
        r = _aq("jobs", "list", "--on", self.name, check=False)
        return r.stdout
