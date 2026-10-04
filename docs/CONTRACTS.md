# Contracts v2 — firmware, backend, AI và dashboard

Base `/api/v2`. Wire identifiers tiếng Anh; JSON UTF-8, extra fields bị từ chối ở request Pydantic. UUID/session là opaque. Một board `device_id` slug theo config. Thời gian server UTC cho history; timeout dùng monotonic/uptime, không trừ UTC cho millis.

## Mục lục

1. [Auth, limits và lỗi](#1-auth-limits-và-lỗi)
2. [Device hello/sync](#2-device-hellosync)
3. [Upload và retry](#3-upload-và-retry)
4. [Observation boundary](#4-observation-boundary)
5. [Admin API](#5-admin-api)
6. [Compatibility và fixtures](#6-compatibility-và-fixtures)

## 1. Auth, limits và lỗi

Device API: `Authorization: Bearer <device token>` provisioned riêng. Không được dùng device token đọc người/ảnh/admin status. Admin: cookie `sss_session`; mutation có `X-CSRF-Token` từ login. Không bật CORS cross-origin mặc định.

Body JSON tối đa 32 KiB; JPEG ≤ `limits.max_frame_bytes`, header metadata ≤ 4 KiB; body read deadline 2 s. Image decoded dimensions bounded và hardware dimensions đúng camera profile. Upload token bucket theo config; hello tối đa 6/min; login tối đa 5 sai/min/IP. Receipt duplicate không tạo work/vote mới.

Lỗi gọn: `{"error":{"code":"MODE_REVISION_CONFLICT"}}`. 401 auth, 403 sai source/role/CSRF, 404 không có, 409 session/revision/idempotency/sequence, 408 upload quá chậm, 413 size, 415 content type, 422 schema/quality protocol, 429 rate limit, 503 model chưa ready. Không trả traceback/request body/password/embedding. Retry-After cho 429/503.

`GET /health/live` public chỉ alive. `GET /health/ready` public chỉ ready boolean/503, phản ánh worker/model; camera/calibration/gallery readiness chi tiết trong authenticated `/status`. Không dùng ready=true thay bằng chứng calibrated hardware.

## 2. Device hello/sync

### Hello

`POST /devices/{device_id}/hello`:

```json
{"protocol_version":2,"boot_id":"random-new-at-boot","firmware_version":"2.0.0","source":"hardware","psram_bytes":4194304}
```

`source=hardware|simulator` phải đúng runtime profile; hardware báo PSRAM=0 bị từ chối (422 PSRAM_REQUIRED); simulation nhận simulator, hardware nhận board. Boot ID 8–64 ký tự. Hello retry cùng boot/session đang active không reset; boot mới disarm/reset. Response:

```json
{"protocol_version":2,"session_id":"opaque-server-session","mode":"DISARMED","mode_revision":2,"max_frame_bytes":524288}
```

Firmware giữ command generation/last ID khi hello trả **cùng session** sau mất mạng ngắn; chỉ reset khi session mới. Sync sequence cũng không reset ở cùng session. Server restart cấp session mới, mặc định DISARMED; không phát lại command từ session cũ.

### Sync và ACK

`POST /devices/{device_id}/sync` độc lập upload:

```json
{
  "session_id":"opaque-server-session","boot_id":"random-new-at-boot",
  "sync_seq":12,"uptime_ms":18000,"buzzer_state":"OFF","pir_high":false,
  "acks":[{"command_id":"opaque-command","generation":4,"status":"applied","buzzer_state":"OFF","executed_uptime_ms":17500,"reason":null}]
}
```

ACK status `applied|duplicate|rejected`; acks tối đa 8. ACK được confirm bằng `acked_command_ids`; device giữ tới confirm. ACK của command superseded/session cũ không hồi sinh trạng thái command hiện tại. `buzzer_state` sync là trạng thái device báo, không tự suy từ event.

Response:

```json
{
  "sync_seq":12,"session_id":"opaque-server-session","mode":"ARMED","mode_revision":3,
  "generation":5,"acked_command_ids":["opaque-command"],
  "command":{"command_id":"next-command","type":"START_ALARM","generation":5,
    "session_id":"opaque-server-session","boot_id":"random-new-at-boot","mode_revision":3,
    "duration_ms":2000,"visit_id":"opaque-visit","remaining_ttl_ms":4200},
  "capture_purpose":null,"capture_session_id":null,"capture_lease_ms":0,"capture_hold_ms":3000,
  "camera":{"width":640,"height":480,"jpeg_quality":12,"sentinel_ms":1000,"active_ms":500,
    "pir_warmup_ms":60000,"pir_burst_ms":10000,"presence_hold_ms":3000}
}
```

`command=null` nếu không có; type `START_ALARM|STOP_ALARM|TEST_ALARM`. Duration/TTL lấy từ config; STOP duration 0, có ưu tiên. Preview/enrollment trả capture purpose/session/lease; giám sát dùng presence hold riêng. Camera width/quality hiện build-time, response mô tả profile; firmware áp dụng các interval, không tự reinitialize resolution từ response.

**Lease:** firmware ghi t0 trước request, t1 sau response, RTT=t1−t0. Chỉ nhận đúng sync_seq/session, revision không lùi, RTT ≤ control timeout. Cửa sổ START bảo thủ = remaining_ttl_ms−RTT; ≤0 thì reject. Duplicate ID không reset deadline; generation cũ hơn đã thấy reject. STOP mới đưa OFF, không cần START còn lease. Disarm/enrollment/đổi revision đưa OFF trước áp command. TEST chỉ DISARMED, test cap; ENROLLMENT không TEST.

Còi hard cap/deadline nằm ở alarm task, độc lập HTTP. `remaining_ttl_ms` là hạn **bắt đầu**, không thời lượng ON. Retry sync same seq nhận TTL tính lại, không response cũ với lease đầy. Seq nhỏ hơn watermark conflict. Mỗi lần poll mới dùng sync_seq mới, dù poll trước timeout; ACK chưa được confirm phải giữ lại. Nếu retry cùng seq thì body phải giống hệt (kể cả uptime/ACK), nếu khác trả SYNC_ID_REUSED. Không cache response TTL nguyên vẹn. Đây là sửa mô tả cũ để khớp cách firmware polling; không đổi wire version.

## 3. Upload và retry

`POST /devices/{device_id}/frames`: raw JPEG body, `Content-Type: image/jpeg`, metadata JSON trong `X-Frame-Meta`:

```json
{"session_id":"opaque-server-session","boot_id":"random-new-at-boot","seq":42,
 "mode_revision":3,"purpose":"monitoring","capture_age_ms":25,"capture_session_id":null}
```

`purpose=monitoring|preview|enrollment`. Preview/enrollment phải có đúng capture_session_id đang active và purpose/mode hợp lệ; không chỉ tin request. `seq` tăng mỗi **ảnh chụp**, không mỗi lần retry. Firmware bỏ ảnh cũ; không buffer khi mạng mất.

`capture_age_ms` tính từ timestamp first DMA của framebuffer đến trước upload, cùng clock esp_timer từ boot; không lấy thời điểm gọi `fb_get` làm thời điểm chụp. Bỏ buffer cũ từ trước lúc ARM/preview, lấy tối đa một replacement rồi vẫn kiểm tuổi. Upload/network và queue/inference có deadline riêng; field này không đo toàn bộ latency.

Mới: HTTP 202 `{"frame_id":"opaque-frame","state":"accepted","duplicate":false}`. Same key/cùng bytes+metadata: 200 cùng ID/state, duplicate=true, không queue. Same key khác fingerprint: 409 FRAME_ID_REUSED. Seq thấp không còn receipt: 409 STALE_FRAME_SEQUENCE. Receipt trạng thái `accepted|processing|processed|replaced|stale|failed|cancelled`; accepted chưa cam kết analyzed.

**v1 → v2:** v1 dự kiến multipart; v2 dùng raw JPEG/header để firmware ít cấp phát hơn. Không gửi multipart/base64/URL ảnh vào endpoint này. Chưa có source triển khai v1 cần migrate DB; nếu nhóm đã viết producer v1 riêng, đổi cả hai phía hoặc giữ adapter riêng có version, không trộn schema.

`POST /devices/{id}/synthetic-frames` **simulation only**, body:

```json
{"metadata":{"session_id":"opaque-session","boot_id":"random-boot","seq":1,"mode_revision":3,
 "purpose":"monitoring","capture_age_ms":0},
 "observations":[{"track_id":"sim-1","bbox":[0.1,0.2,0.2,0.5],"decision":"NOT_CHECKED",
 "person_id":null,"geometry_valid":true,"reason":null}]}
```

Hardware profile luôn từ chối synthetic observations. Dashboard giữ nhãn source; simulator không được gửi source=hardware để giả board. Offline evaluation dùng tool riêng.

## 4. Observation boundary

`contracts.Observation` là ranh giới B ↔ C, Pydantic: cấm extra/nonfinite và ép kiểu numeric/bool sai:

| Field | Kiểu / ý nghĩa |
|---|---|
| `track_id` | String 1–64, tạm trong chuỗi ảnh |
| `bbox` | 4 float hữu hạn `[x,y,w,h]` normalized ảnh gốc, trọn [0,1] |
| `decision` | `KNOWN|UNKNOWN|UNCERTAIN|NO_FACE|NOT_CHECKED` |
| `person_id` | UUID/null; KNOWN chỉ hợp lệ với active person |
| `geometry_valid` | Body/association đủ tin để xét chiều; face-only false |
| `reason` | Code chất lượng/association/matching/null |

Ảnh gốc là hệ tọa độ chuẩn, không trả letterbox coords. Embedding không đưa qua dashboard API. Policy nhận frame_id + monotonic time + Observation[], trả list decision có visit_id/track_id/direction/person_id/reason/severity/audible/suppression/detail. Mỗi đối tượng độc lập. Field/API thay phải có producer-consumer fixture.

## 5. Admin API

| Method/path (sau `/api/v2`) | Input / response chính |
|---|---|
| `POST /auth/login` | username/password → session cookie + csrf_token |
| `POST /auth/logout` | CSRF → 204, revoke |
| `GET /status` | mode/revision, source, age/health, tracks, latest_analysis, capture, gallery count, enrollment_requirements lấy từ config |
| `PUT /system/mode` | mode ARMED/DISARMED + expected_revision; arm cần model/gallery/calibration/device ready |
| `POST /system/test-alarm` | idempotency_key 8–64 → 202 command_id; DISARMED/không capture, device online |
| `POST /system/silence` | visit_id active + idempotency_key → 202 STOP; không disarm |
| `POST /capture/preview` | chỉ DISARMED, không capture khác → 201 lease |
| `GET /capture`, `DELETE /capture` | trạng thái / cancel về DISARMED + staging purge |
| `GET /people`, `POST /people` | list / display_name + consent_recorded=true → draft |
| `POST /people/{id}/enrollment` | inactive/draft, model thật ready → 201 hai lượt |
| `POST /enrollments/{id}/next-round` | round1 đủ → round2 |
| `POST /enrollments/{id}/commit` | `{mode:"DISARMED",expected_revision:n}` → gallery_revision, active=false (draft), next |
| `POST /people/{id}/activate`, `/disable` | activate có samples/calibration/capacity, DISARMED; disable invalidate ngay |
| `DELETE /people/{id}` | full delete + purge mọi evidence; 204 |
| `GET /events?limit=1..100` | newest-first, details/command/notification; bounded history |
| `POST /events/{id}/acknowledge` | idempotent đánh dấu đã xem, không silence |
| `GET /commands` | 50 records gần nhất; state/ACK riêng |
| `GET /latest-frame` | JPEG, X-Frame-Id, no-store; 404 chưa có |
| `GET /media/{id}` | authenticated JPEG evidence, 404 thiếu/purged |

Action key test/silence lưu DB 24h, cùng key khác fingerprint conflict; command + key persist atomically. Duplicate action trả kết quả cũ, không tạo lệnh mới. Thao tác khác dùng revision/resource state hoặc bản chất idempotent. Preview/enrollment đang active thì retry không tạo phiên thứ hai.

UI không diễn giải 202 là buzzer applied. History không xóa alarm khi known xuất hiện sau. User input chỉ `textContent`, không innerHTML tên người. Polling 2s, giảm/stop khi tab ẩn. Mutation có pending/error; ảnh overlay dùng cùng frame ID.

## 6. Compatibility và fixtures

OpenAPI từ server là schema máy đọc, docs này sở hữu semantics. PR cần cập nhật cả hai khi đổi. Device contract version 2; không chỉ thêm required field mà bỏ firmware/simulator chưa cập nhật.

Fixture/test phải cover same key same/different payload, watermark sau purge, boot/session/revision sai, stale inference sau disarm/gallery change, stream quá lớn, bad JPEG, CSRF/device-admin isolation, duplicate command, TTL sau retry, STOP/generation/ACK trễ, offline, enrollment cancel/timeout/multiple faces. Các seed numeric lấy YAML; đừng tạo bản default thứ hai trong doc/code UI.


### Làm rõ v2.1

- Một synthetic frame không được lặp track_id; KNOWN bắt buộc có person_id,
  decision khác không mang person_id. Service kiểm person đó active trước policy.
- next-round tăng mode_revision; firmware lấy revision mới qua sync. Packet cũ
  phải cancelled. Commit không tự activate; API activate là bước chủ động riêng.
- Storage lỗi trả 503 `STORAGE_FAULT` sau khi xóa trạng thái nguy hiểm trong RAM.
- latest-frame có `X-Frame-Id`; logout/disarm/404 phải xóa ảnh/cache hiển thị cũ.
  Preview/enrollment hiển thị vùng A/B từ status, cùng hệ tọa độ với bbox.
- status bổ sung `zones`, `notification_error`, các giới hạn UI từ config; không
  hardcode 30s/1s/7 ngày ở UI nếu người vận hành đã đổi cấu hình hợp lệ.
