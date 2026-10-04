"""One model owner and latest-only processing loop; no HTTP handlers here."""

from __future__ import annotations

import logging

import numpy as np

from .runtime import DomainError

logger = logging.getLogger(__name__)


class VisionWorker:
    def __init__(self, service):
        self.service = service

    def run(self):
        s = self.service
        vision = None
        if s.cfg["profile"] == "hardware" or s.vision_factory is not None:
            try:
                from .vision import OpenCVVision

                vision = s.vision_factory(s.cfg) if s.vision_factory else OpenCVVision(s.cfg)
                # Exercise model loading and both detection paths before reporting ready.
                vision.detections(np.zeros((480, 640, 3), dtype=np.uint8))
                with s.lock:
                    s.vision_ready = True
            except Exception:
                logger.exception("Vision initialization failed")
                with s.lock:
                    s.vision_ready, s.vision_error = False, "VISION_INIT_FAILED_CHECK_MODELS"
        vision_revision = -1
        last_cleanup = s.now()
        while True:
            packet = None
            try:
                with s.condition:
                    if not s.pending and not s.stopping:
                        s.condition.wait(timeout=1)
                    if s.stopping:
                        return
                    s._expire_capture()
                    s._check_health(s.now())
                    if s.now() - last_cleanup > 3600000:
                        try:
                            s.store.cleanup(s.cfg["retention"])
                        except Exception:
                            s.worker_error = "CLEANUP_FAILED"
                        last_cleanup = s.now()
                    packet, s.pending = s.pending, None
                    if packet is None:
                        continue
                    s.processing = True
                    s._receipt_state(packet.frame_id, "processing")
                    gallery = s.store.gallery() if vision else {}
                    revision = (s.mode_revision, s.gallery_revision)
                    if vision and vision_revision != revision:
                        vision.reset()
                        vision_revision = revision
                    if s.now() - packet.received_ms > s.cfg["limits"]["max_result_age_ms"]:
                        s._receipt_state(packet.frame_id, "stale", "RESULT_TOO_OLD")
                        continue
                quality, vector, observations = None, None, []
                if packet.meta.purpose == "monitoring":
                    if vision:
                        observations = vision.analyze(packet.jpeg, gallery, s.now())
                    elif packet.observations is not None:
                        observations = packet.observations
                    else:
                        raise DomainError("REAL_VISION_REQUIRED")
                elif packet.meta.purpose == "enrollment":
                    if vision is None:
                        raise DomainError("REAL_VISION_REQUIRED")
                    vector, quality = vision.enrollment_sample(packet.jpeg)
                with s.lock:
                    # Expire leases even if inference held the worker beyond the deadline.
                    s._expire_capture()
                    # Recheck after native inference to close races with STOP/gallery deletion.
                    if (
                        packet.meta.mode_revision != s.mode_revision
                        or packet.gallery_revision != s.gallery_revision
                        or packet.meta.session_id != s.session_id
                    ):
                        s._receipt_state(packet.frame_id, "cancelled", "REVISION_CHANGED")
                        vision_revision = -1
                    elif s.now() - packet.received_ms > s.cfg["limits"]["max_result_age_ms"]:
                        s._receipt_state(packet.frame_id, "stale", "RESULT_TOO_OLD")
                        vision_revision = -1
                    else:
                        if packet.jpeg:
                            s.latest = {
                                "frame_id": packet.frame_id,
                                "jpeg": packet.jpeg,
                                "received_ms": packet.received_ms,
                            }
                        s.last_frame_ms = packet.received_ms
                        if packet.meta.purpose == "monitoring":
                            try:
                                s._publish(packet, observations)
                            except Exception:
                                s.fail_closed("FRAME_PROCESSING_FAILED")
                                raise
                        elif packet.meta.purpose == "enrollment":
                            s._enrollment_result(packet, vector, quality)
                        s._receipt_state(packet.frame_id, "processed")
            except Exception as exc:
                logger.exception("Worker failed: %s", packet.frame_id if packet else "housekeeping")
                with s.lock:
                    s.worker_error = "FRAME_PROCESSING_FAILED"
                    s.mode, s.mode_revision = "DISARMED", s.mode_revision + 1
                    s.command = None
                    s.capture_session = None
                    pending, s.pending = s.pending, None
                    s.latest = s.latest_analysis = None
                    s.policy.reset()
                    s.last_presence_ms = 0
                    try:
                        with s.store.connection() as db:
                            db.execute("DELETE FROM samples WHERE committed=0")
                        s._issue("STOP_ALARM")
                        if packet:
                            s._receipt_state(packet.frame_id, "failed", type(exc).__name__)
                        if pending:
                            s._receipt_state(pending.frame_id, "cancelled", "WORKER_FAILED")
                    except Exception:
                        s.mode, s.mode_revision = "DISARMED", s.mode_revision + 1
                        s.command = None
                        s.worker_error = "STORAGE_FAULT"
            finally:
                with s.lock:
                    s.processing = False
