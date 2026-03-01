import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Award,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Clock,
  Dumbbell,
  Info,
  LineChart,
  Minus,
  Plus,
  Target,
  TrendingDown,
  TrendingUp,
  Trash2,
  User,
} from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { Exercise, SessionContext, Set, Workout } from "@/types";
import { supabase, supabaseConfigured } from "@/lib/supabase";
import type { User as SupabaseUser } from "@supabase/supabase-js";

const STORAGE_KEY_CURRENT = "gradienttrack_current";
const STORAGE_KEY_HISTORY = "gradienttrack_history";
const STORAGE_KEY_UNITS = "gradienttrack_units";
const STORAGE_KEY_JOIN_DATE = "gradienttrack_join_date";
const STORAGE_KEY_EXERCISE_CATALOG = "gradienttrack_exercise_catalog";
const STORAGE_KEY_BACKFILL = "gradienttrack_backfill_sessions";
const STORAGE_KEY_DASH_ORDER = "gradienttrack_dashboard_order";
const STORAGE_KEY_DASH_TRACKED = "gradienttrack_dashboard_tracked_exercises";
const STORAGE_KEY_DASH_GOALS = "gradienttrack_dashboard_goals";
const STORAGE_KEY_CLOUD_OPT_IN = "gradienttrack_cloud_opt_in";

type Tab = "dashboard" | "exercises" | "workouts" | "profile";
type Units = "lbs" | "kg";
type Trend = "up" | "flat" | "down";
type ExerciseState = "normal" | "stalled" | "breakthrough";
type Confidence = "low" | "high";
type VizMode = "one_rm" | "set_map";
type DashboardMetricId =
  | "weekly_consistency"
  | "key_lift_progress"
  | "bodyweight_trend"
  | "movement_balance";

type BackfillSet = {
  id: string;
  weight: number;
  reps: number;
};

type BackfillSession = {
  id: string;
  exerciseName: string;
  date: string;
  sets: BackfillSet[];
  contextTag?: SessionContext;
};

type ExerciseSessionPoint = {
  id: string;
  date: string;
  label: string;
  sets: Array<{ weight: number; reps: number }>;
  topSet: { weight: number; reps: number };
  est1RM: number;
  adjustedScore: number;
  contextTag?: SessionContext;
};

type TrackedExercise = {
  key: string;
  name: string;
  sessions: ExerciseSessionPoint[];
  totalSets: number;
  totalAdjustedLoad: number;
  est1RM: number;
  workingSet: string;
  trend: Trend;
  state: ExerciseState;
  confidence: Confidence;
  nextTarget: string;
};

type DashboardMetric = {
  id: DashboardMetricId;
  title: string;
  value: string;
  trend: Trend;
  goalUnit: string;
};

type AppSnapshot = {
  currentWorkout: Workout | null;
  history: Workout[];
  units: Units;
  exerciseCatalog: string[];
  backfillSessions: BackfillSession[];
  dashboardOrder: DashboardMetricId[];
  trackedDashboardExercises: string[];
  dashboardGoals: Record<string, number>;
  joinDate: string;
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

const defaultDashboardOrder: DashboardMetricId[] = [
  "weekly_consistency",
  "key_lift_progress",
  "bodyweight_trend",
  "movement_balance",
];
const sessionContextOptions: SessionContext[] = ["great", "normal", "fatigued", "rushed"];

function normalizeExerciseName(name: string) {
  return name.trim().toLowerCase();
}

function estimate1RM(weight: number, reps: number) {
  if (weight <= 0 || reps <= 0 || reps >= 37) return 0;
  return weight * (36 / (37 - reps));
}

function estimateSessionScore(weight: number, reps: number) {
  if (weight <= 0 || reps <= 0) return 0;
  return weight * (1 + reps / 30);
}

function getTrend(values: number[]) {
  if (values.length < 2) return "flat" as Trend;
  const recent = values.slice(-5);
  const baseline = recent[0];
  const latest = recent[recent.length - 1];
  if (baseline <= 0) return "flat" as Trend;
  const pct = ((latest - baseline) / baseline) * 100;
  if (pct >= 2) return "up" as Trend;
  if (pct <= -2) return "down" as Trend;
  return "flat" as Trend;
}

function getConfidence(sessionCount: number): Confidence {
  return sessionCount < 3 ? "low" : "high";
}

function classifyExerciseState(values: number[]): ExerciseState {
  if (values.length < 4) return "normal";
  const latest = values[values.length - 1];
  const recent8 = values.slice(-8);
  const recent4 = values.slice(-4);
  const prior = values.slice(0, -1);

  const priorHigh = prior.length > 0 ? Math.max(...prior) : latest;
  if (latest >= priorHigh * 1.005) return "breakthrough";

  const band = Math.max(...recent4) - Math.min(...recent4);
  const baseline = recent4[0] || 1;
  const driftPct = (band / baseline) * 100;
  if (driftPct < 1.5 && latest < Math.max(...recent8) * 0.995) return "stalled";

  return "normal";
}

function getNextTarget(topSet: { weight: number; reps: number }, trend: Trend, units: Units) {
  const weightStep = units === "kg" ? 2.5 : 5;
  if (topSet.weight <= 0 || topSet.reps <= 0) return "Add a baseline session";
  if (trend === "up") return `Next: ${topSet.weight + weightStep} x ${topSet.reps}`;
  if (trend === "down") return `Next: ${topSet.weight} x ${Math.max(1, topSet.reps + 1)}`;
  return `Next: ${topSet.weight} x ${topSet.reps + 1}`;
}

function triggerHaptic() {
  if (typeof navigator !== "undefined" && "vibrate" in navigator) {
    navigator.vibrate(10);
  }
}

function keepLastThirtyDays(workouts: Workout[]) {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return workouts.filter((workout) => new Date(workout.date).getTime() > cutoff);
}

function formatShortDate(date: string) {
  return new Date(date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function toDateInputValue(date = new Date()) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function moveItem<T>(list: T[], fromIndex: number, toIndex: number) {
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return list;
  const cloned = [...list];
  const [moved] = cloned.splice(fromIndex, 1);
  if (!moved) return list;
  cloned.splice(toIndex, 0, moved);
  return cloned;
}

function buildChartScale(values: number[]) {
  const min = 0;
  const max = Math.max(...values);
  const span = Math.max(max - min, 1);
  const lower = min;
  const upper = max + span * 0.12;
  const domain = Math.max(upper - lower, 1);
  const toY = (value: number) => 90 - ((value - lower) / domain) * 80;
  const ticks = [upper, lower + domain / 2, lower].map((tick) => Math.round(tick));

  return { lower, upper, toY, ticks };
}

function toTemplateWorkout(template: Workout) {
  return {
    id: uuidv4(),
    date: new Date().toISOString(),
    name: `${template.name || "Workout"} (Template)`,
    contextTag: template.contextTag ?? "normal",
    exercises: template.exercises.map((exercise) => ({
      ...exercise,
      id: uuidv4(),
      sets: exercise.sets.map((set) => ({
        ...set,
        id: uuidv4(),
        completed: false,
      })),
    })),
  };
}

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");

  const [currentWorkout, setCurrentWorkout] = useState<Workout | null>(() => {
    const saved = localStorage.getItem(STORAGE_KEY_CURRENT);
    return saved ? JSON.parse(saved) : null;
  });
  const [history, setHistory] = useState<Workout[]>(() => {
    const saved = localStorage.getItem(STORAGE_KEY_HISTORY);
    if (!saved) return [];
    return keepLastThirtyDays(JSON.parse(saved) as Workout[]);
  });
  const [units, setUnits] = useState<Units>(
    () => (localStorage.getItem(STORAGE_KEY_UNITS) as Units | null) ?? "lbs",
  );
  const [joinDate] = useState<string>(() => {
    const stored = localStorage.getItem(STORAGE_KEY_JOIN_DATE);
    if (stored) return stored;
    const now = new Date().toISOString();
    localStorage.setItem(STORAGE_KEY_JOIN_DATE, now);
    return now;
  });

  const [exerciseCatalog, setExerciseCatalog] = useState<string[]>(() => {
    const saved = localStorage.getItem(STORAGE_KEY_EXERCISE_CATALOG);
    if (!saved) return [];
    return JSON.parse(saved) as string[];
  });
  const [backfillSessions, setBackfillSessions] = useState<BackfillSession[]>(() => {
    const saved = localStorage.getItem(STORAGE_KEY_BACKFILL);
    if (!saved) return [];
    return JSON.parse(saved) as BackfillSession[];
  });
  const [dashboardOrder, setDashboardOrder] = useState<DashboardMetricId[]>(() => {
    const saved = localStorage.getItem(STORAGE_KEY_DASH_ORDER);
    if (!saved) return defaultDashboardOrder;
    const parsed = JSON.parse(saved) as DashboardMetricId[];
    const valid = parsed.filter((id) => defaultDashboardOrder.includes(id));
    return valid.length > 0 ? valid : defaultDashboardOrder;
  });
  const [trackedDashboardExercises, setTrackedDashboardExercises] = useState<string[]>(() => {
    const saved = localStorage.getItem(STORAGE_KEY_DASH_TRACKED);
    if (!saved) return [];
    return JSON.parse(saved) as string[];
  });
  const [dashboardGoals, setDashboardGoals] = useState<Record<string, number>>(() => {
    const saved = localStorage.getItem(STORAGE_KEY_DASH_GOALS);
    if (!saved) return {};
    return JSON.parse(saved) as Record<string, number>;
  });
  const [isDashboardManageOpen, setIsDashboardManageOpen] = useState(false);
  const [goalEditor, setGoalEditor] = useState<{ key: string; label: string; value: string } | null>(
    null,
  );

  const [expandedExerciseId, setExpandedExerciseId] = useState<string | null>(null);
  const [workoutName, setWorkoutName] = useState("");
  const [isFinishDialogOpen, setIsFinishDialogOpen] = useState(false);
  const [isAddSheetOpen, setIsAddSheetOpen] = useState(false);
  const [isQuickStartOpen, setIsQuickStartOpen] = useState(false);
  const [isTemplatePickerOpen, setIsTemplatePickerOpen] = useState(false);

  const [newExerciseName, setNewExerciseName] = useState("");
  const [newWeight, setNewWeight] = useState<number | "">("");
  const [newReps, setNewReps] = useState<number | "">("");
  const [isExercisePickerOpen, setIsExercisePickerOpen] = useState(false);
  const [exerciseSearch, setExerciseSearch] = useState("");

  const [selectedExerciseKey, setSelectedExerciseKey] = useState<string | null>(null);
  const [exerciseVizMode, setExerciseVizMode] = useState<VizMode>("one_rm");

  const [isAddExerciseDialogOpen, setIsAddExerciseDialogOpen] = useState(false);
  const [newCatalogExerciseName, setNewCatalogExerciseName] = useState("");

  const [isBackfillDialogOpen, setIsBackfillDialogOpen] = useState(false);
  const [backfillExerciseName, setBackfillExerciseName] = useState("");
  const [backfillDate, setBackfillDate] = useState(toDateInputValue());
  const [backfillContextTag, setBackfillContextTag] = useState<SessionContext>("normal");
  const [backfillSetsDraft, setBackfillSetsDraft] = useState<BackfillSet[]>([
    { id: uuidv4(), weight: 0, reps: 0 },
  ]);
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
    if (currentWorkout) {
      localStorage.setItem(STORAGE_KEY_CURRENT, JSON.stringify(currentWorkout));
    } else {
      localStorage.removeItem(STORAGE_KEY_CURRENT);
    }
  }, [currentWorkout]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(history));
  }, [history]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_UNITS, units);
  }, [units]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_EXERCISE_CATALOG, JSON.stringify(exerciseCatalog));
  }, [exerciseCatalog]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_BACKFILL, JSON.stringify(backfillSessions));
  }, [backfillSessions]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_DASH_ORDER, JSON.stringify(dashboardOrder));
  }, [dashboardOrder]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_DASH_TRACKED, JSON.stringify(trackedDashboardExercises));
  }, [trackedDashboardExercises]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_DASH_GOALS, JSON.stringify(dashboardGoals));
  }, [dashboardGoals]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_CLOUD_OPT_IN, cloudOptIn ? "true" : "false");
    if (!cloudOptIn) {
      setDidInitialCloudSync(false);
      setAuthMessage("Cloud save disabled. Data stays on this device.");
    }
  }, [cloudOptIn]);

  useEffect(() => {
    if (!supabaseConfigured) return;
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

  useEffect(() => {
    if (!localStorage.getItem(STORAGE_KEY_JOIN_DATE)) {
      localStorage.setItem(STORAGE_KEY_JOIN_DATE, joinDate);
    }
  }, [joinDate]);

  const getLocalSnapshot = (): AppSnapshot => ({
    currentWorkout,
    history,
    units,
    exerciseCatalog,
    backfillSessions,
    dashboardOrder,
    trackedDashboardExercises,
    dashboardGoals,
    joinDate,
  });

  const applySnapshot = (snapshot: AppSnapshot) => {
    setCurrentWorkout(snapshot.currentWorkout);
    setHistory(keepLastThirtyDays(snapshot.history));
    setUnits(snapshot.units);
    setExerciseCatalog(snapshot.exerciseCatalog);
    setBackfillSessions(snapshot.backfillSessions);
    setDashboardOrder(snapshot.dashboardOrder);
    setTrackedDashboardExercises(snapshot.trackedDashboardExercises);
    setDashboardGoals(snapshot.dashboardGoals);
  };

  const normalizeDashboardOrder = (order: DashboardMetricId[]) => {
    const valid = order.filter((id) => defaultDashboardOrder.includes(id));
    const missing = defaultDashboardOrder.filter((id) => !valid.includes(id));
    return [...valid, ...missing];
  };

  const mergeSnapshots = (local: AppSnapshot, cloud: AppSnapshot): AppSnapshot => {
    const mergedHistoryMap = new Map<string, Workout>();
    [...cloud.history, ...local.history].forEach((workout) => {
      const existing = mergedHistoryMap.get(workout.id);
      if (!existing) {
        mergedHistoryMap.set(workout.id, workout);
        return;
      }
      if (new Date(workout.date).getTime() > new Date(existing.date).getTime()) {
        mergedHistoryMap.set(workout.id, workout);
      }
    });

    const mergedBackfillMap = new Map<string, BackfillSession>();
    [...cloud.backfillSessions, ...local.backfillSessions].forEach((session) => {
      const existing = mergedBackfillMap.get(session.id);
      if (!existing) {
        mergedBackfillMap.set(session.id, session);
        return;
      }
      if (new Date(session.date).getTime() > new Date(existing.date).getTime()) {
        mergedBackfillMap.set(session.id, session);
      }
    });

    const mergedCatalog = [...cloud.exerciseCatalog];
    local.exerciseCatalog.forEach((name) => {
      const normalized = normalizeExerciseName(name);
      if (!mergedCatalog.some((item) => normalizeExerciseName(item) === normalized)) {
        mergedCatalog.push(name);
      }
    });

    const mergedTracked = [...cloud.trackedDashboardExercises];
    local.trackedDashboardExercises.forEach((key) => {
      if (!mergedTracked.includes(key)) mergedTracked.push(key);
    });

    const localCurrentTime = local.currentWorkout ? new Date(local.currentWorkout.date).getTime() : 0;
    const cloudCurrentTime = cloud.currentWorkout ? new Date(cloud.currentWorkout.date).getTime() : 0;
    const currentWorkoutMerged =
      localCurrentTime >= cloudCurrentTime ? local.currentWorkout : cloud.currentWorkout;

    const localJoin = new Date(local.joinDate).getTime();
    const cloudJoin = new Date(cloud.joinDate).getTime();

    return {
      currentWorkout: currentWorkoutMerged,
      history: keepLastThirtyDays(
        Array.from(mergedHistoryMap.values()).sort(
          (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
        ),
      ),
      units: local.units ?? cloud.units,
      exerciseCatalog: mergedCatalog,
      backfillSessions: Array.from(mergedBackfillMap.values()).sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
      ),
      dashboardOrder: normalizeDashboardOrder(
        Array.from(new Set([...cloud.dashboardOrder, ...local.dashboardOrder])) as DashboardMetricId[],
      ),
      trackedDashboardExercises: mergedTracked,
      dashboardGoals: { ...cloud.dashboardGoals, ...local.dashboardGoals },
      joinDate: localJoin < cloudJoin ? local.joinDate : cloud.joinDate,
    };
  };

  const workoutBasedSessions = useMemo(() => {
    const workouts = [...history, ...(currentWorkout ? [currentWorkout] : [])].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    );

    const sessions: BackfillSession[] = [];
    workouts.forEach((workout) => {
      workout.exercises.forEach((exercise) => {
        if (exercise.sets.length === 0) return;
        sessions.push({
          id: `${workout.id}-${exercise.id}`,
          exerciseName: exercise.name,
          date: workout.date,
          contextTag: workout.contextTag,
          sets: exercise.sets.map((set) => ({
            id: set.id,
            weight: set.weight,
            reps: set.reps,
          })),
        });
      });
    });

    return sessions;
  }, [currentWorkout, history]);

  const trackedExercises = useMemo<TrackedExercise[]>(() => {
    const grouped = new Map<string, TrackedExercise>();
    const combinedSessions = [...workoutBasedSessions, ...backfillSessions].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    );

    combinedSessions.forEach((session) => {
      const key = normalizeExerciseName(session.exerciseName);
      if (!key) return;

      const cleanedSets = session.sets.filter((set) => set.weight > 0 && set.reps > 0);
      if (cleanedSets.length === 0) return;

      const topSet = cleanedSets.reduce((best, current) => {
        const bestScore = estimateSessionScore(best.weight, best.reps);
        const currentScore = estimateSessionScore(current.weight, current.reps);
        return currentScore > bestScore ? current : best;
      }, cleanedSets[0]);

      const adjustedScore =
        cleanedSets.reduce((sum, set) => sum + estimateSessionScore(set.weight, set.reps), 0) /
        cleanedSets.length;

      const point: ExerciseSessionPoint = {
        id: session.id,
        date: session.date,
        label: formatShortDate(session.date),
        sets: cleanedSets.map((set) => ({ weight: set.weight, reps: set.reps })),
        topSet: { weight: topSet.weight, reps: topSet.reps },
        est1RM: estimate1RM(topSet.weight, topSet.reps),
        adjustedScore,
        contextTag: session.contextTag,
      };

      const existing = grouped.get(key);
      if (!existing) {
        grouped.set(key, {
          key,
          name: session.exerciseName.trim(),
          sessions: [point],
          totalSets: cleanedSets.length,
          totalAdjustedLoad: point.adjustedScore,
          est1RM: Math.round(point.est1RM),
          workingSet: `${topSet.weight} x ${topSet.reps}`,
          trend: "flat",
          state: "normal",
          confidence: "low",
          nextTarget: "Add a baseline session",
        });
        return;
      }

      existing.sessions.push(point);
      existing.totalSets += cleanedSets.length;
      existing.totalAdjustedLoad += point.adjustedScore;
    });

    exerciseCatalog.forEach((exerciseName) => {
      const key = normalizeExerciseName(exerciseName);
      if (!key || grouped.has(key)) return;
      grouped.set(key, {
        key,
        name: exerciseName,
        sessions: [],
        totalSets: 0,
        totalAdjustedLoad: 0,
        est1RM: 0,
        workingSet: "No data",
        trend: "flat",
        state: "normal",
        confidence: "low",
        nextTarget: "Add a baseline session",
      });
    });

    commonExercises.forEach((exerciseName) => {
      const key = normalizeExerciseName(exerciseName);
      if (!key || grouped.has(key)) return;
      grouped.set(key, {
        key,
        name: exerciseName,
        sessions: [],
        totalSets: 0,
        totalAdjustedLoad: 0,
        est1RM: 0,
        workingSet: "No data",
        trend: "flat",
        state: "normal",
        confidence: "low",
        nextTarget: "Add a baseline session",
      });
    });

    return Array.from(grouped.values())
      .map((exercise) => {
        if (exercise.sessions.length === 0) return exercise;
        const sessions = [...exercise.sessions].sort(
          (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
        );
        const latest = sessions[sessions.length - 1];
        const derivedTrend = getTrend(sessions.map((session) => session.adjustedScore));
        const confidence = getConfidence(sessions.length);

        return {
          ...exercise,
          sessions,
          est1RM: Math.round(latest.est1RM),
          workingSet: `${latest.topSet.weight} x ${latest.topSet.reps}`,
          trend: confidence === "low" ? "flat" : derivedTrend,
          state: classifyExerciseState(sessions.map((session) => session.adjustedScore)),
          confidence,
          nextTarget: getNextTarget(latest.topSet, derivedTrend, units),
        };
      })
      .sort((a, b) => {
        if (b.totalAdjustedLoad !== a.totalAdjustedLoad) {
          return b.totalAdjustedLoad - a.totalAdjustedLoad;
        }
        return a.name.localeCompare(b.name);
      });
  }, [backfillSessions, exerciseCatalog, units, workoutBasedSessions]);

  const trackedByKey = useMemo(
    () => new Map(trackedExercises.map((exercise) => [exercise.key, exercise])),
    [trackedExercises],
  );

  const selectedExercise = selectedExerciseKey ? trackedByKey.get(selectedExerciseKey) : undefined;

  const dashboardMetrics = useMemo<DashboardMetric[]>(() => {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fiveWeeksAgo = new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000);

    const weeklySessions = history.filter(
      (workout) => new Date(workout.date).getTime() >= sevenDaysAgo.getTime(),
    ).length;

    const benchmark = trackedExercises.find(
      (exercise) => exercise.key === "bench press" || exercise.sessions.length > 0,
    );

    const recentPatternExercises = trackedExercises.filter((exercise) =>
      exercise.sessions.some((session) => new Date(session.date).getTime() >= fiveWeeksAgo.getTime()),
    );

    const patternKeywords: Record<string, string[]> = {
      squat: ["squat", "leg press", "goblet"],
      hinge: ["deadlift", "romanian", "rdl", "hip"],
      push: ["bench", "press", "dip", "tricep"],
      pull: ["row", "pull", "lat", "curl"],
      lunge: ["lunge", "split squat"],
      shoulder: ["overhead", "lateral", "face pull", "arnold"],
    };

    const hitPatterns = Object.values(patternKeywords).filter((keywords) =>
      recentPatternExercises.some((exercise) =>
        keywords.some((keyword) => exercise.key.includes(keyword)),
      ),
    ).length;

    return [
      {
        id: "weekly_consistency",
        title: "Weekly Sessions",
        value: `${weeklySessions}/5 this week`,
        trend: weeklySessions >= 4 ? "up" : weeklySessions >= 3 ? "flat" : "down",
        goalUnit: "sessions",
      },
      {
        id: "key_lift_progress",
        title: benchmark ? `${benchmark.name} Progress` : "Key Lift Progress",
        value: benchmark ? `${benchmark.workingSet} • ${benchmark.est1RM} est` : "225 x 8 • 285 est",
        trend: benchmark ? benchmark.trend : "up",
        goalUnit: `est 1RM (${units})`,
      },
      {
        id: "bodyweight_trend",
        title: "Bodyweight Trend",
        value: units === "lbs" ? "185.0 lbs" : "83.9 kg",
        trend: "flat",
        goalUnit: units,
      },
      {
        id: "movement_balance",
        title: "Movement Balance",
        value: `${hitPatterns}/6 patterns hit`,
        trend: hitPatterns >= 5 ? "up" : hitPatterns >= 4 ? "flat" : "down",
        goalUnit: "patterns",
      },
    ];
  }, [history, trackedExercises, units]);

  const orderedDashboardMetrics = useMemo(() => {
    const metricMap = new Map(dashboardMetrics.map((metric) => [metric.id, metric]));
    return dashboardOrder
      .map((id) => metricMap.get(id))
      .filter((metric): metric is DashboardMetric => Boolean(metric));
  }, [dashboardMetrics, dashboardOrder]);

  const weeklyInsights = useMemo(() => {
    const now = Date.now();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const plannedSessions = 4;
    const completedSessions = history.filter(
      (workout) => new Date(workout.date).getTime() >= weekAgo,
    ).length;

    const touchedExerciseKeys = new Set<string>();
    history
      .filter((workout) => new Date(workout.date).getTime() >= weekAgo)
      .forEach((workout) => {
        workout.exercises.forEach((exercise) => touchedExerciseKeys.add(normalizeExerciseName(exercise.name)));
      });

    const exerciseTouchRate =
      trackedExercises.length > 0 ? Math.round((touchedExerciseKeys.size / trackedExercises.length) * 100) : 0;

    return {
      plannedSessions,
      completedSessions,
      adherencePct: Math.round((completedSessions / plannedSessions) * 100),
      exerciseTouchRate,
    };
  }, [history, trackedExercises]);

  const todayFocus = useMemo(() => {
    const now = Date.now();
    return trackedExercises
      .filter((exercise) => exercise.sessions.length > 0)
      .map((exercise) => {
        const lastSession = exercise.sessions[exercise.sessions.length - 1];
        const lastTime = new Date(lastSession.date).getTime();
        const daysSince = Math.floor((now - lastTime) / (24 * 60 * 60 * 1000));
        const stateBoost = exercise.state === "stalled" ? 6 : exercise.state === "breakthrough" ? -2 : 0;
        const trendBoost = exercise.trend === "down" ? 5 : exercise.trend === "flat" ? 2 : 0;
        return {
          key: exercise.key,
          name: exercise.name,
          daysSince,
          reason: exercise.state === "stalled" ? "stalled" : `${daysSince}d since last`,
          score: daysSince + stateBoost + trendBoost,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
  }, [trackedExercises]);

  const dashboardTrackedExercises = useMemo(
    () =>
      trackedDashboardExercises
        .map((key) => trackedByKey.get(key))
        .filter((exercise): exercise is TrackedExercise => Boolean(exercise)),
    [trackedByKey, trackedDashboardExercises],
  );

  const moveMetricByDirection = (metricId: DashboardMetricId, direction: "up" | "down") => {
    setDashboardOrder((prev) => {
      const fromIndex = prev.indexOf(metricId);
      if (fromIndex < 0) return prev;
      const toIndex = direction === "up" ? fromIndex - 1 : fromIndex + 1;
      if (toIndex < 0 || toIndex >= prev.length) return prev;
      triggerHaptic();
      return moveItem(prev, fromIndex, toIndex);
    });
  };

  const toggleSystemMetric = (metricId: DashboardMetricId) => {
    setDashboardOrder((prev) => {
      triggerHaptic();
      if (prev.includes(metricId)) return prev.filter((id) => id !== metricId);
      return [...prev, metricId];
    });
  };

  const toggleTrackedExercise = (exerciseKey: string) => {
    setTrackedDashboardExercises((prev) => {
      triggerHaptic();
      if (prev.includes(exerciseKey)) return prev.filter((key) => key !== exerciseKey);
      return [...prev, exerciseKey];
    });
  };

  const openGoalEditor = (key: string, label: string) => {
    setGoalEditor({
      key,
      label,
      value: dashboardGoals[key] ? `${dashboardGoals[key]}` : "",
    });
  };

  const saveGoal = () => {
    if (!goalEditor) return;
    const parsed = Number(goalEditor.value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setDashboardGoals((prev) => {
        const next = { ...prev };
        delete next[goalEditor.key];
        return next;
      });
      triggerHaptic();
      setGoalEditor(null);
      return;
    }
    setDashboardGoals((prev) => ({ ...prev, [goalEditor.key]: parsed }));
    triggerHaptic();
    setGoalEditor(null);
  };

  const nudgeGoal = (amount: number, mode: "add" | "pct") => {
    setGoalEditor((prev) => {
      if (!prev) return prev;
      const current = Number(prev.value) || 0;
      const next = mode === "add" ? current + amount : current + current * (amount / 100);
      triggerHaptic();
      return { ...prev, value: `${Math.max(0, Number(next.toFixed(2)))}` };
    });
  };

  const renderTrendIcon = (trend: Trend, className?: string) => {
    if (trend === "up") {
      return (
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400">
          <TrendingUp className={className ?? "h-4 w-4"} />
        </span>
      );
    }
    if (trend === "down") {
      return (
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-red-500/20 text-red-400">
          <TrendingDown className={className ?? "h-4 w-4"} />
        </span>
      );
    }
    return (
      <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-yellow-500/20 text-yellow-300">
        <Minus className={className ?? "h-4 w-4"} />
      </span>
    );
  };

  const renderExerciseStateBadge = (exercise: TrackedExercise) => {
    if (exercise.state === "breakthrough") {
      return (
        <span className="inline-flex items-center gap-1 rounded-md border border-emerald-400/40 bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-300">
          <Award className="h-3 w-3" />
          Breakthrough
        </span>
      );
    }
    if (exercise.state === "stalled") {
      return (
        <span className="inline-flex items-center gap-1 rounded-md border border-yellow-400/40 bg-yellow-500/15 px-2 py-0.5 text-[11px] text-yellow-300">
          <AlertTriangle className="h-3 w-3" />
          Stalled
        </span>
      );
    }
    return null;
  };

  const openBackfillDialog = (exerciseName: string) => {
    setBackfillExerciseName(exerciseName);
    setBackfillDate(toDateInputValue());
    setBackfillContextTag("normal");
    setBackfillSetsDraft([{ id: uuidv4(), weight: 0, reps: 0 }]);
    setIsBackfillDialogOpen(true);
  };

  const openExerciseDetail = (exerciseKey: string) => {
    setSelectedExerciseKey(exerciseKey);
  };

  const changeExerciseVizMode = (mode: VizMode) => {
    setExerciseVizMode(mode);
  };

  const loadCloudSnapshot = async (userId: string) => {
    const { data, error } = await supabase
      .from("user_state")
      .select("payload")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) throw error;
    if (!data?.payload) return null;
    return data.payload as AppSnapshot;
  };

  const saveCloudSnapshot = async (userId: string, snapshot: AppSnapshot) => {
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
      const local = getLocalSnapshot();
      const cloud = (await loadCloudSnapshot(authUser.id)) ?? local;
      const merged = mergeSnapshots(local, cloud);
      applySnapshot(merged);
      await saveCloudSnapshot(authUser.id, merged);
      setAuthMessage("Cloud sync complete.");
      setDidInitialCloudSync(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Cloud sync failed.";
      setAuthMessage(message);
    } finally {
      setIsSyncingCloud(false);
    }
  };

  const signUpWithEmail = async () => {
    if (!authEmail.trim() || !authPassword.trim()) {
      setAuthMessage("Enter email and password first.");
      return;
    }
    setIsAuthLoading(true);
    setAuthMessage("");
    try {
      const primaryAttempt = await supabase.auth.signUp({
        email: authEmail.trim(),
        password: authPassword,
        options: { emailRedirectTo: window.location.origin },
      });
      if (primaryAttempt.error) {
        const fallbackAttempt = await supabase.auth.signUp({
          email: authEmail.trim(),
          password: authPassword,
        });
        if (fallbackAttempt.error) throw fallbackAttempt.error;
        setAuthMessage(
          "Check your email to verify your account. Redirect URL wasn&apos;t configured, but signup succeeded.",
        );
        setNeedsEmailVerification(true);
        return;
      }
      setAuthMessage("Check your email to verify your account, then log in.");
      setNeedsEmailVerification(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sign up failed.";
      setAuthMessage(message);
    } finally {
      setIsAuthLoading(false);
    }
  };

  const signInWithEmail = async () => {
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
      const normalized = message.toLowerCase();
      if (normalized.includes("email not confirmed") || normalized.includes("not confirmed")) {
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
    if (!authEmail.trim()) {
      setAuthMessage("Enter your email, then tap resend.");
      return;
    }
    setIsAuthLoading(true);
    setAuthMessage("");
    try {
      const attempt = await supabase.auth.resend({
        type: "signup",
        email: authEmail.trim(),
        options: { emailRedirectTo: window.location.origin },
      });
      if (attempt.error) {
        const fallback = await supabase.auth.resend({
          type: "signup",
          email: authEmail.trim(),
        });
        if (fallback.error) throw fallback.error;
      }
      setAuthMessage("Verification email sent. Check inbox/spam, then log in.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to resend email.";
      setAuthMessage(message);
    } finally {
      setIsAuthLoading(false);
    }
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setAuthMessage("Signed out. Local data remains on this device.");
  };

  useEffect(() => {
    if (!cloudOptIn || !authUser || !supabaseConfigured || didInitialCloudSync) return;
    void syncCloudNow();
  }, [authUser, cloudOptIn, didInitialCloudSync]);

  useEffect(() => {
    if (!cloudOptIn || !authUser || !supabaseConfigured || !didInitialCloudSync || isSyncingCloud) return;
    const timeoutId = window.setTimeout(() => {
      void saveCloudSnapshot(authUser.id, getLocalSnapshot()).catch(() => {
        setAuthMessage("Auto-sync failed. Tap Sync Now.");
      });
    }, 500);
    return () => window.clearTimeout(timeoutId);
  }, [
    authUser,
    cloudOptIn,
    currentWorkout,
    dashboardGoals,
    dashboardOrder,
    didInitialCloudSync,
    exerciseCatalog,
    history,
    isSyncingCloud,
    backfillSessions,
    trackedDashboardExercises,
    units,
  ]);

  const startWorkout = (template?: Workout) => {
    const newWorkout = template
      ? toTemplateWorkout(template)
      : {
          id: uuidv4(),
          date: new Date().toISOString(),
          name: `Workout ${new Date().toLocaleDateString()}`,
          exercises: [],
          contextTag: "normal" as SessionContext,
        };

    setCurrentWorkout(newWorkout);
    setExpandedExerciseId(newWorkout.exercises[0]?.id ?? null);
    setActiveTab("workouts");
    setIsQuickStartOpen(false);
    setIsTemplatePickerOpen(false);
  };

  const continueWorkout = () => {
    setActiveTab("workouts");
    setIsQuickStartOpen(false);
  };

  const setCurrentWorkoutContextTag = (tag: SessionContext) => {
    setCurrentWorkout((prev) => (prev ? { ...prev, contextTag: tag } : prev));
  };

  const addExerciseToWorkout = () => {
    if (!currentWorkout || !newExerciseName.trim() || !newWeight || !newReps) return;

    const newSet: Set = {
      id: uuidv4(),
      weight: Number(newWeight),
      reps: Number(newReps),
      completed: false,
    };

    const newExercise: Exercise = {
      id: uuidv4(),
      name: newExerciseName.trim(),
      sets: [newSet],
    };

    setCurrentWorkout((prev) =>
      prev ? { ...prev, exercises: [...prev.exercises, newExercise] } : prev,
    );

    const normalized = normalizeExerciseName(newExercise.name);
    setExerciseCatalog((prev) => {
      if (prev.some((item) => normalizeExerciseName(item) === normalized)) return prev;
      return [...prev, newExercise.name];
    });

    setNewExerciseName("");
    setNewWeight("");
    setNewReps("");
    setExerciseSearch("");
    setIsExercisePickerOpen(false);
    setIsAddSheetOpen(false);
    setExpandedExerciseId(newExercise.id);
  };

  const updateSet = (
    exerciseId: string,
    setIndex: number,
    field: "weight" | "reps",
    newValue: number,
  ) => {
    if (!currentWorkout) return;

    setCurrentWorkout((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        exercises: prev.exercises.map((exercise) =>
          exercise.id === exerciseId
            ? {
                ...exercise,
                sets: exercise.sets.map((set, index) =>
                  index === setIndex ? { ...set, [field]: newValue } : set,
                ),
              }
            : exercise,
        ),
      };
    });
  };

  const deleteSet = (exerciseId: string, setIndex: number) => {
    if (!currentWorkout) return;

    setCurrentWorkout((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        exercises: prev.exercises
          .map((exercise) =>
            exercise.id === exerciseId
              ? {
                  ...exercise,
                  sets: exercise.sets.filter((_, index) => index !== setIndex),
                }
              : exercise,
          )
          .filter((exercise) => exercise.sets.length > 0),
      };
    });
  };

  const finishWorkout = () => {
    if (!currentWorkout) return;

    const finalName =
      workoutName.trim() || `Workout ${new Date(currentWorkout.date).toLocaleDateString()}`;
    const finished = { ...currentWorkout, name: finalName };

    setHistory((prev) => keepLastThirtyDays([finished, ...prev]));
    setCurrentWorkout(null);
    setExpandedExerciseId(null);
    setWorkoutName("");
    setIsFinishDialogOpen(false);
    setActiveTab("workouts");
  };

  const addExerciseFromExercisesTab = () => {
    const name = newCatalogExerciseName.trim();
    if (!name) return;

    const normalized = normalizeExerciseName(name);
    setExerciseCatalog((prev) => {
      if (prev.some((exercise) => normalizeExerciseName(exercise) === normalized)) return prev;
      return [...prev, name];
    });

    setSelectedExerciseKey(normalized);
    setNewCatalogExerciseName("");
    setIsAddExerciseDialogOpen(false);
  };

  const saveBackfillSession = () => {
    const cleanExercise = backfillExerciseName.trim();
    if (!cleanExercise) return;

    const validSets = backfillSetsDraft
      .map((set) => ({ ...set, weight: Number(set.weight), reps: Number(set.reps) }))
      .filter((set) => set.weight > 0 && set.reps > 0);

    if (validSets.length === 0) return;

    const sessionDate = backfillDate
      ? new Date(`${backfillDate}T12:00:00`).toISOString()
      : new Date().toISOString();

    const newSession: BackfillSession = {
      id: uuidv4(),
      exerciseName: cleanExercise,
      date: sessionDate,
      sets: validSets,
      contextTag: backfillContextTag,
    };

    const normalized = normalizeExerciseName(cleanExercise);
    setExerciseCatalog((prev) => {
      if (prev.some((exercise) => normalizeExerciseName(exercise) === normalized)) return prev;
      return [...prev, cleanExercise];
    });

    setBackfillSessions((prev) => [...prev, newSession]);
    setSelectedExerciseKey(normalized);
    setIsBackfillDialogOpen(false);
  };

  const filteredCommonExercises = commonExercises.filter((exercise) =>
    exercise.toLowerCase().includes(exerciseSearch.toLowerCase().trim()),
  );

  const renderDashboard = () => {
    return (
      <div className="flex h-full flex-col gap-4">
        <div className="flex items-center justify-between">
          <h1 className="text-4xl font-bold bg-gradient-to-r from-emerald-300 via-emerald-400 to-cyan-400 bg-clip-text text-transparent">
            GradientTrack
          </h1>
          <Button
            variant="outline"
            className="h-9 border-emerald-600/30"
            onClick={() => setIsDashboardManageOpen(true)}
          >
            Manage
          </Button>
        </div>

        <Card className="gradient-card flex-1">
          <CardContent className="space-y-3">
            <div className="space-y-3">
              {orderedDashboardMetrics.map((metric, index) => (
                <div
                  key={metric.id}
                  className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-border/60 bg-background/65 px-4 py-4"
                >
                  <div>{renderTrendIcon(metric.trend)}</div>

                  <div className="min-w-0">
                    <p className="truncate text-xs uppercase tracking-wide text-muted-foreground">
                      {metric.title}
                    </p>
                    <p className="truncate text-lg font-semibold">{metric.value}</p>
                    {dashboardGoals[metric.id] ? (
                      <p className="text-xs text-cyan-300/90">
                        Goal: {dashboardGoals[metric.id]} {metric.goalUnit}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex flex-col gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 rounded-md text-cyan-300"
                      onClick={() => openGoalEditor(metric.id, metric.title)}
                    >
                      <Target className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 rounded-md text-muted-foreground"
                      onClick={() => moveMetricByDirection(metric.id, "up")}
                      disabled={index === 0}
                    >
                      <ChevronUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 rounded-md text-muted-foreground"
                      onClick={() => moveMetricByDirection(metric.id, "down")}
                      disabled={index === orderedDashboardMetrics.length - 1}
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>

            {dashboardTrackedExercises.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Tracked Exercises</p>
                {dashboardTrackedExercises.map((exercise) => {
                  const goalKey = `exercise:${exercise.key}`;
                  return (
                    <div
                      key={exercise.key}
                      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-border/60 bg-background/65 px-4 py-4"
                    >
                      <div>{renderTrendIcon(exercise.trend)}</div>
                      <div className="min-w-0">
                        <p className="truncate text-xs uppercase tracking-wide text-muted-foreground">
                          {exercise.name}
                        </p>
                        <p className="truncate text-lg font-semibold">
                          {exercise.workingSet} • {exercise.est1RM} est
                        </p>
                        {dashboardGoals[goalKey] ? (
                          <p className="text-xs text-cyan-300/90">
                            Goal: {dashboardGoals[goalKey]} est 1RM ({units})
                          </p>
                        ) : null}
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 rounded-md text-cyan-300"
                        onClick={() => openGoalEditor(goalKey, exercise.name)}
                      >
                        <Target className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            ) : null}

            <div className="grid grid-cols-2 gap-2 rounded-xl border border-border/60 bg-background/60 px-4 py-3">
              <div>
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Weekly Adherence</p>
                <p className="text-sm font-semibold">
                  {weeklyInsights.completedSessions}/{weeklyInsights.plannedSessions} ({weeklyInsights.adherencePct}%)
                </p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Exercise Touch Rate</p>
                <p className="text-sm font-semibold">{weeklyInsights.exerciseTouchRate}%</p>
              </div>
            </div>

            {todayFocus.length > 0 ? (
              <div className="rounded-xl border border-border/60 bg-background/60 px-4 py-3">
                <p className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">Today Focus</p>
                <div className="space-y-1.5">
                  {todayFocus.map((item) => (
                    <button
                      key={`focus-${item.key}`}
                      type="button"
                      className="flex w-full items-center justify-between rounded-md px-1 py-1 text-left hover:bg-secondary/20"
                      onClick={() => {
                        setActiveTab("exercises");
                        setSelectedExerciseKey(item.key);
                      }}
                    >
                      <span className="text-sm font-medium">{item.name}</span>
                      <span className="text-xs text-muted-foreground">{item.reason}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    );
  };

  const renderExerciseDetail = (exercise: TrackedExercise) => {
    const hasEnoughData = exercise.totalSets >= 2;
    const sessions = exercise.sessions;
    const latestSession = sessions[sessions.length - 1];

    const allSets = sessions.flatMap((session, sessionIndex) =>
      session.sets.map((set, setIndex) => ({
        id: `${session.id}-${setIndex}`,
        sessionLabel: session.label,
        sessionIndex,
        setIndex,
        weight: set.weight,
        reps: set.reps,
        score: estimateSessionScore(set.weight, set.reps),
      })),
    );

    const rmScale = buildChartScale(
      sessions.length > 0 ? sessions.map((item) => item.est1RM) : [0],
    );
    const adjustedScale = buildChartScale(
      sessions.length > 0 ? sessions.map((item) => item.adjustedScore) : [0],
    );
    const weightScale = buildChartScale(
      allSets.length > 0 ? allSets.map((set) => set.weight) : [0],
    );

    const maxScore = Math.max(...allSets.map((set) => set.score), 1);
    const minScore = Math.min(...allSets.map((set) => set.score), 0);
    const scoreSpan = Math.max(maxScore - minScore, 1);

    const getX = (index: number, length: number) => (length === 1 ? 54 : 12 + (index / (length - 1)) * 84);

    const sessionLinePoints = sessions
      .map((session, index) => `${getX(index, sessions.length)},${rmScale.toY(session.est1RM)}`)
      .join(" ");

    const adjustedLinePoints = sessions
      .map(
        (session, index) => `${getX(index, sessions.length)},${adjustedScale.toY(session.adjustedScore)}`,
      )
      .join(" ");

    const chartInfo = {
      one_rm: "Estimated 1RM uses Brzycki: weight × (36 / (37 - reps)).",
      set_map: "Bubble Y-axis is weight, bubble size is reps, and color intensity is rep-adjusted load.",
    } as const;

    return (
      <div className="flex h-full flex-col gap-4">
        <Button
          variant="ghost"
          className="h-10 w-fit px-2 text-muted-foreground"
          onClick={() => setSelectedExerciseKey(null)}
        >
          <ChevronLeft className="h-4 w-4" />
          Back
        </Button>

        <Card className="gradient-card flex-1">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <div>
                <CardTitle className="text-xl">{exercise.name}</CardTitle>
                <p className="text-sm text-muted-foreground">
                  {exercise.totalSets} sets logged
                </p>
                <div className="mt-1 flex items-center gap-2">
                  {renderExerciseStateBadge(exercise)}
                  <span className="text-[11px] text-muted-foreground">
                    {exercise.confidence === "low" ? "Low confidence (need 3+ sessions)" : "High confidence"}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9 border-emerald-600/30"
                  onClick={() => toggleTrackedExercise(exercise.key)}
                >
                  <Target className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  className="h-9 border-emerald-600/30"
                  onClick={() => openBackfillDialog(exercise.name)}
                >
                  Backfill
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {!hasEnoughData ? (
              <div className="rounded-lg border border-dashed border-border/70 p-5 text-sm text-muted-foreground">
                Add at least 2 total sets for this exercise to unlock trend visualizations.
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant={exerciseVizMode === "one_rm" ? "default" : "outline"}
                    className="h-10"
                    onClick={() => changeExerciseVizMode("one_rm")}
                  >
                    1RM Trend
                  </Button>
                  <Button
                    variant={exerciseVizMode === "set_map" ? "default" : "outline"}
                    className="h-10"
                    onClick={() => changeExerciseVizMode("set_map")}
                  >
                    Weight x Reps
                  </Button>
                </div>

                <div className="rounded-lg border border-border/70 bg-background/70 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-sm font-medium">
                      {exerciseVizMode === "one_rm"
                        ? "Estimated 1RM"
                        : "Weight x Reps Map"}
                    </p>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground">
                          <Info className="h-4 w-4" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-72 text-sm text-muted-foreground" align="end">
                        {chartInfo[exerciseVizMode]}
                      </PopoverContent>
                    </Popover>
                  </div>

                  {exerciseVizMode === "one_rm" ? (
                    <div className="space-y-2">
                      <div className="grid grid-cols-[36px_1fr] gap-2">
                        <div className="flex h-36 flex-col justify-between text-[11px] text-muted-foreground">
                          {rmScale.ticks.map((tick, idx) => (
                            <span key={`rm-${idx}`}>{tick}</span>
                          ))}
                        </div>
                        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-36 w-full">
                          {[26, 50, 74].map((line) => (
                            <line
                              key={line}
                              x1="10"
                              y1={line}
                              x2="98"
                              y2={line}
                              stroke="rgba(148,163,184,0.25)"
                              strokeWidth="0.5"
                            />
                          ))}
                          <polyline
                            points={sessionLinePoints}
                            fill="none"
                            stroke="#34d399"
                            strokeWidth="3"
                            strokeLinejoin="round"
                            strokeLinecap="round"
                          />
                          {sessions.map((session, index) => (
                            <circle
                              key={session.id}
                              cx={getX(index, sessions.length)}
                              cy={rmScale.toY(session.est1RM)}
                              r="2.2"
                              fill="#a7f3d0"
                            />
                          ))}
                        </svg>
                      </div>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{sessions[0]?.label}</span>
                        <span>{sessions[sessions.length - 1]?.label}</span>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="grid grid-cols-[36px_1fr] gap-2">
                        <div className="flex h-36 flex-col justify-between text-[11px] text-muted-foreground">
                          {weightScale.ticks.map((tick, idx) => (
                            <span key={`set-${idx}`}>{tick}</span>
                          ))}
                        </div>
                        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-36 w-full">
                          {[26, 50, 74].map((line) => (
                            <line
                              key={line}
                              x1="10"
                              y1={line}
                              x2="98"
                              y2={line}
                              stroke="rgba(148,163,184,0.2)"
                              strokeWidth="0.5"
                            />
                          ))}
                          {allSets.map((set) => {
                            const xBase = getX(set.sessionIndex, sessions.length);
                            const jitter = ((set.setIndex % 5) - 2) * 1.3;
                            const x = Math.max(11, Math.min(98, xBase + jitter));
                            const y = weightScale.toY(set.weight);
                            const radius = Math.min(6.5, 2.6 + set.reps * 0.22);
                            const heat = (set.score - minScore) / scoreSpan;
                            const fill = `rgba(${Math.round(45 + heat * 90)}, ${Math.round(
                              198 - heat * 24,
                            )}, ${Math.round(238 - heat * 95)}, 0.72)`;
                            return (
                              <circle
                                key={set.id}
                                cx={x}
                                cy={y}
                                r={radius}
                                fill={fill}
                                stroke="rgba(255,255,255,0.24)"
                                strokeWidth="0.4"
                              />
                            );
                          })}
                          <polyline
                            points={adjustedLinePoints}
                            fill="none"
                            stroke="#22d3ee"
                            strokeWidth="1.3"
                            strokeDasharray="3 2"
                            strokeLinejoin="round"
                            strokeLinecap="round"
                          />
                        </svg>
                      </div>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{sessions[0]?.label}</span>
                        <span>{sessions[sessions.length - 1]?.label}</span>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}

            {latestSession ? (
              <div className="grid grid-cols-4 gap-2 rounded-lg border border-border/70 bg-background/70 p-3">
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Latest Top Set</p>
                  <p className="text-sm font-medium">
                    {latestSession.topSet.weight}x{latestSession.topSet.reps}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Current Est. 1RM</p>
                  <p className="text-sm font-medium">{Math.round(latestSession.est1RM)} {units}</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Avg Adj Score</p>
                  <p className="text-sm font-medium">{Math.round(latestSession.adjustedScore)}</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Last Context</p>
                  <p className="text-sm font-medium">{latestSession.contextTag ?? "normal"}</p>
                </div>
              </div>
            ) : null}
            <div className="rounded-lg border border-border/70 bg-background/70 p-3">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Next Target</p>
              <p className="text-sm font-medium">{exercise.nextTarget}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  };

  const renderExercises = () => {
    if (selectedExercise) return renderExerciseDetail(selectedExercise);

    return (
      <div className="flex h-full flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-2xl font-semibold">Exercises</h2>
          <div className="flex items-center gap-2">
            <Button variant="outline" className="h-10 border-emerald-600/30" onClick={() => setIsDashboardManageOpen(true)}>
              Dashboard
            </Button>
            <Button className="h-10" onClick={() => setIsAddExerciseDialogOpen(true)}>
              Add
            </Button>
          </div>
        </div>

        {trackedExercises.length === 0 ? (
          <Card className="border-border/70 bg-card/70 flex-1">
            <CardContent className="py-10 text-center text-muted-foreground">
              No tracked exercises yet.
              <br />
              Add one, then backfill or log a workout.
            </CardContent>
          </Card>
        ) : (
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            {trackedExercises.map((exercise) => {
              const isTrackedOnDashboard = trackedDashboardExercises.includes(exercise.key);
              return (
                <div
                  key={exercise.key}
                  className="rounded-xl border border-border/70 bg-gradient-to-br from-card to-emerald-950/10 p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => openExerciseDetail(exercise.key)}
                    >
                      <p className="text-lg font-semibold leading-tight">{exercise.name}</p>
                      <p className="text-sm text-muted-foreground">
                        Est. 1RM: {exercise.est1RM || "-"} {units}
                      </p>
                    <p className="text-sm text-muted-foreground">Working set: {exercise.workingSet}</p>
                    <p className="text-xs text-muted-foreground">
                      {exercise.totalSets} sets logged
                    </p>
                    <p className="text-xs text-cyan-300/90">{exercise.nextTarget}</p>
                    <div className="mt-1 flex items-center gap-2">
                      {renderExerciseStateBadge(exercise)}
                      <span className="text-[11px] text-muted-foreground">
                        {exercise.confidence === "low" ? "Low confidence" : "High confidence"}
                      </span>
                    </div>
                  </button>

                    <div className="flex items-center gap-1">
                      {renderTrendIcon(exercise.trend)}
                      <Button
                        variant={isTrackedOnDashboard ? "default" : "outline"}
                        size="icon"
                        className="h-9 w-9 border-emerald-600/30"
                        onClick={() => toggleTrackedExercise(exercise.key)}
                      >
                        <Target className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  {exercise.totalSets < 2 && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Add at least 2 sets to unlock trend charts.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const renderCurrentWorkout = () => {
    if (!currentWorkout) {
      return (
        <Card className="border-border/70 bg-card/70 backdrop-blur-sm">
          <CardContent className="py-12 text-center text-muted-foreground">
            No active workout yet.
            <br />
            Tap the center + to start.
          </CardContent>
        </Card>
      );
    }

    return (
      <Card className="border-border/70 bg-gradient-to-br from-card to-emerald-950/10 shadow-sm">
        <CardHeader className="space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-xl">{currentWorkout.name}</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                {new Date(currentWorkout.date).toLocaleDateString()} • {currentWorkout.exercises.length} exercises
              </p>
              <div className="mt-2 flex flex-wrap gap-1">
                {sessionContextOptions.map((tag) => (
                  <Button
                    key={`ctx-${tag}`}
                    type="button"
                    variant={currentWorkout.contextTag === tag ? "default" : "outline"}
                    className="h-7 px-2 text-[11px]"
                    onClick={() => setCurrentWorkoutContextTag(tag)}
                  >
                    {tag}
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="h-11 min-w-11 border-emerald-600/30"
                onClick={() => setIsAddSheetOpen(true)}
              >
                Add Exercise
              </Button>
              <Button
                className="h-11 min-w-11 bg-gradient-to-r from-emerald-600 to-emerald-700"
                onClick={() => setIsFinishDialogOpen(true)}
              >
                Finish
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          {currentWorkout.exercises.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">
              No exercises yet. Add one to start logging sets.
            </p>
          ) : (
            currentWorkout.exercises.map((exercise) => {
              const minReps = Math.min(...exercise.sets.map((set) => set.reps));
              const maxReps = Math.max(...exercise.sets.map((set) => set.reps));
              const repsSummary = exercise.sets.length > 0 ? `${minReps}-${maxReps}` : "0";

              return (
                <Collapsible
                  key={exercise.id}
                  open={expandedExerciseId === exercise.id}
                  onOpenChange={(open) => setExpandedExerciseId(open ? exercise.id : null)}
                >
                  <button
                    type="button"
                    className="w-full rounded-lg px-3 py-3 transition-colors hover:bg-secondary/40 active:scale-[0.99]"
                    onClick={() =>
                      setExpandedExerciseId((prev) => (prev === exercise.id ? null : exercise.id))
                    }
                  >
                    <div className="flex items-center justify-between">
                      <div className="text-left">
                        <p className="text-lg font-semibold">{exercise.name}</p>
                        <p className="text-sm text-muted-foreground">
                          {exercise.sets.length} sets • {repsSummary} reps
                        </p>
                      </div>
                      <ChevronDown
                        className={`h-6 w-6 transition-transform ${
                          expandedExerciseId === exercise.id ? "rotate-180" : ""
                        }`}
                      />
                    </div>
                  </button>

                  <CollapsibleContent>
                    <div className="space-y-4 px-2 pb-3">
                      {exercise.sets.map((set, setIndex) => (
                        <div
                          key={set.id}
                          className="rounded-lg border border-border/60 bg-background/60 p-3"
                        >
                          <div className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
                            <div className="space-y-2">
                              <p className="text-xs text-muted-foreground">Weight</p>
                              <div className="flex items-center gap-1">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-11 w-11"
                                  onClick={() =>
                                    updateSet(
                                      exercise.id,
                                      setIndex,
                                      "weight",
                                      Math.max(0, set.weight - 5),
                                    )
                                  }
                                >
                                  -5
                                </Button>
                                <Input
                                  type="number"
                                  min={0}
                                  value={set.weight}
                                  className="h-12 text-center text-3xl font-bold"
                                  onChange={(event) =>
                                    updateSet(
                                      exercise.id,
                                      setIndex,
                                      "weight",
                                      Math.max(0, Number(event.target.value) || 0),
                                    )
                                  }
                                />
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-11 w-11"
                                  onClick={() =>
                                    updateSet(exercise.id, setIndex, "weight", set.weight + 5)
                                  }
                                >
                                  +5
                                </Button>
                              </div>
                            </div>

                            <div className="space-y-2">
                              <p className="text-xs text-muted-foreground">Reps</p>
                              <div className="flex items-center gap-1">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-11 w-11"
                                  onClick={() =>
                                    updateSet(
                                      exercise.id,
                                      setIndex,
                                      "reps",
                                      Math.max(0, set.reps - 1),
                                    )
                                  }
                                >
                                  -1
                                </Button>
                                <Input
                                  type="number"
                                  min={0}
                                  value={set.reps}
                                  className="h-12 text-center text-3xl font-bold"
                                  onChange={(event) =>
                                    updateSet(
                                      exercise.id,
                                      setIndex,
                                      "reps",
                                      Math.max(0, Number(event.target.value) || 0),
                                    )
                                  }
                                />
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-11 w-11"
                                  onClick={() =>
                                    updateSet(exercise.id, setIndex, "reps", set.reps + 1)
                                  }
                                >
                                  +1
                                </Button>
                              </div>
                            </div>

                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-11 w-11 text-muted-foreground hover:text-destructive"
                              onClick={() => deleteSet(exercise.id, setIndex)}
                            >
                              <Trash2 className="h-5 w-5" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              );
            })
          )}
        </CardContent>
      </Card>
    );
  };

  const renderWorkouts = () => (
    <div className="space-y-6">
      <h2 className="text-2xl font-semibold">Workouts</h2>
      {renderCurrentWorkout()}

      <div>
        <h3 className="mb-3 text-lg font-semibold">History</h3>
        <div className="space-y-3">
          {history.length === 0 ? (
            <Card className="border-border/70 bg-card/70">
              <CardContent className="py-8 text-center text-muted-foreground">
                No past workouts yet.
              </CardContent>
            </Card>
          ) : (
            history.map((workout) => (
              <Card key={workout.id} className="gradient-card">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <CardTitle className="text-lg">{workout.name}</CardTitle>
                      <p className="text-sm text-muted-foreground">
                        {new Date(workout.date).toLocaleDateString()} • {workout.exercises.length} exercises
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      className="h-11 min-w-11 border-emerald-600/30"
                      onClick={() => startWorkout(workout)}
                    >
                      Use as Template
                    </Button>
                  </div>
                </CardHeader>
              </Card>
            ))
          )}
        </div>
      </div>
    </div>
  );

  const renderProfile = () => (
    <div className="space-y-4">
      <h2 className="text-2xl font-semibold">Profile</h2>

      <Card className="gradient-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-lg">Data Storage</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">Converging to your better self</p>
          <p className="text-muted-foreground">Joined: {new Date(joinDate).toLocaleDateString()}</p>
          <p className="text-muted-foreground">Total workouts: {history.length}</p>
          {!cloudOptIn ? (
            <>
              <p className="text-muted-foreground">
                Local-only mode: data persists on this device, but won&apos;t sync across devices.
              </p>
              <Button className="h-10" onClick={() => setCloudOptIn(true)}>
                Enable Cloud Save
              </Button>
            </>
          ) : !supabaseConfigured ? (
            <p className="text-sm text-red-400">
              Supabase not configured. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
            </p>
          ) : authUser ? (
            <div className="space-y-2">
              <p className="text-muted-foreground">Signed in as {authUser.email}</p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="h-10 border-emerald-600/30"
                  onClick={() => void syncCloudNow()}
                  disabled={isSyncingCloud}
                >
                  {isSyncingCloud ? "Syncing..." : "Sync Now"}
                </Button>
                <Button variant="outline" className="h-10 border-emerald-600/30" onClick={() => void signOut()}>
                  Log Out
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="rounded-md border border-border/70 bg-background/50 px-3 py-2 text-xs text-muted-foreground">
                <p>1. Sign up with email + password.</p>
                <p>2. Verify your email from inbox/spam.</p>
                <p>3. Return here and tap Log In.</p>
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
                <Button className="h-10" onClick={() => void signUpWithEmail()} disabled={isAuthLoading}>
                  Sign Up
                </Button>
                <Button
                  variant="outline"
                  className="h-10 border-emerald-600/30"
                  onClick={() => void signInWithEmail()}
                  disabled={isAuthLoading}
                >
                  Log In
                </Button>
              </div>
              {needsEmailVerification ? (
                <Button
                  variant="ghost"
                  className="h-9 px-2 text-xs text-muted-foreground"
                  onClick={() => void resendVerificationEmail()}
                  disabled={isAuthLoading}
                >
                  Resend verification email
                </Button>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Email verification is required after sign up.
              </p>
            </div>
          )}
          {authMessage ? (
            <p className="rounded-md border border-border/70 bg-background/50 px-3 py-2 text-xs text-muted-foreground">
              {authMessage}
            </p>
          ) : null}
          {cloudOptIn ? (
            <Button variant="ghost" className="h-8 px-2 text-xs text-muted-foreground" onClick={() => setCloudOptIn(false)}>
              Disable Cloud Save
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <Card className="gradient-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-lg">Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Label className="text-sm text-muted-foreground">Units</Label>
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant={units === "lbs" ? "default" : "outline"}
              className="h-11"
              onClick={() => setUnits("lbs")}
            >
              lbs
            </Button>
            <Button
              variant={units === "kg" ? "default" : "outline"}
              className="h-11"
              onClick={() => setUnits("kg")}
            >
              kg
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Goal configuration and cloud sync are planned for a later phase.
          </p>
        </CardContent>
      </Card>
    </div>
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="mx-auto h-[calc(100vh-8.25rem)] w-full max-w-2xl overflow-hidden px-4 pt-6 pb-4">
        {activeTab === "dashboard" && renderDashboard()}
        {activeTab === "exercises" && renderExercises()}
        {activeTab === "workouts" && renderWorkouts()}
        {activeTab === "profile" && renderProfile()}
      </main>

      <nav className="safe-area-nav fixed inset-x-0 bottom-0 z-50 border-t border-border/80 bg-background/95 backdrop-blur-xl">
        <div className="mx-auto w-full max-w-2xl px-4 pt-2">
          <div className="grid grid-cols-5 items-end gap-0">
            <Button
              variant="ghost"
              className={`h-14 w-full flex-col gap-1 rounded-xl px-1 ${
                activeTab === "dashboard"
                  ? "bg-gradient-to-br from-emerald-500/20 to-cyan-500/15 text-emerald-400"
                  : "text-muted-foreground"
              }`}
              onClick={() => setActiveTab("dashboard")}
            >
              <Dumbbell className="h-5 w-5" />
              <span className="text-[11px] leading-none">Dashboard</span>
            </Button>

            <Button
              variant="ghost"
              className={`h-14 w-full flex-col gap-1 rounded-xl px-1 ${
                activeTab === "exercises"
                  ? "bg-gradient-to-br from-emerald-500/20 to-cyan-500/15 text-emerald-400"
                  : "text-muted-foreground"
              }`}
              onClick={() => setActiveTab("exercises")}
            >
              <LineChart className="h-5 w-5" />
              <span className="text-[11px] leading-none">Exercises</span>
            </Button>

            <div className="flex justify-center">
              <Button
                className="h-16 w-16 -translate-y-4 rounded-full border border-emerald-300/20 bg-gradient-to-br from-emerald-500 via-emerald-600 to-cyan-600 text-white shadow-xl shadow-emerald-900/50 transition-transform duration-200 hover:scale-[1.02] active:scale-95"
                onClick={() => setIsQuickStartOpen(true)}
              >
                <Plus className="h-7 w-7" />
              </Button>
            </div>

            <Button
              variant="ghost"
              className={`h-14 w-full flex-col gap-1 rounded-xl px-1 ${
                activeTab === "workouts"
                  ? "bg-gradient-to-br from-emerald-500/20 to-cyan-500/15 text-emerald-400"
                  : "text-muted-foreground"
              }`}
              onClick={() => setActiveTab("workouts")}
            >
              <Clock className="h-5 w-5" />
              <span className="text-[11px] leading-none">Workouts</span>
            </Button>

            <Button
              variant="ghost"
              className={`h-14 w-full flex-col gap-1 rounded-xl px-1 ${
                activeTab === "profile"
                  ? "bg-gradient-to-br from-emerald-500/20 to-cyan-500/15 text-emerald-400"
                  : "text-muted-foreground"
              }`}
              onClick={() => setActiveTab("profile")}
            >
              <User className="h-5 w-5" />
              <span className="text-[11px] leading-none">Profile</span>
            </Button>
          </div>
        </div>
      </nav>

      <Dialog open={isDashboardManageOpen} onOpenChange={setIsDashboardManageOpen}>
        <DialogContent className="max-h-[76vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Dashboard Tracking</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm font-medium">System Metrics</p>
              <div className="space-y-2">
                {defaultDashboardOrder.map((metricId) => {
                  const metric = dashboardMetrics.find((item) => item.id === metricId);
                  const enabled = dashboardOrder.includes(metricId);
                  return (
                    <button
                      key={metricId}
                      type="button"
                      className="flex w-full items-center justify-between rounded-lg border border-border/70 bg-secondary/20 px-3 py-2 text-left"
                      onClick={() => toggleSystemMetric(metricId)}
                    >
                      <span className="text-sm">{metric?.title ?? metricId}</span>
                      <span className={`text-xs ${enabled ? "text-emerald-400" : "text-muted-foreground"}`}>
                        {enabled ? "On" : "Off"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium">Exercises</p>
              <div className="space-y-2">
                {trackedExercises.slice(0, 12).map((exercise) => {
                  const enabled = trackedDashboardExercises.includes(exercise.key);
                  return (
                    <button
                      key={`dash-ex-${exercise.key}`}
                      type="button"
                      className="flex w-full items-center justify-between rounded-lg border border-border/70 bg-secondary/20 px-3 py-2 text-left"
                      onClick={() => toggleTrackedExercise(exercise.key)}
                    >
                      <span className="text-sm">{exercise.name}</span>
                      <span className={`text-xs ${enabled ? "text-emerald-400" : "text-muted-foreground"}`}>
                        {enabled ? "Tracked" : "Add"}
                      </span>
                    </button>
                  );
                })}
              </div>
              {trackedExercises.length > 12 ? (
                <p className="text-xs text-muted-foreground">Top 12 exercises shown by adjusted load.</p>
              ) : null}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(goalEditor)} onOpenChange={(open) => !open && setGoalEditor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set Goal</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{goalEditor?.label}</p>
            <Input
              type="number"
              min={0}
              value={goalEditor?.value ?? ""}
              onChange={(event) =>
                setGoalEditor((prev) => (prev ? { ...prev, value: event.target.value } : prev))
              }
              placeholder="Enter target value"
            />
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" className="h-8 px-2 text-xs" onClick={() => nudgeGoal(1, "add")}>
                +1
              </Button>
              <Button type="button" variant="outline" className="h-8 px-2 text-xs" onClick={() => nudgeGoal(2.5, "add")}>
                +2.5
              </Button>
              <Button type="button" variant="outline" className="h-8 px-2 text-xs" onClick={() => nudgeGoal(5, "add")}>
                +5
              </Button>
              <Button type="button" variant="outline" className="h-8 px-2 text-xs" onClick={() => nudgeGoal(10, "add")}>
                +10
              </Button>
              <Button type="button" variant="outline" className="h-8 px-2 text-xs" onClick={() => nudgeGoal(5, "pct")}>
                +5%
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Leave blank or set 0 to remove goal.
            </p>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={saveGoal}>Save Goal</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isQuickStartOpen} onOpenChange={setIsQuickStartOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start Workout</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Button
              className="h-11 w-full bg-gradient-to-r from-emerald-600 to-cyan-600"
              onClick={() => startWorkout()}
            >
              Blank Workout
            </Button>
            <Button
              variant="outline"
              className="h-11 w-full border-emerald-600/30"
              onClick={() => {
                setIsQuickStartOpen(false);
                setIsTemplatePickerOpen(true);
              }}
              disabled={history.length === 0}
            >
              From Template
            </Button>
            <Button
              variant="outline"
              className="h-11 w-full border-emerald-600/30"
              onClick={continueWorkout}
              disabled={!currentWorkout}
            >
              Continue Last
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={isTemplatePickerOpen} onOpenChange={setIsTemplatePickerOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pick a Template</DialogTitle>
          </DialogHeader>
          <div className="max-h-[50vh] space-y-2 overflow-y-auto pr-1">
            {history.length === 0 ? (
              <p className="text-sm text-muted-foreground">No saved workouts yet.</p>
            ) : (
              history.map((workout) => (
                <button
                  key={`template-${workout.id}`}
                  type="button"
                  className="w-full rounded-lg border border-border/70 bg-secondary/20 px-3 py-3 text-left transition-colors hover:bg-secondary/40"
                  onClick={() => startWorkout(workout)}
                >
                  <p className="font-medium">{workout.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {new Date(workout.date).toLocaleDateString()} • {workout.exercises.length} exercises
                  </p>
                </button>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Sheet open={isAddSheetOpen} onOpenChange={setIsAddSheetOpen}>
        <SheetContent
          side="bottom"
          className="mx-auto h-[78vh] max-w-2xl rounded-t-3xl border border-border/80 bg-background"
        >
          <SheetHeader>
            <SheetTitle className="text-2xl">Add Exercise</SheetTitle>
          </SheetHeader>

          <div className="space-y-6 py-6">
            <div className="space-y-2">
              <Label>Exercise Name</Label>
              <Popover open={isExercisePickerOpen} onOpenChange={setIsExercisePickerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className="h-12 w-full justify-between text-left text-base"
                  >
                    {newExerciseName || "Tap to choose or search"}
                    <ChevronDown className="h-4 w-4 opacity-70" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                  <Command>
                    <CommandInput
                      placeholder="Search exercise..."
                      value={exerciseSearch}
                      onValueChange={setExerciseSearch}
                    />
                    <CommandList className="max-h-72">
                      <CommandEmpty>No results.</CommandEmpty>
                      <CommandGroup>
                        {filteredCommonExercises.map((exercise) => (
                          <CommandItem
                            key={exercise}
                            onSelect={() => {
                              setNewExerciseName(exercise);
                              setIsExercisePickerOpen(false);
                            }}
                          >
                            {exercise}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>

              <Input
                className="h-12"
                placeholder="Or type custom exercise"
                value={newExerciseName}
                onChange={(event) => setNewExerciseName(event.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Starting Weight ({units})</Label>
                <Input
                  className="h-12 text-xl"
                  type="number"
                  min={0}
                  placeholder="225"
                  value={newWeight}
                  onChange={(event) =>
                    setNewWeight(event.target.value ? Number(event.target.value) : "")
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>Starting Reps</Label>
                <Input
                  className="h-12 text-xl"
                  type="number"
                  min={0}
                  placeholder="8"
                  value={newReps}
                  onChange={(event) =>
                    setNewReps(event.target.value ? Number(event.target.value) : "")
                  }
                />
              </div>
            </div>

            <Button
              className="h-12 w-full bg-gradient-to-r from-emerald-600 to-cyan-600"
              onClick={addExerciseToWorkout}
              disabled={!newExerciseName.trim() || !newWeight || !newReps}
            >
              Add to Workout
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <Dialog open={isFinishDialogOpen} onOpenChange={setIsFinishDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Finish Workout</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <Label htmlFor="workout-name">Workout Name</Label>
            <Input
              id="workout-name"
              placeholder="e.g. Push Day Heavy"
              value={workoutName}
              onChange={(event) => setWorkoutName(event.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button className="bg-gradient-to-r from-emerald-600 to-cyan-600" onClick={finishWorkout}>
              Save & Finish
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isAddExerciseDialogOpen} onOpenChange={setIsAddExerciseDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Exercise</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Label htmlFor="exercise-name">Exercise Name</Label>
            <Input
              id="exercise-name"
              placeholder="e.g. Bulgarian Split Squat"
              value={newCatalogExerciseName}
              onChange={(event) => setNewCatalogExerciseName(event.target.value)}
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={addExerciseFromExercisesTab}>Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isBackfillDialogOpen} onOpenChange={setIsBackfillDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Backfill {backfillExerciseName || "Exercise"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="backfill-date">Session Date</Label>
              <Input
                id="backfill-date"
                type="date"
                value={backfillDate}
                onChange={(event) => setBackfillDate(event.target.value)}
              />
            </div>

            <div className="space-y-1">
              <Label>Session Context</Label>
              <div className="flex flex-wrap gap-1">
                {sessionContextOptions.map((tag) => (
                  <Button
                    key={`backfill-ctx-${tag}`}
                    type="button"
                    variant={backfillContextTag === tag ? "default" : "outline"}
                    className="h-8 px-2 text-[11px]"
                    onClick={() => setBackfillContextTag(tag)}
                  >
                    {tag}
                  </Button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Sets</Label>
                <Button
                  variant="outline"
                  className="h-9"
                  onClick={() =>
                    setBackfillSetsDraft((prev) => [...prev, { id: uuidv4(), weight: 0, reps: 0 }])
                  }
                >
                  Add Set
                </Button>
              </div>

              <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
                {backfillSetsDraft.map((set, index) => (
                  <div key={set.id} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                    <Input
                      type="number"
                      min={0}
                      placeholder={`Weight (${units})`}
                      value={set.weight || ""}
                      onChange={(event) => {
                        const value = Number(event.target.value) || 0;
                        setBackfillSetsDraft((prev) =>
                          prev.map((item) => (item.id === set.id ? { ...item, weight: value } : item)),
                        );
                      }}
                    />
                    <Input
                      type="number"
                      min={0}
                      placeholder="Reps"
                      value={set.reps || ""}
                      onChange={(event) => {
                        const value = Number(event.target.value) || 0;
                        setBackfillSetsDraft((prev) =>
                          prev.map((item) => (item.id === set.id ? { ...item, reps: value } : item)),
                        );
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-10 w-10"
                      onClick={() => {
                        setBackfillSetsDraft((prev) =>
                          prev.length === 1 ? prev : prev.filter((item) => item.id !== set.id),
                        );
                      }}
                      disabled={backfillSetsDraft.length === 1 && index === 0}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={saveBackfillSession}>Save Session</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default App;
