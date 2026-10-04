#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "esp_camera.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "AlarmLogic.h"
#include "FrameFreshness.h"
#include "NodeState.h"
#include "secrets.h"

// AI-Thinker ESP32-CAM + OV2640. No SD card. Review against the actual board.
constexpr int PIR_PIN = 13, ALARM_PIN = 14;
constexpr uint32_t CONTROL_TIMEOUT = 2000;
portMUX_TYPE stateMux = portMUX_INITIALIZER_UNLOCKED;

SharedState shared;

QueueHandle_t alarmQueue, ackQueue;
char bootId[33];
bool cameraReady = false;

SharedState snapshot() {
  portENTER_CRITICAL(&stateMux);
  SharedState copy = shared;
  portEXIT_CRITICAL(&stateMux);
  return copy;
}

void queueOff(bool reset = false) {
  AlarmMessage message;
  message.control = reset ? 2 : 1;
  // Short bounded wait; independent alarm task continues to enforce its deadline.
  if (xQueueSend(alarmQueue, &message, pdMS_TO_TICKS(30)) != pdTRUE) {
    xQueueReset(alarmQueue);
    portENTER_CRITICAL(&stateMux);
    shared.forceOff = true;
    shared.resetAlarm = shared.resetAlarm || reset;
    portEXIT_CRITICAL(&stateMux);
  }
}

void alarmTask(void*) {
  AlarmLogic alarm;
  for (;;) {
    portENTER_CRITICAL(&stateMux);
    bool forceOff = shared.forceOff;
    bool resetAlarm = shared.resetAlarm;
    shared.forceOff = false;
    shared.resetAlarm = false;
    portEXIT_CRITICAL(&stateMux);
    if (resetAlarm) { alarm.resetSession(); xQueueReset(ackQueue); }
    if (forceOff) alarm.off();
    AlarmMessage message;
    while (xQueueReceive(alarmQueue, &message, 0) == pdTRUE) {
      if (message.control == 1) alarm.off();
      else if (message.control == 2) { alarm.resetSession(); xQueueReset(ackQueue); }
      else {
        SharedState current = snapshot();
        // Queue time and intervening mode/session changes are part of command validity.
        message.command.allowed = message.command.allowed
          && strcmp(message.session, current.session) == 0
          && message.revision == current.revision
          && (message.command.type == 2 || (message.command.type == 1 && current.mode == 1)
              || (message.command.type == 3 && current.mode == 0 && current.purpose == 0));
        uint8_t result = alarm.apply(message.command, millis());
        CommandAck ack;
        strncpy(ack.id, message.command.id, sizeof(ack.id) - 1);
        ack.generation = message.command.generation;
        ack.status = result;
        ack.on = alarm.on;
        ack.uptime = millis();
        if (xQueueSend(ackQueue, &ack, 0) != pdTRUE) {
          alarm.off();
          xQueueReset(alarmQueue);
          Serial.println("ACK_QUEUE_OVERFLOW_OFF");
        }
      }
    }
    SharedState state = snapshot();
    alarm.tick(millis(), state.lastControl);
    digitalWrite(ALARM_PIN, alarm.on == ALARM_ACTIVE_HIGH ? HIGH : LOW);
    portENTER_CRITICAL(&stateMux);
    shared.buzzer = alarm.on;
    portEXIT_CRITICAL(&stateMux);
    vTaskDelay(pdMS_TO_TICKS(20));
  }
}

bool cameraInit() {
  if (!psramFound()) return false;
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer = LEDC_TIMER_0;
  c.pin_d0 = 5; c.pin_d1 = 18; c.pin_d2 = 19; c.pin_d3 = 21;
  c.pin_d4 = 36; c.pin_d5 = 39; c.pin_d6 = 34; c.pin_d7 = 35;
  c.pin_xclk = 0; c.pin_pclk = 22; c.pin_vsync = 25; c.pin_href = 23;
  c.pin_sccb_sda = 26; c.pin_sccb_scl = 27;
  c.pin_pwdn = 32; c.pin_reset = -1;
  c.xclk_freq_hz = 20000000;
  c.pixel_format = PIXFORMAT_JPEG;
  c.frame_size = FRAMESIZE_VGA;
  c.jpeg_quality = 12;
  c.fb_count = 1;
  c.fb_location = CAMERA_FB_IN_PSRAM;
  c.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  return esp_camera_init(&c) == ESP_OK;
}

uint32_t cameraFrameAge(const camera_fb_t* frame) {
  int64_t capturedUs = int64_t(frame->timestamp.tv_sec) * 1000000LL + frame->timestamp.tv_usec;
  return frameAgeMs(esp_timer_get_time(), capturedUs);
}

bool capturedAfter(const camera_fb_t* frame, int64_t barrierUs) {
  int64_t capturedUs = int64_t(frame->timestamp.tv_sec) * 1000000LL + frame->timestamp.tv_usec;
  return capturedUs >= barrierUs;
}

int jsonPost(const char* route, JsonDocument& request, JsonDocument& result) {
  HTTPClient http;
  String url = String(SERVER_URL) + "/api/v2/devices/" + DEVICE_ID + route;
  http.setConnectTimeout(1000);
  http.setTimeout(1000);
  if (!http.begin(url)) return -1;
  http.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);
  http.addHeader("Content-Type", "application/json");
  String body;
  serializeJson(request, body);
  int status = http.POST(body);
  if (status == 200) {
    String response = http.getString();
    if (response.length() > 16384 || deserializeJson(result, response)) status = -2;
  }
  http.end();
  return status;
}

void controlTask(void*) {
  uint32_t sequence = 0, nextAttempt = 0, backoff = 1000;
  CommandAck pending[8];
  int pendingCount = 0;
  char knownSession[65] = {};
  for (;;) {
    uint32_t now = millis();
    if (WiFi.status() != WL_CONNECTED) {
      queueOff();
      portENTER_CRITICAL(&stateMux);
      shared.session[0] = 0; shared.mode = 0;
      portEXIT_CRITICAL(&stateMux);
      if (int32_t(now - nextAttempt) >= 0) {
        WiFi.disconnect(); WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
        nextAttempt = now + backoff + esp_random() % 300;
        backoff = min(backoff * 2, 15000u);
      }
      vTaskDelay(pdMS_TO_TICKS(250));
      continue;
    }
    backoff = 1000;
    SharedState state = snapshot();
    if (!state.session[0]) {
      JsonDocument request, response;
      request["protocol_version"] = 2;
      request["boot_id"] = bootId;
      request["firmware_version"] = "2.1.0";
      request["source"] = "hardware";
      request["psram_bytes"] = ESP.getPsramSize();
      uint32_t start = millis();
      if (jsonPost("/hello", request, response) == 200 && uint32_t(millis() - start) <= CONTROL_TIMEOUT) {
        const char* receivedSession = response["session_id"] | "";
        bool newSession = strcmp(knownSession, receivedSession) != 0;
        queueOff(newSession);
        if (newSession) {
          strlcpy(knownSession, receivedSession, sizeof(knownSession));
          sequence = 0; pendingCount = 0;
        }
        portENTER_CRITICAL(&stateMux);
        strlcpy(shared.session, response["session_id"] | "", sizeof(shared.session));
        shared.revision = response["mode_revision"];
        shared.mode = 0;
        shared.purpose = 0;
        shared.captureAfterUs = esp_timer_get_time();
        portEXIT_CRITICAL(&stateMux);
      }
      vTaskDelay(pdMS_TO_TICKS(1000));
      continue;
    }
    CommandAck ack;
    while (pendingCount < 8 && xQueueReceive(ackQueue, &ack, 0) == pdTRUE) {
      bool replaced = false;
      for (int i = 0; i < pendingCount; ++i) if (strcmp(pending[i].id, ack.id) == 0) {
        pending[i] = ack; replaced = true; break;
      }
      if (!replaced) pending[pendingCount++] = ack;
    }
    JsonDocument request, response;
    request["session_id"] = state.session; request["boot_id"] = bootId;
    request["sync_seq"] = ++sequence; request["uptime_ms"] = now;
    request["buzzer_state"] = state.buzzer ? "ON" : "OFF";
    request["pir_high"] = digitalRead(PIR_PIN) == HIGH;
    JsonArray acks = request["acks"].to<JsonArray>();
    for (int i = 0; i < pendingCount; ++i) {
      JsonObject a = acks.add<JsonObject>();
      a["command_id"] = pending[i].id; a["generation"] = pending[i].generation;
      a["status"] = pending[i].status == 0 ? "applied" : pending[i].status == 1 ? "duplicate" : "rejected";
      a["buzzer_state"] = pending[i].on ? "ON" : "OFF";
      a["executed_uptime_ms"] = pending[i].uptime;
    }
    uint32_t start = millis();
    int status = jsonPost("/sync", request, response);
    uint32_t rtt = millis() - start;
    if (status == 409 || status == 401 || status == 403) {
      queueOff();
      portENTER_CRITICAL(&stateMux); shared.session[0] = 0; shared.mode = 0; portEXIT_CRITICAL(&stateMux);
    } else if (status == 200 && rtt <= CONTROL_TIMEOUT && response["sync_seq"].as<uint32_t>() == sequence
               && strcmp(response["session_id"] | "", state.session) == 0
               && response["mode_revision"].as<uint32_t>() >= state.revision) {
      const char* mode = response["mode"] | "DISARMED";
      uint8_t newMode = strcmp(mode, "ARMED") == 0 ? 1 : strcmp(mode, "ENROLLMENT") == 0 ? 2 : 0;
      uint32_t revision = response["mode_revision"];
      if (revision != state.revision || newMode == 2) queueOff();
      for (JsonVariant id : response["acked_command_ids"].as<JsonArray>()) {
        for (int i = 0; i < pendingCount; ++i) if (strcmp(pending[i].id, id.as<const char*>()) == 0) {
          pending[i] = pending[--pendingCount]; --i;
        }
      }
      portENTER_CRITICAL(&stateMux);
      if (revision != shared.revision) shared.captureAfterUs = esp_timer_get_time();
      shared.mode = newMode; shared.revision = revision; shared.lastControl = millis();
      shared.holdUntil = millis() + min(response["capture_hold_ms"].as<uint32_t>(), 3000u);
      uint32_t lease = response["capture_lease_ms"];
      shared.captureUntil = millis() + (lease > rtt ? lease - rtt : 0);
      const char* purpose = response["capture_purpose"] | "";
      shared.purpose = strcmp(purpose, "preview") == 0 ? 1 : strcmp(purpose, "enrollment") == 0 ? 2 : 0;
      strlcpy(shared.captureSession, response["capture_session_id"] | "", sizeof(shared.captureSession));
      shared.sentinelMs = response["camera"]["sentinel_ms"] | 1000u;
      shared.activeMs = response["camera"]["active_ms"] | 500u;
      shared.warmupMs = response["camera"]["pir_warmup_ms"] | 60000u;
      shared.burstMs = response["camera"]["pir_burst_ms"] | 10000u;
      portEXIT_CRITICAL(&stateMux);
      JsonObject cmd = response["command"].as<JsonObject>();
      if (!cmd.isNull()) {
        AlarmMessage message; message.control = 3;
        strlcpy(message.session, state.session, sizeof(message.session));
        message.revision = revision;
        message.command.queued = true;
        message.command.queuedAt = millis();
        strlcpy(message.command.id, cmd["command_id"] | "", sizeof(message.command.id));
        message.command.generation = cmd["generation"];
        message.command.durationMs = cmd["duration_ms"];
        message.command.leaseMs = cmd["remaining_ttl_ms"].as<int32_t>() - int32_t(rtt);
        const char* type = cmd["type"] | "";
        message.command.type = strcmp(type,"START_ALARM")==0?1:strcmp(type,"STOP_ALARM")==0?2:strcmp(type,"TEST_ALARM")==0?3:0;
        message.command.allowed = strcmp(cmd["session_id"] | "", state.session) == 0
          && strcmp(cmd["boot_id"] | "", bootId) == 0 && cmd["mode_revision"].as<uint32_t>() == revision
          && (message.command.type == 2 || (message.command.type == 1 && newMode == 1)
              || (message.command.type == 3 && newMode == 0
                  && response["capture_lease_ms"].as<uint32_t>() == 0));
        if (xQueueSend(alarmQueue, &message, pdMS_TO_TICKS(30)) != pdTRUE) queueOff();
      }
    }
    vTaskDelay(pdMS_TO_TICKS(1000));
  }
}

void captureTask(void*) {
  uint64_t sequence = 0;
  uint32_t lastCapture = 0, burstUntil = 0, lastInit = 0;
  for (;;) {
    uint32_t now = millis();
    SharedState state = snapshot();
    if (!cameraReady && uint32_t(now - lastInit) >= 5000) {
      lastInit = now; cameraReady = cameraInit();
      if (!cameraReady) Serial.println("CAM_INIT_FAILED_CHECK_PSRAM_POWER");
    }
    bool controlFresh = state.session[0] && uint32_t(now - state.lastControl) < 5000;
    bool lease = state.purpose && int32_t(state.captureUntil - now) > 0;
    if (!cameraReady || WiFi.status() != WL_CONNECTED || !controlFresh || (state.mode != 1 && !lease)) {
      vTaskDelay(pdMS_TO_TICKS(100)); continue;
    }
    if (now >= state.warmupMs && digitalRead(PIR_PIN) == HIGH) burstUntil = now + state.burstMs;
    bool active = int32_t(burstUntil - now) > 0 || int32_t(state.holdUntil - now) > 0 || lease;
    uint32_t interval = active ? state.activeMs : state.sentinelMs;
    if (uint32_t(now - lastCapture) < interval) { vTaskDelay(pdMS_TO_TICKS(30)); continue; }
    lastCapture = now;
    camera_fb_t* frame = esp_camera_fb_get();
    if (!frame) { Serial.println("FB_NULL"); continue; }
    // A single framebuffer can still contain an image from before ARM/preview.
    // Return a stale buffer and wait for at most one newly captured replacement.
    if (cameraFrameAge(frame) > 1000 || !capturedAfter(frame, state.captureAfterUs)) {
      esp_camera_fb_return(frame);
      frame = esp_camera_fb_get();
      if (!frame) { Serial.println("FB_NULL_AFTER_STALE"); continue; }
    }
    ++sequence;
    if (frame->len <= 524288 && cameraFrameAge(frame) <= 1000
        && capturedAfter(frame, state.captureAfterUs)) {
      JsonDocument meta;
      meta["session_id"] = state.session; meta["boot_id"] = bootId; meta["seq"] = sequence;
      meta["mode_revision"] = state.revision; meta["capture_age_ms"] = cameraFrameAge(frame);
      meta["purpose"] = lease ? (state.purpose == 2 ? "enrollment" : "preview") : "monitoring";
      if (lease) meta["capture_session_id"] = state.captureSession;
      String encoded; serializeJson(meta, encoded);
      HTTPClient http;
      http.setConnectTimeout(1000); http.setTimeout(1000);
      String url = String(SERVER_URL) + "/api/v2/devices/" + DEVICE_ID + "/frames";
      if (http.begin(url)) {
        http.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);
        http.addHeader("Content-Type", "image/jpeg"); http.addHeader("X-Frame-Meta", encoded);
        int status = http.POST(frame->buf, frame->len);
        if (status != 200 && status != 202) Serial.printf("FRAME_HTTP_%d\n", status);
        http.end();
      }
    }
    esp_camera_fb_return(frame);
  }
}

void setup() {
  pinMode(ALARM_PIN, OUTPUT);
  digitalWrite(ALARM_PIN, ALARM_ACTIVE_HIGH ? LOW : HIGH);
  pinMode(PIR_PIN, INPUT);
  Serial.begin(115200);
  for (int i = 0; i < 4; ++i) snprintf(bootId + i * 8, 9, "%08lx", (unsigned long)esp_random());
  alarmQueue = xQueueCreate(8, sizeof(AlarmMessage));
  ackQueue = xQueueCreate(8, sizeof(CommandAck));
  if (!alarmQueue || !ackQueue) { Serial.println("QUEUE_INIT_FAILED"); return; }
  WiFi.mode(WIFI_STA); WiFi.setSleep(false); WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  if (xTaskCreatePinnedToCore(alarmTask, "alarm", 4096, nullptr, 3, nullptr, 1) != pdPASS) {
    Serial.println("ALARM_TASK_INIT_FAILED"); return;
  }
  if (xTaskCreatePinnedToCore(controlTask, "control", 12288, nullptr, 2, nullptr, 0) != pdPASS) {
    Serial.println("CONTROL_TASK_INIT_FAILED"); return;
  }
  if (xTaskCreatePinnedToCore(captureTask, "capture", 12288, nullptr, 1, nullptr, 1) != pdPASS) {
    Serial.println("CAPTURE_TASK_INIT_FAILED");
  }
}
void loop() { vTaskDelay(pdMS_TO_TICKS(1000)); }
