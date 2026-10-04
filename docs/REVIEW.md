# Review chuyên sâu Smart Security System v2 → v2.1

**Ngày:** 02/10/2026. Input: `Smart-Security-System-v2.zip` gồm 69 file.
Mốc sản phẩm: TEAM_GUIDE được người dùng nhận xét là gần đúng ý; đối chiếu từng
luồng với SPEC, CONTRACTS, code, tests, tools và firmware. Không chạy với board,
người thật hoặc tài khoản Telegram.

## 1. Kết luận và quyết định

**Giữ nền hiện có, sửa các lỗi tìm thấy và làm rõ bộ khung. Không xóa toàn bộ.**
Bản gốc có modular monolith phù hợp nhóm ba người, pure policy, contract, simulator,
exact model manifest và tests thực sự chạy được. Không có bằng chứng rằng phần lớn
code phải bỏ. Tuy vậy, không thể xem đây là hệ thống đã nghiệm thu chỉ vì đủ tính
năng hoặc vì 49 test gốc pass.

Bản review đã chạy lại 49 test gốc; thêm bộ tái hiện ban đầu có **19 case fail,
2 case pass**. Đây là số case, không phải 19 lỗ hổng độc lập. Các regression về sau
được bổ sung cho race trong inference, transaction, migration, auth và notifier.
Evidence cuối cùng và số test chính xác nằm trong `experiments/HANDOFF.md`.

Ưu tiên đã xử lý: điều kiện tạo cảnh báo/còi, stale result, gallery/enrollment,
validation, lệnh/DB, rồi module boundaries và operator UI. Không đổi board, model,
framework, ngân sách, phạm vi sản phẩm hay deadline tháng 11/2026.

## 2. Spec có bám TEAM_GUIDE không?

| Ý trong TEAM_GUIDE | V2 trước review | Kết quả sau review |
|---|---|---|
| PIR tăng cadence; không tự quyết định người lạ/còi | Spec/code đúng hướng | Giữ; cadence thực vẫn cần đo |
| So mặt ở B, A → B mới có incoming | Policy cơ bản có | Gia cố continuity khi geometry đổi/association mơ hồ |
| Người ngang/xa/B trực tiếp/quay lưng không tự hú | Spec và pure tests có | Giữ; không suy pure test thành camera đã đạt |
| Mỗi track/lượt độc lập, known không che unknown | Code policy có | Giữ per-visit và cooldown; sửa cooldown khi START bị STOP suppress |
| Enrollment một người đứng B, hai lượt | Spec thiếu gate vùng; code không kiểm B | Ghi và thực thi gate B; round change vô hiệu packet cũ |
| Calibration chưa đạt thì lưu draft | Có auto-active khi còn limit, dễ bỏ sanity check | Commit luôn draft; activate riêng sau kiểm tra |
| Có lỗi DB/AI thì ngừng alarm mới | Worker có một phần; API và thời điểm commit còn hở | Fail closed trong mutation; command RAM chỉ sau COMMIT |
| Preview/giám sát/đăng ký tách biệt | Có lease nhưng không recheck đầy đủ sau inference | Recheck lease sau inference, clear cache, ảnh trước mode barrier bị bỏ |
| Người trong nhóm dùng Codex, chia việc rõ | Service gần 1.000 dòng trộn nhiều trách nhiệm | Tách enrollment, worker, tracker và ports; map ownership |
| Code nền cần nhóm kiểm, không phải đã xong BTL | Đã có cảnh báo nhưng evidence cũ dễ bị đọc thành hiện trạng | Archive evidence cũ, ghi riêng kết quả v2.1 và BASE tasks |

SPEC vẫn sở hữu hành vi, CONTRACTS sở hữu wire semantics, YAML sở hữu defaults;
TEAM_GUIDE giải thích sản phẩm. Review không biến TEAM_GUIDE thành bản spec kỹ thuật
thứ hai. Chỉ chỉnh các đoạn bị ảnh hưởng bởi draft activation/module/status.

## 3. Findings và sửa đổi

P1 = có thể sai cảnh báo, actuator state, dữ liệu hoặc cản triển khai; P2 = độ tin
cậy, maintainability hoặc operator flow. “Đã sửa” là software change có kiểm chứng
được nêu, không phải chứng nhận không còn lỗi hay HIL đã PASS.

| ID / mức | Code gốc và vấn đề cụ thể | Sửa v2.1 / bằng chứng |
|---|---|---|
| RV01 / P1 | `config.py`: bỏ qua nhiều camera/vision/zones/notifications bounds; bool có thể qua kiểm int; file config chỉ định không tồn tại lại chạy default simulation | Validate toàn shape/type/range, finite, quan hệ votes/sampling; thiếu explicit path fail; `test_review_regressions` |
| RV02 / P1 | YAML cho đổi hard/control/capture constants nhưng firmware hardcode số khác | Backend từ chối override không được firmware hỗ trợ; ghi rõ build constants trong SPEC; config regression |
| RV03 / P1 | `vision.enrollment_sample`: một mặt ngoài B vẫn được thu | Gate B theo body đã gán hoặc face-only khi không có body; association kiểm riêng; fake-vision regression |
| RV04 / P1 | `worker`: capture hết hạn giữa inference và publish vẫn có thể nhận mẫu nếu chưa có status/sync khác expire | Expire lease dưới lock sau inference rồi check revision; test có barrier chặn inference, không poll status |
| RV05 / P1 | `next_enrollment_round`: không tăng revision; ảnh round1 đang chạy có thể được tính round2 | Tăng revision/cancel pending; worker loại result cũ; `test_round_change_does_not_relabel_inflight_sample` |
| RV06 / P1 | `vision.analyze`: mặt nằm trong nhiều body thành một face-only mới, hai người bị đếm ba; body còn continuity/votes cũ | Không thêm face-only khi đã có nhiều candidates; đánh dấu body mơ hồ, reset qua geometry-kind; regression len/identity/geometry |
| RV07 / P1 | `policy`: cùng ID chuyển geometry invalid→valid có thể tái dùng incoming/votes; frame thiếu track không ngắt chuỗi “liên tiếp” | Reset track khi geometry kind đổi; missing observation reset pending_count; hai regression |
| RV08 / P1 | `policy._vote`: known ID mới không clear known cũ nếu votes đã hết tuổi nhưng confirmation còn freshness | So cả confirmed identity lẫn vote window; test với window hết tuổi/freshness còn |
| RV09 / P1 | `_issue(db=...)` đặt command vào RAM trước transaction ngoài COMMIT; exception handler chạy sau khi context lock thoát tạo cửa sổ race | Stage command, `_deliver_committed` chỉ sau COMMIT; test quan sát ngay trước commit + rollback/outbox fault tests |
| RV10 / P1 | `_disarm`: có I/O trước xóa START; API DB lỗi không có đường fail closed thống nhất | Clear nguy hiểm trước I/O; storage_guard giữ lock tới fail closed; API trả STORAGE_FAULT/503; test DB fault |
| RV11 / P1 | ARM chỉ cần gallery không rỗng; runtime restore/import có thể vượt calibrated limit hoặc thiếu sample | Kiểm capacity và số mẫu tối thiểu lúc ARM; fixture seed sửa thành đủ 5 samples; regression capacity |
| RV12 / P1 | Full delete người A khi đang thu người B và vẫn còn người active có thể không cancel capture; dữ liệu mới tiếp tục ngay sau purge | Full delete disarm/hủy capture/cache trước purge; regression với người khác còn active |
| RV13 / P2 | SyntheticFrame lặp track_id có thể tăng count trong cùng frame; “StrictModel” chỉ cấm extra/nonfinite | StrictInt/StrictBool + unique track + KNOWN/person_id consistency; request/contract tests |
| RV14 / P2 | Sync same seq khác body bị coi duplicate; docs bắt retry cùng seq nhưng firmware polling tăng seq | Same seq phải cùng fingerprint; mỗi poll mới tăng seq, ACK giữ tới confirm; docs và regression đồng bộ |
| RV15 / P1 | Alarm task tin allowed/TTL đã tính ở control task; queue residence và mode/session thay đổi giữa hai task chưa xét | Command mang queuedAt/session/revision; alarm task recheck; C++ kiểm queue TTL; **FreeRTOS execution cần HIL** |
| RV16 / P1 | Frame trước ARM/preview <1s vẫn qua age gate, dù spec nói bỏ buffer trước mode | Barrier esp_timer lúc đổi revision/session; camera timestamp phải sau barrier; **chưa HIL**, cần H06/H09 |
| RV17 / P2 | Python simulator nhận command khác ID cùng generation; TEST trong preview khác firmware/spec | Đồng bộ generation/mode/capture rules; không giữ seen set vô hạn; host/simulator tests |
| RV18 / P2 | `Store.__init__` luôn chạy 001; folder migrations chưa có upgrade runner thật | Runner số liên tục, atomic migration, reject future schema; test upgrade/idempotent/rollback; không sửa 001 |
| RV19 / P2 | Notifier chết vĩnh viễn nếu SQLite/provider shape lỗi ngoài try | Catch theo iteration, status fault riêng, retry interruptible; test DB fault rồi hồi phục, không gửi Telegram |
| RV20 / P2 | UI hardcode số; không vẽ vùng; ảnh/cache còn sau logout; known không hiện tên; tab enrollment không có ảnh | Limits từ status, vùng A/B, clear cache/epoch, tên từ people, preview cancel và enrollment image; syntax PASS, **browser/mobile manual còn cần BASE-05** |
| RV21 / P2 | Evidence handoff ghi hash/test của v2 bị dùng lại sau sửa | Archive evidence gốc; tạo manifest/hash/results mới cho v2.1 |
| RV22 / P2 | `service.py` gom enroll/model loop/state/transaction gần 1.000 dòng; B/C dễ đụng cùng file | Tách composition EnrollmentManager, VisionWorker, pure tracking, runtime types và VisionPort; giữ public facade để caller không phải đổi hàng loạt |
| RV23 / P2 | Pillow `verify()` không đủ kiểm đầy đủ JPEG; làm validation trong coordinator lock | Decode bounded JPEG hoàn chỉnh ngoài lock, recheck session/revision sau decode; native inference vẫn ở worker |
| RV24 / P2 | `tools.manage`: backup chạy startup recovery trên nguồn; restore chưa tự đưa gallery inactive | Backup dùng recover=False; restore revoke state/staging và inactive gallery; nhóm còn phải diễn tập H15 với runtime thật |
| RV25 / P2 | `auth`: username Unicode có thể làm compare_digest string báo lỗi; Bearer prefix không bắt buộc; rate limiter concurrent chưa khóa | Compare UTF-8 bytes, bắt Bearer, lock limiter/bound map; hai API regression |
| RV26 / P2 | Command hết TTL vẫn hiện pending nếu thiết bị ngừng sync | Status cũng expire command bằng monotonic deadline; regression không sync |

Không gắn mọi lỗi với chữ “security vulnerability”: nhiều finding là contract,
state consistency hoặc test coverage. Các P1 liên quan phần cứng phải qua HIL trước
khi dùng làm demo với còi thật dù header host test xanh.

## 4. Giữ, sửa, thêm, bỏ gì?

- **Giữ:** stack, API `/api/v2`, model artifacts/wrapper/license, policy per-visit,
  simulator, SQL 001, cách chia A/B, target 20 người/hai người, nguồn và dependency pins.
- **Sửa:** validation/config; association/enrollment; service transactions/guards;
  policy boundary; firmware queue/freshness guards; auth, UI, tools và docs bị ảnh hưởng.
- **Thêm:** `enrollment.py`, `worker.py`, `tracking.py`, `runtime.py`, `ports.py`,
  `NodeState.h`, `tools/check.py`, regression suites; hai tài liệu ARCHITECTURE/REVIEW.
- **Di chuyển:** bản HANDOFF/checks gốc sang archive; tạo evidence mới ở vị trí chính.
- **Không xóa implementation hàng loạt**, không thêm broker/microservices/frontend
  build chain, không thay code bằng stub giả thành công.

Có compatibility export `service.DomainError/Packet` và `vision.ConservativeTracker`
để call site/test cũ không gãy. Module mới import từ `runtime`/`tracking`; đừng thêm
business logic vào re-export. Không tạo thêm một repository “skeleton” song song
với repository runnable vì hai nguồn rất dễ lệch.

## 5. Đối chiếu yêu cầu → implementation → evidence

| FR / yêu cầu | Module chính | Software evidence | Phần còn phải đo/review |
|---|---|---|---|
| FR01 sampling/PIR | firmware control/capture | Static review/profile constants | H08/H09 cadence/PIR/nguồn |
| FR02–05 bounded/freshness/revision/startup | service, worker, firmware | Service/storage/API/race tests | Full sketch và H01/H06/H09 |
| FR06–09 geometry/visit/multi-person | spatial, tracking, vision, policy | Policy/vision math/review tests | G2 ảnh thật; H11/H13 |
| FR10–12 model/open-set/temporal | manifest, vision, matching, policy | Hash, blank smoke, math/temporal tests | Threshold/quality/holdout G3/G4 |
| FR13–15 enrollment/gallery | enrollment, worker, storage | Hai lượt/draft/cancel/race/capacity | Operator flow, data consistency thực |
| FR16–19 event/suppression/command/safety | policy, service, AlarmLogic | Policy, transaction, simulator/HTTP, C++ | Full compile và HIL timing/GPIO |
| FR20–21 persistence/retention/delete | storage, migrations, enrollment | Migration/retention/delete tests | Disk quota/restore dữ liệu thật |
| FR22 auth | auth, main | CSRF/roles/bounds/validation tests | LAN deployment/firewall/operator |
| FR23 backup | tools.manage + Store | Đọc code/checksum route; SQLite backup API | H15 diễn tập backup/restore trước demo |
| FR24 health/config | config, service, worker | Config + worker fault/race tests | Native stall, soak30min/mạng yếu |
| EX01 Telegram | notifications | Recovery bằng fake step; không gọi provider | Optional integration sau core |
| UI operator | main/static/templates | Endpoint + JS syntax | BASE-05 browser/mobile, accessibility |

Không cộng các ô software PASS để suy ra cả FR đã nghiệm thu ngoài đời.

## 6. Những giới hạn còn lại — không giấu trong chữ TODO

1. **Full ESP32 compile BLOCKED:** đã thử CLI1.2.2; tải package index/core bị DNS
   timeout. Đây không phải compile error đã xác nhận của source, cũng không phải
   compile PASS. BASE-02 là việc đầu tiên của A. Không nạp board trong phiên review.
2. **Chưa có ảnh người thật/holdout:** không chứng minh quality seed, đường A/B,
   nhận diện 20 người, tốc độ đi, face/body association hoặc chống giả mạo.
3. **UI chưa chạy trên browser thật:** phần sửa có syntax/API evidence; người nhóm
   phải kiểm laptop/mobile và thao tác enrollment. Không gọi node --check là UI test.
4. **Hiệu năng:** vẫn là SQLite + media I/O trong một số critical section; latency
   cần đo. Một worker pending một slot hạn chế backlog nhưng không tạo bảo đảm realtime.
5. **Tracker đơn giản:** IoU/center matching bảo thủ, không ReID; overlap hoặc miss
   có thể mất incoming. Chưa đổi thuật toán khi chưa có failure dataset thực.
6. **Enrollment consistency seed dùng độ giống sample:** không phải xác minh danh
   tính/liveness; admin kiểm người trước camera. Cần đo cùng session và duplicate
   person trên gallery thật; không coi cosine thành xác suất.
7. **Evaluate tool một actor/lượt:** mixed scenes, label/split theo buổi, gần trùng,
   calibration reviewer và physical latency vẫn có phần kiểm thủ công. Ghi rõ ở VALIDATION.
8. **Dependency warning:** Starlette TestClient/httpx deprecation; suite chạy được.
   Không nâng toàn stack chỉ để hết warning trong review nghiệp vụ.
9. **Runtime cài từ checkout:** chưa claim wheel distribution, multi-worker, nhiều
   camera hoặc deploy Internet. Những thứ này không thuộc baseline BTL.
10. **Không đảm bảo “100% hết bug”:** phạm vi review/test và bằng chứng được công bố
    để nhóm biết cần kiểm gì tiếp. Không bịa số AI/HIL để đánh dấu gate hoàn thành.

## 7. Bạn nên xem gì trước?

Đọc phần 1–3 báo cáo này → ARCHITECTURE mục 2/6 → chạy simulator → giao BASE-01…05.
Nếu thời gian ít, ưu tiên hiểu 4 luồng: **frame vào worker**, **A→B tạo event**,
**event→command→ACK**, **enrollment draft→activate**. Không cần đọc mọi dòng code
trong một lượt để bắt đầu chia việc; phải đọc đủ phần mình nhận và phần interface.
