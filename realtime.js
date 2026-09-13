import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { supabaseConfig } from "./supabase-config.js?v=2";

const state = { client: null, admin: null, attemptId: null, attempt: null, attemptsChannel: null, studentAttemptChannel: null, attempts: [], monitorFilters: { search: "", status: "all", answer: {} } };
const $ = (selector) => document.querySelector(selector);
const escapeHTML = (value = "") => { const element = document.createElement("div"); element.textContent = value; return element.innerHTML; };

function generateReadableStudentId() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "0123456789";
  const randomChar = (pool) => pool[Math.floor(Math.random() * pool.length)];
  return `${randomChar(letters)}${randomChar(letters)}${Array.from({ length: 7 }, () => randomChar(digits)).join("")}`;
}

async function ensurePublicStudentProfile() {
  const internal = localStorage.getItem("english_test_internal_student_id") || `student-${crypto.randomUUID()}`;
  const stored = localStorage.getItem("english_test_student_public_id");
  let publicId = stored || generateReadableStudentId();
  if (state.client && !stored) {
    const existing = await state.client.from("students").select("student_id").eq("user_id", internal).maybeSingle();
    if (existing?.data?.student_id) {
      publicId = existing.data.student_id;
    } else {
      const candidate = generateReadableStudentId();
      const attempt = await state.client.from("students").insert({ user_id: internal, student_id: candidate, taker_name: "Student" }).select("student_id").maybeSingle();
      if (!attempt.error && attempt.data?.student_id) publicId = attempt.data.student_id;
    }
  }
  localStorage.setItem("english_test_internal_student_id", internal);
  localStorage.setItem("english_test_student_public_id", publicId);
  return { internalStudentId: internal, publicStudentId: publicId };
}

const internalStudentId = localStorage.getItem("english_test_internal_student_id") || `student-${crypto.randomUUID()}`;
const publicStudentId = localStorage.getItem("english_test_student_public_id") || generateReadableStudentId();
localStorage.setItem("english_test_internal_student_id", internalStudentId);
localStorage.setItem("english_test_student_public_id", publicStudentId);
const configured = supabaseConfig.url.startsWith("https://") && !supabaseConfig.url.includes("YOUR_PROJECT") && supabaseConfig.anonKey !== "YOUR_SUPABASE_ANON_KEY" && supabaseConfig.url !== "https://YOUR_PROJECT_REF.supabase.co";

function displayStudentId(attempt = {}) {
  return attempt.student_id || attempt.display_student_id || attempt.user_id || "Unknown";
}

function isTimerEnabled(paper = {}) {
  return Boolean(paper?.timer_enabled) && Number(paper?.time_limit_minutes || 0) > 0;
}

function getPaperTimeLimitMinutes(paper = {}) {
  return Number(paper?.time_limit_minutes || 0);
}

function getAttemptDeadline(attempt = {}) {
  if (!attempt || !attempt.started_at) return null;
  const timeLimitMinutes = Number(attempt.time_limit_minutes || 0);
  if (!timeLimitMinutes) return null;
  const start = new Date(attempt.started_at);
  if (Number.isNaN(start.getTime())) return null;
  return new Date(start.getTime() + timeLimitMinutes * 60000);
}

function getAttemptRemainingMs(attempt = {}) {
  const deadline = getAttemptDeadline(attempt);
  if (!deadline) return null;
  return Math.max(deadline.getTime() - Date.now(), 0);
}

function formatRemainingTime(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "No timer";
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function setConnection(message, connected = false) {
  const status = $("#monitorConnection");
  if (status) { status.textContent = message; status.classList.toggle("connected", connected); }
}

function mapPaper(row) {
  return {
    id: row.id,
    title: row.title,
    questions: row.questions || [],
    timer_enabled: Boolean(row.timer_enabled),
    time_limit_minutes: Number(row.time_limit_minutes || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function isCompletedAttempt(attempt) {
  return attempt.status === "completed" || attempt.status === "submitted";
}

function hasPendingManualReview(attempt) {
  const marks = attempt.manual_marks || {};
  return (attempt.questions || []).some(question => question.type === "explanation" && !Object.prototype.hasOwnProperty.call(marks, question.id));
}

function attemptState(attempt) {
  if (!attempt) return "missing";
  if (attempt.status === "in-progress") return "in-progress";
  return hasPendingManualReview(attempt) ? "pending-review" : "completed";
}

function normalizedAnswer(value) { return String(value ?? "").trim().toLowerCase(); }

function answerIsCorrect(question, answer) {
  const type = question.type || "multiple-choice";
  if (answer === undefined || answer === null || answer === "") return false;
  if (type === "multiple-choice") return Number(answer) === Number(question.correctAnswer);
  if (type === "true-false") return normalizedAnswer(answer) === normalizedAnswer(question.correctAnswer);
  if (type === "fill-blank" || type === "short-answer") return (question.acceptedAnswers || [question.correctAnswer]).some(expected => normalizedAnswer(answer) === normalizedAnswer(expected));
  if (type === "matching") return Array.isArray(answer) && answer.length === question.pairs.length && question.pairs.every((pair, index) => normalizedAnswer(answer[index]) === normalizedAnswer(pair.right));
  return Array.isArray(answer) && answer.length === question.items.length && answer.every((itemIndex, index) => Number(itemIndex) === index);
}

function questionMaximumMarks(question) {
  if ((question.type || "multiple-choice") === "matching" && question.pairs?.length) return Number(question.marksPerPair || (Number(question.marks || 0) / question.pairs.length) || 1) * question.pairs.length;
  return Number(question.marks || 0);
}

function questionEarnedMarks(question, answer, manualMarks = {}) {
  const type = question.type || "multiple-choice";
  if (type === "explanation") return Number(manualMarks[question.id] || 0);
  if (type === "matching") {
    const pairMark = Number(question.marksPerPair || (Number(question.marks || 0) / (question.pairs?.length || 1)) || 1);
    return (question.pairs || []).reduce((sum, pair, index) => sum + (normalizedAnswer(answer?.[index]) === normalizedAnswer(pair.right) ? pairMark : 0), 0);
  }
  return answerIsCorrect(question, answer) ? questionMaximumMarks(question) : 0;
}

function answerStatus(question, answer) {
  if (answer === undefined || answer === null || answer === "" || (Array.isArray(answer) && !answer.length)) return "unanswered";
  if ((question.type || "multiple-choice") === "explanation") return "pending";
  return answerIsCorrect(question, answer) ? "correct" : "incorrect";
}

function manualReviewStatus(question, answer, manualMarks) {
  if ((question.type || "multiple-choice") !== "explanation") return null;
  if (answer === undefined || answer === null || String(answer).trim() === "") return "unanswered";
  return Number.isFinite(Number(manualMarks)) ? "reviewed" : "pending";
}

function evaluateAttempt(attempt) {
  const questions = attempt.questions || [];
  const answers = attempt.answers || {};
  const manualMarks = attempt.manual_marks || {};
  const statuses = questions.map(question => manualReviewStatus(question, answers[question.id], manualMarks[question.id]) || answerStatus(question, answers[question.id]));
  const correct = statuses.filter(status => status === "correct").length;
  const incorrect = statuses.filter(status => status === "incorrect").length;
  const unanswered = statuses.filter(status => status === "unanswered").length;
  const pending = statuses.filter(status => status === "pending").length;
  const reviewed = statuses.filter(status => status === "reviewed").length;
  const totalMarks = questions.reduce((sum, question) => sum + questionMaximumMarks(question), 0);
  const autoScore = questions.reduce((sum, question, index) => sum + (statuses[index] === "correct" ? questionEarnedMarks(question, answers[question.id], {}) : question.type === "matching" ? questionEarnedMarks(question, answers[question.id], {}) : 0), 0);
  const manualScore = questions.reduce((sum, question) => sum + ((question.type || "multiple-choice") === "explanation" ? Number(manualMarks[question.id] || 0) : 0), 0);
  const score = autoScore + manualScore;
  return { correct, incorrect, unanswered, pending, reviewed, autoScore, manualScore, score, totalMarks, percentage: totalMarks ? Math.round(score / totalMarks * 100) : 0, statuses };
}

function formatAttemptAnswer(question, answer) {
  if (answer === undefined || answer === null || answer === "" || (Array.isArray(answer) && !answer.length)) return "Unanswered";
  const type = question.type || "multiple-choice";
  if (type === "explanation") return String(answer);
  if (type === "multiple-choice") return question.options?.[answer] || `Option ${String.fromCharCode(65 + Number(answer))}`;
  if (type === "true-false" || type === "fill-blank" || type === "short-answer") return Array.isArray(answer) ? answer.join(", ") : String(answer);
  if (type === "matching") return (question.pairs || []).map((pair, index) => `${pair.left}: ${answer[index] || "Unanswered"}`).join("; ");
  return (answer || []).map(index => question.items?.[index] || "").join(" ");
}

function formatCorrectAnswer(question) {
  const type = question.type || "multiple-choice";
  if (type === "multiple-choice") return question.options?.[question.correctAnswer] || "Unanswered";
  if (type === "true-false") return question.correctAnswer;
  if (type === "fill-blank" || type === "short-answer") return (question.acceptedAnswers || [question.correctAnswer]).filter(Boolean).join(", ");
  if (type === "matching") return (question.pairs || []).map(pair => `${pair.left}: ${pair.right}`).join("; ");
  if (type === "explanation") return "Manual review required";
  return (question.items || []).join(" ");
}

function renderAnswerRow(attempt, question, index, answer, status) {
  const manualMarks = attempt.manual_marks || {};
  if ((question.type || "multiple-choice") === "explanation") {
    const reviewed = status === "reviewed";
    const unanswered = !answer || String(answer).trim() === "";
    const reviewLabel = reviewed ? "✅ Reviewed" : unanswered ? "⬜ Unanswered" : "⏳ Pending Review";
    return `<div class="manual-review-row"><div><strong>Q${index + 1}: ${escapeHTML(question.text)}</strong><span class="review-status ${reviewed ? "reviewed" : "pending"}">${reviewLabel}</span></div><div><small>Student answer</small><p>${escapeHTML(answer || "Unanswered")}</p></div>${question.referenceAnswer ? `<div><small>Reference answer / marking notes</small><p>${escapeHTML(question.referenceAnswer)}</p></div>` : ""}${isCompletedAttempt(attempt) ? `<div class="manual-review-actions"><input type="number" min="0" max="${Number(question.marks) || 0}" step="1" value="${reviewed ? Number(manualMarks[question.id]) : ""}" placeholder="0-${Number(question.marks) || 0}" id="manual-mark-${attempt.id}-${question.id}" /><span>/ ${Number(question.marks) || 0} marks</span><button class="btn btn-secondary compact-btn" onclick="window.monitorSaveManualMark?.('${attempt.id}', '${question.id}', ${Number(question.marks) || 0})">${reviewed ? "Update Marks" : "Save Marks"}</button></div>` : ""}</div>`;
  }
  const statusLabel = status === "correct" ? "✅ Correct" : status === "incorrect" ? "❌ Incorrect" : "⬜ Unanswered";
  const maximum = questionMaximumMarks(question);
  const earned = questionEarnedMarks(question, answer, {});
  return `<div class="attempt-answer ${status}"><span>Q${index + 1}</span><div class="answer-copy"><strong>${escapeHTML(formatAttemptAnswer(question, answer))}</strong><small>Correct: ${escapeHTML(formatCorrectAnswer(question))}</small><small>Marks: ${earned} / ${maximum}</small></div><span class="answer-status">${statusLabel}</span></div>`;
}

function renderAttempts(rows = state.attempts) {
  state.attempts = rows;
  const container = $("#attemptList");
  if (!container) return;
  const search = state.monitorFilters.search.trim().toLowerCase();
  const filtered = rows.filter(attempt => {
    const evaluation = evaluateAttempt(attempt);
    const searchable = `${attempt.taker_name || ""} ${displayStudentId(attempt) || ""}`.toLowerCase();
    const statusMatches = state.monitorFilters.status === "all" || (state.monitorFilters.status === "in-progress" && attempt.status === "in-progress") || (state.monitorFilters.status === "submitted" && isCompletedAttempt(attempt)) || (state.monitorFilters.status === "correct" && evaluation.correct > 0) || (state.monitorFilters.status === "incorrect" && evaluation.incorrect > 0) || (state.monitorFilters.status === "unanswered" && evaluation.unanswered > 0) || (state.monitorFilters.status === "pending" && isCompletedAttempt(attempt) && evaluation.pending > 0) || (state.monitorFilters.status === "reviewed" && isCompletedAttempt(attempt) && evaluation.pending === 0 && evaluation.reviewed > 0);
    return (!search || searchable.includes(search)) && statusMatches;
  });
  updateMonitorSummary(rows);
  if (!filtered.length) { container.innerHTML = `<div class="empty"><h3>No matching attempts</h3><p>Try changing the search or filters.</p></div>`; return; }
  container.innerHTML = filtered.map((attempt) => {
    const questions = attempt.questions || [];
    const answers = attempt.answers || {};
    const evaluation = evaluateAttempt(attempt);
    const total = attempt.question_count || questions.length;
    const answered = Object.keys(answers).length;
    const progress = total ? Math.round(answered / total * 100) : 0;
    const answerFilter = state.monitorFilters.answer[attempt.id] || "all";
    const answerRows = questions.map((question, index) => { const answer = answers[question.id]; const status = evaluation.statuses[index]; if (answerFilter !== "all" && status !== answerFilter) return ""; return renderAnswerRow(attempt, question, index, answer, status); }).join("");
    const reviewSummary = evaluation.pending ? "⏳ Pending Review" : evaluation.unanswered && questions.some(question => question.type === "explanation") ? "⚠️ Includes Unanswered" : "✅ Reviewed";
    const completed = isCompletedAttempt(attempt);
    const exportButton = completed && !evaluation.pending ? `<button class="btn btn-secondary" onclick="window.monitorExportPdf?.('${attempt.id}')">Export Result PDF</button>` : "";
    return `<article class="attempt-card ${completed ? "submitted-card" : ""}"><div class="attempt-header"><div><strong>${escapeHTML(attempt.taker_name || "Unknown learner")}</strong><small>ID: ${escapeHTML(attempt.user_id || "unknown")}</small></div><span class="attempt-status ${completed ? "submitted" : "in-progress"}">${completed ? "Completed" : "In Progress"}</span></div><h3>${escapeHTML(attempt.paper_title || "Untitled paper")}</h3><div class="attempt-progress"><div style="width:${progress}%"></div></div><div class="attempt-summary"><span>${answered} answered · ${evaluation.unanswered} unanswered · ${evaluation.correct} correct / ${evaluation.incorrect} incorrect</span><strong>Score: ${evaluation.score} / ${evaluation.totalMarks}${completed ? ` · ${evaluation.percentage}%` : ` · ${progress}%`}</strong></div>${completed ? `<div class="attempt-summary"><span>Auto ${evaluation.autoScore} · Manual ${evaluation.manualScore} · ${reviewSummary}</span><strong>${evaluation.correct} correct / ${evaluation.incorrect} incorrect</strong></div>` : ""}<details class="attempt-details" ${completed ? "open" : ""}><summary>Review answers</summary><select class="answer-filter" aria-label="Filter answers" onchange="window.monitorSetAnswerFilter?.('${attempt.id}', this.value)"><option value="all" ${answerFilter === "all" ? "selected" : ""}>Show All Answers</option><option value="correct" ${answerFilter === "correct" ? "selected" : ""}>Show Only Correct</option><option value="incorrect" ${answerFilter === "incorrect" ? "selected" : ""}>Show Only Incorrect</option><option value="unanswered" ${answerFilter === "unanswered" ? "selected" : ""}>Show Only Unanswered</option><option value="pending" ${answerFilter === "pending" ? "selected" : ""}>Show Pending Manual Review</option><option value="reviewed" ${answerFilter === "reviewed" ? "selected" : ""}>Show Reviewed</option></select><div class="attempt-answers">${answerRows || `<p class="type-help">No answers match this filter.</p>`}</div></details><div class="attempt-actions"><button class="btn btn-outline" onclick="window.monitorExpandAttempt?.('${attempt.id}')">Expand Review Answers</button>${exportButton}<button class="btn btn-danger" onclick="window.monitorDeleteAttempt?.('${attempt.id}')">Delete Attempt</button></div></article>`;
  }).join("");
}

function updateMonitorSummary(rows) {
  const summary = $("#monitorSummary");
  if (!summary) return;
  const submitted = rows.filter(isCompletedAttempt).length;
  const active = rows.length - submitted;
  const correct = rows.reduce((sum, attempt) => sum + evaluateAttempt(attempt).correct, 0);
  const unanswered = rows.reduce((sum, attempt) => sum + evaluateAttempt(attempt).unanswered, 0);
  summary.innerHTML = `<div class="monitor-stat"><span>Total attempts</span><strong>${rows.length}</strong></div><div class="monitor-stat"><span>Currently taking</span><strong>${active}</strong></div><div class="monitor-stat"><span>Submitted</span><strong>${submitted}</strong></div><div class="monitor-stat"><span>Correct answers</span><strong>${correct}</strong></div>`;
}

async function loadPapers() {
  const { data, error } = await state.client.from("papers").select("*").order("created_at", { ascending: true });
  if (error) throw error;
  window.realtimeLoadPapers?.(data.map(mapPaper));
}

async function loadAttempts() {
  const { data, error } = await state.client.from("attempts").select("*").order("updated_at", { ascending: false });
  if (error) throw error;
  renderAttempts(data);
  const active = data.filter((attempt) => attempt.status === "in-progress").length;
  $("#homeAttemptCount")?.replaceChildren(String(active));
  $("#heroActiveCount")?.replaceChildren(String(active));
}

window.monitorSetFilter = (key, value) => {
  state.monitorFilters[key] = value;
  renderAttempts();
};
window.monitorSetAnswerFilter = (attemptId, value) => {
  state.monitorFilters.answer[attemptId] = value;
  renderAttempts();
};

window.getPublicStudentId = () => publicStudentId;
window.getInternalStudentId = () => internalStudentId;

window.monitorExpandAttempt = (attemptId) => {
  const attempt = state.attempts.find(row => String(row.id) === String(attemptId));
  if (!attempt) return;
  const evaluation = evaluateAttempt(attempt);
  const body = $("#attemptReviewBody");
  const questions = attempt.questions || [];
  body.innerHTML = `<div class="review-modal-meta"><div class="monitor-stat"><span>Student</span><strong>${escapeHTML(attempt.taker_name || "Unknown")}</strong></div><div class="monitor-stat"><span>Student ID</span><strong>${escapeHTML(displayStudentId(attempt))}</strong></div><div class="monitor-stat"><span>Paper</span><strong>${escapeHTML(attempt.paper_title || "Untitled")}</strong></div><div class="monitor-stat"><span>Score</span><strong>${evaluation.score} / ${evaluation.totalMarks}</strong></div></div>${questions.map((question, index) => {
    const answer = (attempt.answers || {})[question.id];
    const status = evaluation.statuses[index];
    const instruction = question.instruction ? `<p><strong>Instruction:</strong> ${escapeHTML(question.instruction)}</p>` : "";
    const review = renderAnswerRow(attempt, question, index, answer, status);
    return `<section class="review-modal-question"><h4>Q${index + 1} · ${escapeHTML(questionTypeLabelForReview(question))}</h4>${instruction}<p><strong>${escapeHTML(question.text)}</strong></p>${review}</section>`;
  }).join("")}`;
  $("#attemptReviewModal").classList.add("show");
  $("#attemptReviewModal").setAttribute("aria-hidden", "false");
};

window.monitorCloseReview = () => {
  $("#attemptReviewModal").classList.remove("show");
  $("#attemptReviewModal").setAttribute("aria-hidden", "true");
};

function questionTypeLabelForReview(question) {
  return question.type === "explanation" ? "Explanation / Manual Review" : question.type === "matching" ? "Matching" : question.type === "ordering" ? "Ordering Words" : "Auto-graded";
}

function sectionLabel(question, index) {
  const source = `${question.instruction || ""} ${question.text || ""}`;
  const match = source.match(/\b([A-Z]\d+)\b/);
  return match ? match[1] : "Other";
}

window.monitorExportPdf = async (attemptId) => {
  const { data: attempt, error } = await state.client.from("attempts").select("*").eq("id", attemptId).maybeSingle();
  if (error) {
    console.error("Latest attempt fetch failed before PDF export", { attemptId, error });
    alert(`Unable to load the latest result: ${error.message}`);
    return;
  }
  if (!attempt) return;
  const evaluation = evaluateAttempt(attempt);
  if (evaluation.pending) { alert("Finish all manual reviews before exporting the result."); return; }
  const sections = new Map();
  (attempt.questions || []).forEach((question, index) => {
    const label = sectionLabel(question, index);
    const current = sections.get(label) || { earned: 0, maximum: 0, order: index };
    current.earned += questionEarnedMarks(question, (attempt.answers || {})[question.id], attempt.manual_marks || {});
    current.maximum += questionMaximumMarks(question);
    sections.set(label, current);
  });
  const orderedSections = [...sections.entries()].sort((a, b) => a[1].order - b[1].order);
  const report = `<html><head><title>Result - ${escapeHTML(attempt.taker_name || "Student")}</title><style>body{font-family:Arial,sans-serif;padding:40px;color:#171725}h1{margin-bottom:4px}.meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:24px 0}.score{font-size:24px;font-weight:700;margin:22px 0}table{width:100%;border-collapse:collapse}td,th{padding:10px;border-bottom:1px solid #ddd;text-align:left}@media print{body{padding:0}}</style></head><body><h1>English Test Result</h1><p>${escapeHTML(attempt.paper_title || "Untitled paper")}</p><div class="meta"><div>Student: <strong>${escapeHTML(attempt.taker_name || "Unknown")}</strong></div><div>Student ID: <strong>${escapeHTML(displayStudentId(attempt))}</strong></div><div>Attempt date: ${escapeHTML(attempt.submitted_at || attempt.updated_at || "")}</div><div>Status: Completed</div></div><div class="score">TOTAL SCORE: ${evaluation.score} / ${evaluation.totalMarks} (${evaluation.percentage}%)</div><table><thead><tr><th>Section</th><th>Marks</th></tr></thead><tbody>${orderedSections.map(([label, value]) => `<tr><td>${escapeHTML(label)}</td><td>${value.earned} / ${value.maximum}</td></tr>`).join("")}</tbody></table><script>window.onload=()=>window.print();</script></body></html>`;
  const reportWindow = window.open("", "_blank");
  if (!reportWindow) { alert("Allow pop-ups to export the result PDF."); return; }
  reportWindow.document.write(report);
  reportWindow.document.close();
};
window.monitorSaveManualMark = async (attemptId, questionId, maximum) => {
  if (!state.admin) return;
  const input = [...document.querySelectorAll(`#manual-mark-${attemptId}-${questionId}`)].filter(element => element.offsetParent !== null).pop();
  const mark = Number(input?.value);
  if (!Number.isInteger(mark) || mark < 0 || mark > maximum) {
    alert(`Enter a whole number from 0 to ${maximum}.`);
    return;
  }
  const { data: attempt, error: fetchError } = await state.client.from("attempts").select("*").eq("id", attemptId).maybeSingle();
  if (fetchError || !attempt) {
    console.error("Latest attempt fetch failed before manual mark save", { attemptId, questionId, fetchError });
    alert(fetchError ? `Unable to load the latest attempt: ${fetchError.message}` : "This attempt no longer exists.");
    return;
  }
  const manualMarks = { ...(attempt.manual_marks || {}), [questionId]: mark };
  const evaluation = evaluateAttempt({ ...attempt, manual_marks: manualMarks });
  const { error } = await state.client.from("attempts").update({ manual_marks: manualMarks, score: evaluation.score, total_marks: evaluation.totalMarks, percentage: evaluation.percentage, updated_at: new Date().toISOString() }).eq("id", attemptId);
  if (error) {
    console.error("Manual mark save failed", { attemptId, questionId, mark, error });
    const message = error.message?.includes("manual_marks")
      ? "Manual review is not enabled in Supabase yet. Run supabase-schema.sql, then reload the page."
      : `Unable to save marks: ${error.message}`;
    alert(message);
    return;
  }
  await loadAttempts();
  const latest = state.attempts.find(row => String(row.id) === String(attemptId));
  if (latest) window.studentAttemptUpdated?.(latest);
};
window.monitorResetFilters = () => {
  state.monitorFilters = { search: "", status: "all", answer: {} };
  $("#attemptSearch").value = "";
  $("#attemptStatusFilter").value = "all";
  renderAttempts();
};

window.realtimeFindStudentAttempt = async (paperId) => {
  if (!state.client) return { data: null, error: new Error("Supabase is not configured") };
  const result = await state.client.from("attempts").select("*").eq("user_id", internalStudentId).eq("paper_id", paperId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (result.error) console.error("Student attempt lookup failed", { paperId, internalStudentId, error: result.error });
  return result;
};

function subscribeStudentAttempt(attemptId) {
  if (!state.client || state.studentAttemptChannel) return;
  state.studentAttemptChannel = state.client.channel(`student-attempt-${attemptId}`).on("postgres_changes", { event: "UPDATE", schema: "public", table: "attempts", filter: `id=eq.${attemptId}` }, async () => {
    const latest = await state.client.from("attempts").select("*").eq("id", attemptId).maybeSingle();
    if (latest.data) { state.attempt = latest.data; window.studentAttemptUpdated?.(latest.data); }
  }).subscribe();
}

window.realtimeAttemptState = attemptState;
window.monitorDeleteAttempt = async (attemptId) => {
  const id = String(attemptId || "").trim();
  if (!state.admin || !id || !window.confirm("Delete this attempt and all saved answers?")) return;

  const { data: deletedRows, error } = await state.client
    .from("attempts")
    .delete()
    .eq("id", id)
    .select("id");

  if (error) {
    console.error("Attempt delete failed", { attemptId: id, error });
    setConnection(`Delete failed: ${error.message}`);
    alert(`Unable to delete attempt: ${error.message}`);
    return;
  }

  const deleted = (deletedRows || []).some(row => String(row.id) === id);
  if (!deleted) {
    const errorMessage = "Supabase deleted 0 rows. Check the attempt ID and the Admins can delete attempts policy.";
    console.error("Attempt delete failed", { attemptId: id, error: errorMessage, deletedRows });
    setConnection("Delete failed: no matching attempt was deleted");
    alert(errorMessage);
    return;
  }

  state.attempts = state.attempts.filter(attempt => String(attempt.id) !== id);
  delete state.monitorFilters.answer[id];
  renderAttempts();
  try {
    await loadAttempts();
  } catch (reloadError) {
    console.error("Attempt deleted but monitor refresh failed", { attemptId: id, error: reloadError });
    setConnection(`Attempt deleted, but monitor refresh failed: ${reloadError.message}`);
  }
};

function subscribe() {
  state.client.channel("papers-live").on("postgres_changes", { event: "*", schema: "public", table: "papers" }, loadPapers).subscribe();
}

function subscribeAdminAttempts() {
  if (state.attemptsChannel || !state.admin) return;
  state.attemptsChannel = state.client.channel("attempts-live").on("postgres_changes", { event: "*", schema: "public", table: "attempts" }, loadAttempts).subscribe();
}

function formatAttemptsError(error) {
  if (error?.message?.includes("Could not find the table 'public.attempts'")) {
    return "Supabase attempts table is missing. Run supabase-schema.sql in the Supabase SQL Editor, then reload this page.";
  }
  return `Supabase error: ${error.message}`;
}

function showAdminSession(session) {
  state.admin = session?.user || null;
  $("#adminLoginPanel").hidden = Boolean(state.admin);
  $("#adminSession").hidden = !state.admin;
  $("#monitorControls").hidden = !state.admin;
  $("#adminEmailLabel").textContent = state.admin?.email || "";
  if (state.admin) { subscribeAdminAttempts(); loadAttempts().then(() => setConnection("Supabase connected", true)).catch((error) => setConnection(formatAttemptsError(error))); }
  else { if (state.attemptsChannel) { state.client.removeChannel(state.attemptsChannel); state.attemptsChannel = null; } state.attempts = []; $("#attemptList").innerHTML = `<div class="empty"><h3>Admin sign-in required</h3><p>Sign in to view live learner answers.</p></div>`; setConnection("Students can take tests"); }
}

window.adminSignIn = async () => {
  const errorElement = $("#adminLoginError");
  const email = $("#adminEmail").value.trim();
  const password = $("#adminPassword").value;
  errorElement.textContent = "";
  if (!email || !password) {
    errorElement.textContent = "Enter the admin email and password.";
    return;
  }
  const { error } = await state.client.auth.signInWithPassword({ email, password });
  if (error) {
    if (error.message.includes("Email not confirmed")) {
      errorElement.textContent = "Confirm your email from the Supabase verification email, then sign in again.";
    } else if (error.message.includes("Invalid login credentials")) {
      errorElement.textContent = "Invalid email or password. Check the Supabase Authentication user, or reset the password in Supabase.";
    } else {
      errorElement.textContent = error.message;
    }
  }
};
window.adminSignOut = async () => { await state.client.auth.signOut(); };
window.realtimeIsAdmin = () => Boolean(state.admin);

window.realtimeSavePaper = async (paper) => {
  if (!state.admin) return;
  const safeTimerEnabled = Boolean(paper?.timer_enabled);
  const safeTimeLimit = Number(paper?.time_limit_minutes || 0);
  const { error } = await state.client.from("papers").upsert({
    id: paper.id,
    title: paper.title,
    questions: paper.questions,
    owner_id: state.admin.id,
    timer_enabled: safeTimerEnabled,
    time_limit_minutes: safeTimerEnabled ? Math.max(1, safeTimeLimit) : 0,
    updated_at: new Date().toISOString()
  });
  if (error) console.error("Paper save failed", error);
};
window.realtimeDeletePaper = async (paperId) => { if (state.admin) await state.client.from("papers").delete().eq("id", paperId); };

window.realtimeStartAttempt = async (paperId, paperTitle, questions, takerName, paperConfig = {}) => {
  const timeLimitMinutes = Number(paperConfig.time_limit_minutes || 0);
  const now = new Date();
  const startedAt = now.toISOString();
  const deadlineAt = timeLimitMinutes > 0 ? new Date(now.getTime() + timeLimitMinutes * 60000).toISOString() : null;
  const existing = await window.realtimeFindStudentAttempt?.(paperId);
  if (existing?.error) {
    console.error("Cannot safely recover student attempt", existing.error);
    return null;
  }
  if (existing?.data) {
    state.attemptId = existing.data.id;
    state.attempt = existing.data;
    sessionStorage.setItem("english_test_attempt_id", existing.data.id);
    if (timeLimitMinutes > 0 && (!existing.data.deadline_at || Number(existing.data.time_limit_minutes || 0) !== timeLimitMinutes || !existing.data.started_at)) {
      const refresh = await state.client.from("attempts").update({ started_at: existing.data.started_at || startedAt, deadline_at: existing.data.deadline_at || deadlineAt, time_limit_minutes: timeLimitMinutes, updated_at: new Date().toISOString() }).eq("id", existing.data.id).select().single();
      if (!refresh.error && refresh.data) state.attempt = refresh.data;
    }
    if (attemptState(existing.data) === "pending-review") subscribeStudentAttempt(existing.data.id);
    return state.attempt || existing.data;
  }
  const attempt = { user_id: internalStudentId, student_id: publicStudentId, taker_name: takerName, paper_id: paperId, paper_title: paperTitle, questions, question_count: questions.length, answers: {}, current_index: 0, status: "in-progress", total_marks: questions.reduce((sum, question) => sum + Number(question.marks || 0), 0), time_limit_minutes: timeLimitMinutes, started_at: startedAt, deadline_at: deadlineAt };
  const { data, error } = await state.client.from("attempts").insert(attempt).select().single();
  if (error) { console.error("Attempt creation failed", error); return; }
  state.attemptId = data.id; state.attempt = data; sessionStorage.setItem("english_test_attempt_id", data.id);
  return data;
};
window.realtimeSaveAnswer = async (questionId, answerIndex, currentIndex) => { if (!state.attemptId) return; state.attempt = state.attempt || { answers: {} }; state.attempt.answers = { ...(state.attempt.answers || {}), [questionId]: answerIndex }; await state.client.from("attempts").update({ answers: state.attempt.answers, current_index: currentIndex, updated_at: new Date().toISOString() }).eq("id", state.attemptId); };
window.realtimeUpdateProgress = async (currentIndex) => { if (state.attemptId) await state.client.from("attempts").update({ current_index: currentIndex, updated_at: new Date().toISOString() }).eq("id", state.attemptId); };
window.realtimeSubmit = async (score, totalMarks, percentage) => {
  if (!state.attemptId) return { error: new Error("No active attempt") };
  const completedAt = new Date().toISOString();
  const fullUpdate = { score, total_marks: totalMarks, percentage, manual_marks: {}, status: "completed", submitted_at: completedAt, updated_at: completedAt };
  let result = await state.client.from("attempts").update(fullUpdate).eq("id", state.attemptId);
  if (result.error?.message?.includes("manual_marks")) {
    console.warn("manual_marks is not available yet; saving completion without manual review marks.");
    result = await state.client.from("attempts").update({ score, total_marks: totalMarks, percentage, status: "completed", submitted_at: completedAt, updated_at: completedAt }).eq("id", state.attemptId);
  }
  if (result.error) console.error("Attempt completion save failed", result.error);
  if (!result.error) {
    state.attempt = { ...(state.attempt || {}), id: state.attemptId, score, total_marks: totalMarks, percentage, manual_marks: {}, status: "completed", submitted_at: completedAt, updated_at: completedAt };
    subscribeStudentAttempt(state.attemptId);
  }
  return { ...result, attemptId: state.attemptId, attempt: state.attempt };
};

if (!configured) {
  setConnection("Supabase setup required");
  $("#adminLoginError").textContent = "Add your Supabase URL and anon key to supabase-config.js.";
} else {
  state.client = createClient(supabaseConfig.url, supabaseConfig.anonKey, { global: { headers: { "x-student-id": internalStudentId, "x-student-public-id": publicStudentId } } });
  ensurePublicStudentProfile().catch((error) => console.error("Student profile creation failed", error));
  loadPapers().then(() => setConnection("Supabase connected", true)).catch((error) => {
    const message = error.message?.includes("Could not find the table")
      ? "Supabase connected. Run supabase-schema.sql in the SQL Editor."
      : `Supabase error: ${error.message}`;
    setConnection(message);
    console.error("Supabase paper load failed", error);
  });
  state.client.auth.onAuthStateChange((_event, session) => showAdminSession(session));
  subscribe();
}
