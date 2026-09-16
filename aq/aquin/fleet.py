"""Fleet places & remote jobs — thin wrappers around the `aq` CLI.

Same verbs as the shell, from a short Python snippet:

    from aquin import Place

    p = Place("temp")
    j = p.train()          # or p.run(["aq", "train"]) / p.eval() / p.serve()
    # j = p.train(nodes=2)  # pool: multi-node gang + RANK/WORLD_SIZE/MASTER_*
    # j.recover(next=True)  # same id on another pool member after host death
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

    def recover(
        self,
        *,
        same: bool = False,
        next: bool = False,
        on: str | None = None,
        force: bool = False,
    ) -> dict[str, Any]:
        """Restart this job id after host/process death (SSH preempt pattern)."""
        args = ["jobs", "recover", self.id, "--json"]
        if same:
            args.append("--same")
        if next:
            args.append("--next")
        if on:
            args += ["--on", on]
        if force:
            args.append("--force")
        r = _aq(*args)
        data = json.loads(r.stdout.strip() or "{}")
        if data.get("place"):
            self.place = str(data["place"])
        return data

    def tag(self, *tags: str, rm: bool = False) -> None:
        """Set or remove labels on this job (`aq tag job`)."""
        args = ["tag", "job", self.id]
        if rm:
            args.append("--rm")
        args += list(tags)
        _aq(*args)


class Place:
    """Named SSH place from `aq add` / `~/.aquin/places.json`."""

    def __init__(self, name: str):
        self.name = name

    def train(self, *extra: str, gpu: int | None = None, nodes: int | None = None) -> Job:
        return self._verb("train", extra, gpu=gpu, nodes=nodes)

    def eval(
        self, name: str | None = None, *extra: str, gpu: int | None = None, nodes: int | None = None
    ) -> Job:
        args = (*([name] if name else []), *extra)
        return self._verb("eval", args, gpu=gpu, nodes=nodes)

    def serve(self, *extra: str, gpu: int | None = None, nodes: int | None = None) -> Job:
        return self._verb("serve", extra, gpu=gpu, nodes=nodes)

    def _verb(
        self,
        verb: str,
        extra: tuple[str, ...],
        *,
        gpu: int | None,
        nodes: int | None = None,
    ) -> Job:
        args = ["jobs", verb, "--on", self.name, "--json"]
        if gpu is not None:
            args += ["--gpu", str(gpu)]
        if nodes is not None:
            args += ["--nodes", str(nodes)]
        if extra:
            args += ["--", *extra]
        r = _aq(*args)
        data = json.loads(r.stdout.strip() or "{}")
        jid = data.get("id")
        if not jid:
            raise RuntimeError(f"aq jobs {verb} --json returned no id:\n" + (r.stdout or r.stderr))
        return Job(id=str(jid), place=self.name)

    def run(
        self, cmd: Sequence[str], *, gpu: int | None = None, nodes: int | None = None
    ) -> Job:
        """Background `cmd` on this place (or gang if nodes>1 on a pool)."""
        if not cmd:
            raise ValueError("run() needs a command")
        args = ["jobs", "run", "--on", self.name, "--json"]
        if gpu is not None:
            args += ["--gpu", str(gpu)]
        if nodes is not None:
            args += ["--nodes", str(nodes)]
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

    def sync(self, dir: str | Path | None = None) -> None:
        """Push/update local folder to this place (`aq sync`)."""
        args = ["sync", "--on", self.name]
        if dir is not None:
            args.insert(1, str(dir))
        _aq(*args)

    def shutdown(self, *, wipe: bool = False) -> None:
        """Stop jobs on this place and clear fleet session."""
        args = ["shutdown", self.name]
        if wipe:
            args.append("--wipe")
        _aq(*args)

    def port(self, spec: int | str, *, bg: bool = True) -> None:
        """SSH tunnel: expose remote port on the laptop (`aq port`)."""
        args = ["port", str(spec), "--on", self.name]
        if bg:
            args.append("--bg")
        _aq(*args)

    def tag(self, *tags: str, rm: bool = False) -> None:
        """Set or remove labels on this place (`aq tag place`)."""
        args = ["tag", "place", self.name]
        if rm:
            args.append("--rm")
        args += list(tags)
        _aq(*args)


@dataclass
class Queue:
    """Named SSH work queue (`aq queue …`)."""

    name: str

    def submit(
        self,
        cmd: Sequence[str],
        *,
        priority: int = 0,
        gpu: int | None = None,
        nodes: int | None = None,
    ) -> Job:
        if not cmd:
            raise ValueError("submit() needs a command")
        args = ["queue", "push", self.name, "--json", "--priority", str(priority)]
        if gpu is not None:
            args += ["--gpu", str(gpu)]
        if nodes is not None:
            args += ["--nodes", str(nodes)]
        args += ["--", *cmd]
        r = _aq(*args)
        data = json.loads(r.stdout.strip() or "{}")
        jid = data.get("id")
        if not jid:
            raise RuntimeError("aq queue push --json returned no id:\n" + (r.stdout or r.stderr))
        return Job(id=str(jid), place=None)

    def drain(self, *, off: bool = False, worker: str | None = None) -> None:
        args = ["queue", "drain", self.name]
        if off:
            args.append("--off")
        if worker:
            args += ["--worker", worker]
        _aq(*args)

    def move(self, job_id: str, *, to: str) -> None:
        _aq("queue", "move", job_id, "--to", to)
