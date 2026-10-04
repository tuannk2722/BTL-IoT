"""Record a short real-camera visit through an authenticated preview on a private LAN."""

from __future__ import annotations

import argparse
import getpass
import json
import os
import time
from pathlib import Path
from uuid import uuid4

import httpx


def checked(response):
    response.raise_for_status()
    return response.json() if response.content else {}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", default="http://127.0.0.1:8000")
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--seconds", type=int, default=15)
    parser.add_argument("--username", default="admin")
    parser.add_argument("--participant-alias", required=True)
    parser.add_argument("--split", choices=["validation", "test"], required=True)
    parser.add_argument(
        "--kind",
        choices=[
            "known",
            "unknown",
            "unidentified",
            "passerby",
            "far",
            "outgoing",
            "direct-b",
            "empty",
        ],
        required=True,
    )
    parser.add_argument("--expected-person-id")
    parser.add_argument("--face-eligible", action="store_true")
    args = parser.parse_args()
    if not 5 <= args.seconds <= 25:
        parser.error("Record 5–25 seconds; baseline preview lease is 30 seconds")
    if (args.kind == "known") != bool(args.expected_person_id):
        parser.error("Only known visits require --expected-person-id")
    if args.face_eligible and args.kind not in {"known", "unknown"}:
        parser.error("--face-eligible applies to incoming known/unknown visits only")
    password = os.environ.get("SSS_ADMIN_PASSWORD") or getpass.getpass("Admin password: ")
    visit_id = str(uuid4())
    folder = args.directory / visit_id
    frames, seen, preview = [], set(), False
    with httpx.Client(
        base_url=args.server.rstrip("/") + "/api/v2/", timeout=3, trust_env=False
    ) as client:
        login = checked(
            client.post("auth/login", json={"username": args.username, "password": password})
        )
        client.headers["X-CSRF-Token"] = login["csrf_token"]
        try:
            status = checked(client.get("status"))
            if status["profile"] != "hardware" or not status["device_online"]:
                parser.error("A hardware camera must be online; synthetic recording is forbidden")
            checked(client.post("capture/preview", json={}))
            preview = True
            folder.mkdir(parents=True, exist_ok=False)
            started = time.monotonic()
            while time.monotonic() - started < args.seconds:
                response = client.get("latest-frame")
                if response.status_code == 404:
                    time.sleep(0.25)
                    continue
                response.raise_for_status()
                frame_id = response.headers.get("X-Frame-Id")
                if frame_id and frame_id not in seen:
                    seen.add(frame_id)
                    image = folder / f"{len(frames):04d}.jpg"
                    image.write_bytes(response.content)
                    frames.append(
                        {
                            "path": image.relative_to(args.directory).as_posix(),
                            "time_ms": int((time.monotonic() - started) * 1000),
                        }
                    )
                time.sleep(0.25)
        finally:
            if preview:
                client.delete("capture")
            client.post("auth/logout", json={})
    if len(frames) < 2:
        raise RuntimeError("Insufficient frames; no manifest entry written. Remove partial folder.")
    entry = {
        "visit_id": visit_id,
        "participant_alias": args.participant_alias,
        "split": args.split,
        "kind": args.kind,
        "expected_person_id": args.expected_person_id,
        "face_eligible": args.face_eligible,
        "frames": frames,
    }
    with (args.directory / "visits.jsonl").open("a", encoding="utf-8") as output:
        output.write(json.dumps(entry, ensure_ascii=False) + "\n")
    print(f"Recorded {len(frames)} distinct frames into {folder}. Review labels before evaluation.")


if __name__ == "__main__":
    main()
