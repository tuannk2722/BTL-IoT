from __future__ import annotations

import logging
import os
import threading
from datetime import datetime, timezone

import httpx

logger = logging.getLogger(__name__)


class Notifier:
    """Optional text-only outbox; provider latency never blocks the inference worker."""

    def __init__(self, service):
        self.service = service
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self.run, name="notification-worker", daemon=True)
        self.thread.start()

    def close(self):
        self.stop_event.set()
        self.thread.join(timeout=4)

    def run(self):
        while not self.stop_event.wait(1):
            try:
                self.step()
                self.service.notification_error = None
            except Exception:
                # Do not log provider exception text: URLs can contain bot tokens.
                self.service.notification_error = "NOTIFICATION_WORKER_FAULT"
                logger.error("Notification iteration failed; retrying without blocking core")
                self.stop_event.wait(2)

    def step(self):
        cfg = self.service.cfg["notifications"]
        with self.service.store.connection() as db:
            row = db.execute(
                "SELECT o.*,e.reason AS event_reason, e.media_id FROM outbox o JOIN events e "
                "ON o.event_id=e.id WHERE o.state='pending' ORDER BY o.created_at LIMIT 1"
            ).fetchone()
        if not row:
            return
        age = (
            datetime.now(timezone.utc) - datetime.fromisoformat(row["created_at"])
        ).total_seconds() * 1000
        if not cfg["telegram_enabled"]:
            state, reason = "disabled", None
        elif age > cfg["expiry_ms"]:
            state, reason = "expired", "ALERT_TOO_OLD"
        elif not os.environ.get("SSS_TELEGRAM_TOKEN") or not os.environ.get("SSS_TELEGRAM_CHAT"):
            state, reason = "failed", "PROVIDER_NOT_CONFIGURED"
        else:
            # Telegram can accept a request whose response times out: bounded retry may duplicate.
            token, chat = os.environ["SSS_TELEGRAM_TOKEN"], os.environ["SSS_TELEGRAM_CHAT"]
            try:
                media_path = None
                if row.get("media_id"):
                    candidate = self.service.store.runtime / "media" / f"{row['media_id']}.jpg"
                    if candidate.exists():
                        media_path = candidate

                text = f"Smart Security: {row['event_reason']} | {row['created_at']}"
                if media_path:
                    with open(media_path, "rb") as f:
                        response = httpx.post(
                            f"https://api.telegram.org/bot{token}/sendPhoto",
                            timeout=10.0,
                            trust_env=False,
                            data={"chat_id": chat, "caption": text},
                            files={"photo": ("image.jpg", f, "image/jpeg")},
                        )
                else:
                    response = httpx.post(
                        f"https://api.telegram.org/bot{token}/sendMessage",
                        timeout=3.0,
                        trust_env=False,
                        json={"chat_id": chat, "text": text},
                    )
                payload = response.json()
                if not isinstance(payload, dict):
                    raise ValueError("Invalid provider response")
                if response.is_success and payload.get("ok"):
                    state, reason = "sent", None
                elif response.status_code == 429:
                    parameters = payload.get("parameters", {})
                    raw_delay = (
                        parameters.get("retry_after", 2) if isinstance(parameters, dict) else 2
                    )
                    delay = min(60, max(1, raw_delay if type(raw_delay) is int else 2))
                    self.stop_event.wait(delay)
                    state, reason = "pending", "RATE_LIMIT"
                elif response.status_code >= 500:
                    state, reason = "pending", "PROVIDER_ERROR"
                else:
                    state, reason = "failed", "PROVIDER_REJECTED"
            except (httpx.HTTPError, ValueError, TypeError):
                state, reason = "pending", "DELIVERY_UNCONFIRMED"
            if state == "pending":
                if row["attempts"] + 1 >= cfg["max_attempts"]:
                    state = "unknown" if reason == "DELIVERY_UNCONFIRMED" else "failed"
                else:
                    self.stop_event.wait(min(30, 2 ** (row["attempts"] + 1)))
        with self.service.store.connection() as db:
            db.execute(
                "UPDATE outbox SET state=?,reason=?,attempts=attempts+1 WHERE id=?",
                (state, reason, row["id"]),
            )
