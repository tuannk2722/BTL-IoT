"use strict";
const $ = id => document.getElementById(id);
let viewEpoch = 0;
let peopleById = new Map();
let csrf = sessionStorage.getItem("sss_csrf") || "",
  current = null,
  events = [],
  busy = false,
  imageUrl = null;

// Metrics tracking
let lastFrameId = null;
let frameCount = 0;
let fpsStartTime = performance.now();
let currentFps = 0;
let lastRtt = null;

const labels = {
  KNOWN: "Người quen",
  UNKNOWN: "Không khớp người đã đăng ký",
  UNCERTAIN: "Chưa xác định",
  NO_FACE: "Chưa thấy mặt",
  NOT_CHECKED: "Chưa ở vùng nhận diện",
  ARMED: "Đang bật giám sát",
  DISARMED: "Đã tắt giám sát",
  ENROLLMENT: "Đang đăng ký",
  INCOMING: "Từ vùng ngoài đến cửa",
  OUTGOING: "Từ cửa ra ngoài",
  UNRESOLVED: "Chưa rõ chiều đi",
  known_visit: "Người quen ở vùng cửa",
  unknown_approach: "Người chưa đăng ký tiếp cận cửa",
  unresolved_presence: "Cần kiểm tra người ở vùng cửa",
  capacity_exceeded: "Vượt phạm vi hai người",
  acked: "Thiết bị đã xác nhận",
  pending: "Đang chờ",
  superseded: "Đã thay bằng lệnh mới",
  expired: "Hết hạn",
  cancelled: "Đã hủy",
  rejected: "Thiết bị từ chối",
  disabled: "Đã tắt",
  sent: "Đã gửi",
  failed: "Gửi thất bại",
  unknown: "Chưa xác nhận gửi thành công"
};

function actionKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

function show(text) {
  $("message").textContent = text;
  $("message").classList.add("visible");
}

function node(tag, text, className) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (className) n.className = className;
  return n;
}

async function api(path, method = "GET", body) {
  const response = await fetch("/api/v2" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (response.status === 401 && path !== "/auth/login") {
    logoutView();
    throw new Error("Cần đăng nhập lại.");
  }
  const result = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(result.error?.code || "Yêu cầu thất bại");
  return result;
}

/* Lightbox Modal functions */
function openLightbox(mediaId, title, meta) {
  const dialog = $("lightbox-dialog");
  if (!dialog) return;
  const titleEl = $("lightbox-title");
  if (titleEl) titleEl.textContent = title || "Ảnh bằng chứng sự kiện";
  const metaEl = $("lightbox-meta");
  if (metaEl) metaEl.textContent = meta || "";
  const src = `/api/v2/media/${mediaId}`;
  const imgEl = $("lightbox-img");
  if (imgEl) imgEl.src = src;
  const dl = $("lightbox-download");
  if (dl) {
    dl.href = src;
    dl.download = `evidence-${mediaId}.jpg`;
  }
  dialog.showModal();
}

function closeLightbox() {
  const dialog = $("lightbox-dialog");
  if (dialog && dialog.open) {
    dialog.close();
    const imgEl = $("lightbox-img");
    if (imgEl) imgEl.removeAttribute("src");
  }
}

const lbClose = $("lightbox-close");
if (lbClose) lbClose.onclick = closeLightbox;
const lbDismiss = $("lightbox-dismiss");
if (lbDismiss) lbDismiss.onclick = closeLightbox;
const lbDialog = $("lightbox-dialog");
if (lbDialog) {
  lbDialog.addEventListener("click", e => {
    if (e.target === lbDialog) closeLightbox();
  });
}

function clearImages() {
  for (const id of ["camera-image", "enrollment-image"]) {
    $(id).removeAttribute("src");
    $(id).hidden = true;
  }
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageUrl = null;
  const canvas = $("overlay");
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
  $("image-empty").hidden = false;
  closeLightbox();
}

function logoutView() {
  viewEpoch++;
  current = null;
  events = [];
  peopleById.clear();
  clearImages();
  for (const id of ["event-list", "people-list", "tracks"]) $(id).replaceChildren();
  csrf = "";
  sessionStorage.removeItem("sss_csrf");
  $("app").hidden = true;
  $("login-panel").hidden = false;
  $("logout").hidden = true;
  $("connection").textContent = "Chưa đăng nhập";
}

async function action(button, fn) {
  button.disabled = true;
  try {
    await fn();
  } catch (e) {
    show(e.message);
  } finally {
    button.disabled = false;
  }
  await refresh();
}

$("login-form").onsubmit = async e => {
  e.preventDefault();
  await action(e.submitter, async () => {
    const result = await api("/auth/login", "POST", {
      username: $("username").value,
      password: $("password").value
    });
    viewEpoch++;
    csrf = result.csrf_token;
    sessionStorage.setItem("sss_csrf", csrf);
    $("password").value = "";
    $("message").classList.remove("visible");
  });
};

$("logout").onclick = async e => action(e.target, async () => {
  await api("/auth/logout", "POST", {});
  logoutView();
});

for (const button of document.querySelectorAll("nav button")) button.onclick = () => {
  for (const b of document.querySelectorAll("nav button")) b.classList.toggle("selected", b === button);
  for (const tab of document.querySelectorAll(".tab")) tab.hidden = tab.id !== button.dataset.tab;
};

for (const [id, mode] of [
    ["arm", "ARMED"],
    ["disarm", "DISARMED"]
  ]) $(id).onclick = e => action(e.target, async () => {
  await api("/system/mode", "PUT", {
    mode,
    expected_revision: current.mode_revision
  });
  show(labels[mode]);
});

$("test").onclick = e => action(e.target, async () => {
  await api("/system/test-alarm", "POST", {
    idempotency_key: actionKey()
  });
  show("Đã tạo lệnh test; chờ thiết bị xác nhận.");
});

$("preview").onclick = e => action(e.target, () => api("/capture/preview", "POST", {}));
$("cancel-preview").onclick = e => action(e.target, () => api("/capture", "DELETE"));
$("cancel-enrollment").onclick = e => action(e.target, () => api("/capture", "DELETE"));
$("next-round").onclick = e => action(e.target, () => api(`/enrollments/${current.capture.id}/next-round`, "POST", {}));

$("commit-enrollment").onclick = e => action(e.target, async () => {
  const result = await api(`/enrollments/${current.capture.id}/commit`, "POST", {
    mode: "DISARMED",
    expected_revision: current.mode_revision
  });
  show(result.active ? "Đã lưu. Chủ động bật giám sát sau khi kiểm tra." : "Đã lưu mẫu draft. Cần hiệu chỉnh trước khi kích hoạt.");
});

$("person-form").onsubmit = e => {
  e.preventDefault();
  action(e.submitter, async () => {
    await api("/people", "POST", {
      display_name: $("display-name").value,
      consent_recorded: $("consent").checked
    });
    e.target.reset();
  });
};

$("severity-filter").onchange = renderEvents;

function statusRow(root, key, value) {
  root.append(node("dt", key), node("dd", String(value)));
}

async function refresh() {
  if (!csrf || busy) return;
  busy = true;
  const epoch = viewEpoch;
  const t0 = performance.now();
  try {
    const status = await api("/status");
    if (epoch !== viewEpoch) return;
    lastRtt = Math.round(performance.now() - t0);
    current = status;

    const latEl = $("metric-latency");
    if (latEl) {
      latEl.textContent = `Độ trễ API: ${lastRtt} ms`;
      latEl.className = "metric-pill " + (lastRtt < 120 ? "good" : lastRtt < 300 ? "warn" : "alert");
    }

    $("preview").textContent = `Xem thử ${current.ui_limits.preview_ms / 1000} giây`;
    $("test").textContent = `Test còi ${current.ui_limits.test_cap_ms / 1000} giây`;
    $("history-retention").textContent = `100 sự kiện gần nhất. Ảnh bằng chứng: tối đa ${current.ui_limits.evidence_days} ngày, có thể dọn sớm theo quota.`;
    $("cancel-preview").hidden = !(current.capture.active && current.capture.purpose === "preview");
    $("app").hidden = false;
    $("login-panel").hidden = true;
    $("logout").hidden = false;
    $("connection").textContent = current.device_online ? "Thiết bị online" : "Thiết bị offline";
    $("profile-banner").textContent = current.profile === "simulation" ? "ĐANG GIẢ LẬP — quan sát và còi không phải kết quả phần cứng hoặc độ chính xác AI." : "CAMERA THẬT — " + (current.calibration_error ? "Cần hoàn tất hiệu chỉnh: " + current.calibration_error : "Hồ sơ hiệu chỉnh: " + current.calibration_id);
    $("mode-info").textContent = labels[current.mode] + (current.worker_error ? " · " + current.worker_error : "");
    const health = $("health");
    health.replaceChildren();
    statusRow(health, "AI", current.vision_error || current.worker_error || (current.vision_ready ? "Sẵn sàng" : "Chưa sẵn sàng"));
    statusRow(health, "Còi báo từ thiết bị", current.buzzer_reported);
    if (current.notification_error) statusRow(health, "Thông báo", current.notification_error);
    statusRow(health, "Lệnh đang chờ", current.pending_command?.type || "Không có");
    statusRow(health, "Người quen active", current.active_people);
    statusRow(health, "Ảnh bỏ do thay mới", current.frames_replaced);

    const ageEl = $("image-age");
    if (current.frame_age_ms === null) {
      ageEl.textContent = "Tuổi ảnh: chưa có";
      ageEl.className = "metric-pill";
    } else {
      const sec = (current.frame_age_ms / 1000).toFixed(1);
      ageEl.textContent = `Tuổi ảnh: ${sec}s${current.frame_age_ms > 5000 ? " · ẢNH CŨ" : ""}`;
      ageEl.className = "metric-pill " + (current.frame_age_ms < 1500 ? "good" : current.frame_age_ms < 4000 ? "warn" : "alert");
    }

    const people = await api("/people");
    if (epoch !== viewEpoch) return;
    peopleById = new Map(people.map(p => [p.id, p.display_name]));
    renderPeople(people);
    const tracks = $("tracks");
    tracks.replaceChildren();
    if (!current.tracks.length) tracks.append(node("p", "Chưa có đối tượng trong lượt quan sát."));
    for (const track of current.tracks) {
      const row = node("div", undefined, "track");
      row.append(node("strong", track.person_id ? `${labels[track.identity]}: ${peopleById.get(track.person_id) || "Hồ sơ"}` : labels[track.identity]), node("p", `${labels[track.direction]} · vùng ${track.zone}`));
      if (track.visit_id) {
        const b = node("button", "Tắt còi lượt này");
        b.onclick = () => action(b, () => api("/system/silence", "POST", {
          visit_id: track.visit_id,
          idempotency_key: actionKey()
        }));
        row.append(b);
      }
      tracks.append(row);
    }
    const capture = current.capture;
    $("enrollment").hidden = !(capture.active && capture.purpose === "enrollment");
    if (!$("enrollment").hidden) {
      $("enrollment-progress").textContent = `Lượt ${capture.round}/2 — ảnh đạt: ${capture.accepted.join(" + ")} — ảnh bị loại: ${capture.rejected}`;
      $("enrollment-feedback").textContent = capture.last_feedback;
      $("next-round").disabled = capture.round !== 1 || capture.accepted[0] < current.enrollment_requirements.per_round_min;
      $("commit-enrollment").disabled = Math.min(...capture.accepted) < current.enrollment_requirements.per_round_min || capture.accepted.reduce((a, b) => a + b, 0) < current.enrollment_requirements.accepted_min;
    }
    const receivedEvents = await api("/events?limit=100");
    if (epoch !== viewEpoch) return;
    events = receivedEvents;
    renderEvents();
    await loadImage();
  } catch (e) {
    show(e.message);
    $("connection").textContent = "Không cập nhật được";
  } finally {
    busy = false;
  }
}

function renderPeople(people) {
  $("people-count").textContent = `${people.length}/${current.enrollment_requirements.max_people} hồ sơ`;
  const root = $("people-list");
  root.replaceChildren();
  for (const person of people) {
    const row = node("article", undefined, "card person-row"),
      info = node("div"),
      buttons = node("div", undefined, "actions");
    info.append(node("strong", person.display_name), node("p", person.active ? "Đang dùng để nhận diện" : "Draft / đã vô hiệu"), node("div", person.id, "identifier"));
    for (const [label, path] of [
        ["Đăng ký", `/people/${person.id}/enrollment`],
        [person.active ? "Vô hiệu" : "Kích hoạt", `/people/${person.id}/${person.active?"disable":"activate"}`]
      ]) {
      const b = node("button", label);
      b.onclick = () => action(b, () => api(path, "POST", {}));
      buttons.append(b);
    }
    const del = node("button", "Xóa hoàn toàn");
    del.onclick = () => {
      if (confirm("Xóa mẫu khuôn mặt và toàn bộ ảnh bằng chứng hiện có. Nhóm cần xóa các backup cũ riêng nếu đã tạo. Tiếp tục?")) action(del, () => api(`/people/${person.id}`, "DELETE"));
    };
    buttons.append(del);
    row.append(info, buttons);
    root.append(row);
  }
}

function renderEvents() {
  const root = $("event-list");
  root.replaceChildren();
  for (const event of events.filter(e => $("severity-filter").value === "all" || e.severity === $("severity-filter").value)) {
    const row = node("article", undefined, "card event " + event.severity);
    row.append(node("h3", labels[event.reason] || event.reason), node("p", new Date(event.created_at).toLocaleString("vi-VN") + " · " + event.source));
    row.append(node("p", `Còi: ${event.details.audible?(labels[event.command?.state]||"Chờ thiết bị"):(event.details.suppression||"Không phát lệnh")}. Thông báo: ${labels[event.notification?.state]||"Trong dashboard"}.`));
    if (event.details.person_id) row.append(node("p", `Người: ${peopleById.get(event.details.person_id) || "Hồ sơ không còn active"}`));
    const actions = node("div", undefined, "actions");
    const ack = node("button", event.acknowledged_at ? "Đã xem" : "Đánh dấu đã xem");
    ack.disabled = !!event.acknowledged_at;
    ack.onclick = () => action(ack, () => api(`/events/${event.id}/acknowledge`, "POST", {}));
    actions.append(ack);
    if (event.media_id) {
      const mediaId = event.media_id;
      const metaText = `${new Date(event.created_at).toLocaleString("vi-VN")} · ${labels[event.reason] || event.reason}`;
      const view = node("button", "Phóng to ảnh bằng chứng");
      view.onclick = () => openLightbox(mediaId, labels[event.reason] || event.reason, metaText);
      actions.append(view);

      const thumb = node("img", undefined, "event-thumb");
      thumb.alt = "Ảnh bằng chứng sự kiện (bấm để xem to)";
      thumb.src = `/api/v2/media/${mediaId}`;
      thumb.title = "Bấm để xem ảnh phóng to";
      thumb.onclick = () => openLightbox(mediaId, labels[event.reason] || event.reason, metaText);
      row.append(thumb);
    }
    row.append(actions);
    root.append(row);
  }
  if (!root.children.length) root.append(node("p", "Chưa có sự kiện phù hợp."));
}

async function loadImage() {
  const epoch = viewEpoch;
  const analysis = current?.latest_analysis;
  const zones = current?.zones;
  const response = await fetch("/api/v2/latest-frame");
  if (epoch !== viewEpoch) return;
  if (response.status === 401) { logoutView(); return; }
  if (response.status === 404) { clearImages(); return; }
  if (!response.ok) return;
  const frameId = response.headers.get("X-Frame-Id"),
    blob = await response.blob(),
    img = $("camera-image");
  if (epoch !== viewEpoch) return;

  // Track FPS
  if (frameId && frameId !== lastFrameId) {
    lastFrameId = frameId;
    frameCount++;
    const now = performance.now();
    const elapsed = now - fpsStartTime;
    if (elapsed >= 1500) {
      currentFps = (frameCount * 1000) / elapsed;
      frameCount = 0;
      fpsStartTime = now;
      const fpsEl = $("metric-fps");
      if (fpsEl) {
        fpsEl.textContent = `FPS: ${currentFps.toFixed(1)}`;
        fpsEl.className = "metric-pill " + (currentFps >= 1.0 ? "good" : currentFps >= 0.5 ? "warn" : "alert");
      }
    }
  }

  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageUrl = URL.createObjectURL(blob);
  $("enrollment-image").src = imageUrl;
  $("enrollment-image").hidden = false;
  img.src = imageUrl;
  img.hidden = false;
  $("image-empty").hidden = true;
  img.onload = () => {
    if (epoch !== viewEpoch) return;
    const canvas = $("overlay");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const [key, label] of [["approach", "A"], ["doorstep", "B"]]) {
      if (!zones) break;
      const [x,y,w,h] = zones[key];
      ctx.strokeStyle = key === "approach" ? "#ffca78" : "#72dec3";
      ctx.lineWidth = 2;
      ctx.strokeRect(x*canvas.width,y*canvas.height,w*canvas.width,h*canvas.height);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.font = "20px sans-serif";
      ctx.fillText(label,x*canvas.width+5,y*canvas.height+23);
    }
    if (analysis?.frame_id !== frameId) return;
    for (const o of analysis.observations) {
      ctx.strokeStyle = o.decision === "UNKNOWN" ? "#ff8d92" : "#72dec3";
      ctx.lineWidth = 3;
      ctx.strokeRect(o.bbox[0] * canvas.width, o.bbox[1] * canvas.height, o.bbox[2] * canvas.width, o.bbox[3] * canvas.height);
    }
  };
}

setInterval(() => {
  if (!document.hidden) refresh();
}, 2000);
refresh();
