from __future__ import annotations

from typing import Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    field_validator,
    model_validator,
)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Hello(StrictModel):
    protocol_version: Literal[2]
    boot_id: str = Field(min_length=8, max_length=64)
    firmware_version: str = Field(max_length=64)
    source: Literal["hardware", "simulator"]
    psram_bytes: StrictInt = Field(ge=0)


class Ack(StrictModel):
    command_id: str
    generation: StrictInt = Field(ge=0)
    status: Literal["applied", "duplicate", "rejected"]
    buzzer_state: Literal["OFF", "ON"]
    executed_uptime_ms: StrictInt = Field(ge=0)
    reason: str | None = None


class Sync(StrictModel):
    session_id: str
    boot_id: str
    sync_seq: StrictInt = Field(ge=0)
    uptime_ms: StrictInt = Field(ge=0)
    buzzer_state: Literal["OFF", "ON"] = "OFF"
    pir_high: StrictBool = False
    acks: list[Ack] = Field(default_factory=list, max_length=8)


class FrameMeta(StrictModel):
    session_id: str
    boot_id: str
    seq: StrictInt = Field(ge=0)
    mode_revision: StrictInt = Field(ge=0)
    purpose: Literal["monitoring", "preview", "enrollment"]
    capture_age_ms: StrictInt = Field(ge=0)
    capture_session_id: str | None = None


class Observation(StrictModel):
    track_id: str = Field(min_length=1, max_length=64)
    bbox: tuple[float, float, float, float]
    decision: Literal["KNOWN", "UNKNOWN", "UNCERTAIN", "NO_FACE", "NOT_CHECKED"]
    person_id: str | None = None
    geometry_valid: StrictBool = True
    reason: str | None = None

    @field_validator("bbox")
    @classmethod
    def valid_bbox(cls, value):
        from .spatial import Rect

        Rect(*value)
        return value

    @model_validator(mode="after")
    def identity_consistent(self):
        if (self.decision == "KNOWN") != bool(self.person_id):
            raise ValueError("Only KNOWN requires a person_id")
        return self


class SyntheticFrame(StrictModel):
    metadata: FrameMeta
    observations: list[Observation] = Field(max_length=20)

    @model_validator(mode="after")
    def unique_tracks(self):
        ids = [o.track_id for o in self.observations]
        if len(set(ids)) != len(ids):
            raise ValueError("One observation per track per frame")
        return self


class Login(StrictModel):
    username: str = Field(max_length=100)
    password: str = Field(max_length=512)


class ModeChange(StrictModel):
    mode: Literal["ARMED", "DISARMED"]
    expected_revision: StrictInt = Field(ge=0)


class PersonCreate(StrictModel):
    display_name: str = Field(min_length=1, max_length=100)
    consent_recorded: Literal[True]

    @field_validator("consent_recorded", mode="before")
    @classmethod
    def explicit_consent(cls, value):
        if value is not True:
            raise ValueError("Explicit consent required")
        return value

    @field_validator("display_name")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("Display name cannot be blank")
        return value.strip()


class IdempotentAction(StrictModel):
    idempotency_key: str = Field(min_length=8, max_length=64)


class Silence(IdempotentAction):
    visit_id: str
