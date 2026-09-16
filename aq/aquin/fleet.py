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

    def train(self, *extra: str, gpu: int | None = None) -> Job:
        return self._verb("train", extra, gpu=gpu)

    def eval(self, name: str | None = None, *extra: str, gpu: int | None = None) -> Job:
        args = (*([name] if name else []), *extra)
        return self._verb("eval", args, gpu=gpu)

    def serve(self, *extra: str, gpu: int | None = None) -> Job:
        return self._verb("serve", extra, gpu=gpu)

    def _verb(self, verb: str, extra: tuple[str, ...], *, gpu: int | None) -> Job:
        args = ["jobs", verb, "--on", self.name, "--json"]
        if gpu is not None:
            args += ["--gpu", str(gpu)]
        if extra:
            args += ["--", *extra]
        r = _aq(*args)
        data = json.loads(r.stdout.strip() or "{}")
        jid = data.get("id")
        if not jid:
            raise RuntimeError(f"aq jobs {verb} --json returned no id:\n" + (r.stdout or r.stderr))
        return Job(id=str(jid), place=self.name)

    def run(self, cmd: Sequence[str], *, gpu: int | None = None) -> Job:
        """Background `cmd` on this place. Returns a Job."""
        if not cmd:
            raise ValueError("run() needs a command")
        args = ["jobs", "run", "--on", self.name, "--json"]
        if gpu is not None:
            args += ["--gpu", str(gpu)]
        args += ["--", *cmd]
        r = _aq(*args)
        data = json.loads(r.stdout.strip() or "{}")
        jid = data.get("id")
        if not jid:
            raise RuntimeError("aq jobs run --json returned no id:\n" + (r.stdout or r.stderr))
        return Job(id=str(jid), place=self.name)

    def jobs(self) -> str:
        """Raw `aq jobs list` text for this place."""
        r = _aq("jobs", "list", "--on", self.name, check=False)
        return r.stdout
