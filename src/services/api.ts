import {
  AdminQuestionSummary,
  AdminUserSummary,
  AnswerRecord,
  SessionPayload
} from "../types";

const API_BASE_URL = (process.env.EXPO_PUBLIC_API_BASE_URL || "").trim();

export const isApiConfigured = () => API_BASE_URL.length > 0;

const request = async <T,>(path: string, options?: RequestInit) => {
  if (!isApiConfigured()) {
    return null;
  }

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, options);
    if (!response.ok) {
      return null;
    }
    if (response.status === 204) {
      return null as T;
    }
    return (await response.json()) as T;
  } catch {
    return null;
  }
};

export const postAnswer = async (answer: AnswerRecord) => {
  const response = await request<{ ok: boolean }>("/answers", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(answer)
  });

  return Boolean(response);
};

export const createSession = async (payload: SessionPayload) => {
  return request<{ session_id: string }>("/sessions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
};

export const fetchSession = async (sessionId: string) =>
  request<{ session_id: string; user_id: string; started_at: string }>(
    `/sessions/${sessionId}`
  );

export const fetchProgress = async (sessionId: string) =>
  request<{ answered_count: number; total_active_ms: number }>(
    `/progress?session_id=${encodeURIComponent(sessionId)}`
  );

export const fetchRecap = async (sessionId: string) =>
  request<{ answers: AnswerRecord[] }>(
    `/recap?session_id=${encodeURIComponent(sessionId)}`
  );

export const fetchAdminUsers = async () =>
  request<AdminUserSummary[]>("/admin/users");

export const fetchAdminUserQuestions = async (userId: string) =>
  request<AdminQuestionSummary[]>(`/admin/users/${userId}/questions`);

export const createPairing = async (payload: {
  user_id_a: string;
  user_id_b: string;
  session_id?: string | null;
}) =>
  request<{ pairing_id: string }>("/admin/pairings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
