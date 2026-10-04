# Kiểm chứng, calibration và demo

Các con số trong YAML là **seed**. Chỉ report từ camera/laptop/bố trí thực của nhóm mới cho biết phạm vi đã đạt. Simulator kiểm luồng; unit test kiểm quy tắc; ONNX smoke kiểm model load. Không phép nào thay độ chính xác, độ trễ đầu-cuối hoặc kiểm nguồn/còi thật.

## 1. Điều kiện và mục tiêu nghiệm thu

Camera cố định, VGA/JPEG quality 12, ánh sáng trong nhà, đường tiếp cận A → B, không đeo vật che mặt trong phần nhận diện chính. Cố ý test điều kiện không đủ mặt/chiều ở phần warning. Ghi model manifest/hash, camera profile/hash, threshold, quy mô gallery, OS/Python/dependency, CPU/RAM, Wi-Fi, nguồn/board/module.

| Chỉ tiêu dự án | Mục tiêu G4 | Cách đo |
|---|---|---|
| Người đã đăng ký đúng tên | ≥90% lượt known holdout; không có tên sai | Số lượt info đúng / tất cả lượt known; báo thêm nhóm face-eligible |
| Người chưa đăng ký nhận nhầm thành quen | 0 trên holdout đã thu | Bất kỳ observation KNOWN sai trên lượt unknown; không chỉ event đã confirmed |
| Unknown incoming có alarm event | ≥90% nhóm face-eligible; báo cả tỷ lệ tất cả lượt | Alarm event recall; lượt thiếu mặt/direction vẫn nằm mẫu số tổng |
| Coverage chiều tiếp cận | ≥80% lượt known + unknown chính | Có track INCOMING / tất cả lượt tiếp cận |
| Known/ngang/xa/ra ngoài/empty/B trực tiếp | 0 alarm không hợp lệ | Báo số alarm / từng nhóm và toàn bộ nhóm negative |
| Unresolved hiện diện đủ lâu | Có warning, không còi | Đủ warning dwell theo config; tách chưa rõ chiều/mặt/geometry |
| Quy mô | Mục tiêu 20 người, hai người đồng thời | Limit đã đo theo report; chưa đủ người thì chưa ghi validated 20 |
| CPU inference | p95 ≤700 ms là mục tiêu ban đầu | Tool offline, máy demo; điều chỉnh scope có evidence nếu không đạt |
| Đầu-cuối còi | p95 ≤4 s là mục tiêu ban đầu | Bắt đầu lượt đứng B có mặt đủ điều kiện → buzzer thực ON; video đo thời gian |
| Safety | Mọi test deadline/STOP/reboot pass | HIL; còi không vượt hard cap, không phát lại duplicate |
| Chạy bền | 30 phút không reset nguồn/heap tăng liên tục | Board heap/reset log, server RSS/queue/frame age, ảnh/còi |

Đây là mục tiêu cho BTL, không kết quả đã đạt và không chuẩn chứng nhận sản phẩm. Không đổi mục tiêu sau khi thấy holdout để báo pass. Nếu phải giới hạn phạm vi, ghi quyết định nhóm + report mới.

## 2. Thu dữ liệu đúng cách

### 2.1. Enrollment và chia phiên

1. Có đồng ý của người tham gia; dùng alias P01/P02… trong dataset/report, không dùng tên trong tên file.
2. Preview, chốt vị trí camera, zones và ánh sáng. Đảm bảo body center đi qua A/B và khuôn mặt ở B đủ pixel. Giữ bố trí này trong enrollment, validation và test.
3. Thu enrollment hai lượt, mỗi lượt 5 mẫu chất lượng. Commit luôn draft; calibration/sanity check xong mới activate riêng. Không đưa ảnh enrollment vào dataset đánh giá.
4. Thu **validation** ở lượt/buổi khác; dùng để chọn accept/reject/margin/quality. Người known giữ cùng danh tính; ảnh, lượt và pose phải mới.
5. Thu **test/holdout** ở phiên khác và giữ chưa chạy trong lúc tune. Unknown là người không có trong gallery; nên dùng danh tính unknown khác giữa validation/test khi có thể. Không chỉ chia các frame liền nhau của cùng video ra hai split.

Pilot 3–5 người known + vài người unknown để sửa bố trí. Để claim mục tiêu 20: đủ 20 người đã enrollment, từng người có ít nhất 3 lượt validation và 3 lượt test. Thu tối thiểu 30 lượt unknown từ nhiều người; thêm tối thiểu 50 lượt negative tổng, có known/ngang/xa/ra ngoài/empty/B trực tiếp. Mỗi kiểu chính cần nhiều lần, hai người chéo/che nhau ít nhất 10 lượt riêng để review association và command thực. Bộ tối thiểu này còn nhỏ; **0/30 nhầm không bảo đảm tỷ lệ nhầm ngoài đời dưới 1%**.

Các lượt tiếp cận chính dù không thấy mặt vẫn giữ kind `known`/`unknown` và `face_eligible=false`; không đổi thành empty hay bỏ khỏi report. Kind `unidentified` dành cho bài thử chủ động che/quay mặt để kiểm warning. Eligible do người annotate trước inference, dựa ảnh rõ, đủ kích thước, không che và đi đúng vùng; lưu lý do/biên bản riêng. Báo cả tổng và eligible để thấy coverage.

### 2.2. Ghi một lượt từ board

Tool sau gọi preview có xác thực, chỉ chấp nhận runtime hardware + board online. Chụp ngắn 5–25 giây; actor chờ preview bắt đầu, đi từ A vào B rồi giữ vài giây. Tool lưu raw JPEG **riêng trong `data/` đã ignored Git**, khác baseline runtime không lưu ảnh enrollment.

```bash
python -m tools.record_visit --directory data/camera-v1 --participant-alias P01 --split validation --kind known --expected-person-id UUID --face-eligible --seconds 15
python -m tools.record_visit --directory data/camera-v1 --participant-alias U01 --split validation --kind unknown --face-eligible --seconds 15
python -m tools.record_visit --directory data/camera-v1 --participant-alias U02 --split test --kind direct-b --seconds 15
```

Dùng Python trong venv; tool hỏi mật khẩu, không in mật khẩu. Nếu camera ở máy khác thêm `--server http://IP-LAN:8000`. Dừng giám sát trước; không chạy đồng thời hai recorder. Hết lượt tool cancel preview và logout. Nếu ngắt/lỗi mạng, lease vẫn tự hết; xem/hủy phiên trên dashboard, bỏ folder dở chưa có manifest entry.

Thời gian recorder là thời điểm nhận ảnh ở client, xấp xỉ cadence quan sát. Không dùng nó như timestamp exposure hoặc độ trễ còi vật lý. Quan sát quá ít/ảnh mất cần ghi vào biên bản; không chỉ giữ các lượt đẹp. Tool không tự xác nhận consent hoặc nhãn đúng; người nhóm review chúng.

`data/camera-v1/visits.jsonl`: mỗi dòng một object. Ví dụ schema (các path phải là ảnh JPEG thực, duy nhất; không copy ảnh để tăng N):

```json
{"visit_id":"visit-001","participant_alias":"P01","split":"validation","kind":"known","expected_person_id":"UUID-gallery","face_eligible":true,"frames":[{"path":"visit-001/0000.jpg","time_ms":0},{"path":"visit-001/0001.jpg","time_ms":500}]}
```

Có thể đổi kind thành `unknown`, `unidentified`, `passerby`, `far`, `outgoing`, `direct-b`, `empty`; chỉ known có expected_person_id, kind khác là null/không có. Mỗi lượt ít nhất 2 frame với thời gian tăng nghiêm ngặt; thực tế phải đủ chuỗi A/B/warning. Chỉ frame path dưới folder dataset, không path ngoài/URL. Tool đánh giá kiểm path được dùng một lần; **không tự phát hiện mọi ảnh gần trùng hoặc rò phiên**. Người nhóm chịu trách nhiệm tách phiên và kiểm nội dung.

## 3. Hiệu chỉnh và freeze profile

1. Dừng server; giữ hardware config/runtime đúng. Download + smoke model. Draft gallery đã commit có thể dùng evaluation; không cần bỏ calibration gate để thu dữ liệu.
2. Chạy validation:

```bash
python -m tools.evaluate --manifest data/camera-v1/visits.jsonl --split validation --report experiments/private/validation-01.json
```

Tool acquire runtime lock, dùng committed gallery gồm drafts, reset tracker/policy mỗi lượt, chạy CPU trên JPEG thật và ghi report mới. Không điều khiển board, không đổi calibration. Không ghi đè report trước. Dùng tất cả drafts thuộc gallery muốn đo; dọn draft không liên quan hoặc dùng runtime evaluation riêng có consent.

3. Xem số đếm/mẫu số/null khi N=0; wrong identity, unknown accepted, alarm recall, direction coverage, warning, per-kind và p50/p95 CPU. Report gồm config/hash/máy/gallery, content hash ảnh đã đọc; không gồm raw face/vector. Kiểm ảnh lỗi/association thủ công. Matching score không phải xác suất.
4. Thay một nhóm tham số trong `configs/local.yaml` mỗi vòng; report tên mới. Thêm margin khi hai người dễ lẫn; kiểm cả UNKNOWN/UNCERTAIN/NO_FACE, đừng chỉ tối đa known recall. Hình học xấu thì sửa bố trí và thu lại, không hạ face gate để có nhiều phiếu.
5. Freeze config/model/camera/gallery và quyết định nhóm. Chạy test một lần trên bộ chưa dùng tune:

```bash
python -m tools.evaluate --manifest data/camera-v1/visits.jsonl --split test --report experiments/private/holdout-01.json
python -m tools.manage doctor
python -m tools.manage calibration-check
```

6. Nếu fail, giữ report fail, sửa theo validation và thu holdout mới. Không tune theo chính holdout rồi gọi nó independent test nữa.
7. Reviewer khác owner AI duyệt report + HIL. Copy `configs/calibration.seed.json` → `configs/calibration.local.json`, ghi `calibration_id`, state `validated`, **exact hashes từ tool**, model_set_id, path report tồn tại, reviewer, metrics và limit gallery thực đã đo. Seed values không đủ để làm hồ sơ validated.

Khung hồ sơ (placeholder phải thay bằng bằng chứng thật):

```json
{
  "calibration_id":"camera-v1-reviewed-YYYYMMDD",
  "state":"validated",
  "model_set_id":"opencv-zoo-cpu-v1",
  "camera_profile_hash":"FROM-DOCTOR",
  "model_manifest_sha256":"FROM-CALIBRATION-CHECK",
  "validated_gallery_limit":5,
  "validation_report":"experiments/private/holdout-01.json",
  "reviewer":"alias reviewer",
  "metrics":{"report_reviewed":true,"hil_report":"private path"}
}
```

Đây là hành động reviewer, tool không ký/chứng minh nội dung report. Backend chỉ kiểm structural gate, version/hash/limit/path, **không tự đọc report để chứng nhận mục tiêu đã đạt**. Restart server để load profile → `calibration-check` không lỗi → activate draft people đúng limit → arm chủ động. Khi camera/zone/quality/policy/model đổi, hash cũ bị chặn. Thêm người trong limit vẫn sanity check và kiểm nhầm với gallery; vượt limit cần đo lại.

## 4. HIL và lỗi cần thử

Ghi setup/version/video/log đã loại token; mỗi test PASS/FAIL/chưa làm, actual timing/ACK và reviewer. Không test bằng cách cấp điện sai.

| ID | Thử | Kết quả bắt buộc |
|---|---|---|
| H01 | Boot/reboot board và server | Còi OFF, session mới, server DISARMED; không replay START cũ |
| H02 | START bình thường | Đúng command ID/generation, ACK; ON duration không vượt hard cap thực |
| H03 | Duplicate START/sync retry | Không kéo dài ON/deadline; TTL retry giảm, ACK không tạo thêm START |
| H04 | STOP rồi command cũ/ACK trễ | OFF; generation cũ không hồi sinh ON; command state đúng |
| H05 | Mất Wi-Fi, tắt laptop hoặc sync timeout | OFF theo deadline/control cap dù JPEG request kẹt; không buffer/replay ảnh |
| H06 | Disarm, enrollment, cancel hoặc gallery delete trong inference | OFF; ảnh/result revision cũ không có alert mới |
| H07 | TEST khi DISARMED/ARMED/enrollment | DISARMED test tối đa test cap; các trạng thái khác từ chối |
| H08 | Cấp nguồn/camera/PIR | VGA640×480 JPEG, PSRAM thật; warm-up PIR không gây alarm; không brownout/reboot |
| H09 | Upload lỗi/quá lớn/bad JPEG/seq cũ; ARM sau idle dài | Reject bounded; buffer cũ bị bỏ theo timestamp driver; còi/control không bị upload giữ vô hạn |
| H10 | Queue ACK/command đầy, control rehello cùng session | OFF nếu overflow; generation giữ cùng session; không phát lại START |
| H11 | Mất tracker/che nhau/hơn hai người | Reset/uncertain/warning phù hợp, không mượn known/direction người khác |
| H12 | Cạn media quota/không ghi DB | Quota dọn evidence; DB fail DISARMED; không START chưa persist |
| H13 | Một known đứng, unknown mới đến; hai khách sát cooldown | Từng lượt log riêng; suppression rõ, không còi muộn sau người đi |
| H14 | Auth và xóa dữ liệu | Device không vào admin/media; CSRF đúng; delete purge face/evidence/cache |
| H15 | Backup/restore vào runtime mới | Checksums pass, reprovision token/password, DISARMED, không replay command |

Mất control 5 s không cho còi kêu 5 s nếu hard cap 3 s ngắn hơn: cái đến trước đưa OFF. Độ trễ mạng/server có thể chặn arm hoặc làm warning; không sửa firmware bỏ deadline để “demo trơn”.

Backup khi server dừng:

```bash
python -m tools.manage backup --path backups/checkpoint-01
```

Restore vào **runtime mới** với `SSS_RUNTIME` đặt path riêng rồi chạy `restore --path backups/checkpoint-01`; sau đó bootstrap. Restore tự revoke session/command và đưa gallery về inactive; chỉ activate lại sau review consent. Trên PowerShell: `$env:SSS_RUNTIME="runtime/restored-hardware"`; Linux: `export SSS_RUNTIME=runtime/restored-hardware`. Kiểm profile/calibration/model/consent trước activate/arm. Backup không gồm credential, config hoặc weights; lưu các profile cần review riêng. Không restore người đã rút consent; xóa backup cũ sau full delete.

## 5. Script demo 5–7 phút

1. Cho thấy sơ đồ/camera thật, dashboard source hardware, calibration ID và trạng thái DISARMED; brief PIR chỉ tăng cadence.
2. Preview vùng A/B; người đi ngang/xa không gây alarm. Arm chủ động.
3. Known A → B: info đúng người, không còi. Người chưa đăng ký A → B: event, command ACK, còi tự hết. Giải thích một lần/lượt, cooldown.
4. Quay mặt/đứng B trực tiếp đủ lâu: warning cần kiểm tra, không gọi ngay người lạ. Known đứng, khách mới đến: lượt riêng.
5. Silence khác acknowledge, rồi disarm; demo enrollment hai lượt hoặc video đã ghi nếu thời gian ngắn.
6. Cho thấy một lỗi Wi-Fi/server bằng test đã kiểm trước, còi tự OFF; trình bày số đo/limitations.

Chuẩn bị nguồn/cáp dự phòng, laptop không sleep, IP LAN ổn định, máy đã cache model/package. Simulator là phương án trình bày luồng khi hardware hỏng, phải giữ banner và nói rõ chưa phải demo camera/AI thực.

## 6. Bằng chứng của gói bàn giao

`experiments/HANDOFF.md` và `handoff-checks.json` ghi kết quả **bản v2.1 hiện tại**.
Evidence v2 gốc chuyển vào `experiments/archive/v2/`; không dùng hash/kết quả cũ
để chứng nhận source đã sửa. Baseline cũ 49 test pass nhưng các test review bổ sung
đã tìm thấy lỗi; số test pass không phải chứng minh không còn bug.

Full Arduino CLI compile vẫn BLOCKED ở bước tải platform/index do DNS trong môi
trường review. Nhóm cần BASE-02 + HIL. C++ host tests không kiểm task scheduling,
GPIO, nguồn hoặc protocol parser trên ESP32. GitHub Actions và Windows chưa chạy.

### 6.1 Regression mới phải giữ

| Boundary | Test hoặc gate |
|---|---|
| Input config, duplicate tracks, direction/geometry | `test_review_regressions.py` |
| Disarm/gallery change sau khi inference đã bắt đầu | `test_worker_boundaries.py` với threading.Event |
| Capture timeout hoặc round change trong inference | `test_worker_boundaries.py`; không chỉ cancel pending |
| Command trước/sau transaction commit, migration rollback | `test_foundation.py`, `test_storage.py` |
| Same generation khác command, TEST trong preview | `test_foundation.py`, firmware host/HIL |
| Queue residence và frame trước mode barrier | Host AlarmLogic + H06/H09/H10 trên board |
| UI clear cache/logout, overlay/frame ID, tên known, mobile | BASE-05 manual; JS syntax không thay interaction test |

### 6.2 Giới hạn công cụ đánh giá hiện tại

`evaluate.py` là baseline single-actor recorded visits, không phải máy chấm đầy đủ
cho mixed/two-person scene. Các ca hai người/che nhau/capacity trong G4 phải có
annotation và review riêng theo H11/H13; muốn tự động hóa cần issue mở rộng schema
visit theo actor. Chưa đo throughput queue/replaced hay physical latency bằng tool
CPU offline. Dataset split theo buổi và consent vẫn cần người xác minh; path unique
không tự phát hiện các bản copy/ảnh gần trùng được đổi tên.
