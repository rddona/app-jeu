export type QuestionInstance = {
  id: string;
  text: string;
  sectionId: string;
  options: string[];
};

export type AnswerRecord = {
  reponse_id: string;
  user_id: string;
  session_id: string;
  section_id: string;
  question_id: string;
  question_text: string;
  selected_option: string | null;
  free_text: string;
  reponse: string;
  timestamp: string;
  skipped: boolean;
  total_active_ms?: number;
};

export type ProgressState = {
  user_id: string;
  person_name: string;
  session_id: string;
  started_at: string;
  question_started_at: string;
  total_active_ms: number;
  section_index: number;
  question_index: number;
  answered_count: number;
};

export type SessionPayload = {
  user_id: string;
  person_name: string;
  session_id: string;
  started_at: string;
  total_active_ms?: number;
};

export type AdminUserSummary = {
  user_id: string;
  name: string;
  answered_count: number;
  last_session_id?: string | null;
};

export type AdminQuestionSummary = {
  question_id: string;
  question_text?: string | null;
};
