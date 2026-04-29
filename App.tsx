import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import {
  SpaceGrotesk_400Regular,
  SpaceGrotesk_500Medium,
  SpaceGrotesk_600SemiBold,
  useFonts
} from "@expo-google-fonts/space-grotesk";

import {
  QUESTION_SECTIONS,
  QUESTIONS_PER_SECTION
} from "./src/data/questionBank";
import { extractSignals, pickNextQuestion } from "./src/engine/questionEngine";
import {
  appendAnswer,
  flushPending,
  flushPendingSessions,
  loadAnswers,
  loadProgress,
  queuePending,
  queuePendingSession,
  resetAll,
  saveProgress
} from "./src/services/persistence";
import {
  createPairing,
  createSession,
  fetchAdminUserQuestions,
  fetchAdminUsers,
  isApiConfigured,
  postAnswer
} from "./src/services/api";
import {
  AdminQuestionSummary,
  AdminUserSummary,
  AnswerRecord,
  ProgressState
} from "./src/types";

type Stage = "name" | "resume" | "questions" | "recap" | "admin";

const TOTAL_QUESTIONS = QUESTIONS_PER_SECTION * QUESTION_SECTIONS.length;

const createId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;

const formatDuration = (ms: number) => {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours > 0) {
    return `${hours} h ${remainingMinutes} min`;
  }
  return `${remainingMinutes} min`;
};

const formatDate = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString();
};

export default function App() {
  const [fontsLoaded] = useFonts({
    SpaceGrotesk_400Regular,
    SpaceGrotesk_500Medium,
    SpaceGrotesk_600SemiBold
  });

  const [stage, setStage] = useState<Stage>("name");
  const [personName, setPersonName] = useState("");
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [answers, setAnswers] = useState<AnswerRecord[]>([]);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [freeText, setFreeText] = useState("");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [adminUsers, setAdminUsers] = useState<AdminUserSummary[]>([]);
  const [adminQuestions, setAdminQuestions] = useState<AdminQuestionSummary[]>(
    []
  );
  const [adminSelectedUserId, setAdminSelectedUserId] = useState<string | null>(
    null
  );
  const [pairSelection, setPairSelection] = useState<string[]>([]);
  const [adminStatus, setAdminStatus] = useState<string | null>(null);
  const [adminBusy, setAdminBusy] = useState(false);

  const transition = useRef(new Animated.Value(0)).current;
  const lastQuestionId = useRef<string | null>(null);

  const sectionIndex = progress?.section_index ?? 0;
  const questionIndex = progress?.question_index ?? 0;

  useEffect(() => {
    transition.setValue(0);
    Animated.timing(transition, {
      toValue: 1,
      duration: 350,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true
    }).start();
  }, [stage, sectionIndex, questionIndex, transition]);

  useEffect(() => {
    let isMounted = true;

    const init = async () => {
      const [storedAnswers, storedProgress] = await Promise.all([
        loadAnswers(),
        loadProgress()
      ]);

      if (!isMounted) {
        return;
      }

      if (storedAnswers.length > 0) {
        setAnswers(storedAnswers);
      }

      if (storedProgress?.person_name) {
        setPersonName(storedProgress.person_name);
      }

      if (storedProgress) {
        setProgress(storedProgress);
      }

      if (storedProgress?.section_index >= QUESTION_SECTIONS.length) {
        setStage("recap");
      } else if (storedProgress?.person_name) {
        setStage("resume");
      }

      if (isApiConfigured()) {
        await flushPendingSessions(createSession);
        await flushPending(postAnswer);
      }

      setIsLoading(false);
    };

    init();

    return () => {
      isMounted = false;
    };
  }, []);

  const signals = useMemo(() => extractSignals(answers), [answers]);
  const currentSection =
    stage === "questions" ? QUESTION_SECTIONS[sectionIndex] : null;

  const currentQuestion = useMemo(() => {
    if (!currentSection) {
      return null;
    }

    const askedIds = new Set(
      answers
        .filter((answer) => answer.section_id === currentSection.id)
        .map((answer) => answer.question_id)
    );

    return pickNextQuestion(currentSection, askedIds, signals);
  }, [answers, currentSection, signals]);

  useEffect(() => {
    if (stage !== "questions" || !currentQuestion || !progress) {
      return;
    }

    if (lastQuestionId.current === currentQuestion.id) {
      return;
    }

    lastQuestionId.current = currentQuestion.id;
    const now = new Date().toISOString();
    const updated = { ...progress, question_started_at: now };
    setProgress(updated);
    saveProgress(updated);
  }, [currentQuestion, progress, stage]);

  const answeredCount = useMemo(
    () => answers.filter((answer) => !answer.skipped).length,
    [answers]
  );
  const attemptedCount = answers.length;
  const progressCount = Math.min(attemptedCount + 1, TOTAL_QUESTIONS);
  const progressValue = Math.min(attemptedCount / TOTAL_QUESTIONS, 1);

  const questionTextById = useMemo(() => {
    const map = new Map<string, string>();
    for (const section of QUESTION_SECTIONS) {
      for (const question of section.pool) {
        map.set(question.id, question.text);
      }
    }
    return map;
  }, []);

  const localAdminUsers = useMemo(() => {
    if (!progress?.user_id) {
      return [] as AdminUserSummary[];
    }
    return [
      {
        user_id: progress.user_id,
        name: progress.person_name,
        answered_count: answeredCount,
        last_session_id: progress.session_id
      }
    ];
  }, [answeredCount, progress]);

  const handleStart = async () => {
    const trimmedName = personName.trim();
    if (!trimmedName) {
      setErrorText("Merci de saisir un nom pour demarrer.");
      return;
    }

    const now = new Date().toISOString();
    const userId = createId("user");
    const sessionId = createId("session");
    const nextProgress: ProgressState = {
      user_id: userId,
      person_name: trimmedName,
      session_id: sessionId,
      started_at: now,
      question_started_at: now,
      total_active_ms: 0,
      section_index: 0,
      question_index: 0,
      answered_count: 0
    };

    setErrorText(null);
    setAnswers([]);
    setSelectedOption(null);
    setFreeText("");
    setProgress(nextProgress);
    setStage("questions");

    await resetAll();
    await saveProgress(nextProgress);

    if (isApiConfigured()) {
      const sessionPayload = {
        user_id: userId,
        person_name: trimmedName,
        session_id: sessionId,
        started_at: now
      };
      const response = await createSession(sessionPayload);
      if (!response) {
        await queuePendingSession(sessionPayload);
      }
    }
  };

  const handleResume = async () => {
    if (!progress) {
      return;
    }
    const now = new Date().toISOString();
    const updated = { ...progress, question_started_at: now };
    setProgress(updated);
    await saveProgress(updated);
    setStage("questions");
  };

  const handleSubmit = async (skipped: boolean) => {
    if (!currentQuestion || !currentSection || !progress) {
      return;
    }

    const trimmedFreeText = freeText.trim();
    const selected = selectedOption;

    if (!skipped && !selected && !trimmedFreeText) {
      setErrorText("Selectionnez une option ou ajoutez un texte.");
      return;
    }

    setErrorText(null);

    const now = new Date();
    const startedAt = Date.parse(progress.question_started_at);
    const activeDelta = Number.isNaN(startedAt)
      ? 0
      : Math.max(0, now.getTime() - startedAt);
    const totalActiveMs = progress.total_active_ms + activeDelta;

    const responseText = skipped
      ? ""
      : [selected, trimmedFreeText].filter(Boolean).join(" | ");

    const record: AnswerRecord = {
      reponse_id: createId("rep"),
      user_id: progress.user_id,
      session_id: progress.session_id,
      section_id: currentSection.id,
      question_id: currentQuestion.id,
      question_text: currentQuestion.text,
      selected_option: skipped ? null : selected,
      free_text: skipped ? "" : trimmedFreeText,
      reponse: responseText,
      timestamp: now.toISOString(),
      skipped,
      total_active_ms: totalActiveMs
    };

    setSelectedOption(null);
    setFreeText("");
    setAnswers((prev) => [...prev, record]);

    await appendAnswer(record);

    if (isApiConfigured()) {
      await flushPendingSessions(createSession);
      const ok = await postAnswer(record);
      if (!ok) {
        await queuePending(record);
      }
      await flushPending(postAnswer);
    }

    let nextSectionIndex = progress.section_index;
    let nextQuestionIndex = progress.question_index + 1;
    let nextStage: Stage = "questions";

    if (nextQuestionIndex >= QUESTIONS_PER_SECTION) {
      nextQuestionIndex = 0;
      nextSectionIndex += 1;
    }

    if (nextSectionIndex >= QUESTION_SECTIONS.length) {
      nextStage = "recap";
    }

    const nextProgress: ProgressState = {
      ...progress,
      total_active_ms: totalActiveMs,
      section_index: nextStage === "recap" ? QUESTION_SECTIONS.length : nextSectionIndex,
      question_index: nextStage === "recap" ? 0 : nextQuestionIndex,
      answered_count: progress.answered_count + (skipped ? 0 : 1),
      question_started_at: now.toISOString()
    };

    setProgress(nextProgress);
    await saveProgress(nextProgress);

    setStage(nextStage);
  };

  const handleReset = async () => {
    await resetAll();
    setStage("name");
    setAnswers([]);
    setProgress(null);
    setPersonName("");
    setSelectedOption(null);
    setFreeText("");
    setErrorText(null);
  };

  const loadAdminUsers = async () => {
    setAdminStatus(null);
    if (!isApiConfigured()) {
      setAdminUsers([]);
      return;
    }
    setAdminBusy(true);
    const response = await fetchAdminUsers();
    setAdminUsers(response ?? []);
    setAdminBusy(false);
  };

  const handleOpenAdmin = async () => {
    setStage("admin");
    setAdminQuestions([]);
    setAdminSelectedUserId(null);
    setPairSelection([]);
    await loadAdminUsers();
  };

  const handleSelectAdminUser = async (userId: string) => {
    setAdminSelectedUserId(userId);
    setAdminQuestions([]);
    setAdminStatus(null);

    if (!isApiConfigured()) {
      const localQuestions = answers
        .filter((answer) => answer.user_id === userId)
        .map((answer) => ({
          question_id: answer.question_id,
          question_text: answer.question_text
        }));
      setAdminQuestions(localQuestions);
      return;
    }

    setAdminBusy(true);
    const response = await fetchAdminUserQuestions(userId);
    setAdminQuestions(response ?? []);
    setAdminBusy(false);
  };

  const togglePairSelection = (userId: string) => {
    setPairSelection((prev) => {
      if (prev.includes(userId)) {
        return prev.filter((id) => id !== userId);
      }
      if (prev.length >= 2) {
        return [prev[1], userId];
      }
      return [...prev, userId];
    });
  };

  const handleCreatePairing = async () => {
    if (pairSelection.length !== 2) {
      setAdminStatus("Selectionnez deux personnes pour creer le duo.");
      return;
    }
    if (!isApiConfigured()) {
      setAdminStatus("Connectez l API pour creer un duo.");
      return;
    }
    setAdminBusy(true);
    const response = await createPairing({
      user_id_a: pairSelection[0],
      user_id_b: pairSelection[1],
      session_id: null
    });
    setAdminStatus(response ? "Duo cree." : "Echec de creation du duo.");
    setAdminBusy(false);
  };

  if (!fontsLoaded || isLoading) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <LinearGradient colors={["#f7f4ef", "#e8f0f5"]} style={styles.bg}>
          <View style={styles.center}>
            <Text style={styles.loadingText}>Chargement...</Text>
          </View>
        </LinearGradient>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <LinearGradient colors={["#f7f4ef", "#e8f0f5"]} style={styles.bg}>
        <View style={styles.glowWarm} />
        <View style={styles.glowCool} />
        <KeyboardAvoidingView
          style={styles.container}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView
            contentContainerStyle={styles.scroll}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.header}>
              <View style={styles.brandRow}>
                <View>
                  <Text style={styles.brand}>RD Reponses</Text>
                  <Text style={styles.subtitle}>
                    Questionnaire dynamique pour mieux connaitre votre duo.
                  </Text>
                </View>
                <Pressable style={styles.adminButton} onPress={handleOpenAdmin}>
                  <Text style={styles.adminButtonText}>Admin</Text>
                </Pressable>
              </View>
            </View>

            <Animated.View
              style={{
                opacity: transition,
                transform: [
                  {
                    translateY: transition.interpolate({
                      inputRange: [0, 1],
                      outputRange: [12, 0]
                    })
                  }
                ]
              }}
            >
              {stage === "name" && (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Votre nom</Text>
                  <Text style={styles.cardBody}>
                    Ce nom est utilise pour associer chaque reponse.
                  </Text>
                  <TextInput
                    placeholder="Nom et prenom"
                    placeholderTextColor="#6b7280"
                    value={personName}
                    onChangeText={setPersonName}
                    style={styles.input}
                  />
                  {errorText ? (
                    <Text style={styles.errorText}>{errorText}</Text>
                  ) : null}
                  <View style={styles.buttonRow}>
                    <Pressable style={styles.primaryButton} onPress={handleStart}>
                      <Text style={styles.primaryButtonText}>Commencer</Text>
                    </Pressable>
                  </View>
                </View>
              )}

              {stage === "resume" && progress && (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Reprendre</Text>
                  <Text style={styles.cardBody}>
                    Connecte en tant que {progress.person_name}.
                  </Text>
                  <View style={styles.statRow}>
                    <View style={styles.statCard}>
                      <Text style={styles.statLabel}>Reponses</Text>
                      <Text style={styles.statValue}>{answeredCount}</Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text style={styles.statLabel}>Debut</Text>
                      <Text style={styles.statValue}>
                        {formatDate(progress.started_at)}
                      </Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text style={styles.statLabel}>Temps passe</Text>
                      <Text style={styles.statValue}>
                        {formatDuration(progress.total_active_ms)}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.buttonRow}>
                    <Pressable style={styles.secondaryButton} onPress={handleReset}>
                      <Text style={styles.secondaryButtonText}>Nouvelle session</Text>
                    </Pressable>
                    <Pressable style={styles.primaryButton} onPress={handleResume}>
                      <Text style={styles.primaryButtonText}>Reprendre</Text>
                    </Pressable>
                  </View>
                </View>
              )}

              {stage === "questions" && currentSection && currentQuestion && (
                <View style={styles.card}>
                  <View style={styles.sectionRow}>
                    <Text style={styles.sectionTag}>
                      Volet {sectionIndex + 1} / {QUESTION_SECTIONS.length}
                    </Text>
                    <Text style={styles.progressTag}>
                      Question {progressCount} / {TOTAL_QUESTIONS}
                    </Text>
                  </View>

                  <View style={styles.progressTrack}>
                    <Animated.View
                      style={[
                        styles.progressFill,
                        {
                          width: `${progressValue * 100}%`
                        }
                      ]}
                    />
                  </View>

                  <Text style={styles.sectionTitle}>{currentSection.title}</Text>
                  <Text style={styles.questionText}>{currentQuestion.text}</Text>

                  <Text style={styles.optionTitle}>Choisissez une option</Text>
                  <View style={styles.optionGrid}>
                    {currentQuestion.options.map((option) => {
                      const selected = option === selectedOption;
                      return (
                        <Pressable
                          key={option}
                          style={[
                            styles.optionChip,
                            selected ? styles.optionChipSelected : null
                          ]}
                          onPress={() => setSelectedOption(option)}
                        >
                          <Text
                            style={
                              selected
                                ? styles.optionTextSelected
                                : styles.optionText
                            }
                          >
                            {option}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>

                  <Text style={styles.optionHint}>
                    Vous pouvez ajouter un texte libre (200 caracteres).
                  </Text>

                  <TextInput
                    placeholder="Votre reponse libre..."
                    placeholderTextColor="#6b7280"
                    value={freeText}
                    onChangeText={setFreeText}
                    multiline
                    maxLength={200}
                    style={[styles.input, styles.inputTall]}
                  />
                  <Text style={styles.counterText}>{freeText.length} / 200</Text>

                  {errorText ? (
                    <Text style={styles.errorText}>{errorText}</Text>
                  ) : null}

                  <View style={styles.buttonRow}>
                    <Pressable
                      style={styles.secondaryButton}
                      onPress={() => handleSubmit(true)}
                    >
                      <Text style={styles.secondaryButtonText}>Passer</Text>
                    </Pressable>
                    <Pressable
                      style={styles.primaryButton}
                      onPress={() => handleSubmit(false)}
                    >
                      <Text style={styles.primaryButtonText}>Suivant</Text>
                    </Pressable>
                  </View>
                </View>
              )}

              {stage === "recap" && progress && (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Resume final</Text>
                  <Text style={styles.cardBody}>
                    Session de {progress.person_name} terminee.
                  </Text>
                  <View style={styles.statRow}>
                    <View style={styles.statCard}>
                      <Text style={styles.statLabel}>Reponses</Text>
                      <Text style={styles.statValue}>{answeredCount}</Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text style={styles.statLabel}>Debut</Text>
                      <Text style={styles.statValue}>
                        {formatDate(progress.started_at)}
                      </Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text style={styles.statLabel}>Temps passe</Text>
                      <Text style={styles.statValue}>
                        {formatDuration(progress.total_active_ms)}
                      </Text>
                    </View>
                  </View>

                  <Text style={styles.sectionTitle}>Toutes les reponses</Text>
                  <View style={styles.recapList}>
                    {answers.map((answer, index) => (
                      <View key={`${answer.reponse_id}-${index}`} style={styles.recapItem}>
                        <Text style={styles.recapQuestion}>
                          {index + 1}. {answer.question_text}
                        </Text>
                        {answer.skipped ? (
                          <Text style={styles.recapAnswer}>Passe</Text>
                        ) : (
                          <Text style={styles.recapAnswer}>
                            {(answer.selected_option || "") +
                              (answer.free_text
                                ? ` | ${answer.free_text}`
                                : "")}
                          </Text>
                        )}
                      </View>
                    ))}
                  </View>

                  <View style={styles.buttonRow}>
                    <Pressable style={styles.secondaryButton} onPress={handleOpenAdmin}>
                      <Text style={styles.secondaryButtonText}>Admin</Text>
                    </Pressable>
                    <Pressable style={styles.primaryButton} onPress={handleReset}>
                      <Text style={styles.primaryButtonText}>Nouvelle session</Text>
                    </Pressable>
                  </View>
                </View>
              )}

              {stage === "admin" && (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Espace admin</Text>
                  {!isApiConfigured() ? (
                    <Text style={styles.cardBody}>
                      Connectez l API pour acceder aux donnees globales.
                    </Text>
                  ) : null}
                  {adminStatus ? (
                    <Text style={styles.infoText}>{adminStatus}</Text>
                  ) : null}

                  <Text style={styles.sectionTitle}>Personnes</Text>
                  <Text style={styles.cardBody}>
                    Appui long sur une personne pour voir les questions repondues.
                  </Text>
                  {(isApiConfigured() ? adminUsers : localAdminUsers).map((user) => {
                    const isSelected = pairSelection.includes(user.user_id);
                    return (
                      <Pressable
                        key={user.user_id}
                        style={[
                          styles.adminRow,
                          isSelected ? styles.adminRowSelected : null
                        ]}
                        onPress={() => togglePairSelection(user.user_id)}
                        onLongPress={() => handleSelectAdminUser(user.user_id)}
                      >
                        <View>
                          <Text style={styles.adminName}>{user.name}</Text>
                          <Text style={styles.adminMeta}>
                            Reponses: {user.answered_count}
                          </Text>
                        </View>
                        <Text style={styles.adminTag}>Choisir</Text>
                      </Pressable>
                    );
                  })}

                  <View style={styles.buttonRow}>
                    <Pressable
                      style={styles.secondaryButton}
                      onPress={handleCreatePairing}
                      disabled={adminBusy}
                    >
                      <Text style={styles.secondaryButtonText}>Creer duo</Text>
                    </Pressable>
                    <Pressable
                      style={styles.primaryButton}
                      onPress={() => setStage(progress ? "resume" : "name")}
                    >
                      <Text style={styles.primaryButtonText}>Retour</Text>
                    </Pressable>
                  </View>

                  {adminSelectedUserId ? (
                    <View style={styles.adminQuestions}>
                      <Text style={styles.sectionTitle}>Questions repondues</Text>
                      {adminQuestions.length === 0 ? (
                        <Text style={styles.cardBody}>Aucune question.</Text>
                      ) : (
                        adminQuestions.map((question, index) => {
                          const label =
                            question.question_text ||
                            questionTextById.get(question.question_id) ||
                            question.question_id;
                          return (
                            <Text key={`${question.question_id}-${index}`} style={styles.recapQuestion}>
                              {index + 1}. {label}
                            </Text>
                          );
                        })
                      )}
                    </View>
                  ) : null}
                </View>
              )}
            </Animated.View>
          </ScrollView>
        </KeyboardAvoidingView>
      </LinearGradient>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#f5f1e8"
  },
  bg: {
    flex: 1
  },
  container: {
    flex: 1
  },
  scroll: {
    paddingHorizontal: 20,
    paddingBottom: 32
  },
  header: {
    paddingTop: 12,
    paddingBottom: 16
  },
  brandRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start"
  },
  brand: {
    fontFamily: "SpaceGrotesk_600SemiBold",
    fontSize: 28,
    color: "#1b1c1a"
  },
  subtitle: {
    fontFamily: "SpaceGrotesk_400Regular",
    fontSize: 14,
    color: "#4f5b54",
    marginTop: 6
  },
  adminButton: {
    backgroundColor: "rgba(31, 92, 76, 0.12)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999
  },
  adminButtonText: {
    fontFamily: "SpaceGrotesk_600SemiBold",
    fontSize: 12,
    color: "#1f5c4c",
    textTransform: "uppercase",
    letterSpacing: 0.6
  },
  card: {
    backgroundColor: "rgba(255, 255, 255, 0.94)",
    borderRadius: 20,
    padding: 20,
    shadowColor: "#1b1c1a",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.14,
    shadowRadius: 24,
    elevation: 6
  },
  cardTitle: {
    fontFamily: "SpaceGrotesk_600SemiBold",
    fontSize: 20,
    color: "#1b1c1a",
    marginBottom: 8
  },
  cardBody: {
    fontFamily: "SpaceGrotesk_400Regular",
    fontSize: 14,
    color: "#4f5b54",
    marginBottom: 16,
    lineHeight: 20
  },
  sectionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 12
  },
  sectionTag: {
    fontFamily: "SpaceGrotesk_500Medium",
    fontSize: 12,
    color: "#1b1c1a",
    textTransform: "uppercase",
    letterSpacing: 0.8
  },
  progressTag: {
    fontFamily: "SpaceGrotesk_500Medium",
    fontSize: 12,
    color: "#4f5b54"
  },
  progressTrack: {
    height: 6,
    borderRadius: 999,
    backgroundColor: "#e6ded4",
    marginBottom: 16,
    overflow: "hidden"
  },
  progressFill: {
    height: 6,
    borderRadius: 999,
    backgroundColor: "#1f5c4c"
  },
  sectionTitle: {
    fontFamily: "SpaceGrotesk_600SemiBold",
    fontSize: 18,
    color: "#1b1c1a",
    marginBottom: 8
  },
  questionText: {
    fontFamily: "SpaceGrotesk_400Regular",
    fontSize: 16,
    color: "#1b1c1a",
    marginBottom: 12,
    lineHeight: 22
  },
  optionTitle: {
    fontFamily: "SpaceGrotesk_500Medium",
    fontSize: 13,
    color: "#4f5b54",
    marginBottom: 10
  },
  optionGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 10
  },
  optionChip: {
    borderWidth: 1,
    borderColor: "#e2d9cd",
    backgroundColor: "#f8f4ef",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 999
  },
  optionChipSelected: {
    borderColor: "#1f5c4c",
    backgroundColor: "rgba(31, 92, 76, 0.12)"
  },
  optionText: {
    fontFamily: "SpaceGrotesk_500Medium",
    fontSize: 12,
    color: "#3f4b46"
  },
  optionTextSelected: {
    fontFamily: "SpaceGrotesk_600SemiBold",
    fontSize: 12,
    color: "#1f5c4c"
  },
  optionHint: {
    fontFamily: "SpaceGrotesk_400Regular",
    fontSize: 12,
    color: "#6b6f66",
    marginBottom: 6
  },
  input: {
    borderWidth: 1,
    borderColor: "#e2d9cd",
    backgroundColor: "#f9f6f2",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontFamily: "SpaceGrotesk_400Regular",
    fontSize: 15,
    color: "#1b1c1a"
  },
  inputTall: {
    minHeight: 120,
    textAlignVertical: "top"
  },
  counterText: {
    fontFamily: "SpaceGrotesk_400Regular",
    fontSize: 12,
    color: "#6b6f66",
    textAlign: "right",
    marginTop: 6
  },
  errorText: {
    fontFamily: "SpaceGrotesk_400Regular",
    color: "#8b3b2e",
    marginTop: 8,
    marginBottom: 8
  },
  infoText: {
    fontFamily: "SpaceGrotesk_400Regular",
    color: "#1f5c4c",
    marginBottom: 8
  },
  buttonRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 12,
    marginTop: 16
  },
  primaryButton: {
    backgroundColor: "#1f5c4c",
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 999,
    shadowColor: "#1f5c4c",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.28,
    shadowRadius: 12,
    elevation: 4
  },
  primaryButtonText: {
    fontFamily: "SpaceGrotesk_600SemiBold",
    color: "#ffffff",
    fontSize: 14
  },
  secondaryButton: {
    backgroundColor: "#eadfd4",
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 999
  },
  secondaryButtonText: {
    fontFamily: "SpaceGrotesk_500Medium",
    color: "#4f3d2f",
    fontSize: 14
  },
  loadingText: {
    fontFamily: "SpaceGrotesk_500Medium",
    fontSize: 16,
    color: "#4f5b54"
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center"
  },
  glowWarm: {
    position: "absolute",
    width: 260,
    height: 260,
    borderRadius: 260,
    backgroundColor: "rgba(196, 156, 120, 0.35)",
    top: -80,
    right: -60
  },
  glowCool: {
    position: "absolute",
    width: 300,
    height: 300,
    borderRadius: 300,
    backgroundColor: "rgba(166, 198, 175, 0.4)",
    bottom: -120,
    left: -80
  },
  statRow: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 16
  },
  statCard: {
    flex: 1,
    padding: 12,
    backgroundColor: "#f8f4ef",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e2d9cd"
  },
  statLabel: {
    fontFamily: "SpaceGrotesk_500Medium",
    fontSize: 11,
    color: "#6b6f66",
    textTransform: "uppercase",
    letterSpacing: 0.6
  },
  statValue: {
    fontFamily: "SpaceGrotesk_600SemiBold",
    fontSize: 14,
    color: "#1b1c1a",
    marginTop: 4
  },
  recapList: {
    marginTop: 8
  },
  recapItem: {
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#eee6dc"
  },
  recapQuestion: {
    fontFamily: "SpaceGrotesk_500Medium",
    fontSize: 13,
    color: "#1b1c1a"
  },
  recapAnswer: {
    fontFamily: "SpaceGrotesk_400Regular",
    fontSize: 13,
    color: "#4f5b54",
    marginTop: 4
  },
  adminRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#e2d9cd",
    backgroundColor: "#f9f6f2",
    marginBottom: 10
  },
  adminRowSelected: {
    borderColor: "#1f5c4c",
    backgroundColor: "rgba(31, 92, 76, 0.12)"
  },
  adminName: {
    fontFamily: "SpaceGrotesk_600SemiBold",
    fontSize: 14,
    color: "#1b1c1a"
  },
  adminMeta: {
    fontFamily: "SpaceGrotesk_400Regular",
    fontSize: 12,
    color: "#6b6f66",
    marginTop: 4
  },
  adminTag: {
    fontFamily: "SpaceGrotesk_500Medium",
    fontSize: 12,
    color: "#1f5c4c"
  },
  adminQuestions: {
    marginTop: 16
  }
});
