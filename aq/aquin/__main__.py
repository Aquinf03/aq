"""python -m aquin init [name]"""

from __future__ import annotations

import argparse
from pathlib import Path

from aquin.scaffold import init_run


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="aquin", description="Aquin SDK")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_init = sub.add_parser("init", help="create recipe.yaml + example.py + artifacts/")
    p_init.add_argument(
        "name",
        nargs="?",
        default="aq-run",
        help="folder name (default: aq-run)",
    )

    args = ap.parse_args(argv)
    if args.cmd == "init":
        cwd = Path.cwd()
        dest = cwd / args.name
        if dest.exists() and any(dest.iterdir()):
            for i in range(1, 10_000):
                cand = cwd / f"{args.name}-new{i}"
                if not cand.exists() or not any(cand.iterdir()):
                    dest = cand
                    break
        root, created, skipped = init_run(dest)
        try:
            rel = root.relative_to(cwd)
        except ValueError:
            rel = root
        print("run")
        print(f"  {rel}")
        print("  recipe.yaml + example.py + artifacts/ — paths live in the YAML")
        if created:
            print("created")
            for f in created:
                print(f"  {f}")
        if skipped:
            print("already there")
            for f in skipped:
                print(f"  {f}")
        print("next")
        print(f"  cd {rel}")
        print("  point data.path in recipe.yaml at your file")
        print("  python example.py")
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
