import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Dumbbell,
  Minus,
  Pin,
  Plus,
  Trash2,
  TrendingDown,
  TrendingUp,
  User,
  X,
} from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase, supabaseConfigured } from "@/lib/supabase";
import type { User as SupabaseUser } from "@supabase/supabase-js";

const STORAGE_KEY_SNAPSHOT = "gradienttrack_snapshot_v2";
const STORAGE_KEY_CLOUD_OPT_IN = "gradienttrack_cloud_opt_in";

const LEGACY_STORAGE_KEY_CURRENT = "gradienttrack_current";
const LEGACY_STORAGE_KEY_HISTORY = "gradienttrack_history";
const LEGACY_STORAGE_KEY_UNITS = "gradienttrack_units";
const LEGACY_STORAGE_KEY_JOIN_DATE = "gradienttrack_join_date";
const LEGACY_STORAGE_KEY_EXERCISE_CATALOG = "gradienttrack_exercise_catalog";
const LEGACY_STORAGE_KEY_BACKFILL = "gradienttrack_backfill_sessions";

type Tab = "exercises" | "profile";
type Units = "lbs" | "kg";
type Trend = "up" | "flat" | "down";
type PlotMode = "data" | "trend";
type SetTag = "easy" | "grindy" | "paused" | "straps";
type ExerciseGroup = "Chest" | "Back" | "Legs" | "Shoulders" | "Arms" | "Core" | "Other";

type LoggedSet = {
  id: string;
  date: string;
  weight: number;
  reps: number;
  sessionId?: string;
  tag?: SetTag;
  note?: string;
};

type ExerciseRecord = {
  id: string;
  key: string;
  name: string;
  group: ExerciseGroup;
  entries: LoggedSet[];
};

type AppSnapshot = {
  exercises: ExerciseRecord[];
  favoriteExerciseKeys: string[];
  favoritesUpdatedAt: number;
  units: Units;
  joinDate: string;
};

type PendingSet = {
  id: string;
  createdAt: string;
  weight: number;
  reps: number;
  tag?: SetTag;
  note?: string;
};

type ExerciseDraft = {
  weight: string;
  reps: string;
  tag: SetTag | "";
  note: string;
  sessionId: string;
  pendingSets: PendingSet[];
};

type DayGroup = {
  dayKey: string;
  label: string;
  entries: LoggedSet[];
};

type LegacyWorkout = {
  id?: string;
  date: string;
  exercises?: Array<{
    id?: string;
    name: string;
    sets?: Array<{ id?: string; weight: number; reps: number }>;
  }>;
};

type LegacyBackfill = {
  id?: string;
  date: string;
  exerciseName: string;
  sets?: Array<{ id?: string; weight: number; reps: number }>;
};

const commonExercises = [
  "Bench Press",
  "Incline Bench Press",
  "Decline Bench Press",
  "Dumbbell Bench Press",
  "Squat",
  "Front Squat",
  "Goblet Squat",
  "Leg Press",
  "Deadlift",
  "Romanian Deadlift",
  "Sumo Deadlift",
  "Overhead Press",
  "Arnold Press",
  "Barbell Row",
  "Dumbbell Row",
  "Pull-Up",
  "Lat Pulldown",
  "Bicep Curl",
  "Hammer Curl",
  "Tricep Extension",
  "Lateral Raise",
  "Face Pull",
  "Calf Raise",
];

const exerciseGroups: ExerciseGroup[] = ["Chest", "Back", "Legs", "Shoulders", "Arms", "Core", "Other"];

const shellClass =
  "rounded-[1.75rem] border border-green-500/10 bg-[linear-gradient(180deg,rgba(7,12,10,0.98),rgba(3,7,6,1))] shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]";
const subtlePanelClass =
  "rounded-2xl border border-green-500/10 bg-green-500/[0.03] shadow-[inset_0_1px_0_rgba(255,255,255,0.015)]";

function normalizeExerciseName(name: string) {
  return name.trim().toLowerCase();
}

function inferExerciseGroup(name: string): ExerciseGroup {
  const value = normalizeExerciseName(name);
  if (/(bench|chest|fly|push-up|dip)/.test(value)) return "Chest";
  if (/(row|pull|pulldown|lat|deadlift|back)/.test(value)) return "Back";
  if (/(squat|leg|calf|lunge|deadlift|hamstring|quad)/.test(value)) return "Legs";
  if (/(press|raise|shoulder|delt|arnold)/.test(value)) return "Shoulders";
  if (/(curl|tricep|bicep|extension)/.test(value)) return "Arms";
  if (/(core|ab|plank|crunch)/.test(value)) return "Core";
  return "Other";
}

function triggerHaptic() {
  if (typeof navigator !== "undefined" && "vibrate" in navigator) {
    navigator.vibrate(10);
  }
}

function formatShortDate(date: string) {
  return new Date(date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatAxisDate(date: string) {
  return new Date(date).toLocaleDateString(undefined, {
    month: "short",
    year: "2-digit",
  });
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function sortEntries(entries: LoggedSet[]) {
  return [...entries].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

function sortExercises(exercises: ExerciseRecord[]) {
  return [...exercises].sort((a, b) => {
    const latestA = a.entries[a.entries.length - 1]?.date ?? "";
    const latestB = b.entries[b.entries.length - 1]?.date ?? "";
    if (latestA !== latestB) return latestB.localeCompare(latestA);
    return a.name.localeCompare(b.name);
  });
}

function createEmptySnapshot(units: Units = "lbs", joinDate = new Date().toISOString()): AppSnapshot {
  return {
    exercises: [],
    favoriteExerciseKeys: [],
    favoritesUpdatedAt: 0,
    units,
    joinDate,
  };
}

function toSnapshot(payload: unknown): AppSnapshot {
  if (!payload || typeof payload !== "object") {
    return createEmptySnapshot();
  }

  const candidate = payload as Partial<AppSnapshot> & {
    currentWorkout?: LegacyWorkout | null;
    history?: LegacyWorkout[];
    exerciseCatalog?: string[];
    backfillSessions?: LegacyBackfill[];
  };

  if (Array.isArray(candidate.exercises)) {
    const exercises = candidate.exercises
      .map((exercise) => {
        const name = typeof exercise.name === "string" ? exercise.name.trim() : "";
        const key = name ? normalizeExerciseName(name) : "";
        if (!name || !key) return null;

        const entries = Array.isArray(exercise.entries)
          ? exercise.entries
              .filter(
                (entry): entry is LoggedSet =>
                  Boolean(
                    entry &&
                      typeof entry.id === "string" &&
                      typeof entry.date === "string" &&
                      typeof entry.weight === "number" &&
                      typeof entry.reps === "number",
                  ),
              )
              .filter((entry) => entry.weight > 0 && entry.reps > 0)
          : [];

        return {
          id: typeof exercise.id === "string" ? exercise.id : uuidv4(),
          key,
          name,
          group:
            typeof exercise.group === "string" && exerciseGroups.includes(exercise.group as ExerciseGroup)
              ? (exercise.group as ExerciseGroup)
              : inferExerciseGroup(name),
          entries: sortEntries(entries),
        } satisfies ExerciseRecord;
      })
      .filter((exercise): exercise is ExerciseRecord => Boolean(exercise));

    return {
      exercises: sortExercises(exercises),
      favoriteExerciseKeys: Array.isArray(candidate.favoriteExerciseKeys)
        ? candidate.favoriteExerciseKeys.filter((item): item is string => typeof item === "string")
        : [],
      favoritesUpdatedAt:
        typeof candidate.favoritesUpdatedAt === "number" ? candidate.favoritesUpdatedAt : 0,
      units: candidate.units === "kg" ? "kg" : "lbs",
      joinDate: typeof candidate.joinDate === "string" ? candidate.joinDate : new Date().toISOString(),
    };
  }

  return migrateLegacyPayload(candidate);
}

function migrateLegacyPayload(payload: {
  currentWorkout?: LegacyWorkout | null;
  history?: LegacyWorkout[];
  exerciseCatalog?: string[];
  backfillSessions?: LegacyBackfill[];
  units?: string;
  joinDate?: string;
}): AppSnapshot {
  const map = new Map<string, ExerciseRecord>();

  const ensureExercise = (name: string) => {
    const cleanName = name.trim();
    const key = normalizeExerciseName(cleanName);
    if (!cleanName || !key) return null;
    const existing = map.get(key);
    if (existing) return existing;
    const created: ExerciseRecord = {
      id: uuidv4(),
      key,
      name: cleanName,
      group: inferExerciseGroup(cleanName),
      entries: [],
    };
    map.set(key, created);
    return created;
  };

  const addEntry = (name: string, date: string, weight: number, reps: number, id?: string) => {
    if (weight <= 0 || reps <= 0 || !date) return;
    const exercise = ensureExercise(name);
    if (!exercise) return;
    exercise.entries.push({
      id: id ?? uuidv4(),
      date,
      weight,
      reps,
    });
  };

  const workouts = [
    ...(Array.isArray(payload.history) ? payload.history : []),
    ...(payload.currentWorkout ? [payload.currentWorkout] : []),
  ];

  workouts.forEach((workout) => {
    workout.exercises?.forEach((exercise) => {
      exercise.sets?.forEach((set) => {
        addEntry(exercise.name, workout.date, Number(set.weight), Number(set.reps), set.id);
      });
    });
  });

  (payload.backfillSessions ?? []).forEach((session) => {
    session.sets?.forEach((set) => {
      addEntry(session.exerciseName, session.date, Number(set.weight), Number(set.reps), set.id);
    });
  });

  (payload.exerciseCatalog ?? []).forEach((exerciseName) => {
    ensureExercise(exerciseName);
  });

  return {
    exercises: sortExercises(
      Array.from(map.values()).map((exercise) => ({
        ...exercise,
        entries: sortEntries(exercise.entries),
      })),
    ),
    favoriteExerciseKeys: [],
    favoritesUpdatedAt: 0,
    units: payload.units === "kg" ? "kg" : "lbs",
    joinDate: typeof payload.joinDate === "string" ? payload.joinDate : new Date().toISOString(),
  };
}

function loadLocalSnapshot() {
  const current = parseJson<AppSnapshot>(localStorage.getItem(STORAGE_KEY_SNAPSHOT));
  if (current) return toSnapshot(current);

  return migrateLegacyPayload({
    currentWorkout: parseJson<LegacyWorkout>(localStorage.getItem(LEGACY_STORAGE_KEY_CURRENT)),
    history: parseJson<LegacyWorkout[]>(localStorage.getItem(LEGACY_STORAGE_KEY_HISTORY)) ?? [],
    exerciseCatalog:
      parseJson<string[]>(localStorage.getItem(LEGACY_STORAGE_KEY_EXERCISE_CATALOG)) ?? [],
    backfillSessions:
      parseJson<LegacyBackfill[]>(localStorage.getItem(LEGACY_STORAGE_KEY_BACKFILL)) ?? [],
    units: localStorage.getItem(LEGACY_STORAGE_KEY_UNITS) ?? "lbs",
    joinDate: localStorage.getItem(LEGACY_STORAGE_KEY_JOIN_DATE) ?? new Date().toISOString(),
  });
}

function mergeSnapshots(local: AppSnapshot, cloud: AppSnapshot): AppSnapshot {
  const map = new Map<string, ExerciseRecord>();

  const mergeExercise = (exercise: ExerciseRecord) => {
    const existing = map.get(exercise.key);
    if (!existing) {
      map.set(exercise.key, {
        ...exercise,
        entries: sortEntries(exercise.entries),
      });
      return;
    }

    const entryMap = new Map<string, LoggedSet>();
    [...existing.entries, ...exercise.entries].forEach((entry) => {
      const dedupeKey = entry.id || `${entry.date}:${entry.weight}:${entry.reps}`;
      entryMap.set(dedupeKey, entry);
    });

    map.set(exercise.key, {
      ...existing,
      name: exercise.name || existing.name,
      entries: sortEntries(Array.from(entryMap.values())),
    });
  };

  cloud.exercises.forEach(mergeExercise);
  local.exercises.forEach(mergeExercise);

  const localJoin = new Date(local.joinDate).getTime();
  const cloudJoin = new Date(cloud.joinDate).getTime();

  return {
    exercises: sortExercises(Array.from(map.values())),
    favoriteExerciseKeys:
      (local.favoritesUpdatedAt ?? 0) >= (cloud.favoritesUpdatedAt ?? 0)
        ? local.favoriteExerciseKeys
        : cloud.favoriteExerciseKeys,
    favoritesUpdatedAt: Math.max(local.favoritesUpdatedAt ?? 0, cloud.favoritesUpdatedAt ?? 0),
    units: local.units ?? cloud.units,
    joinDate: localJoin < cloudJoin ? local.joinDate : cloud.joinDate,
  };
}

function getTrend(values: number[]) {
  if (values.length < 2) return "flat" as Trend;
  const recent = values.slice(-5);
  const baseline = recent[0];
  const latest = recent[recent.length - 1];
  if (latest > baseline) return "up" as Trend;
  if (latest < baseline) return "down" as Trend;
  return "flat" as Trend;
}

function getExerciseStats(exercise: ExerciseRecord) {
  const entries = sortEntries(exercise.entries);
  const maxWeight = entries.reduce((max, entry) => Math.max(max, entry.weight), 0);
  const latestEntry = entries[entries.length - 1] ?? null;
  const maxByEntry = entries.map((entry) => entry.weight);
  return {
    maxWeight,
    latestEntry,
    trend: getTrend(maxByEntry),
    totalEntries: entries.length,
  };
}

function createExerciseDraft(): ExerciseDraft {
  return {
    weight: "",
    reps: "",
    tag: "",
    note: "",
    sessionId: uuidv4(),
    pendingSets: [],
  };
}

function buildChart(values: number[]) {
  const safeMax = Math.max(...values, 1);
  const upper = safeMax * 1.08;
  const getY = (value: number) => 92 - (value / upper) * 76;
  const ticks = [0, upper * 0.33, upper * 0.66, upper].map((tick) => Math.round(tick));
  return { upper, getY, ticks };
}

function buildTimeScale(dates: string[]) {
  const sortedTimes = dates
    .map((date) => new Date(date).getTime())
    .filter((time) => Number.isFinite(time))
    .sort((a, b) => a - b);

  const start = sortedTimes[0] ?? Date.now();
  const last = sortedTimes[sortedTimes.length - 1] ?? start;
  const end = Math.max(last + 14 * 24 * 60 * 60 * 1000, start + 14 * 24 * 60 * 60 * 1000);
  const span = Math.max(end - start, 1);
  const getX = (date: string) => 4 + (((new Date(date).getTime() - start) / span) * 92);
  return { start, end, getX };
}

function compactRepsInOrder(entries: LoggedSet[]) {
  const parts: string[] = [];
  let lastReps: number | null = null;
  let count = 0;

  const flush = () => {
    if (lastReps === null || count === 0) return;
    parts.push(count > 1 ? `${count}x${lastReps}` : `1x${lastReps}`);
  };

  entries.forEach((entry) => {
    if (entry.reps === lastReps) {
      count += 1;
      return;
    }
    flush();
    lastReps = entry.reps;
    count = 1;
  });
  flush();

  return parts.join(", ");
}

function summarizeEntriesByWeight(entries: LoggedSet[], units: Units) {
  const grouped: Array<{ weight: number; entries: LoggedSet[] }> = [];

  entries.forEach((entry) => {
    const existing = grouped.find((group) => group.weight === entry.weight);
    if (existing) {
      existing.entries.push(entry);
      return;
    }
    grouped.push({ weight: entry.weight, entries: [entry] });
  });

  return grouped
    .map((group) => `${group.weight} ${units} · ${compactRepsInOrder(group.entries)}`)
    .join("  •  ");
}

function buildLinePath(points: Array<{ x: number; y: number }>) {
  if (points.length === 0) return "";
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
}

function buildAreaPath(points: Array<{ x: number; y: number }>) {
  if (points.length === 0) return "";
  const first = points[0];
  const last = points[points.length - 1];
  return `M ${first.x} 92 L ${first.x} ${first.y} ${points
    .slice(1)
    .map((point) => `L ${point.x} ${point.y}`)
    .join(" ")} L ${last.x} 92 Z`;
}

function App() {
  const initialSnapshot = useMemo(() => loadLocalSnapshot(), []);

  const [activeTab, setActiveTab] = useState<Tab>("exercises");
  const [exercises, setExercises] = useState<ExerciseRecord[]>(initialSnapshot.exercises);
  const [favoriteExerciseKeys, setFavoriteExerciseKeys] = useState<string[]>(
    initialSnapshot.favoriteExerciseKeys ?? [],
  );
  const [favoritesUpdatedAt, setFavoritesUpdatedAt] = useState<number>(
    initialSnapshot.favoritesUpdatedAt ?? 0,
  );
  const [units, setUnits] = useState<Units>(initialSnapshot.units);
  const [joinDate] = useState<string>(initialSnapshot.joinDate);
  const [selectedExerciseKey, setSelectedExerciseKey] = useState<string | null>(null);
  const [plotMode, setPlotMode] = useState<PlotMode>("data");
  const [hoveredSessionIndex, setHoveredSessionIndex] = useState<number | null>(null);
  const [expandedDataGroups, setExpandedDataGroups] = useState<Record<string, boolean>>({});
  const [revealedSwipe, setRevealedSwipe] = useState<{ key: string; side: "left" | "right" } | null>(null);

  const [isAddExerciseOpen, setIsAddExerciseOpen] = useState(false);
  const [newExerciseName, setNewExerciseName] = useState("");
  const [newExerciseGroup, setNewExerciseGroup] = useState<ExerciseGroup>("Other");
  const [exerciseDrafts, setExerciseDrafts] = useState<Record<string, ExerciseDraft>>({});
  const [isHistoricalLogOpen, setIsHistoricalLogOpen] = useState(false);
  const [historicalExerciseKey, setHistoricalExerciseKey] = useState<string | null>(null);
  const [historicalDate, setHistoricalDate] = useState(() => {
    const now = new Date();
    const year = now.getFullYear();
    const month = `${now.getMonth() + 1}`.padStart(2, "0");
    const day = `${now.getDate()}`.padStart(2, "0");
    return `${year}-${month}-${day}`;
  });
  const [historicalWeight, setHistoricalWeight] = useState("");
  const [historicalReps, setHistoricalReps] = useState("");
  const [historicalPendingSets, setHistoricalPendingSets] = useState<Array<{ id: string; weight: number; reps: number }>>(
    [],
  );
  const touchStateRef = useRef<{ key: string; startX: number } | null>(null);

  const [cloudOptIn, setCloudOptIn] = useState<boolean>(
    () => localStorage.getItem(STORAGE_KEY_CLOUD_OPT_IN) === "true",
  );
  const [authUser, setAuthUser] = useState<SupabaseUser | null>(null);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [needsEmailVerification, setNeedsEmailVerification] = useState(false);
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [isSyncingCloud, setIsSyncingCloud] = useState(false);
  const [didInitialCloudSync, setDidInitialCloudSync] = useState(false);

  useEffect(() => {
    const snapshot: AppSnapshot = {
      exercises,
      favoriteExerciseKeys,
      favoritesUpdatedAt,
      units,
      joinDate,
    };
    localStorage.setItem(STORAGE_KEY_SNAPSHOT, JSON.stringify(snapshot));
  }, [exercises, favoriteExerciseKeys, favoritesUpdatedAt, joinDate, units]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_CLOUD_OPT_IN, cloudOptIn ? "true" : "false");
    if (!cloudOptIn) {
      setDidInitialCloudSync(false);
      setAuthMessage("Cloud save disabled. Data stays on this device.");
    }
  }, [cloudOptIn]);

  useEffect(() => {
    if (!supabaseConfigured || !supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setAuthUser(data.session?.user ?? null);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthUser(session?.user ?? null);
      setDidInitialCloudSync(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const getLocalSnapshotValue = () =>
    ({
      exercises,
      favoriteExerciseKeys,
      favoritesUpdatedAt,
      units,
      joinDate,
    }) satisfies AppSnapshot;

  const applySnapshot = (snapshot: AppSnapshot) => {
    setExercises(sortExercises(snapshot.exercises));
    setFavoriteExerciseKeys(snapshot.favoriteExerciseKeys ?? []);
    setFavoritesUpdatedAt(snapshot.favoritesUpdatedAt ?? 0);
    setUnits(snapshot.units);
  };

  const loadCloudSnapshot = async (userId: string) => {
    if (!supabase) return null;
    const { data, error } = await supabase
      .from("user_state")
      .select("payload")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) throw error;
    if (!data?.payload) return null;
    return toSnapshot(data.payload);
  };

  const saveCloudSnapshot = async (userId: string, snapshot: AppSnapshot) => {
    if (!supabase) return;
    const { error } = await supabase.from("user_state").upsert(
      {
        user_id: userId,
        payload: snapshot,
      },
      { onConflict: "user_id" },
    );
    if (error) throw error;
  };

  const syncCloudNow = async () => {
    if (!cloudOptIn || !authUser || !supabaseConfigured) return;
    setIsSyncingCloud(true);
    setAuthMessage("Syncing...");
    try {
      const local = getLocalSnapshotValue();
      const cloud = (await loadCloudSnapshot(authUser.id)) ?? local;
      const merged = mergeSnapshots(local, cloud);
      applySnapshot(merged);
      await saveCloudSnapshot(authUser.id, merged);
      setAuthMessage("Cloud sync complete.");
      setDidInitialCloudSync(true);
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : "Cloud sync failed.");
    } finally {
      setIsSyncingCloud(false);
    }
  };

  useEffect(() => {
    if (!cloudOptIn || !authUser || !supabaseConfigured || didInitialCloudSync) return;
    void syncCloudNow();
  }, [authUser, cloudOptIn, didInitialCloudSync]);

  useEffect(() => {
    if (!cloudOptIn || !authUser || !supabaseConfigured || !didInitialCloudSync || isSyncingCloud) return;
    const timeoutId = window.setTimeout(() => {
      void saveCloudSnapshot(authUser.id, getLocalSnapshotValue()).catch(() => {
        setAuthMessage("Auto-sync failed. Tap Sync Now.");
      });
    }, 500);
    return () => window.clearTimeout(timeoutId);
  }, [
    authUser,
    cloudOptIn,
    didInitialCloudSync,
    exercises,
    favoriteExerciseKeys,
    favoritesUpdatedAt,
    isSyncingCloud,
    joinDate,
    units,
  ]);

  const signUpWithEmail = async () => {
    if (!supabase) {
      setAuthMessage("Supabase is not configured for this environment.");
      return;
    }
    if (!authEmail.trim() || !authPassword.trim()) {
      setAuthMessage("Enter email and password first.");
      return;
    }
    setIsAuthLoading(true);
    setAuthMessage("");
    try {
      const result = await supabase.auth.signUp({
        email: authEmail.trim(),
        password: authPassword,
        options: { emailRedirectTo: window.location.origin },
      });
      if (result.error) throw result.error;
      setNeedsEmailVerification(true);
      setAuthMessage("Check your email to verify your account, then log in.");
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : "Sign up failed.");
    } finally {
      setIsAuthLoading(false);
    }
  };

  const signInWithEmail = async () => {
    if (!supabase) {
      setAuthMessage("Supabase is not configured for this environment.");
      return;
    }
    if (!authEmail.trim() || !authPassword.trim()) {
      setAuthMessage("Enter email and password first.");
      return;
    }
    setIsAuthLoading(true);
    setAuthMessage("");
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: authEmail.trim(),
        password: authPassword,
      });
      if (error) throw error;
      setAuthMessage("Logged in.");
      setNeedsEmailVerification(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Login failed.";
      if (message.toLowerCase().includes("not confirmed")) {
        setNeedsEmailVerification(true);
        setAuthMessage("Verify your email first, then log in.");
      } else {
        setAuthMessage(message);
      }
    } finally {
      setIsAuthLoading(false);
    }
  };

  const resendVerificationEmail = async () => {
    if (!supabase) {
      setAuthMessage("Supabase is not configured for this environment.");
      return;
    }
    if (!authEmail.trim()) {
      setAuthMessage("Enter your email first.");
      return;
    }
    setIsAuthLoading(true);
    setAuthMessage("");
    try {
      const { error } = await supabase.auth.resend({
        type: "signup",
        email: authEmail.trim(),
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) throw error;
      setAuthMessage("Verification email sent.");
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : "Unable to resend email.");
    } finally {
      setIsAuthLoading(false);
    }
  };

  const signOut = async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
    setAuthMessage("Signed out. Local data remains on this device.");
  };

  const getDraft = (exerciseKey: string) => exerciseDrafts[exerciseKey] ?? createExerciseDraft();

  const setDraftValue = (
    exerciseKey: string,
    field: "weight" | "reps" | "tag" | "note",
    value: string,
  ) => {
    setExerciseDrafts((prev) => ({
      ...prev,
      [exerciseKey]: {
        ...(prev[exerciseKey] ?? createExerciseDraft()),
        [field]: value,
      },
    }));
  };

  const addExercise = () => {
    const cleanName = newExerciseName.trim();
    if (!cleanName) return;
    const key = normalizeExerciseName(cleanName);
    const exists = exercises.find((exercise) => exercise.key === key);
    if (exists) {
      setSelectedExerciseKey(exists.key);
      setPlotMode("data");
      setIsAddExerciseOpen(false);
      setNewExerciseName("");
      setNewExerciseGroup("Other");
      return;
    }

    const created: ExerciseRecord = {
      id: uuidv4(),
      key,
      name: cleanName,
      group: newExerciseGroup === "Other" ? inferExerciseGroup(cleanName) : newExerciseGroup,
      entries: [],
    };

    setExercises((prev) => sortExercises([created, ...prev]));
    setSelectedExerciseKey(created.key);
    setPlotMode("data");
    setIsAddExerciseOpen(false);
    setNewExerciseName("");
    setNewExerciseGroup("Other");
    triggerHaptic();
  };

  const queueSet = (exerciseKey: string, seed?: Partial<ExerciseDraft>) => {
    const draft = {
      ...getDraft(exerciseKey),
      ...(seed ?? {}),
    };
    const weight = Number(draft?.weight);
    const reps = Number(draft?.reps);
    if (!Number.isFinite(weight) || !Number.isFinite(reps) || weight <= 0 || reps <= 0) return;

    setExerciseDrafts((prev) => ({
      ...prev,
      [exerciseKey]: {
        ...draft,
        weight: "",
        reps: "",
        pendingSets: [
          ...draft.pendingSets,
          {
            id: uuidv4(),
            createdAt: new Date().toISOString(),
            weight,
            reps,
            tag: draft.tag || undefined,
            note: draft.note.trim() || undefined,
          },
        ],
      },
    }));
    triggerHaptic();
  };

  const removePendingSet = (exerciseKey: string, pendingSetId: string) => {
    setExerciseDrafts((prev) => {
      const draft = prev[exerciseKey];
      if (!draft) return prev;
      return {
        ...prev,
        [exerciseKey]: {
          ...draft,
          pendingSets: draft.pendingSets.filter((set) => set.id !== pendingSetId),
        },
      };
    });
    triggerHaptic();
  };

  const clearSessionDraft = (exerciseKey: string) => {
    setExerciseDrafts((prev) => ({
      ...prev,
      [exerciseKey]: createExerciseDraft(),
    }));
    triggerHaptic();
  };

  const saveSessionDraft = (exerciseKey: string) => {
    const draft = getDraft(exerciseKey);
    if (draft.pendingSets.length === 0) return;
    const sessionId = draft.sessionId;

    setExercises((prev) =>
      sortExercises(
        prev.map((exercise) =>
          exercise.key === exerciseKey
            ? {
                ...exercise,
                entries: sortEntries([
                  ...exercise.entries,
                  ...draft.pendingSets.map((set) => ({
                    id: set.id,
                    date: set.createdAt,
                    weight: set.weight,
                    reps: set.reps,
                    sessionId,
                    tag: set.tag,
                    note: set.note,
                  })),
                ]),
              }
            : exercise,
        ),
      ),
    );

    setExerciseDrafts((prev) => ({
      ...prev,
      [exerciseKey]: {
        ...createExerciseDraft(),
        tag: draft.tag,
      },
    }));
    triggerHaptic();
  };

  const logSetDirect = (exerciseKey: string) => {
    const draft = getDraft(exerciseKey);
    const weight = Number(draft.weight);
    const reps = Number(draft.reps);
    if (!Number.isFinite(weight) || !Number.isFinite(reps) || weight <= 0 || reps <= 0) return;

    setExercises((prev) =>
      sortExercises(
        prev.map((exercise) =>
          exercise.key === exerciseKey
            ? {
                ...exercise,
                entries: sortEntries([
                  ...exercise.entries,
                  {
                    id: uuidv4(),
                    date: new Date().toISOString(),
                    weight,
                    reps,
                  },
                ]),
              }
            : exercise,
        ),
      ),
    );

    setExerciseDrafts((prev) => ({
      ...prev,
      [exerciseKey]: {
        ...createExerciseDraft(),
      },
    }));
    triggerHaptic();
  };

  const toggleFavorite = (exerciseKey: string) => {
    setFavoriteExerciseKeys((prev) =>
      prev.includes(exerciseKey) ? prev.filter((item) => item !== exerciseKey) : [exerciseKey, ...prev],
    );
    setFavoritesUpdatedAt(Date.now());
    setRevealedSwipe(null);
    triggerHaptic();
  };

  const deleteExercise = (exerciseKey: string) => {
    setExercises((prev) => prev.filter((exercise) => exercise.key !== exerciseKey));
    setFavoriteExerciseKeys((prev) => prev.filter((item) => item !== exerciseKey));
    setFavoritesUpdatedAt(Date.now());
    setRevealedSwipe(null);
    triggerHaptic();
  };

  const deleteEntry = (exerciseKey: string, entryId: string) => {
    setExercises((prev) =>
      sortExercises(
        prev.map((exercise) =>
          exercise.key === exerciseKey
            ? {
                ...exercise,
                entries: exercise.entries.filter((entry) => entry.id !== entryId),
              }
            : exercise,
        ),
      ),
    );
    triggerHaptic();
  };

  const updateEntry = (
    exerciseKey: string,
    entryId: string,
    field: "weight" | "reps",
    value: number,
  ) => {
    if (!Number.isFinite(value) || value <= 0) return;
    setExercises((prev) =>
      sortExercises(
        prev.map((exercise) =>
          exercise.key === exerciseKey
            ? {
                ...exercise,
                entries: sortEntries(
                  exercise.entries.map((entry) =>
                    entry.id === entryId ? { ...entry, [field]: value } : entry,
                  ),
                ),
              }
            : exercise,
        ),
      ),
    );
  };

  const openHistoricalLog = (exerciseKey: string) => {
    setHistoricalExerciseKey(exerciseKey);
    setHistoricalWeight("");
    setHistoricalReps("");
    setHistoricalPendingSets([]);
    setIsHistoricalLogOpen(true);
  };

  const addHistoricalPendingSet = () => {
    const weight = Number(historicalWeight);
    const reps = Number(historicalReps);
    if (!Number.isFinite(weight) || !Number.isFinite(reps) || weight <= 0 || reps <= 0) return;
    setHistoricalPendingSets((prev) => [...prev, { id: uuidv4(), weight, reps }]);
    setHistoricalWeight("");
    setHistoricalReps("");
    triggerHaptic();
  };

  const removeHistoricalPendingSet = (pendingSetId: string) => {
    setHistoricalPendingSets((prev) => prev.filter((set) => set.id !== pendingSetId));
    triggerHaptic();
  };

  const saveHistoricalSet = () => {
    if (!historicalExerciseKey || historicalPendingSets.length === 0) return;
    const isoDate = new Date(`${historicalDate}T12:00:00`).toISOString();
    const sessionId = uuidv4();
    setExercises((prev) =>
      sortExercises(
        prev.map((exercise) =>
          exercise.key === historicalExerciseKey
            ? {
                ...exercise,
                entries: sortEntries([
                  ...exercise.entries,
                  ...historicalPendingSets.map((set) => ({
                    id: set.id,
                    date: isoDate,
                    weight: set.weight,
                    reps: set.reps,
                    sessionId,
                  })),
                ]),
              }
            : exercise,
        ),
      ),
    );
    setIsHistoricalLogOpen(false);
    setHistoricalWeight("");
    setHistoricalReps("");
    setHistoricalPendingSets([]);
    triggerHaptic();
  };

  const trackedExercises = useMemo(
    () => {
      const favoriteSet = new Set(favoriteExerciseKeys);
      return [...exercises]
        .map((exercise) => ({
          ...exercise,
          stats: getExerciseStats(exercise),
          isFavorite: favoriteSet.has(exercise.key),
        }))
        .sort((a, b) => {
          if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
          const latestA = a.entries[a.entries.length - 1]?.date ?? "";
          const latestB = b.entries[b.entries.length - 1]?.date ?? "";
          if (latestA !== latestB) return latestB.localeCompare(latestA);
          return a.name.localeCompare(b.name);
        });
    },
    [exercises, favoriteExerciseKeys],
  );

  const groupedExercises = useMemo(() => {
    const groups: Array<{ title: string; items: typeof trackedExercises }> = [];
    const favorites = trackedExercises.filter((exercise) => exercise.isFavorite);
    if (favorites.length > 0) {
      groups.push({ title: "Favorites", items: favorites });
    }

    exerciseGroups.forEach((group) => {
      const items = trackedExercises.filter((exercise) => !exercise.isFavorite && exercise.group === group);
      if (items.length > 0) {
        groups.push({ title: group, items });
      }
    });

    return groups;
  }, [trackedExercises]);

  const selectedExercise = trackedExercises.find((exercise) => exercise.key === selectedExerciseKey) ?? null;

  const selectedExerciseSessions = useMemo(() => {
    if (!selectedExercise) return [];
    const grouped = new Map<string, LoggedSet[]>();

    selectedExercise.entries.forEach((entry) => {
      const groupKey = entry.sessionId ?? entry.date.slice(0, 10);
      const bucket = grouped.get(groupKey) ?? [];
      bucket.push(entry);
      grouped.set(groupKey, bucket);
    });

    return Array.from(grouped.entries())
      .map(([groupKey, entries]) => {
        const sorted = sortEntries(entries);
        const maxWeight = sorted.reduce((max, entry) => Math.max(max, entry.weight), 0);
        const repWeightedWeight =
          sorted.reduce((sum, entry) => sum + entry.weight * entry.reps, 0) /
          Math.max(1, sorted.reduce((sum, entry) => sum + entry.reps, 0));
        const totalReps = sorted.reduce((sum, entry) => sum + entry.reps, 0);
        return {
          dayKey: groupKey,
          label: formatShortDate(sorted[sorted.length - 1]?.date ?? new Date().toISOString()),
          date: sorted[sorted.length - 1]?.date ?? new Date().toISOString(),
          entries: sorted,
          maxWeight,
          repWeightedWeight,
          totalReps,
          totalSets: sorted.length,
        };
      })
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }, [selectedExercise]);

  const selectedExerciseDayGroups = useMemo<DayGroup[]>(() => {
    if (!selectedExercise) return [];
    const groups = new Map<string, LoggedSet[]>();
    selectedExercise.entries.forEach((entry) => {
      const dayKey = entry.date.slice(0, 10);
      const bucket = groups.get(dayKey) ?? [];
      bucket.push(entry);
      groups.set(dayKey, bucket);
    });

    return Array.from(groups.entries())
      .map(([dayKey, entries]) => ({
        dayKey,
        label: formatShortDate(entries[entries.length - 1]?.date ?? `${dayKey}T12:00:00`),
        entries: sortEntries(entries),
      }))
      .sort((a, b) => b.dayKey.localeCompare(a.dayKey));
  }, [selectedExercise]);

  useEffect(() => {
    setHoveredSessionIndex(
      selectedExerciseSessions.length > 0 ? selectedExerciseSessions.length - 1 : null,
    );
  }, [plotMode, selectedExerciseKey, selectedExerciseSessions]);

  const renderTrendIcon = (trend: Trend) => {
    if (trend === "up") {
      return (
        <span className="inline-flex size-9 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
          <TrendingUp className="h-4 w-4" />
        </span>
      );
    }
    if (trend === "down") {
      return (
        <span className="inline-flex size-9 items-center justify-center rounded-full bg-red-500/15 text-red-400">
          <TrendingDown className="h-4 w-4" />
        </span>
      );
    }
    return (
      <span className="inline-flex size-9 items-center justify-center rounded-full bg-yellow-500/15 text-yellow-300">
        <Minus className="h-4 w-4" />
      </span>
    );
  };

  const handleSwipeStart = (exerciseKey: string, clientX: number) => {
    touchStateRef.current = { key: exerciseKey, startX: clientX };
  };

  const handleSwipeEnd = (exerciseKey: string, clientX: number) => {
    const touchState = touchStateRef.current;
    touchStateRef.current = null;
    if (!touchState || touchState.key !== exerciseKey) return;
    const delta = clientX - touchState.startX;
    if (delta > 48) {
      setRevealedSwipe({ key: exerciseKey, side: "right" });
      return;
    }
    if (delta < -48) {
      setRevealedSwipe({ key: exerciseKey, side: "left" });
      return;
    }
    setRevealedSwipe(null);
  };

  const renderChart = () => {
    if (!selectedExercise || selectedExerciseSessions.length === 0) {
      return (
        <div className="rounded-2xl border border-dashed border-border/70 px-4 py-12 text-center text-sm text-muted-foreground">
          Log a few sets to unlock the visualizer.
        </div>
      );
    }

    const values = selectedExerciseSessions.map((session) => session.repWeightedWeight);
    const chart = buildChart(values);
    const timeScale = buildTimeScale(selectedExerciseSessions.map((session) => session.date));
    const linePoints = values.map((value, index) => ({
      x: timeScale.getX(selectedExerciseSessions[index]?.date ?? new Date().toISOString()),
      y: chart.getY(value),
    }));
    const areaPath = buildAreaPath(linePoints);
    const linePath = buildLinePath(linePoints);
    const focusIndex = hoveredSessionIndex ?? values.length - 1;
    const focusSession =
      selectedExerciseSessions[focusIndex] ?? selectedExerciseSessions[selectedExerciseSessions.length - 1];
    const focusPoint = linePoints[focusIndex] ?? linePoints[linePoints.length - 1];
    const tooltipX = Math.min(88, Math.max(12, focusPoint.x));
    const tooltipY = Math.min(18, Math.max(10, focusPoint.y - 8));

    const handleChartMove = (clientX: number, rect: DOMRect) => {
      const relative = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const pointerTime =
        timeScale.start + (rect.width === 0 ? 0 : (relative / rect.width) * (timeScale.end - timeScale.start));
      let nextIndex = 0;
      let smallestDistance = Number.POSITIVE_INFINITY;
      selectedExerciseSessions.forEach((session, index) => {
        const distance = Math.abs(new Date(session.date).getTime() - pointerTime);
        if (distance < smallestDistance) {
          smallestDistance = distance;
          nextIndex = index;
        }
      });
      setHoveredSessionIndex(nextIndex);
    };

    return (
      <div className="space-y-3">
        <div className={`${subtlePanelClass} grid grid-cols-[1fr_auto] gap-3 p-3`}>
          <div>
            <p className="text-[11px] uppercase tracking-[0.18em] text-green-200/70">Rep-Weighted Trend</p>
            <p className="text-3xl font-semibold leading-none tracking-tight tabular-nums">
              {Math.round(focusSession.repWeightedWeight)} {units}
            </p>
          </div>
          <div className="text-right">
            <p className="text-sm font-medium text-slate-200">{focusSession.label}</p>
            <p className="text-xs text-slate-400">
              {focusSession.totalSets} sets • {focusSession.totalReps} reps
            </p>
          </div>
        </div>

        <div className="overflow-hidden rounded-[1.75rem] border border-green-500/10 bg-[linear-gradient(180deg,rgba(7,17,13,0.98),rgba(4,9,7,1))] p-3">
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="h-80 w-full touch-none"
            onPointerMove={(event) => handleChartMove(event.clientX, event.currentTarget.getBoundingClientRect())}
            onPointerDown={(event) => handleChartMove(event.clientX, event.currentTarget.getBoundingClientRect())}
            onPointerLeave={() => setHoveredSessionIndex(selectedExerciseSessions.length - 1)}
          >
            {[20, 40, 60, 80].map((line) => (
              <line
                key={`h-${line}`}
                x1="0"
                y1={line}
                x2="100"
                y2={line}
                stroke="rgba(120, 255, 173, 0.1)"
                strokeWidth="0.35"
              />
            ))}

            {selectedExerciseSessions.map((_, index) => {
              if (index === 0 || index === selectedExerciseSessions.length - 1) return null;
              const x = timeScale.getX(selectedExerciseSessions[index]?.date ?? new Date().toISOString());
              return (
                <line
                  key={`v-${index}`}
                  x1={x}
                  y1="0"
                  x2={x}
                  y2="92"
                  stroke="rgba(120, 255, 173, 0.08)"
                  strokeDasharray="2 2"
                  strokeWidth="0.3"
                />
              );
            })}

            <line
              x1={focusPoint.x}
              y1="0"
              x2={focusPoint.x}
              y2="92"
              stroke="rgba(158, 255, 190, 0.2)"
              strokeDasharray="2 2"
              strokeWidth="0.4"
            />

            <path d={areaPath} fill="rgba(34, 197, 94, 0.14)" />
            <path
              d={linePath}
              fill="none"
              stroke="rgba(110,231,183,0.95)"
              strokeWidth="1.6"
              strokeLinejoin="round"
              strokeLinecap="round"
            />

            {selectedExerciseSessions.map((session, index) => {
              const point = linePoints[index];
              const isFocused = index === focusIndex;
              return (
                <g key={`line-point-${session.dayKey}`}>
                  <circle
                    cx={point.x}
                    cy={point.y}
                    r={isFocused ? 1.4 : 0.9}
                    fill="rgba(4,9,7,0.98)"
                    stroke="rgba(110,231,183,0.98)"
                    strokeWidth={isFocused ? 1 : 0.7}
                  />
                </g>
              );
            })}

            <g transform={`translate(${tooltipX}, ${tooltipY})`}>
              <rect
                x="-13"
                y="-8"
                rx="4"
                width="26"
                height="10"
                fill="rgba(8,12,10,0.92)"
                stroke="rgba(110,231,183,0.2)"
                strokeWidth="0.3"
              />
              <text x="0" y="-1.2" textAnchor="middle" fontSize="3.1" fill="rgba(236,253,245,0.95)">
                {Math.round(focusSession.repWeightedWeight)}
              </text>
            </g>
          </svg>

          <div className="mt-2 grid grid-cols-[1fr_auto] items-end gap-2 text-xs text-slate-400">
            <div className="flex items-center justify-between">
              <span>{formatAxisDate(new Date(timeScale.start).toISOString())}</span>
              <span>{formatAxisDate(new Date((timeScale.start + timeScale.end) / 2).toISOString())}</span>
              <span>{formatAxisDate(new Date(timeScale.end).toISOString())}</span>
            </div>
            <div className="space-y-1 text-right">
              {[...chart.ticks].reverse().map((tick) => (
                <p key={`tick-${tick}`} className="tabular-nums">
                  {tick} {units}
                </p>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderExerciseDetail = () => {
    if (!selectedExercise) return null;

    const detailDraft = getDraft(selectedExercise.key);

    return (
      <div className="flex h-full flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-3xl font-semibold leading-tight">{selectedExercise.name}</h1>
            <p className="text-sm text-slate-400">
              {selectedExercise.stats.maxWeight} {units} max
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              className="h-9 rounded-xl px-3 text-xs text-green-300"
              onClick={() => openHistoricalLog(selectedExercise.key)}
            >
              Past
            </Button>
            <div>{renderTrendIcon(selectedExercise.stats.trend)}</div>
          </div>
        </div>

        <div className={`${subtlePanelClass} p-3`}>
          <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
            <Input
              type="number"
              inputMode="decimal"
              placeholder={`Weight (${units})`}
              value={detailDraft.weight}
              onChange={(event) => setDraftValue(selectedExercise.key, "weight", event.target.value)}
              className="h-12 rounded-2xl border-white/8 bg-white/[0.03] text-base"
            />
            <Input
              type="number"
              inputMode="numeric"
              placeholder="Reps"
              value={detailDraft.reps}
              onChange={(event) => setDraftValue(selectedExercise.key, "reps", event.target.value)}
              className="h-12 rounded-2xl border-white/8 bg-white/[0.03] text-base"
            />
            <Button className="h-12 rounded-2xl px-4" onClick={() => logSetDirect(selectedExercise.key)}>
              Log
            </Button>
          </div>
        </div>

        <div className={`${subtlePanelClass} grid grid-cols-2 gap-2 p-1`}>
          <Button
            variant={plotMode === "data" ? "default" : "ghost"}
            className="h-10 rounded-xl"
            onClick={() => setPlotMode("data")}
          >
            Data
          </Button>
          <Button
            variant={plotMode === "trend" ? "default" : "ghost"}
            className="h-10 rounded-xl"
            onClick={() => setPlotMode("trend")}
          >
            Trend
          </Button>
        </div>

        {plotMode === "data" ? (
          <div className={`min-h-0 flex-1 overflow-y-auto ${shellClass}`}>
            {selectedExerciseDayGroups.length === 0 ? (
              <div className="px-4 py-12 text-center text-sm text-slate-400">No saved sets yet.</div>
            ) : (
              <div className="divide-y divide-white/6">
                {selectedExerciseDayGroups.map((group) => {
                  const groupKey = `${selectedExercise.key}:${group.dayKey}`;
                  const isExpanded = Boolean(expandedDataGroups[groupKey]);
                  return (
                    <div key={groupKey} className="px-4 py-3">
                      <button
                        type="button"
                        className="grid w-full grid-cols-[1fr_auto] items-center gap-3 text-left"
                        onClick={() =>
                          setExpandedDataGroups((prev) => ({
                            ...prev,
                            [groupKey]: !prev[groupKey],
                          }))
                        }
                      >
                        <div>
                          <p className="text-lg font-semibold">{group.label}</p>
                          <p className="text-sm text-slate-400">{summarizeEntriesByWeight(group.entries, units)}</p>
                        </div>
                        <span className="inline-flex items-center gap-2 text-xs text-slate-400">
                          {group.entries.length} sets
                          {isExpanded ? (
                            <ChevronUp className="h-4 w-4" />
                          ) : (
                            <ChevronDown className="h-4 w-4" />
                          )}
                        </span>
                      </button>

                      {isExpanded ? (
                        <div className="mt-3 space-y-2">
                          {group.entries.map((entry) => (
                            <div
                              key={entry.id}
                              className="grid grid-cols-[1fr_1fr_auto_auto] items-center gap-2 rounded-2xl border border-green-500/10 bg-green-500/[0.03] p-2"
                            >
                              <Input
                                type="number"
                                inputMode="decimal"
                                value={entry.weight}
                                onChange={(event) =>
                                  updateEntry(
                                    selectedExercise.key,
                                    entry.id,
                                    "weight",
                                    Math.max(0, Number(event.target.value) || 0),
                                  )
                                }
                                className="h-10 rounded-xl border-white/8 bg-white/[0.03]"
                              />
                              <Input
                                type="number"
                                inputMode="numeric"
                                value={entry.reps}
                                onChange={(event) =>
                                  updateEntry(
                                    selectedExercise.key,
                                    entry.id,
                                    "reps",
                                    Math.max(0, Number(event.target.value) || 0),
                                  )
                                }
                                className="h-10 rounded-xl border-white/8 bg-white/[0.03]"
                              />
                              <div className="text-[11px] text-slate-400">{formatShortDate(entry.date)}</div>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="text-red-400 hover:text-red-300"
                                onClick={() => deleteEntry(selectedExercise.key, entry.id)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1">{renderChart()}</div>
        )}
      </div>
    );
  };

  const renderExercises = () => {
    if (selectedExercise) return renderExerciseDetail();

    return (
      <div className="flex h-full flex-col">
        {trackedExercises.length === 0 ? (
          <Card className={`${shellClass} flex-1`}>
            <CardContent className="flex h-full flex-col items-center justify-center px-6 py-12 text-center text-muted-foreground">
              Start by adding an exercise.
            </CardContent>
          </Card>
        ) : (
          <div className={`min-h-0 flex-1 overflow-y-auto ${shellClass}`}>
            <div className="space-y-6 px-4 py-4">
              {groupedExercises.map((group) => (
                <section key={group.title} className="space-y-2">
                  <p className="px-1 text-[11px] uppercase tracking-[0.18em] text-slate-500">{group.title}</p>
                  <div className="divide-y divide-white/6 overflow-hidden rounded-[1.4rem] border border-white/6 bg-white/[0.02]">
                    {group.items.map((exercise) => {
                      const draft = getDraft(exercise.key);
                      const isRevealedLeft =
                        revealedSwipe?.key === exercise.key && revealedSwipe.side === "left";
                      const isRevealedRight =
                        revealedSwipe?.key === exercise.key && revealedSwipe.side === "right";
                      return (
                        <div key={exercise.key} className="px-3 py-3">
                          <div className="relative overflow-hidden rounded-2xl">
                            <div className="absolute inset-0 flex items-center justify-between">
                              <button
                                type="button"
                                className="flex h-full w-20 items-center justify-center rounded-l-2xl bg-green-500/12 text-green-300"
                                onClick={() => toggleFavorite(exercise.key)}
                              >
                                <Pin className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                className="flex h-full w-20 items-center justify-center rounded-r-2xl bg-red-500/12 text-red-300"
                                onClick={() => deleteExercise(exercise.key)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                            <div
                              className={`relative rounded-2xl bg-background/95 px-3 py-2 transition-transform duration-200 ${
                                isRevealedLeft ? "-translate-x-16" : isRevealedRight ? "translate-x-16" : "translate-x-0"
                              }`}
                              onTouchStart={(event) =>
                                handleSwipeStart(exercise.key, event.changedTouches[0]?.clientX ?? 0)
                              }
                              onTouchEnd={(event) =>
                                handleSwipeEnd(exercise.key, event.changedTouches[0]?.clientX ?? 0)
                              }
                            >
                              <button
                                type="button"
                                className="block w-full text-left"
                                onClick={() => {
                                  setSelectedExerciseKey(exercise.key);
                                  setPlotMode("data");
                                  setRevealedSwipe(null);
                                }}
                              >
                                <div className="flex items-end justify-between gap-3">
                                  <div className="min-w-0">
                                    <p className="truncate text-2xl font-semibold leading-tight">{exercise.name}</p>
                                    <p className="mt-1 text-base font-medium leading-none tabular-nums text-slate-300">
                                      Max {exercise.stats.maxWeight} {units}
                                    </p>
                                  </div>
                                  {exercise.isFavorite ? (
                                    <Pin className="h-4 w-4 shrink-0 text-green-300" />
                                  ) : null}
                                </div>
                                <p className="mt-1 text-xs text-slate-500">
                                  {exercise.stats.latestEntry
                                    ? `Last ${exercise.stats.latestEntry.weight} x ${exercise.stats.latestEntry.reps}`
                                    : "No sets logged yet"}
                                </p>
                              </button>
                            </div>
                          </div>

                          <div className="mt-3 grid grid-cols-[1fr_1fr_auto] gap-2">
                            <Input
                              type="number"
                              inputMode="decimal"
                              placeholder={`Weight (${units})`}
                              value={draft.weight}
                              onChange={(event) => setDraftValue(exercise.key, "weight", event.target.value)}
                              className="h-11 rounded-2xl border-white/8 bg-white/[0.03]"
                            />
                            <Input
                              type="number"
                              inputMode="numeric"
                              placeholder="Reps"
                              value={draft.reps}
                              onChange={(event) => setDraftValue(exercise.key, "reps", event.target.value)}
                              className="h-11 rounded-2xl border-white/8 bg-white/[0.03]"
                            />
                            <Button className="h-11 rounded-2xl px-4" onClick={() => queueSet(exercise.key)}>
                              Log
                            </Button>
                          </div>

                          {draft.pendingSets.length > 0 ? (
                            <div className={`${subtlePanelClass} mt-3 space-y-2 p-3`}>
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-[11px] uppercase tracking-[0.18em] text-slate-400">
                                  Current Session
                                </p>
                                <div className="flex gap-2">
                                  <Button
                                    variant="ghost"
                                    className="h-8 rounded-xl px-2 text-xs text-slate-400"
                                    onClick={() => clearSessionDraft(exercise.key)}
                                  >
                                    Clear
                                  </Button>
                                  <Button
                                    className="h-8 rounded-xl px-3 text-xs"
                                    onClick={() => saveSessionDraft(exercise.key)}
                                  >
                                    Save
                                  </Button>
                                </div>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                {draft.pendingSets.map((set) => (
                                  <button
                                    key={set.id}
                                    type="button"
                                    className="inline-flex items-center gap-2 rounded-full border border-white/8 bg-white/[0.03] px-3 py-1 text-sm text-slate-200"
                                    onClick={() => removePendingSet(exercise.key, set.id)}
                                  >
                                    <span className="tabular-nums">
                                      {set.weight}x{set.reps}
                                    </span>
                                    <X className="h-3 w-3 text-slate-400" />
                                  </button>
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderProfile = () => (
    <div className="space-y-4">
      <div>
        <h1 className="text-3xl font-semibold">Profile</h1>
        <p className="text-sm text-slate-400">Storage, sync, and units.</p>
      </div>

      <Card className={shellClass}>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg">Data Storage</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-slate-400">Joined: {new Date(joinDate).toLocaleDateString()}</p>
          <p className="text-slate-400">Exercises tracked: {exercises.length}</p>

          {!cloudOptIn ? (
            <>
              <p className="text-slate-400">
                Local-only mode keeps data on this device. Enable cloud save if you want sync across devices.
              </p>
              <Button className="h-10 rounded-xl" onClick={() => setCloudOptIn(true)}>
                Enable Cloud Save
              </Button>
            </>
          ) : !supabaseConfigured ? (
            <p className="text-sm text-red-400">
              Supabase not configured. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
            </p>
          ) : authUser ? (
            <div className="space-y-2">
              <p className="text-slate-400">Signed in as {authUser.email}</p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="h-10 rounded-xl border-green-600/30"
                  onClick={() => void syncCloudNow()}
                  disabled={isSyncingCloud}
                >
                  {isSyncingCloud ? "Syncing..." : "Sync Now"}
                </Button>
                <Button variant="outline" className="h-10 rounded-xl border-green-600/30" onClick={() => void signOut()}>
                  Log Out
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="rounded-xl border border-border/70 bg-background/50 px-3 py-2 text-xs text-muted-foreground">
                <p>1. Sign up with email and password.</p>
                <p>2. Verify your email.</p>
                <p>3. Return here and tap log in.</p>
              </div>
              <Input
                type="email"
                placeholder="Email"
                autoComplete="email"
                value={authEmail}
                onChange={(event) => setAuthEmail(event.target.value)}
              />
              <Input
                type="password"
                placeholder="Password"
                autoComplete="current-password"
                value={authPassword}
                onChange={(event) => setAuthPassword(event.target.value)}
              />
              <div className="flex gap-2">
                <Button className="h-10 rounded-xl" onClick={() => void signUpWithEmail()} disabled={isAuthLoading}>
                  Sign Up
                </Button>
                <Button
                  variant="outline"
                  className="h-10 rounded-xl border-green-600/30"
                  onClick={() => void signInWithEmail()}
                  disabled={isAuthLoading}
                >
                  Log In
                </Button>
              </div>
              {needsEmailVerification ? (
                <Button
                  variant="ghost"
                  className="h-9 rounded-xl px-2 text-xs text-muted-foreground"
                  onClick={() => void resendVerificationEmail()}
                  disabled={isAuthLoading}
                >
                  Resend verification email
                </Button>
              ) : null}
            </div>
          )}

          {authMessage ? (
            <p className="rounded-xl border border-white/6 bg-white/[0.03] px-3 py-2 text-xs text-slate-400">
              {authMessage}
            </p>
          ) : null}

          {cloudOptIn ? (
            <Button variant="ghost" className="h-8 rounded-xl px-2 text-xs text-muted-foreground" onClick={() => setCloudOptIn(false)}>
              Disable Cloud Save
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <Card className={shellClass}>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg">Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Label className="text-sm text-slate-400">Units</Label>
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant={units === "lbs" ? "default" : "outline"}
              className="h-11 rounded-xl"
              onClick={() => setUnits("lbs")}
            >
              lbs
            </Button>
            <Button
              variant={units === "kg" ? "default" : "outline"}
              className="h-11 rounded-xl"
              onClick={() => setUnits("kg")}
            >
              kg
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );

  const filteredCommonExercises = commonExercises
    .filter((exercise) => !exercises.some((item) => item.key === normalizeExerciseName(exercise)))
    .filter((exercise) => exercise.toLowerCase().includes(newExerciseName.toLowerCase().trim()))
    .slice(0, 8);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="mx-auto h-[calc(100vh-6.75rem)] w-full max-w-3xl overflow-hidden px-3 pt-3 pb-2">
        {activeTab === "exercises" ? renderExercises() : renderProfile()}
      </main>

      <nav className="safe-area-nav fixed inset-x-0 bottom-0 z-50 border-t border-border/70 bg-background/95 backdrop-blur-xl">
        <div className="mx-auto w-full max-w-3xl px-3 pt-2">
          <div className="grid grid-cols-3 items-end gap-2 rounded-2xl border border-border/70 bg-card/50 p-1.5">
            <Button
              variant="ghost"
              className={`h-14 rounded-xl ${
                activeTab === "exercises" ? "bg-background/90 text-primary shadow-sm" : "text-muted-foreground"
              }`}
              onClick={() => {
                setActiveTab("exercises");
                setSelectedExerciseKey(null);
              }}
            >
              <Dumbbell className="h-5 w-5" />
              Exercises
            </Button>

            <div className="flex justify-center">
              <Button
                className="h-14 w-14 -translate-y-3 rounded-full border border-primary/20 bg-primary text-primary-foreground shadow-lg shadow-green-950/30"
                onClick={() => setIsAddExerciseOpen(true)}
              >
                <Plus className="h-6 w-6" />
              </Button>
            </div>

            <Button
              variant="ghost"
              className={`h-14 rounded-xl ${
                activeTab === "profile" ? "bg-background/90 text-primary shadow-sm" : "text-muted-foreground"
              }`}
              onClick={() => {
                setActiveTab("profile");
                setSelectedExerciseKey(null);
              }}
            >
              <User className="h-5 w-5" />
              Profile
            </Button>
          </div>
        </div>
      </nav>

      <Dialog open={isAddExerciseOpen} onOpenChange={setIsAddExerciseOpen}>
        <DialogContent className="w-[calc(100vw-1rem)] max-w-sm overflow-hidden p-4 sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Exercise</DialogTitle>
          </DialogHeader>
          <div className="min-w-0 space-y-3">
            <Input
              className="w-full min-w-0"
              placeholder="Exercise name"
              value={newExerciseName}
              onChange={(event) => {
                const value = event.target.value;
                setNewExerciseName(value);
                setNewExerciseGroup(inferExerciseGroup(value));
              }}
            />
            <div className="grid grid-cols-2 gap-2">
              {exerciseGroups.map((group) => (
                <Button
                  key={group}
                  type="button"
                  variant={newExerciseGroup === group ? "default" : "outline"}
                  className="h-9 rounded-xl"
                  onClick={() => setNewExerciseGroup(group)}
                >
                  {group}
                </Button>
              ))}
            </div>
            {filteredCommonExercises.length > 0 ? (
              <div className="flex max-w-full flex-wrap gap-2 overflow-hidden">
                {filteredCommonExercises.map((exercise) => (
                  <Button
                    key={`suggest-${exercise}`}
                    type="button"
                    variant="outline"
                    className="h-8 max-w-full rounded-full px-3 text-xs"
                    onClick={() => {
                      setNewExerciseName(exercise);
                      setNewExerciseGroup(inferExerciseGroup(exercise));
                    }}
                  >
                    {exercise}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={addExercise}>Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isHistoricalLogOpen} onOpenChange={setIsHistoricalLogOpen}>
        <DialogContent className="w-[calc(100vw-1rem)] max-w-sm overflow-hidden p-4 sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Log Past Session</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input type="date" value={historicalDate} onChange={(event) => setHistoricalDate(event.target.value)} />
            <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
              <Input
                type="number"
                inputMode="decimal"
                placeholder={`Weight (${units})`}
                value={historicalWeight}
                onChange={(event) => setHistoricalWeight(event.target.value)}
              />
              <Input
                type="number"
                inputMode="numeric"
                placeholder="Reps"
                value={historicalReps}
                onChange={(event) => setHistoricalReps(event.target.value)}
              />
              <Button className="rounded-xl px-3" onClick={addHistoricalPendingSet}>
                Add
              </Button>
            </div>
            {historicalPendingSets.length > 0 ? (
              <div className="space-y-2 rounded-2xl border border-green-500/10 bg-green-500/[0.03] p-3">
                <p className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Sets</p>
                <div className="space-y-2">
                  {historicalPendingSets.map((set, index) => (
                    <div
                      key={set.id}
                      className="flex items-center justify-between gap-3 rounded-xl border border-white/6 bg-white/[0.03] px-3 py-2"
                    >
                      <p className="text-sm tabular-nums text-slate-200">
                        {index + 1}. {set.weight} x {set.reps}
                      </p>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 rounded-full text-slate-400"
                        onClick={() => removeHistoricalPendingSet(set.id)}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={saveHistoricalSet} disabled={historicalPendingSets.length === 0}>
              Save Session
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default App;
